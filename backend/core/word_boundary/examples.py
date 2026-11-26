"""Pure nearest-example proposals for shadow evaluation, never parser costs.

Contract: ``feature_vector`` returns 1,030 floats (1,024 raster, six geometry).
``build_index`` returns JSON data with exact, same-role descriptor groups in
``samples``; each group's ``refs`` preserves every input's metadata. Opposite
labels are never merged. ``predict`` returns at most five descriptor groups,
with a surviving reference's metadata and all non-excluded refs per neighbor.
Excluded snapshots cannot supply support, provenance, or opposite evidence.

Defaults are conservative starting settings, NOT empirically validated
calibration. Confidence is a gate-strength score, not a probability. This module
does not activate predictions, mutate inputs, access storage, or blend costs.
"""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

INDEX_VERSION = 1
FEATURE_VERSION = 1
MASK_SIZE = 32
MASK_FEATURES = MASK_SIZE * MASK_SIZE
GEOMETRY_FEATURES = 6
FEATURE_COUNT = MASK_FEATURES + GEOMETRY_FEATURES
DEFAULT_CONFIG = {
    "version": 1,
    "max_neighbors": 5,
    "min_support": 5,
    "min_distinct_pages": 2,
    "max_distance": 0.15,
    "min_margin": 0.10,
    "max_distance_ratio": 0.5,
    "mask_weight": 0.5,
    "geometry_weight": 0.5,
    "chunk_size": 256,
}


def feature_vector(mask: np.ndarray, *, w: int, h: int, area: int, band_height: int, peak_offset: float) -> list[float]:
    """Describe an isolated cropped bool glyph; ``peak_offset`` is in pixels.

    Area-resample the glyph, preserving aspect ratio, onto a centered 32x32
    canvas. Raster / 32 has norm <= 1; geometry / sqrt(6) has norm <= 1.
    Geometry is bounded width/band, height/band, area/band**2, ink density,
    aspect w/(w+h), and signed offset/band, in that order. Positive unbounded
    ratios use r/(1+r); the signed offset uses r/(1+abs(r)).
    """
    if not isinstance(mask, np.ndarray) or mask.dtype != np.bool_ or mask.ndim != 2:
        raise ValueError("mask must be a two-dimensional boolean ndarray")
    for name, value in (("w", w), ("h", h), ("area", area), ("band_height", band_height)):
        if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, np.integer)) or value <= 0:
            raise ValueError(f"{name} must be a positive integer")
    if mask.shape != (h, w) or int(np.count_nonzero(mask)) != area:
        raise ValueError("mask shape and ink count must match w, h, and area")
    if not math.isfinite(peak_offset):
        raise ValueError("peak_offset must be finite")
    w, h, area, band_height = map(int, (w, h, area, band_height))
    scale = MASK_SIZE / max(w, h)
    out_w, out_h = max(1, round(w * scale)), max(1, round(h * scale))

    def weights(source: int, target: int) -> np.ndarray:
        edges = np.linspace(0, source, target + 1)
        pixels = np.arange(source)
        overlap = np.minimum(edges[1:, None], pixels + 1) - np.maximum(edges[:-1, None], pixels)
        result: np.ndarray = np.maximum(overlap, 0) / (source / target)
        return result

    raster = np.zeros((MASK_SIZE, MASK_SIZE), dtype=np.float64)
    x, y = (MASK_SIZE - out_w) // 2, (MASK_SIZE - out_h) // 2
    raster[y : y + out_h, x : x + out_w] = weights(h, out_h) @ mask @ weights(w, out_w).T
    geometry = np.array(
        [
            w / (band_height + w),
            h / (band_height + h),
            area / (band_height**2 + area),
            area / (w * h),
            w / (w + h),
            peak_offset / (band_height + abs(peak_offset)),
        ],
        dtype=np.float64,
    )
    descriptor: list[float] = np.concatenate(
        (raster.ravel() / MASK_SIZE, geometry / math.sqrt(GEOMETRY_FEATURES))
    ).tolist()
    return descriptor


