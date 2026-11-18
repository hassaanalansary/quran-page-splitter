"""The stored fingerprint set, changed a page at a time instead of rebuilt.

:func:`library.build_library` groups every confirmed example from scratch. The stored set
(``docs/plans/fingerprint-set.md``) is built that way once, and then only changed:

    Confirm a page    its examples go into the groups (place_examples_in_groups)
                        nearest fingerprint of their kind within LIMIT → join it,
                        and keep_spread_shapes decides whether the group keeps them
                        none within LIMIT → a new group, the example its fingerprint
    a shape leaves    drop_shape_from_group: a fingerprint hands over to its
                        nearest kept shape; a group with nothing left goes
    lookups           build_library_from_groups: the kept shapes as a Library
    a confirmed page  hide_shapes_of_page: the same Library without that page's shapes,
    processed again     so its first guesses stay an honest test

**Fingerprints never move by themselves.** A from-scratch rebuild after one more page
replaced 44 to 52 of 276 fingerprints, so a group's fingerprint changes only when it
leaves the group (Remove, or its page re-confirmed with another label) or on Rebuild.

**A group keeps at most** ``KEEP - 1`` **shapes besides its fingerprint**, and no member
list: guesses only ever used the kept shapes. Which shapes stay is the spread rule of
:func:`keep_spread_shapes`.

Pure: no database. The shapes carry their raw features (``examples.feature_vector``);
what the comparison makes of them is worked out here when it is needed.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field

import numpy as np

from core.word_boundary.library import EXACT_DISTANCE, KEEP, Comparison, Library

#: Shapes a group keeps besides its fingerprint.
KEPT_PER_GROUP = KEEP - 1


@dataclass
class KeptShape:
    """One confirmed blob the set keeps: where it is, its raw features, and how far it
    is from its group's fingerprint."""

    snapshot_id: str
    blob_id: int
    page_number: int
    line_number: int
    revision_id: str | None
    features: np.ndarray = field(repr=False)
    distance: float = 0.0
    looks_right: bool = False

    @property
    def key(self) -> tuple[str, int]:
        return (self.snapshot_id, self.blob_id)

    def reference(self, *, fingerprint: bool) -> dict:
        """What identifies the shape in a Library's ``refs`` — never its features."""
        return {
            "snapshot_id": self.snapshot_id,
            "blob_id": self.blob_id,
            "page_number": self.page_number,
            "line_number": self.line_number,
            "revision_id": self.revision_id,
            "fingerprint": fingerprint,
        }


@dataclass
class ShapeGroup:
    """One fingerprint of a kind (a role, and a mark's type) and the shapes kept beside
    it, the nearest to it first."""

    role: str
    subtype: str
    fingerprint: KeptShape
    kept: list[KeptShape] = field(default_factory=list)

    @property
    def kind(self) -> tuple[str, str]:
        return (self.role, self.subtype)

    def shapes(self) -> list[KeptShape]:
        return [self.fingerprint, *self.kept]


@dataclass
class Placement:
    """Where :func:`place_examples_in_groups` put one example."""

    example: KeptShape
    group: ShapeGroup
    started_group: bool
    kept: bool


def sort_kept_shapes(shapes: list[KeptShape]) -> list[KeptShape]:
    return sorted(shapes, key=lambda shape: (shape.distance, shape.key))


def place_examples_in_groups(
    groups: list[ShapeGroup],
    examples: Iterable[tuple[str, str, KeptShape]],
    method: Comparison,
    limit: float,
) -> list[Placement]:
    """Put each (role, subtype, example) into the nearest group of its kind within
    ``limit``, or make it the fingerprint of a new group. In order: a fingerprint an
    example starts is a group the examples after it may join, as a whole page's blobs
    did when this was measured (page 27 onto pages 1 to 26: 1,112 joined, 3 started groups).

    ``groups`` is changed in place; what happened to each example is returned.
    """
    banks: dict[tuple[str, str], tuple[list[ShapeGroup], object]] = {}

    def bank_of(kind: tuple[str, str]) -> tuple[list[ShapeGroup], object]:
        if kind not in banks:
            own = [group for group in groups if group.kind == kind]
            banks[kind] = (own, stack_fingerprints(own, method))
        return banks[kind]

    placements = []
    for role, subtype, example in examples:
        kind = (role, subtype)
        own, bank = bank_of(kind)
        if own:
            near = method.distances(bank, [method.describe(example.features)])[0]
            nearest = int(np.argmin(near))
            if near[nearest] <= limit:
                example.distance = float(near[nearest])
                kept = keep_spread_shapes(own[nearest], example)
                placements.append(Placement(example, own[nearest], started_group=False, kept=kept))
                continue
        example.distance = 0.0
        group = ShapeGroup(role=role, subtype=subtype, fingerprint=example)
        groups.append(group)
        own.append(group)
        banks[kind] = (own, stack_fingerprints(own, method))
        placements.append(Placement(example, group, started_group=True, kept=True))
    return placements


