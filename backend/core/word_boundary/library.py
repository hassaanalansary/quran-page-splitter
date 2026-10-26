"""The fingerprint library: confirmed examples, grouped by shape, that every new blob is
compared with.

Built from the blobs of confirmed pages, kind by kind — the letters (bodies) as one
kind, and the marks as one kind per type, untyped marks as one more::

    for each example, in page order:
        nearest fingerprint of its kind within LIMIT?  ── yes ─► joins that group
                                                       └─ no ──► becomes a fingerprint
    each group's fingerprint re-chosen as its most typical member, then walked again
    kept: every fingerprint and up to 11 of its members, spread nearest to farthest

A fingerprint is one distinct way a kind is written; the members kept beside it show how
far it reaches. LIMIT is in the comparison's own units, a per-mushaf setting.

Asked about a new blob, the library always answers:

* **body or mark** — whichever of the nearest kept letter and the nearest kept mark is
  nearer; ``confidence`` (0..1) says by how much: (far - near) / (far + near);
* **its type** — each type's nearest kept shape, as :mod:`examples` answered it, so
  the text check (:mod:`mark_check`) reads both the same way.

Measured on the first mushaf (pages 3-14 learning, pages 15-17 tested, every
disagreement checked by eye): 2 typing mistakes in 2,036 marks and 1 body/mark mistake in
2,425 blobs, against 4 and 381 unanswered for the all-examples matcher it replaces, at
about a twentieth of its time per blob. ``wl-out/shapes/REPORT.md`` §15 has the bench.

The comparison is pluggable (``COMPARISONS``); ``descriptor32`` — :func:`examples.feature_vector`'s
32x32 picture and six geometry numbers, weighed as the old matcher weighed them — is
the default, and the only one for now.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Protocol

import numpy as np

from core.word_boundary.examples import (
    DEFAULT_CONFIG,
    FEATURE_COUNT,
    GEOMETRY_FEATURES,
    MASK_FEATURES,
    TYPE_CONFIG,
)

#: Shapes kept per group: the fingerprint and up to this many less one of its members.
KEEP = 12
#: A group's fingerprint is re-chosen from at most this many of its members.
MEDOID_SAMPLE = 60
#: At or below this two descriptors are one bitmap: noise of the batched sums.
_EXACT = 1e-6


class Comparison(Protocol):
    """How two blobs are compared. ``describe`` turns a blob's descriptor (``features``,
    as :func:`calibration_snapshots.blob_features` gives it) into whatever this
    comparison works on; ``stack`` many of those once; ``distances`` from several
    queries to a stack at once — smaller is nearer, in the comparison's own units."""

    name: str
    #: A LIMIT that groups the first mushaf's marks into about a hundred fingerprints.
    default_limit: float

    def describe(self, features: Sequence[float] | np.ndarray) -> np.ndarray: ...

    def stack(self, reps: Sequence[np.ndarray]) -> Any: ...

    def distances(self, bank: Any, reps: Sequence[np.ndarray]) -> np.ndarray: ...


