"""OpenCV compute backend (CPU vs OpenCL UMat).

Use OpenCL-backed imgproc where available via ``cv2.UMat``. CUDA builds are
unsupported for these code paths unless ``cv2.cuda`` devices exist and callers
migrate to GpuMat separately.

Controls:
    OPENCV_ACCEL: ``auto`` (default), ``cpu``, ``opencl``. Mis-spelled values
    fall back to ``auto``.
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
_effective: AccelName | None = None
_configured_once = False


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
    global _effective
    if _effective is not None:
        return _effective

    preference = _want_opencl_from_env()
    if preference is False:
        cv2.ocl.setUseOpenCL(False)
        _effective = "cpu"
        return _effective

    if preference is True:
        if cv2.ocl.haveOpenCL():
            cv2.ocl.setUseOpenCL(True)
            _effective = "opencl"
        else:
            logger.warning(
                "OPENCV_ACCEL requested OpenCL but haveOpenCL() is false; using CPU."
            )
            cv2.ocl.setUseOpenCL(False)
            _effective = "cpu"
        return _effective

    # auto
    if cv2.ocl.haveOpenCL():
        cv2.ocl.setUseOpenCL(True)
        _effective = "opencl"
    else:
        cv2.ocl.setUseOpenCL(False)
        _effective = "cpu"
    return _effective


def configure_opencv_acceleration() -> AccelName:
    """Configure OpenCL use from env and return the effective backend.

    Safe to call once at pipeline startup; repeats are no-ops.
    """
    global _configured_once
    name = resolve_effective_backend()
    if not _configured_once:
        _configured_once = True
        logger.info(
            "OpenCV acceleration: %s (OPENCV_ACCEL=%r, CUDA devices=%d, haveOpenCL=%s)",
            name,
            os.environ.get(_ENV_KEY, "auto"),
            cuda_device_count(),
            cv2.ocl.haveOpenCL(),
        )
    return name


def acceleration_is_opencl() -> bool:
    """Whether OpenCL-backed UMat ops should run (CPU path if False)."""
    return configure_opencv_acceleration() == "opencl"


def _as_umat(mat: np.ndarray | cv2.UMat) -> cv2.UMat:
    if isinstance(mat, cv2.UMat):
        return mat
    # OpenCV stubs omit ndarray wrappers for UMat(...)
    return cv2.UMat(mat)  # type: ignore[call-overload, no-any-return]


def upload_gray_for_matching(padded_line: np.ndarray) -> np.ndarray | cv2.UMat:
    """Upload padded scan line once for repeated ``matchTemplate`` (OpenCL)."""
    if not acceleration_is_opencl():
        return padded_line
    return _as_umat(padded_line)


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
) -> np.ndarray:
    """``TM_CCOEFF_NORMED`` match; result is CPU ``numpy.ndarray``."""
    if not acceleration_is_opencl():
        img = image.get() if isinstance(image, cv2.UMat) else image
        tpl = templ.get() if isinstance(templ, cv2.UMat) else templ
        return cv2.matchTemplate(img, tpl, cv2.TM_CCOEFF_NORMED)

    img_u = _as_umat(image)
    tpl_u = _as_umat(templ)
    match_u = cv2.matchTemplate(img_u, tpl_u, cv2.TM_CCOEFF_NORMED)
    return match_u.get()