def stack_fingerprints(groups: list[ShapeGroup], method: Comparison) -> object:
    return method.stack([method.describe(group.fingerprint.features) for group in groups])


def keep_spread_shapes(group: ShapeGroup, newcomer: KeptShape) -> bool:
    """Whether the group keeps ``newcomer`` beside its fingerprint — the spread rule.

    - A shape printed pixel for pixel like the fingerprint shows nothing new: skipped.
    - While there is room (``KEPT_PER_GROUP``), it is kept.
    - When full, the farthest shape stays, so the group's whole reach is covered. Of
      the others, the one closest to a neighbour (the next shape along the distance
      to the fingerprint, the fingerprint itself at 0) is dropped: it adds least.
    - A looks-right shape is never dropped, and counts toward the room. When nothing
      may be dropped, the newcomer is not kept.
    - On a tie the newcomer goes, so the kept shapes do not churn; then by blob key.
    """
    if newcomer.distance <= EXACT_DISTANCE or any(shape.key == newcomer.key for shape in group.shapes()):
        return False
    candidates = sort_kept_shapes([*group.kept, newcomer])
    if len(candidates) <= KEPT_PER_GROUP:
        group.kept = candidates
        return True
    dropped = choose_shape_to_drop(candidates, newcomer)
    if dropped is None:
        return False
    group.kept = [shape for shape in candidates if shape is not dropped]
    return dropped is not newcomer


def choose_shape_to_drop(candidates: list[KeptShape], newcomer: KeptShape) -> KeptShape | None:
    """Of shapes sorted by distance, the one that covers least — never the farthest,
    never a looks-right one; on a tie the newcomer."""
    distances = [0.0, *(shape.distance for shape in candidates)]
    best: tuple[float, bool, tuple[str, int]] | None = None
    chosen = None
    for index, shape in enumerate(candidates[:-1]):
        if shape.looks_right:
            continue
        before = distances[index + 1] - distances[index]
        after = distances[index + 2] - distances[index + 1]
        rank = (min(before, after), shape is not newcomer, shape.key)
        if best is None or rank < best:
            best, chosen = rank, shape
    return chosen


def drop_shape_from_group(
    groups: list[ShapeGroup], group: ShapeGroup, key: tuple[str, int], method: Comparison
) -> None:
    """Take one shape out of its group. A fingerprint hands over to its nearest kept
    shape, and the rest are measured again against the new one (an exact copy of it is
    let go, unless it looks right). A group with nothing left goes."""
    if group.fingerprint.key != key:
        group.kept = [shape for shape in group.kept if shape.key != key]
        return
    if not group.kept:
        groups.remove(group)
        return
    successor, *rest = sort_kept_shapes(group.kept)
    successor.distance = 0.0
    group.fingerprint = successor
    measure_kept_distances(group, rest, method)


def measure_kept_distances(group: ShapeGroup, shapes: list[KeptShape], method: Comparison) -> None:
    """Measure ``shapes`` against the group's fingerprint and keep them in order."""
    if shapes:
        bank = method.stack([method.describe(group.fingerprint.features)])
        near = method.distances(bank, [method.describe(shape.features) for shape in shapes])[:, 0]
        for shape, distance in zip(shapes, near, strict=True):
            shape.distance = float(distance)
    group.kept = sort_kept_shapes([shape for shape in shapes if shape.distance > EXACT_DISTANCE or shape.looks_right])


def find_group_of_shape(groups: list[ShapeGroup], key: tuple[str, int]) -> ShapeGroup | None:
    return next((group for group in groups if any(shape.key == key for shape in group.shapes())), None)


