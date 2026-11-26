"""The stored fingerprint set changed a page at a time. No database."""

import math
import unittest

import numpy as np

from core.word_boundary.examples import MASK_FEATURES
from core.word_boundary.library import build_library, comparison, group_examples
from core.word_boundary.library_updates import (
    KEPT_PER_GROUP,
    KeptShape,
    ShapeGroup,
    build_library_from_groups,
    convert_library_to_groups,
    drop_shape_from_group,
    hide_shapes_of_page,
    keep_spread_shapes,
    place_examples_in_groups,
)


def descriptor(value=0.0):
    """Features whose weighted distance to another's is exactly the difference of their
    values, so a test can say how far apart two shapes are."""
    return np.array([value / 32] * MASK_FEATURES + [value / math.sqrt(6)] * 6)


def shape(number, value, *, distance=0.0, page=1, looks_right=False):
    return KeptShape(
        snapshot_id=f"snapshot-{number}",
        blob_id=number,
        page_number=page,
        line_number=1,
        revision_id=None,
        features=descriptor(value),
        distance=distance,
        looks_right=looks_right,
    )


def sample(number, value, *, subtype="fatha", page=1):
    return {
        "features": descriptor(value),
        "role": "mark",
        "key": f":{subtype}",
        "snapshot_id": f"snapshot-{number}",
        "blob_id": number,
        "page_number": page,
        "line_number": 1,
        "revision_id": None,
    }


class PlacingTests(unittest.TestCase):
    def test_an_example_joins_its_nearest_fingerprint_within_the_limit(self):
        groups = [ShapeGroup("mark", ":fatha", shape(0, 0.0)), ShapeGroup("mark", ":fatha", shape(1, 1.0))]
        (placed,) = place_examples_in_groups(groups, [("mark", ":fatha", shape(2, 0.9))], comparison(), 0.27)
        self.assertIs(placed.group, groups[1])
        self.assertFalse(placed.started_group)
        self.assertAlmostEqual(placed.example.distance, 0.1)
        self.assertEqual([kept.key for kept in groups[1].kept], [("snapshot-2", 2)])

    def test_an_example_beyond_every_fingerprint_starts_a_group_the_next_ones_may_join(self):
        groups = [ShapeGroup("mark", ":fatha", shape(0, 0.0))]
        placements = place_examples_in_groups(
            groups, [("mark", ":fatha", shape(1, 5.0)), ("mark", ":fatha", shape(2, 5.1))], comparison(), 0.27
        )
        self.assertEqual([placement.started_group for placement in placements], [True, False])
        self.assertEqual(len(groups), 2)
        self.assertIs(placements[1].group, groups[1])

    def test_an_example_only_joins_a_group_of_its_own_kind(self):
        groups = [ShapeGroup("mark", ":kasra", shape(0, 0.0))]
        (placed,) = place_examples_in_groups(groups, [("mark", ":fatha", shape(1, 0.0))], comparison(), 0.27)
        self.assertTrue(placed.started_group)
        self.assertEqual([group.kind for group in groups], [("mark", ":kasra"), ("mark", ":fatha")])

    def test_placing_never_moves_a_fingerprint(self):
        groups = [ShapeGroup("mark", ":fatha", shape(0, 0.0))]
        place_examples_in_groups(
            groups, [("mark", ":fatha", shape(i, 0.01 * i)) for i in range(1, 30)], comparison(), 0.27
        )
        self.assertEqual(groups[0].fingerprint.key, ("snapshot-0", 0))


class SpreadTests(unittest.TestCase):
    def full_group(self):
        group = ShapeGroup("mark", ":fatha", shape(0, 0.0))
        group.kept = [shape(i, 0.0, distance=0.02 * i) for i in range(1, KEPT_PER_GROUP + 1)]
        return group

    def test_a_copy_of_the_fingerprint_is_not_kept(self):
        group = ShapeGroup("mark", ":fatha", shape(0, 0.0))
        self.assertFalse(keep_spread_shapes(group, shape(1, 0.0, distance=0.0)))
        self.assertEqual(group.kept, [])

    def test_shapes_are_kept_while_there_is_room_nearest_first(self):
        group = ShapeGroup("mark", ":fatha", shape(0, 0.0))
        for number, distance in ((1, 0.2), (2, 0.1)):
            self.assertTrue(keep_spread_shapes(group, shape(number, 0.0, distance=distance)))
        self.assertEqual([kept.blob_id for kept in group.kept], [2, 1])

    def test_a_full_group_keeps_its_farthest_shape_and_drops_the_most_crowded(self):
        group = self.full_group()
        farthest = group.kept[-1]
        # 0.031 crowds 0.02 and 0.04 most: one of the three closest together goes.
        self.assertTrue(keep_spread_shapes(group, shape(50, 0.0, distance=0.5)))
        self.assertEqual(len(group.kept), KEPT_PER_GROUP)
        self.assertIn(farthest, group.kept)
        self.assertEqual(group.kept[-1].blob_id, 50)

    def test_a_newcomer_that_adds_least_is_not_kept(self):
        group = self.full_group()
        before = [kept.key for kept in group.kept]
        self.assertFalse(keep_spread_shapes(group, shape(50, 0.0, distance=0.0401)))
        self.assertEqual([kept.key for kept in group.kept], before)

    def test_a_looks_right_shape_is_never_dropped(self):
        group = ShapeGroup("mark", ":fatha", shape(0, 0.0))
        group.kept = [shape(i, 0.0, distance=0.02 * i, looks_right=True) for i in range(1, KEPT_PER_GROUP + 1)]
        self.assertFalse(keep_spread_shapes(group, shape(50, 0.0, distance=0.031)))
        self.assertTrue(all(kept.looks_right for kept in group.kept))


