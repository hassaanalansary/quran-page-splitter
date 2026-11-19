"""One confirmed page brought into the stored fingerprint set's groups.

The steps of ``docs/plans/fingerprint-set.md`` §2 that need the page, shared by a
Confirm (:func:`fingerprint_updates.add_confirmed_page_to_library`) and by a Rebuild that
catches up with pages confirmed while it ran::

    read_page_examples                    the page's eligible blobs, labels and features
    drop_shapes_the_page_no_longer_has    a changed label, a gone blob, a removal
    place_new_page_examples               the rest join their nearest group, or start one
    check_page_shapes_match_labels        every shape of the page carries its label
"""

from __future__ import annotations

from dataclasses import dataclass

from api.models import CalibrationRevision, Mushaf
from api.services.calibration_examples import collect_library_examples
from core.word_boundary.library import Comparison
from core.word_boundary.library_updates import (
    Placement,
    ShapeGroup,
    drop_shape_from_group,
    place_examples_in_groups,
    shape_from_sample,
)

Label = tuple[str, str]


@dataclass
class PageExamples:
    """A confirmed page's eligible blobs: each one's label, and the examples as samples."""

    page_number: int
    revision_id: str
    labels: dict[tuple[str, int], Label]
    samples: list[dict]


def read_page_examples(mushaf: Mushaf, page_number: int, revision: CalibrationRevision) -> PageExamples:
    samples = collect_library_examples(mushaf, [revision])
    return PageExamples(
        page_number=page_number,
        revision_id=str(revision.pk),
        labels={(sample["snapshot_id"], sample["blob_id"]): (sample["role"], sample["subtype"]) for sample in samples},
        samples=samples,
    )


def is_removed(key: tuple[str, int], label: Label, removed: dict[tuple[str, int], Label]) -> bool:
    """A removal counts while the blob is still confirmed as what it was removed as."""
    return removed.get(key) == label


def drop_shapes_the_page_no_longer_has(
    groups: list[ShapeGroup],
    page: PageExamples,
    removed: dict[tuple[str, int], Label],
    method: Comparison,
) -> int:
    """Take out the page's shapes whose label changed, whose blob is no longer an
    example, or that were removed — and point the rest at the page's new confirmation.
    Returns how many were taken out."""
    dropped = 0
    for group in list(groups):
        for shape in list(group.shapes()):
            if shape.page_number != page.page_number:
                continue
            label = page.labels.get(shape.key)
            if label != group.kind or is_removed(shape.key, label, removed):
                drop_shape_from_group(groups, group, shape.key, method)
                dropped += 1
            else:
                shape.revision_id = page.revision_id
    return dropped


def place_new_page_examples(
    groups: list[ShapeGroup],
    page: PageExamples,
    removed: dict[tuple[str, int], Label],
    method: Comparison,
    limit: float,
) -> list[Placement]:
    """The page's examples not in the set yet, and not removed, placed in page order."""
    present = {shape.key for group in groups for shape in group.shapes()}
    arriving = []
    for sample in page.samples:
        key = (sample["snapshot_id"], sample["blob_id"])
        label = page.labels[key]
        if key in present or is_removed(key, label, removed):
            continue
        arriving.append((label[0], label[1], shape_from_sample(sample, distance=0.0, looks_right_keys=frozenset())))
    return place_examples_in_groups(groups, arriving, method, limit)


def check_page_shapes_match_labels(groups: list[ShapeGroup], page: PageExamples) -> bool:
    """Whether every shape the set keeps from the page carries the page's label for it."""
    return all(
        page.labels.get(shape.key) == group.kind
        for group in groups
        for shape in group.shapes()
        if shape.page_number == page.page_number
    )


def bring_page_into_groups(
    groups: list[ShapeGroup],
    page: PageExamples,
    removed: dict[tuple[str, int], Label],
    method: Comparison,
    limit: float,
) -> bool:
    """§2 steps 2 to 4 for one page. Returns whether the check passed."""
    drop_shapes_the_page_no_longer_has(groups, page, removed, method)
    place_new_page_examples(groups, page, removed, method, limit)
    return check_page_shapes_match_labels(groups, page)