def build_library_from_groups(groups: list[ShapeGroup], method: Comparison, limit: float) -> Library:
    """The kept shapes as a Library for lookups: one stacked matrix, each shape's
    described numbers a row view of it, so they are held once."""
    shapes = [(group, shape, index == 0) for group in groups for index, shape in enumerate(group.shapes())]
    matrix = np.empty((len(shapes), len(method.describe(groups[0].fingerprint.features)) if groups else 0))
    for row, (_, shape, _) in enumerate(shapes):
        matrix[row] = method.describe(shape.features)
    return Library(
        method=method,
        limit=limit,
        roles=np.array([group.role for group, _, _ in shapes], dtype=str),
        kinds=np.array([group.subtype if group.role == "mark" else "" for group, _, _ in shapes], dtype=str),
        refs=[shape.reference(fingerprint=is_fingerprint) for _, shape, is_fingerprint in shapes],
        copies=[1] * len(shapes),
        reps=list(matrix),
        bank=method.stack(matrix),
        examples=len(shapes),
        typed_examples=sum(1 for group, _, _ in shapes if group.role == "mark" and group.subtype),
        fingerprints=len(groups),
        groups=[describe_group(group) for group in groups],
    )


def describe_group(group: ShapeGroup) -> dict:
    """A group as :attr:`Library.groups` lays it out: its fingerprint, then its kept
    shapes, with their distance to it, every member kept."""
    members = group.shapes()
    return {
        "role": group.role,
        "subtype": group.subtype,
        "centre": group.fingerprint.reference(fingerprint=True),
        "members": [shape.reference(fingerprint=index == 0) for index, shape in enumerate(members)],
        "distance": [shape.distance for shape in members],
        "kept": list(range(1, len(members))),
    }


def hide_shapes_of_page(library: Library, page_number: int) -> Library:
    """The same lookups without one page's shapes: for processing a page that is
    already confirmed, so its first guesses are not answered by its own labels. A group
    whose fingerprint came from that page still answers through its other kept shapes."""
    keep = [index for index, ref in enumerate(library.refs) if ref.get("page_number") != page_number]
    matrix = np.stack([library.reps[index] for index in keep]) if keep else np.zeros((0, 0))
    groups = []
    for item in library.groups:
        members = [
            (ref, distance)
            for ref, distance in zip(item["members"], item["distance"], strict=True)
            if ref.get("page_number") != page_number
        ]
        if members:
            groups.append(
                {
                    **item,
                    "centre": members[0][0],
                    "members": [ref for ref, _ in members],
                    "distance": [distance for _, distance in members],
                    "kept": list(range(1, len(members))),
                }
            )
    return Library(
        method=library.method,
        limit=library.limit,
        roles=library.roles[keep],
        kinds=library.kinds[keep],
        refs=[library.refs[index] for index in keep],
        copies=[library.copies[index] for index in keep],
        reps=list(matrix),
        bank=library.method.stack(matrix) if keep else library.method.stack([]),
        examples=len(keep),
        typed_examples=sum(1 for index in keep if library.roles[index] == "mark" and library.kinds[index]),
        fingerprints=len(groups),
        groups=groups,
    )


def convert_library_to_groups(
    library: Library, samples: list[dict], *, looks_right_keys: frozenset[tuple[str, int]] = frozenset()
) -> list[ShapeGroup]:
    """A from-scratch :func:`library.build_library` as stored groups: each group's
    fingerprint, then its looks-right members (never dropped), then the members the
    build spread across its reach, through the same spread rule as a Confirm."""
    by_key = {(sample["snapshot_id"], sample["blob_id"]): sample for sample in samples}
    groups = []
    for item in library.groups:
        centre = shape_from_sample(
            by_key[reference_key(item["centre"])], distance=0.0, looks_right_keys=looks_right_keys
        )
        group = ShapeGroup(role=item["role"], subtype=item["subtype"], fingerprint=centre)
        members = list(zip(item["members"], item["distance"], strict=True))
        looks_right = [(ref, distance) for ref, distance in members if reference_key(ref) in looks_right_keys]
        picked = [members[index] for index in item["kept"]]
        for ref, distance in [*looks_right, *picked]:
            shape = shape_from_sample(by_key[reference_key(ref)], distance=distance, looks_right_keys=looks_right_keys)
            keep_spread_shapes(group, shape)
        groups.append(group)
    return groups


def reference_key(ref: dict) -> tuple[str, int]:
    return (str(ref["snapshot_id"]), int(ref["blob_id"]))


def shape_from_sample(sample: dict, *, distance: float, looks_right_keys: frozenset[tuple[str, int]]) -> KeptShape:
    key = (str(sample["snapshot_id"]), int(sample["blob_id"]))
    return KeptShape(
        snapshot_id=key[0],
        blob_id=key[1],
        page_number=int(sample.get("page_number") or 0),
        line_number=int(sample.get("line_number") or 0),
        revision_id=sample.get("revision_id"),
        features=np.asarray(sample["features"], dtype=np.float64),
        distance=float(distance),
        looks_right=key in looks_right_keys,
    )