class Descriptor32:
    """:func:`examples.feature_vector` as the old matcher compared it: the blob stretched
    into 32x32 and six geometry numbers (its size against the line's band, its fill, its
    shape, and how far its middle sits above or below the line's peak), half and half,
    plain euclidean distance. The six numbers are what tell a fatha from a kasra of the
    same stroke, and a sukun from the head of a letter."""

    name = "descriptor32"
    #: 100 fingerprints for the first mushaf's pages 3-14 (8,776 typed marks).
    default_limit = 0.27

    def __init__(self) -> None:
        self.root = np.sqrt(
            np.concatenate(
                (
                    np.full(MASK_FEATURES, DEFAULT_CONFIG["mask_weight"]),
                    np.full(GEOMETRY_FEATURES, DEFAULT_CONFIG["geometry_weight"]),
                )
            )
        )

    def describe(self, features: Sequence[float] | np.ndarray) -> np.ndarray:
        vector = np.asarray(features, dtype=np.float64)
        if vector.shape != (FEATURE_COUNT,) or not np.isfinite(vector).all():
            raise ValueError(f"features must contain {FEATURE_COUNT} finite numbers")
        result: np.ndarray = vector * self.root
        return result

    def stack(self, reps: Sequence[np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
        matrix = np.stack(reps) if len(reps) else np.zeros((0, FEATURE_COUNT), dtype=np.float64)
        return matrix, np.einsum("ij,ij->i", matrix, matrix)

    def distances(self, bank: tuple[np.ndarray, np.ndarray], reps: Sequence[np.ndarray]) -> np.ndarray:
        matrix, norms = bank
        queries = np.stack(reps) if len(reps) else np.zeros((0, FEATURE_COUNT), dtype=np.float64)
        squared = np.einsum("ij,ij->i", queries, queries)[:, None] + norms[None, :] - 2.0 * (queries @ matrix.T)
        result: np.ndarray = np.sqrt(np.maximum(squared, 0.0))
        return result


#: Every comparison a mushaf may choose, by name.
COMPARISONS: dict[str, type] = {Descriptor32.name: Descriptor32}
DEFAULT_COMPARISON = Descriptor32.name


def comparison(name: str | None = None) -> Comparison:
    """The comparison called ``name`` — the default when none is named."""
    factory = COMPARISONS.get(name or DEFAULT_COMPARISON)
    if factory is None:
        raise ValueError(f"unknown comparison: {name}")
    instance: Comparison = factory()
    return instance


# ---------------------------------------------------------------------------
# Grouping
# ---------------------------------------------------------------------------
def _walk(method: Comparison, reps: list[np.ndarray], limit: float, start: list[int]) -> tuple[list[int], list[int]]:
    """Each example, in order, joins its nearest fingerprint within ``limit`` or becomes
    one. Returns (fingerprints, the group of each example)."""
    prints = list(start)
    bank = method.stack([reps[i] for i in prints]) if prints else None
    owner: list[int] = []
    for index, rep in enumerate(reps):
        if bank is not None:
            near = method.distances(bank, [rep])[0]
            nearest = int(np.argmin(near))
            if near[nearest] <= limit:
                owner.append(nearest)
                continue
        prints.append(index)
        owner.append(len(prints) - 1)
        bank = method.stack([reps[i] for i in prints])
    return prints, owner


def _typical(method: Comparison, reps: list[np.ndarray], members: list[int]) -> int:
    """The member with the least total distance to the others — of a spread sample of
    a big group."""
    if len(members) <= 2:
        return members[0]
    sample = members[:: max(1, len(members) // MEDOID_SAMPLE)][:MEDOID_SAMPLE]
    matrix = method.distances(method.stack([reps[i] for i in sample]), [reps[i] for i in sample])
    return sample[int(np.argmin(np.minimum(matrix, matrix.T).sum(axis=1)))]


def group(method: Comparison, reps: list[np.ndarray], limit: float) -> list[dict]:
    """One kind's examples in fingerprint groups: ``centre`` (the fingerprint) and
    ``members`` (every example of the group, the nearest to the fingerprint first)."""
    if not reps:
        return []
    first, owner = _walk(method, reps, limit, [])
    members: list[list[int]] = [[] for _ in first]
    for index, group_index in enumerate(owner):
        members[group_index].append(index)
    # Placed once more against the re-chosen fingerprints, in the same order: one now
    # beyond every fingerprint starts a group of its own, which later ones may join.
    final, owner = _walk(method, reps, limit, [_typical(method, reps, own) for own in members])
    groups = []
    for group_index, centre in enumerate(final):
        own = [index for index, found in enumerate(owner) if found == group_index]
        if not own:
            continue
        near = method.distances(method.stack([reps[i] for i in own]), [reps[centre]])[0]
        order = np.argsort(near, kind="stable")
        groups.append(
            {
                "centre": centre,
                "members": [own[i] for i in order],
                "distance": [float(near[i]) for i in order],
            }
        )
    return groups


def kept(groups: list[dict]) -> list[tuple[int, bool, int]]:
    """(example, is the fingerprint, examples its group stands for) for every shape a
    library keeps: each fingerprint, and up to ``KEEP - 1`` members spread from the
    nearest to the farthest — so the kept shapes cover the group's whole reach. A
    member printed pixel for pixel like its fingerprint shows nothing new: skipped."""
    found = []
    for item in groups:
        members, distance = item["members"], item["distance"]
        found.append((item["centre"], True, len(members)))
        picks = sorted(set(np.linspace(0, len(members) - 1, min(KEEP, len(members))).round().astype(int).tolist()))
        found += [(members[i], False, 1) for i in picks if members[i] != item["centre"] and distance[i] > _EXACT]
    return found


# ---------------------------------------------------------------------------
# The library
# ---------------------------------------------------------------------------
@dataclass
class Library:
    """The kept shapes of confirmed examples, stacked for lookup."""

    method: Comparison
    limit: float
    #: Per kept shape: "body" or "mark".
    roles: np.ndarray
    #: Per kept shape: a mark's type ("" when untyped, and for every body).
    kinds: np.ndarray
    #: Per kept shape: the example it is (everything but its descriptor).
    refs: list[dict]
    #: Per kept shape: how many examples it stands for (its group's size for a
    #: fingerprint, 1 for a member).
    copies: list[int]
    #: Per kept shape: what the comparison made of it, and all of them stacked.
    reps: list[np.ndarray] = field(repr=False)
    bank: Any = field(repr=False)
    #: Examples the library was built from, those of them typed marks, and the
    #: fingerprints they made.
    examples: int = 0
    typed_examples: int = 0
    fingerprints: int = 0
    #: Each typed kind's kept shapes, by position.
    _by_type: dict[str, np.ndarray] = field(default_factory=dict, init=False, repr=False)

    def __post_init__(self) -> None:
        typed = (self.roles == "mark") & (self.kinds != "")
        self._by_type = {
            str(kind): np.flatnonzero(typed & (self.kinds == kind)) for kind in sorted(set(self.kinds[typed].tolist()))
        }

    @property
    def types(self) -> list[str]:
        """Every mark type the library knows."""
        return list(self._by_type)

    @property
    def can_propose(self) -> bool:
        """Whether it knows letters and marks both — what a body-or-mark answer needs."""
        return bool((self.roles == "body").any() and (self.roles == "mark").any())

    def _distances(self, features: Sequence[Sequence[float] | np.ndarray]) -> np.ndarray:
        if not len(features) or not len(self.refs):
            return np.zeros((len(features), len(self.refs)))
        return self.method.distances(self.bank, [self.method.describe(entry) for entry in features])

    # ---- body or mark --------------------------------------------------------------
    def roles_of(self, features: Sequence[Sequence[float] | np.ndarray]) -> list[dict]:
        """Body or mark for each blob: the nearer of its nearest kept letter and nearest
        kept mark, with how sure (see the module's docstring) and both shapes."""
        if not self.can_propose:
            return [_no_role() for _ in features]
        distances = self._distances(features)
        bodies, marks = np.flatnonzero(self.roles == "body"), np.flatnonzero(self.roles == "mark")
        answers = []
        for row in distances:
            letter = int(bodies[np.argmin(row[bodies])])
            mark = int(marks[np.argmin(row[marks])])
            near_letter, near_mark = float(row[letter]), float(row[mark])
            role = "mark" if near_mark <= near_letter else "body"
            near, far = min(near_letter, near_mark), max(near_letter, near_mark)
            answers.append(
                {
                    "role": role,
                    "confidence": round((far - near) / (far + near), 4) if far > 0 else 0.0,
                    "reasons": [],
                    "nearest_letter": round(near_letter, 4),
                    "nearest_mark": round(near_mark, 4),
                    "letter": self._ref(letter),
                    "mark": self._ref(mark),
                }
            )
        return answers

    def role_of(self, features: Sequence[float] | np.ndarray) -> dict:
        return self.roles_of([features])[0]

    def nearest(self, features: Sequence[float] | np.ndarray, count: int = 5) -> list[dict]:
        """The ``count`` kept shapes nearest one blob, of either role, nearest first."""
        if not len(self.refs):
            return []
        row = self._distances([features])[0]
        return [
            {**self._ref(int(i)), "distance": round(float(row[i]), 4)} for i in np.argsort(row, kind="stable")[:count]
        ]

    # ---- types -----------------------------------------------------------------------
    def type_scores(self, features: Sequence[Sequence[float] | np.ndarray]) -> list[dict[str, float]]:
        """Every known type's distance to each mark — its nearest kept shape of that
        type; nearer is likelier. Empty when the library knows no type."""
        if not self._by_type:
            return [{} for _ in features]
        distances = self._distances(features)
        return [{kind: round(float(row[where].min()), 4) for kind, where in self._by_type.items()} for row in distances]

    def predict_types(self, features: Sequence[Sequence[float] | np.ndarray]) -> list[dict]:
        """The likeliest type of each mark and how sure — answered as
        :func:`examples.predict_types` answers it: no guess when no kept shape of any
        type lies within ``max_distance``; *sure* when the guess is ``sure_ratio`` times
        nearer than the next type, with ``sure_support`` of its kept shapes that close —
        or when it alone has an exact match."""
        settings = TYPE_CONFIG
        nothing: dict = {
            "subtype": "",
            "confidence": 0.0,
            "support": 0,
            "distance": None,
            "sure": False,
            "runner_up": "",
            "runner_distance": None,
        }
        if not self._by_type:
            return [dict(nothing) for _ in features]
        distances = self._distances(features)
        names = list(self._by_type)
        answers = []
        for row in distances:
            nearest = {name: float(row[where].min()) for name, where in self._by_type.items()}
            support = {
                name: int((row[where] < settings["max_distance"]).sum()) for name, where in self._by_type.items()
            }
            rank = sorted(names, key=lambda name: (nearest[name], -support[name], name))
            close = [name for name in rank if support[name] > 0]
            if not close:
                answers.append({**nothing, "distance": round(min(nearest.values()), 4)})
                continue
            exact = [name for name in close if nearest[name] <= _EXACT]
            winner = exact[0] if len(exact) == 1 else close[0]
            rivals = [name for name in rank if name != winner]
            score = nearest[winner]
            runner = nearest[rivals[0]] if rivals else math.inf
            if len(exact) == 1 or not math.isfinite(runner):
                confidence = 1.0
            else:
                confidence = max(0.0, 1.0 - score / runner) if runner > 0 else 0.0
            clear = score <= settings["sure_ratio"] * runner
            answers.append(
                {
                    "subtype": winner,
                    "confidence": round(confidence, 4),
                    "support": support[winner],
                    "distance": round(score, 4),
                    "sure": len(exact) == 1 or bool(clear and support[winner] >= settings["sure_support"]),
                    "runner_up": rivals[0] if rivals else "",
                    "runner_distance": round(runner, 4) if rivals else None,
                }
            )
        return answers

    def nearest_by_type(
        self, features: Sequence[float] | np.ndarray, *, types: int = 3, per_type: int = 3
    ) -> list[dict]:
        """The evidence behind one mark's guess: the ``types`` nearest types, each with
        its distance and its own ``per_type`` nearest kept shapes — nearest type first."""
        if not self._by_type:
            return []
        row = self._distances([features])[0]
        found = []
        for name, where in self._by_type.items():
            closest = where[np.lexsort((where, row[where]))][:per_type]
            found.append(
                {
                    "subtype": name,
                    "distance": round(float(row[closest[0]]), 4),
                    "examples": [{**self._ref(int(i)), "distance": round(float(row[i]), 4)} for i in closest],
                }
            )
        found.sort(key=lambda entry: (entry["distance"], entry["subtype"]))
        return found[:types]

    # ---- this page's own typing ----------------------------------------------------
    def with_typed(self, samples: list[dict]) -> Library:
        """This library and the given typed marks besides — a page's own marks, kept
        whole and ungrouped, so typing a few on a page teaches the rest at once."""
        if not samples:
            return self
        reps = [*self.reps, *(self.method.describe(sample["features"]) for sample in samples)]
        return replace(
            self,
            roles=np.concatenate((self.roles, np.array(["mark"] * len(samples), dtype=str))),
            kinds=np.concatenate((self.kinds, np.array([sample["subtype"] for sample in samples], dtype=str))),
            refs=[*self.refs, *(_ref_of(sample, fingerprint=False) for sample in samples)],
            copies=[*self.copies, *([1] * len(samples))],
            reps=reps,
            bank=self.method.stack(reps),
        )

    def _ref(self, position: int) -> dict:
        return {
            **self.refs[position],
            "role": str(self.roles[position]),
            "subtype": str(self.kinds[position]),
            "copies": self.copies[position],
        }


def _no_role() -> dict:
    return {"role": None, "confidence": 0.0, "reasons": ["no_examples"]}


def _ref_of(sample: dict, *, fingerprint: bool) -> dict:
    """What identifies an example — never its descriptor — and whether it is its
    group's fingerprint."""
    ref = {key: value for key, value in sample.items() if key not in ("features", "role", "subtype")}
    ref["fingerprint"] = fingerprint
    return ref


def build_library(samples: list[dict], *, method: Comparison | None = None, limit: float | None = None) -> Library:
    """A library from confirmed examples — each ``features``, ``role`` ("body" or
    "mark"), ``subtype`` (a mark's type, or "") and whatever identifies it
    (``snapshot_id``, ``blob_id``, ``page_number``, ``line_number`` …), in page order.

    Grouped kind by kind: the letters, each mark type, and the untyped marks."""
    method = method or comparison()
    limit = method.default_limit if limit is None else limit
    if limit <= 0:
        raise ValueError("limit must be positive")
    kinds: dict[tuple[str, str], list[dict]] = {}
    for sample in samples:
        role = sample.get("role")
        if role not in ("body", "mark"):
            raise ValueError("role must be body or mark")
        kind = (sample.get("subtype") or "") if role == "mark" else ""
        kinds.setdefault((role, kind), []).append(sample)
    roles, names, refs, copies, reps, prints = [], [], [], [], [], 0
    for (role, kind), own in kinds.items():
        described = [method.describe(sample["features"]) for sample in own]
        groups = group(method, described, limit)
        prints += len(groups)
        for index, fingerprint, count in kept(groups):
            roles.append(role)
            names.append(kind)
            refs.append(_ref_of(own[index], fingerprint=fingerprint))
            copies.append(count)
            reps.append(described[index])
    return Library(
        method=method,
        limit=limit,
        roles=np.array(roles, dtype=str),
        kinds=np.array(names, dtype=str),
        refs=refs,
        copies=copies,
        reps=reps,
        bank=method.stack(reps),
        examples=len(samples),
        typed_examples=sum(1 for sample in samples if sample["role"] == "mark" and sample.get("subtype")),
        fingerprints=prints,
    )
