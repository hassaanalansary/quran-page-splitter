"""Pixel work every engine needs, and none of them should own.

    from core.imaging import find_content_bbox, make_transparent

Four modules, no domain knowledge between them. Nothing here has heard of a mushaf,
a line or an aya — hand it an array and it answers about the array. That is the test
for whether something belongs here: if it needs to know what the picture *is*, it
belongs to an engine instead.

    accel.py              which OpenCV backend to use, and the one kernel that
                          cannot be trusted to it
    utils.py              binarise, find the ink, cut it out, make it transparent
    template_matching.py  find a small picture inside a bigger one
    strokes.py            paint a freehand path onto a mask

``accel`` is the odd one and worth knowing about before you touch template
matching: this project's OpenCL path fabricates perfect ``TM_CCOEFF_NORMED``
scores, so the matchers re-score on the CPU rather than believing them. The
evidence is in that module.
"""

from core.imaging.accel import (
    acceleration_is_opencl,
    configure_opencv_acceleration,
    cuda_device_count,
    match_template_ccoeff_normed,
    resize_area,
    resolve_effective_backend,
    upload_gray_for_matching,
)
from core.imaging.strokes import apply_eraser_stroke
from core.imaging.template_matching import (
    MAX_VERIFICATIONS,
    IgnoreRect,
    TemplateSpec,
    cpu_score_at,
    locate_x_matches,
    make_mask,
    make_template_spec,
    match_template,
    needs_cpu_verification,
)
from core.imaging.utils import (
    binarize_image,
    clean_image,
    find_content_bbox,
    make_transparent,
    right_strip,
)

__all__ = [
    "MAX_VERIFICATIONS",
    "IgnoreRect",
    "TemplateSpec",
    "acceleration_is_opencl",
    "apply_eraser_stroke",
    "binarize_image",
    "clean_image",
    "configure_opencv_acceleration",
    "cpu_score_at",
    "cuda_device_count",
    "find_content_bbox",
    "locate_x_matches",
    "make_mask",
    "make_template_spec",
    "make_transparent",
    "match_template",
    "match_template_ccoeff_normed",
    "needs_cpu_verification",
    "resize_area",
    "resolve_effective_backend",
    "right_strip",
    "upload_gray_for_matching",
]
