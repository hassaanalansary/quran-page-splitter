"""OpenCV compute backend (CPU vs OpenCL UMat).

Use OpenCL-backed imgproc where available via ``cv2.UMat``. CUDA builds are
unsupported for these code paths unless ``cv2.cuda`` devices exist and callers
migrate to GpuMat separately.

Controls:
    OPENCV_ACCEL: ``auto`` (default), ``cpu``, ``opencl``. Mis-spelled values
    fall back to ``auto``.

The backend is resolved afresh at the start of every pipeline run, not once per
process. It used to be latched on first use, which made ``OPENCV_ACCEL`` a
restart-only setting and — worse — meant a run's log could not be trusted to say
which kernel actually produced its scores.

Per-run and per-template overrides are separate concerns: this module answers
"what did the environment ask for", while a caller that must not touch OpenCL
for a particular match passes ``force_cpu=True`` (see
``core.template_matching``).
"""

from __future__ import annotations

import logging
import os
from typing import Literal

import cv2
import numpy as np

logger = logging.getLogger(__name__)

AccelName = Literal["cpu", "opencl"]

_ENV_KEY = "OPENCV_ACCEL"
#: Backend in force right now. Refreshed by every ``resolve_effective_backend``
#: call; cached only so the hot path can answer without re-querying OpenCL.
_current: AccelName | None = None


def _want_opencl_from_env() -> bool | None:
    """Return True=force OpenCL, False=force CPU, None=auto."""
    raw = os.environ.get(_ENV_KEY, "auto").strip().lower()
    if raw == "cpu":
        return False
    if raw in ("opencl", "ocl", "gpu"):
        return True
    return None


def cuda_device_count() -> int:
    if not hasattr(cv2, "cuda"):
        return 0
    try:
        return int(cv2.cuda.getCudaEnabledDeviceCount())
    except cv2.error:
        return 0


def resolve_effective_backend() -> AccelName:
    """Read the environment, apply the choice to OpenCV, and return it.

    Re-reads every time. Nothing is latched, so changing ``OPENCV_ACCEL``
    between runs takes effect on the next run rather than the next restart.
    """
    global _current

    preference = _want_opencl_from_env()
    if preference is True and not cv2.ocl.haveOpenCL():
        logger.warning("OPENCV_ACCEL requested OpenCL but haveOpenCL() is false; using CPU.")
        preference = False

    use_opencl = cv2.ocl.haveOpenCL() if preference is None else preference
    cv2.ocl.setUseOpenCL(use_opencl)
    _current = "opencl" if use_opencl else "cpu"
    return _current


def configure_opencv_acceleration() -> AccelName:
    """Resolve the backend and record it in the log. Call once per run.

    The log line is written on every call, not just the first: it is the only
    record of which kernel produced a given run's match scores, and a run log
    that silently inherited an earlier run's backend would be misleading.
    """
    name = resolve_effective_backend()
    logger.info(
        "OpenCV acceleration: %s (OPENCV_ACCEL=%r, CUDA devices=%d, haveOpenCL=%s)",
        name,
        os.environ.get(_ENV_KEY, "auto"),
        cuda_device_count(),
        cv2.ocl.haveOpenCL(),
    )
    return name


def acceleration_is_opencl() -> bool:
    """Whether OpenCL-backed UMat ops should run (CPU path if False).

    Answers from the backend the current run resolved. Callers that reach the
    matcher without a pipeline (tests, scripts) resolve it lazily on first ask.
    """
    if _current is None:
        resolve_effective_backend()
    return _current == "opencl"


def _as_umat(mat: np.ndarray | cv2.UMat) -> cv2.UMat:
    if isinstance(mat, cv2.UMat):
        return mat
    # OpenCV stubs omit ndarray wrappers for UMat(...)
    return cv2.UMat(mat)  # type: ignore[call-overload, no-any-return]


def upload_gray_for_matching(gray: np.ndarray, *, force_cpu: bool = False) -> np.ndarray | cv2.UMat:
    """Upload a grayscale image once for repeated ``matchTemplate`` (OpenCL)."""
    if force_cpu or not acceleration_is_opencl():
        return gray
    return _as_umat(gray)


def resize_area(src: np.ndarray | cv2.UMat, dsize: tuple[int, int]) -> np.ndarray:
    """Resize with INTER_AREA; OpenCL uses UMat when enabled."""
    if not acceleration_is_opencl():
        s = src.get() if isinstance(src, cv2.UMat) else src
        return cv2.resize(s, dsize, interpolation=cv2.INTER_AREA)

    um = _as_umat(src)
    out = cv2.resize(um, dsize, interpolation=cv2.INTER_AREA)
    return out.get()


def match_template_ccoeff_normed(
    image: np.ndarray | cv2.UMat,
    templ: np.ndarray | cv2.UMat,
    mask: np.ndarray | cv2.UMat | None = None,
    *,
    force_cpu: bool = False,
) -> np.ndarray:
    """``TM_CCOEFF_NORMED`` match; result is CPU ``numpy.ndarray``.

    ``force_cpu`` pins one call to the CPU kernel regardless of the run's
    backend — used both by the "prefer acceleration off" setting and to
    re-score OpenCL candidates against a kernel whose scores can be trusted.
    """
    if force_cpu or not acceleration_is_opencl():
        img = image.get() if isinstance(image, cv2.UMat) else image
        tpl = templ.get() if isinstance(templ, cv2.UMat) else templ
        if mask is None:
            return cv2.matchTemplate(img, tpl, cv2.TM_CCOEFF_NORMED)
        msk = mask.get() if isinstance(mask, cv2.UMat) else mask
        return cv2.matchTemplate(img, tpl, cv2.TM_CCOEFF_NORMED, mask=msk)

    img_u = _as_umat(image)
    tpl_u = _as_umat(templ)
    if mask is None:
        match_u = cv2.matchTemplate(img_u, tpl_u, cv2.TM_CCOEFF_NORMED)
    else:
        match_u = cv2.matchTemplate(
            img_u,
            tpl_u,
            cv2.TM_CCOEFF_NORMED,
            mask=_as_umat(mask),
        )
    return match_u.get()