def _config(config: dict | None) -> dict:
    settings = dict(DEFAULT_CONFIG)
    if config is not None:
        unknown = config.keys() - settings.keys()
        if unknown:
            raise ValueError(f"unknown classifier settings: {sorted(unknown)}")
        settings.update(config)
    if type(settings["version"]) is not int or settings["version"] != DEFAULT_CONFIG["version"]:
        raise ValueError("unsupported config version")
    for key in ("max_neighbors", "min_support", "min_distinct_pages", "chunk_size"):
        if type(settings[key]) is not int or settings[key] < 1:
            raise ValueError(f"{key} must be a positive integer")
    if not settings["min_distinct_pages"] <= settings["min_support"] <= settings["max_neighbors"] <= 5:
        raise ValueError("require min_distinct_pages <= min_support <= max_neighbors <= 5")
    for key in ("max_distance", "min_margin", "max_distance_ratio", "mask_weight", "geometry_weight"):
        value = settings[key]
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value <= 0:
            raise ValueError(f"{key} must be positive and finite")
    if settings["max_distance_ratio"] >= 1:
        raise ValueError("max_distance_ratio must be less than one")
    if not math.isclose(settings["mask_weight"] + settings["geometry_weight"], 1.0):
        raise ValueError("mask_weight and geometry_weight must sum to one")
    return settings