class DroppingTests(unittest.TestCase):
    def test_a_dropped_fingerprint_hands_over_to_its_nearest_kept_shape(self):
        group = ShapeGroup("mark", ":fatha", shape(0, 0.0), [shape(1, 0.1, distance=0.1), shape(2, 0.3, distance=0.3)])
        groups = [group]
        drop_shape_from_group(groups, group, ("snapshot-0", 0), comparison())
        self.assertEqual(group.fingerprint.key, ("snapshot-1", 1))
        self.assertEqual(group.fingerprint.distance, 0.0)
        self.assertAlmostEqual(group.kept[0].distance, 0.2)  # measured again from the new fingerprint

    def test_a_group_with_nothing_left_goes(self):
        group = ShapeGroup("mark", ":fatha", shape(0, 0.0))
        groups = [group]
        drop_shape_from_group(groups, group, ("snapshot-0", 0), comparison())
        self.assertEqual(groups, [])

    def test_a_kept_shape_just_leaves(self):
        group = ShapeGroup("mark", ":fatha", shape(0, 0.0), [shape(1, 0.1, distance=0.1)])
        drop_shape_from_group([group], group, ("snapshot-1", 1), comparison())
        self.assertEqual((group.fingerprint.blob_id, group.kept), (0, []))


class LookupTests(unittest.TestCase):
    def test_the_groups_answer_like_a_library(self):
        groups = [
            ShapeGroup("mark", ":fatha", shape(0, 0.0), [shape(1, 0.1, distance=0.1)]),
            ShapeGroup("mark", ":kasra", shape(2, 3.0)),
        ]
        library = build_library_from_groups(groups, comparison(), 0.27)
        self.assertEqual((library.fingerprints, len(library.refs)), (2, 3))
        self.assertEqual(library.predict_types([descriptor(0.05)])[0]["kind"], "fatha")
        self.assertEqual(library.predict_types([descriptor(2.9)])[0]["kind"], "kasra")
        # Held once: every row is a view of the bank's matrix.
        self.assertTrue(all(np.shares_memory(rep, library.bank[0]) for rep in library.reps))

    def test_hiding_a_page_answers_without_its_shapes(self):
        groups = [ShapeGroup("mark", ":fatha", shape(0, 0.0, page=7), [shape(1, 0.1, distance=0.1, page=3)])]
        hidden = hide_shapes_of_page(build_library_from_groups(groups, comparison(), 0.27), 7)
        self.assertEqual([ref["page_number"] for ref in hidden.refs], [3])
        self.assertEqual(hidden.groups[0]["centre"]["blob_id"], 1)  # the group still answers
        self.assertEqual(hidden.predict_types([descriptor(0.05)])[0]["kind"], "fatha")


class RebuildTests(unittest.TestCase):
    def test_a_looks_right_example_stays_a_fingerprint(self):
        method = comparison()
        values = [0.0, 0.1, 0.2]
        reps = [method.describe(descriptor(value)) for value in values]
        # Unseeded, the middle one stands for the group; seeded, the first one stays.
        self.assertEqual(group_examples(method, reps, 0.27)[0]["centre"], 1)
        self.assertEqual(group_examples(method, reps, 0.27, seeds=[0])[0]["centre"], 0)

    def test_a_build_becomes_groups_keeping_looks_right_members(self):
        samples = [sample(i, 0.01 * i) for i in range(30)]
        library = build_library(samples, limit=0.5, fingerprint_keys=frozenset({("snapshot-0", 0)}))
        groups = convert_library_to_groups(library, samples, looks_right_keys=frozenset({("snapshot-13", 13)}))
        self.assertEqual(groups[0].fingerprint.key, ("snapshot-0", 0))
        self.assertLessEqual(len(groups[0].kept), KEPT_PER_GROUP)
        self.assertIn(("snapshot-13", 13), [kept.key for kept in groups[0].kept])

    def test_a_page_typed_mark_the_library_keeps_is_not_counted_twice(self):
        library = build_library([sample(0, 0.0)], limit=0.27)
        self.assertIs(library.with_page_examples([sample(0, 0.0)]), library)
        self.assertEqual(len(library.with_page_examples([sample(0, 0.0, subtype="kasra")]).refs), 2)


if __name__ == "__main__":
    unittest.main()