def _features(features: Sequence[float] | np.ndarray) -> np.ndarray:
    try:
        vector = np.asarray(features, dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise ValueError("features must be numeric") from exc
    if vector.shape != (FEATURE_COUNT,) or not np.isfinite(vector).all():
        raise ValueError(f"features must contain {FEATURE_COUNT} finite numbers")
    return vector


def build_index(samples: list[dict], config: dict | None = None) -> dict:
    """Group exact descriptors per role, retaining refs without inflating support.

    Reusing a sample_id for differing metadata or features is rejected, because
    it would make independent support and snapshot exclusion ambiguous. Exact
    repeats retain their refs but still count as only one descriptor group.
    Additional metadata must be JSON serializable; inputs are copied.
    """
    settings = _config(config)
    groups: dict[tuple, dict] = {}
    seen_ids: dict[str, str] = {}
    for sample in samples:
        vector = _features(sample["features"])
        metadata = {key: value for key, value in sample.items() if key != "features"}
        for key in ("sample_id", "snapshot_id"):
            if not isinstance(metadata.get(key), str) or not metadata[key]:
                raise ValueError(f"{key} must be a nonempty string")
        for key in ("blob_id", "page_number", "line_number"):
            if key not in metadata or metadata[key] is None:
                raise ValueError(f"{key} is required")
        if metadata.get("role") not in ("body", "mark"):
            raise ValueError("role must be body or mark")
        if type(metadata["page_number"]) is not int or metadata["page_number"] < 1:
            raise ValueError("page_number must be a positive integer")
        try:
            encoded = json.dumps({**metadata, "features": vector.tolist()}, allow_nan=False, sort_keys=True)
            copied = json.loads(encoded)
        except (TypeError, ValueError) as exc:
            raise ValueError("sample metadata must be finite JSON data") from exc
        sample_id = metadata["sample_id"]
        if sample_id in seen_ids and seen_ids[sample_id] != encoded:
            raise ValueError(f"conflicting sample_id: {sample_id}")
        seen_ids[sample_id] = encoded
        # Float tuples make +0 and -0 equal as well as avoiding lossy rounding.
        group_key = (metadata["role"], tuple(vector))
        features = copied.pop("features")
        if group_key not in groups:
            groups[group_key] = {"role": metadata["role"], "features": features, "refs": []}
        groups[group_key]["refs"].append(copied)
    return {
        "version": INDEX_VERSION,
        "feature_version": FEATURE_VERSION,
        "feature_count": FEATURE_COUNT,
        "mode": "shadow",
        "validated": False,
        "config": settings,
        "sample_count": len(samples),
        "unique_count": len(groups),
        "samples": list(groups.values()),
    }


def _page_count(neighbors: list[dict]) -> int:
    # Match groups to distinct provenance pages. Counting the union would allow
    # a single duplicated glyph to manufacture all required page diversity.
    assigned: dict[int, int] = {}

    def assign(group: int, visited: set[int]) -> bool:
        for page in sorted({ref["page_number"] for ref in neighbors[group]["refs"]}):
            if page in visited:
                continue
            visited.add(page)
            if page not in assigned or assign(assigned[page], visited):
                assigned[page] = group
                return True
        return False

    return sum(assign(group, set()) for group in range(len(neighbors)))


@dataclass(frozen=True)
class PreparedIndex:
    """An index with its descriptors stacked once, for many lookups.

    ``build_index`` output is JSON — right for reports and tests, and far too slow
    to search directly: every lookup would convert every stored descriptor back
    from a list of 1,030 floats. A page holds about a thousand blobs, so the
    matrix is built here once per page and each lookup is one vectorised pass.
    """

    settings: dict
    weights: np.ndarray
    matrix: np.ndarray
    roles: list[str]
    #: ``roles`` as a boolean array, so "nearest of each role" is a mask.
    is_body: np.ndarray
    refs: list[list[dict]]
    #: Snapshot ids per group, so exclusion is a set test rather than a scan.
    snapshots: list[frozenset[str]]


def prepare(index: dict) -> PreparedIndex:
    """Validate an index once and stack its descriptors for lookup."""
    if (
        index.get("version") != INDEX_VERSION
        or index.get("feature_version") != FEATURE_VERSION
        or index.get("feature_count") != FEATURE_COUNT
    ):
        raise ValueError("unsupported index or feature version")
    settings = _config(index["config"])
    entries = index["samples"]
    matrix = (
        np.stack([_features(entry["features"]) for entry in entries])
        if entries
        else np.zeros((0, FEATURE_COUNT), dtype=np.float64)
    )
    return PreparedIndex(
        settings=settings,
        weights=np.concatenate(
            (
                np.full(MASK_FEATURES, settings["mask_weight"]),
                np.full(GEOMETRY_FEATURES, settings["geometry_weight"]),
            )
        ),
        matrix=matrix,
        roles=[entry["role"] for entry in entries],
        is_body=np.array([entry["role"] == "body" for entry in entries], dtype=bool),
        refs=[entry["refs"] for entry in entries],
        snapshots=[frozenset(ref["snapshot_id"] for ref in entry["refs"]) for entry in entries],
    )


def build_prepared(samples: list[dict], config: dict | None = None) -> PreparedIndex:
    """``prepare(build_index(samples, config))`` without the JSON round trip.

    ``build_index`` serialises every descriptor to check it and copy it — right for
    an index that is stored or reported, and wasteful for one built to be searched
    and thrown away. Exact duplicates still collapse into one group per role, with
    every sample's metadata kept on the group, so support is counted the same way.
    """
    settings = _config(config)
    groups: dict[tuple[str, bytes], int] = {}
    rows: list[np.ndarray] = []
    roles: list[str] = []
    refs: list[list[dict]] = []
    for sample in samples:
        vector = _features(sample["features"])
        role = sample.get("role")
        if role not in ("body", "mark"):
            raise ValueError("role must be body or mark")
        metadata = {key: value for key, value in sample.items() if key != "features"}
        # +0.0 and -0.0 differ in bytes; normalise so they share a group as they
        # do in ``build_index``.
        key = (role, (vector + 0.0).tobytes())
        if key in groups:
            refs[groups[key]].append(metadata)
            continue
        groups[key] = len(rows)
        rows.append(vector)
        roles.append(role)
        refs.append([metadata])
    return PreparedIndex(
        settings=settings,
        weights=np.concatenate(
            (
                np.full(MASK_FEATURES, settings["mask_weight"]),
                np.full(GEOMETRY_FEATURES, settings["geometry_weight"]),
            )
        ),
        matrix=np.stack(rows) if rows else np.zeros((0, FEATURE_COUNT), dtype=np.float64),
        roles=roles,
        is_body=np.array([role == "body" for role in roles], dtype=bool),
        refs=refs,
        snapshots=[frozenset(ref["snapshot_id"] for ref in group) for group in refs],
    )


def predict(features: Sequence[float] | np.ndarray, index: dict, exclude_snapshot_ids: set[str] | None = None) -> dict:
    """One lookup against a JSON index. Prepare once and use ``predict_prepared``
    when looking up more than a handful of blobs."""
    return predict_prepared(features, prepare(index), exclude_snapshot_ids)


def predict_prepared(
    features: Sequence[float] | np.ndarray, prepared: PreparedIndex, exclude_snapshot_ids: set[str] | None = None
) -> dict:
    """Find <=5 nearest unique groups with one NumPy-vectorized pass.

    All returned neighbors must agree, be strictly closer than max_distance,
    meet independent support/page requirements, and have an observed opposite
    farther than min_margin and max_distance_ratio allow. Missing opposite
    evidence abstains. Distances use the weighted Euclidean descriptor blocks.
    """
    query = _features(features)
    settings = prepared.settings
    excluded = exclude_snapshot_ids or set()
    if excluded:
        eligible = [not group <= excluded for group in prepared.snapshots]
        positions = np.flatnonzero(eligible)
    else:
        positions = np.arange(len(prepared.roles))
    nearest_role = {"body": math.inf, "mark": math.inf}
    best: list[tuple[float, int]] = []
    if positions.size:
        delta = prepared.matrix[positions] - query
        distances = np.sqrt(np.einsum("ij,j,ij->i", delta, prepared.weights, delta))
        bodies = prepared.is_body[positions]
        for role, mask in (("body", bodies), ("mark", ~bodies)):
            if mask.any():
                nearest_role[role] = float(distances[mask].min())
        # Ties broken by position, as the chunked scan this replaces did.
        order = np.lexsort((positions, distances))[: settings["max_neighbors"]]
        best = [(float(distances[i]), int(positions[i])) for i in order]
    eligible_count = int(positions.size)
    neighbors = []
    for distance, position in best:
        refs = [ref for ref in prepared.refs[position] if ref["snapshot_id"] not in excluded]
        neighbors.append({**refs[0], "role": prepared.roles[position], "distance": distance, "refs": refs})
    candidate = neighbors[0]["role"] if neighbors else None
    unanimous = bool(neighbors) and all(neighbor["role"] == candidate for neighbor in neighbors)
    support = len(neighbors) if unanimous else 0
    pages = _page_count(neighbors) if unanimous else 0
    farthest = neighbors[-1]["distance"] if neighbors else None
    nearest_opposite = nearest_role["mark" if candidate == "body" else "body"] if candidate else math.inf
    opposite = nearest_opposite if math.isfinite(nearest_opposite) else None
    margin = opposite - farthest if opposite is not None and farthest is not None else None
    ratio = farthest / opposite if opposite is not None and opposite > 0 and farthest is not None else None
    failures = []
    if not neighbors:
        failures.append("no_examples")
    elif not unanimous:
        failures.append("mixed_neighbors")
    if support < settings["min_support"]:
        failures.append("insufficient_support")
    if pages < settings["min_distinct_pages"]:
        failures.append("insufficient_pages")
    if farthest is not None and farthest >= settings["max_distance"]:
        failures.append("too_far")
    if opposite is None:
        failures.append("missing_opposite")
    elif margin is None or margin <= settings["min_margin"]:
        failures.append("insufficient_margin")
    if opposite is not None and (ratio is None or ratio >= settings["max_distance_ratio"]):
        failures.append("insufficient_ratio")
    confidence = 0.0
    if not failures:
        confidence = min(
            1.0 - farthest / settings["max_distance"],
            1.0 - settings["min_margin"] / margin,
            1.0 - ratio / settings["max_distance_ratio"],
        )
    # Copy nested provenance too: callers can annotate results without changing
    # subsequent predictions or the persistent index.
    copied: dict = json.loads(
        json.dumps(
            {
                "proposed_role": candidate if not failures else None,
                "neighbors": neighbors,
                "confidence": confidence,
                "confidence_kind": "unvalidated_gate_strength",
                "support_count": support,
                "distinct_pages": pages,
                "eligible_count": eligible_count,
                "nearest_opposite_distance": opposite,
                "margin": margin,
                "distance_ratio": ratio,
                "reasons": failures,
                "mode": "shadow",
                "validated": False,
                "config": settings,
            },
            allow_nan=False,
        )
    )
    return copied


# ---------------------------------------------------------------------------
# Mark types
# ---------------------------------------------------------------------------
#: A best guess for every mark's type — fatha, kasra, sukun … — shown to a person to
#: accept or correct. Never a role lock, and never a training label until accepted.
#: Deliberately looser than the role gate: a wrong guess costs one correction, a
#: missing one costs typing the mark by hand.
#:
#: **Each type is judged by its own nearest examples**, not by a vote of the nearest
#: examples overall. Until 2026-09-29 the seven nearest voted, and a common type won
#: by numbers: a page opened with one madda and forty-four fathas typed saw every
#: madda guessed fatha, because a fatha's stroke stretched to the 32-pixel square is
#: nearly a madda's and the fathas filled the seven seats. Replaying pages 2 to 8 of the
#: first mushaf as each was first opened: maddas guessed wrong 10 → 1, sure-and-wrong
#: guesses of any type 36 → 30 (of 4,626). Weighting size more was tried and made it
#: worse — this mushaf's fathas run from 17 to 58 px wide.
TYPE_CONFIG = {
    #: How many of a type's nearest examples its distance is the mean of.
    "per_type": 3,
    #: Examples further than this say nothing about the mark: no guess at all.
    "max_distance": 0.35,
    #: A guess is "sure" when its type is this much nearer than the next type…
    "sure_ratio": 0.85,
    #: …with at least this many of its examples within ``max_distance`` — or when it
    #: is the only type with an exact match.
    "sure_support": 2,
}
#: At or below this the two descriptors are one bitmap: noise of the batched sums.
_EXACT = 1e-6
#: Marks compared per pass, which bounds the distance matrix at this many rows.
_CHUNK = 256


@dataclass(frozen=True)
class TypeIndex:
    """Typed marks, one row per exact (type, descriptor) group, stacked for lookup.

    Only marks a person typed belong here, and only their types are compared: the
    body-or-mark question is settled before a type is asked for.
    """

    weights: np.ndarray
    matrix: np.ndarray
    types: list[str]
    #: Snapshot ids per group, so a lookup can leave a page's own examples out.
    snapshots: list[frozenset[str]]
    #: Where each group's copies were typed — ``snapshot_id`` and ``blob_id`` — so
    #: an explanation can show them.
    refs: list[list[dict]]
    #: ``matrix`` scaled by the square roots of ``weights``, and its rows' squared
    #: norms: a weighted distance to every group is then one matrix product.
    scaled: np.ndarray
    norms: np.ndarray


def build_type_index(samples: list[dict]) -> TypeIndex:
    """Stack typed marks — each ``features``, ``subtype``, ``snapshot_id`` and
    optionally ``blob_id`` — for lookup.

    Identical descriptors of one type collapse into one group: a printed mushaf repeats
    a glyph pixel for pixel, and a hundred copies of one fatha are one piece of evidence,
    not a hundred. The same descriptor typed two ways stays two groups — a disagreement,
    which no exact match can then settle.
    """
    settings = _config(None)
    groups: dict[tuple[str, bytes], int] = {}
    rows: list[np.ndarray] = []
    types: list[str] = []
    snapshots: list[set[str]] = []
    refs: list[list[dict]] = []
    for sample in samples:
        vector = _features(sample["features"])
        subtype = sample.get("subtype")
        if not isinstance(subtype, str) or not subtype:
            raise ValueError("subtype must be a nonempty string")
        snapshot_id = str(sample["snapshot_id"])
        ref = {"snapshot_id": snapshot_id, "blob_id": sample.get("blob_id")}
        key = (subtype, (vector + 0.0).tobytes())
        if key in groups:
            snapshots[groups[key]].add(snapshot_id)
            refs[groups[key]].append(ref)
            continue
        groups[key] = len(rows)
        rows.append(vector)
        types.append(subtype)
        snapshots.append({snapshot_id})
        refs.append([ref])
    weights = np.concatenate(
        (
            np.full(MASK_FEATURES, settings["mask_weight"]),
            np.full(GEOMETRY_FEATURES, settings["geometry_weight"]),
        )
    )
    matrix = np.stack(rows) if rows else np.zeros((0, FEATURE_COUNT), dtype=np.float64)
    scaled = matrix * np.sqrt(weights)
    return TypeIndex(
        weights=weights,
        matrix=matrix,
        types=types,
        snapshots=[frozenset(group) for group in snapshots],
        refs=refs,
        scaled=scaled,
        norms=np.einsum("ij,ij->i", scaled, scaled),
    )


def _type_distances(queries: np.ndarray, index: TypeIndex, eligible: np.ndarray) -> np.ndarray:
    """Weighted distance from each query to each group; excluded groups are infinitely far."""
    scaled = queries * np.sqrt(index.weights)
    squared = np.einsum("ij,ij->i", scaled, scaled)[:, None] + index.norms[None, :] - 2.0 * (scaled @ index.scaled.T)
    distances: np.ndarray = np.sqrt(np.maximum(squared, 0.0))
    distances[:, ~eligible] = np.inf
    return distances


def _by_type(
    distances: np.ndarray, index: TypeIndex, names: list[str], per_type: int, max_distance: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per query and type: the mean of that type's nearest distances, the nearest one,
    and how many of them fall within ``max_distance``."""
    rows = distances.shape[0]
    means = np.full((rows, len(names)), np.inf)
    nearest = np.full((rows, len(names)), np.inf)
    support = np.zeros((rows, len(names)), dtype=int)
    types = np.array(index.types)
    for column, name in enumerate(names):
        own = distances[:, types == name]
        count = min(per_type, own.shape[1])
        closest = np.sort(np.partition(own, count - 1, axis=1)[:, :count] if own.shape[1] > count else own, axis=1)
        finite = np.isfinite(closest)
        kept = finite.sum(axis=1)
        total = np.where(finite, closest, 0.0).sum(axis=1)
        means[:, column] = np.where(kept > 0, total / np.maximum(kept, 1), np.inf)
        nearest[:, column] = closest[:, 0]
        support[:, column] = (closest < max_distance).sum(axis=1)
    return means, nearest, support


def predict_types(
    features: Sequence[Sequence[float] | np.ndarray],
    index: TypeIndex,
    exclude_snapshot_ids: set[str] | None = None,
    config: dict | None = None,
) -> list[dict]:
    """The most likely type of each of several marks, and how sure — in one pass.

    Every type is scored by the mean distance to its own ``per_type`` nearest groups,
    and the nearest-scoring type is the guess — provided one of its examples lies
    within ``max_distance``. So a type typed a thousand times cannot outvote a closer
    few of a rare one, as a vote of the nearest examples overall would. A type with
    fewer examples is scored on the ones it has, but is not *sure* until
    ``sure_support`` of them are close.

    Each answer holds ``subtype`` ("" when no typed example is close enough),
    ``distance`` (to the guessed type's nearest example; to the nearest example of any
    type when there is no guess), ``support`` (that type's close examples),
    ``runner_up`` and ``runner_distance`` (the next type and its score),
    ``confidence`` (how much nearer the guess scores than the runner-up: 0 a tie, 1 no
    rival — agreement among the examples, not a probability) and ``sure``.
    """
    settings = {**TYPE_CONFIG, **(config or {})}
    queries = np.stack([_features(entry) for entry in features]) if len(features) else np.zeros((0, FEATURE_COUNT))
    nothing: dict = {
        "subtype": "",
        "confidence": 0.0,
        "support": 0,
        "distance": None,
        "sure": False,
        "runner_up": "",
        "runner_distance": None,
    }
    excluded = exclude_snapshot_ids or set()
    eligible = np.array([not group <= excluded for group in index.snapshots], dtype=bool)
    if not eligible.any():
        return [dict(nothing) for _ in range(len(queries))]
    names = sorted(set(index.types))
    max_distance = settings["max_distance"]
    answers: list[dict] = []
    for start in range(0, len(queries), _CHUNK):
        distances = _type_distances(queries[start : start + _CHUNK], index, eligible)
        means, nearest, support = _by_type(distances, index, names, settings["per_type"], max_distance)
        for row in range(distances.shape[0]):
            # Ties go to the better-supported type, then the name — never to set order.
            rank = sorted(
                (column for column in range(len(names)) if np.isfinite(means[row, column])),
                key=lambda column: (means[row, column], -support[row, column], names[column]),
            )
            # Only a type with an example close enough may be the guess.
            close = [column for column in rank if support[row, column] > 0]
            if not close:
                answers.append({**nothing, "distance": round(float(nearest[row].min()), 4)})
                continue
            exact = [column for column in close if nearest[row, column] <= _EXACT]
            winner = exact[0] if len(exact) == 1 else close[0]
            rivals = [column for column in rank if column != winner]
            score = float(means[row, winner])
            runner = float(means[row, rivals[0]]) if rivals else math.inf
            if len(exact) == 1 or not math.isfinite(runner):
                confidence = 1.0
            else:
                confidence = max(0.0, 1.0 - score / runner) if runner > 0 else 0.0
            clear = score <= settings["sure_ratio"] * runner
            answers.append(
                {
                    "subtype": names[winner],
                    "confidence": round(confidence, 4),
                    "support": int(support[row, winner]),
                    "distance": round(float(nearest[row, winner]), 4),
                    "sure": len(exact) == 1 or bool(clear and support[row, winner] >= settings["sure_support"]),
                    "runner_up": names[rivals[0]] if rivals else "",
                    "runner_distance": round(runner, 4) if rivals else None,
                }
            )
    return answers


def type_scores(
    features: Sequence[Sequence[float] | np.ndarray],
    index: TypeIndex,
    exclude_snapshot_ids: set[str] | None = None,
    config: dict | None = None,
) -> list[dict[str, float]]:
    """Every type's score for each of several marks: the mean distance to its own
    ``per_type`` nearest groups, as :func:`predict_types` ranks them — nearer is
    likelier. Types without an eligible example are left out, so an empty dict means
    the index knows nothing to compare with.

    For a caller that weighs the matcher against other evidence — the word's text —
    rather than taking its single best guess.
    """
    settings = {**TYPE_CONFIG, **(config or {})}
    queries = np.stack([_features(entry) for entry in features]) if len(features) else np.zeros((0, FEATURE_COUNT))
    excluded = exclude_snapshot_ids or set()
    eligible = np.array([not group <= excluded for group in index.snapshots], dtype=bool)
    if not eligible.any():
        return [{} for _ in range(len(queries))]
    names = sorted({kind for kind, keep in zip(index.types, eligible, strict=True) if keep})
    answers: list[dict[str, float]] = []
    for start in range(0, len(queries), _CHUNK):
        distances = _type_distances(queries[start : start + _CHUNK], index, eligible)
        means, _, _ = _by_type(distances, index, names, settings["per_type"], settings["max_distance"])
        for row in range(distances.shape[0]):
            finite = np.isfinite(means[row])
            answers.append(
                {name: round(float(means[row, column]), 4) for column, name in enumerate(names) if finite[column]}
            )
    return answers


def predict_type(
    features: Sequence[float] | np.ndarray,
    index: TypeIndex,
    exclude_snapshot_ids: set[str] | None = None,
    config: dict | None = None,
) -> dict:
    """The most likely type of one mark, and how sure — see :func:`predict_types`."""
    return predict_types([features], index, exclude_snapshot_ids, config)[0]


def nearest_by_type(
    features: Sequence[float] | np.ndarray,
    index: TypeIndex,
    *,
    types: int = 3,
    per_type: int = 3,
    exclude_snapshot_ids: set[str] | None = None,
) -> list[dict]:
    """The evidence behind one mark's guess: the ``types`` nearest-scoring types, each
    with its score and its own ``per_type`` nearest groups — nearest type first.

    Each example is its group's first reference, with ``distance`` and ``copies``.
    """
    excluded = exclude_snapshot_ids or set()
    eligible = np.array([not group <= excluded for group in index.snapshots], dtype=bool)
    if not eligible.any():
        return []
    distances = _type_distances(_features(features)[None, :], index, eligible)[0]
    found = []
    kinds = np.array(index.types)
    for name in sorted(set(index.types)):
        positions = np.flatnonzero((kinds == name) & np.isfinite(distances))
        if not positions.size:
            continue
        closest = positions[np.lexsort((positions, distances[positions]))][:per_type]
        found.append(
            {
                "subtype": name,
                "distance": round(float(distances[closest].mean()), 4),
                "examples": [
                    {
                        **index.refs[position][0],
                        "distance": round(float(distances[position]), 4),
                        "copies": len(index.refs[position]),
                    }
                    for position in closest
                ],
            }
        )
    found.sort(key=lambda entry: (entry["distance"], entry["subtype"]))
    return found[:types]
