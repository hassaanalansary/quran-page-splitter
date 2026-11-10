"""The fingerprint library: grouping, kept shapes, and its answers. No database."""

import math
import unittest

from core.word_boundary.examples import MASK_FEATURES
from core.word_boundary.library import KEEP, build_library, comparison, group, kept


def descriptor(value=0.0):
    """A descriptor whose weighted distance to another is exactly the difference of
    their values — so a test can say how far apart two shapes are."""
    return [value / 32] * MASK_FEATURES + [value / math.sqrt(6)] * 6


def example(number, value, role="mark", subtype="", page=1):
    return {
        "features": descriptor(value),
        "role": role,
        "subtype": subtype,
        "snapshot_id": f"snapshot-{number}",
        "blob_id": number,
        "page_number": page,
        "line_number": 1,
    }


def reps(values):
    method = comparison()
    return method, [method.describe(descriptor(value)) for value in values]


class GroupingTests(unittest.TestCase):
    def test_examples_within_the_limit_share_a_fingerprint(self):
        method, shapes = reps([0.0, 0.1, 0.2, 5.0, 5.1])
        groups = group(method, shapes, 0.27)
        self.assertEqual(sorted(sorted(item["members"]) for item in groups), [[0, 1, 2], [3, 4]])

    def test_the_fingerprint_is_the_groups_most_typical_member(self):
        # The walk starts the group at 0.0; re-chosen, the middle of 0.0..0.2 stands for it.
        method, shapes = reps([0.0, 0.1, 0.2])
        (only,) = group(method, shapes, 0.27)
        self.assertEqual(only["centre"], 1)
        self.assertEqual(only["members"][0], 1)  # nearest the fingerprint first

    def test_a_group_keeps_its_fingerprint_and_members_spread_to_its_edge(self):
        method, shapes = reps([0.01 * i for i in range(30)])
        groups = group(method, shapes, 0.27)
        shapes_kept = kept(groups)
        for item in groups:
            own = [entry for entry in shapes_kept if entry[0] in item["members"]]
            self.assertLessEqual(len(own), KEEP)
            self.assertIn((item["centre"], True, len(item["members"])), own)
            self.assertIn(item["members"][-1], [entry[0] for entry in own])  # its farthest reach

    def test_a_smaller_limit_keeps_more_fingerprints(self):
        samples = [example(i, 0.05 * i, subtype="fatha") for i in range(20)]
        wide, narrow = build_library(samples, limit=0.5), build_library(samples, limit=0.08)
        self.assertLess(wide.fingerprints, narrow.fingerprints)
        self.assertEqual((wide.examples, wide.typed_examples), (20, 20))

    def test_the_library_keeps_every_group_for_people_to_look_through(self):
        samples = [example(i, 0.05 * i, subtype="fatha") for i in range(10)] + [example(20, 9.0, subtype="kasra")]
        library = build_library(samples, limit=0.27)
        self.assertEqual(len(library.groups), library.fingerprints)
        self.assertEqual(sum(len(item["members"]) for item in library.groups), 11)
        for item in library.groups:
            self.assertIn(item["centre"], item["members"])
            self.assertNotIn("features", item["centre"])
            self.assertEqual(item["distance"], sorted(item["distance"]))  # nearest first
            self.assertTrue(all(0 <= index < len(item["members"]) for index in item["kept"]))
        (kasra,) = [item for item in library.groups if item["subtype"] == "kasra"]
        self.assertEqual((kasra["role"], len(kasra["members"]), kasra["kept"]), ("mark", 1, []))

    def test_the_limit_must_be_positive(self):
        with self.assertRaises(ValueError):
            build_library([example(0, 0.0)], limit=0)


class RoleTests(unittest.TestCase):
    def library(self):
        return build_library(
            [example(i, 0.01 * i, subtype="fatha") for i in range(5)]
            + [example(10 + i, 3.0 + 0.01 * i, role="body") for i in range(5)]
        )

    def test_the_nearer_of_the_nearest_letter_and_mark_answers(self):
        found = self.library().role_of(descriptor(0.02))
        self.assertEqual(found["role"], "mark")
        self.assertEqual(found["reasons"], [])
        self.assertAlmostEqual(found["nearest_mark"], 0.0, places=6)
        self.assertEqual((found["mark"]["role"], found["letter"]["role"]), ("mark", "body"))

    def test_confidence_says_by_how_much(self):
        library = self.library()
        sure = library.role_of(descriptor(0.0))
        torn = library.role_of(descriptor(1.52))  # about as far from both
        self.assertGreater(sure["confidence"], 0.9)
        self.assertLess(torn["confidence"], 0.05)

    def test_it_always_answers_once_it_knows_letters_and_marks(self):
        far = self.library().role_of(descriptor(50.0))
        self.assertIn(far["role"], ("body", "mark"))

    def test_without_letters_it_cannot_say(self):
        library = build_library([example(0, 0.0, subtype="fatha")])
        self.assertFalse(library.can_propose)
        self.assertEqual(
            library.role_of(descriptor(0.0)), {"role": None, "confidence": 0.0, "reasons": ["no_examples"]}
        )


class TypeTests(unittest.TestCase):
    def library(self):
        return build_library(
            [example(i, 0.01 * i, subtype="fatha") for i in range(3)]
            + [example(10 + i, 0.3 + 0.01 * i, subtype="kasra") for i in range(3)]
            + [example(20, 0.15)]  # untyped: a mark, never a type
            + [example(30, 3.0, role="body")]
        )

    def test_each_type_scores_its_nearest_kept_shape(self):
        (scores,) = self.library().type_scores([descriptor(0.05)])
        self.assertEqual(set(scores), {"fatha", "kasra"})
        self.assertAlmostEqual(scores["fatha"], 0.03, places=4)
        self.assertAlmostEqual(scores["kasra"], 0.25, places=4)

    def test_a_clearly_nearer_type_with_support_is_sure(self):
        (found,) = self.library().predict_types([descriptor(0.0)])
        self.assertEqual((found["subtype"], found["sure"], found["runner_up"]), ("fatha", True, "kasra"))

    def test_between_two_types_the_guess_is_unsure(self):
        (found,) = self.library().predict_types([descriptor(0.16)])
        self.assertFalse(found["sure"])

    def test_nothing_close_is_no_guess(self):
        (found,) = self.library().predict_types([descriptor(2.0)])
        self.assertEqual(found["subtype"], "")
        self.assertIsNotNone(found["distance"])

    def test_this_pages_typing_teaches_without_changing_the_library(self):
        library = self.library()
        here = library.with_typed(
            [{"features": descriptor(1.0), "subtype": "damma", "snapshot_id": "here", "blob_id": 1}]
        )
        self.assertEqual(here.types, ["damma", "fatha", "kasra"])
        self.assertEqual(library.types, ["fatha", "kasra"])
        self.assertEqual(here.predict_types([descriptor(1.0)])[0]["subtype"], "damma")

    def test_the_evidence_lists_the_nearest_types_with_their_shapes(self):
        candidates = self.library().nearest_by_type(descriptor(0.0), types=2, per_type=2)
        self.assertEqual([entry["subtype"] for entry in candidates], ["fatha", "kasra"])
        self.assertEqual(len(candidates[0]["examples"]), 2)
        self.assertEqual(candidates[0]["examples"][0]["distance"], candidates[0]["distance"])
        self.assertNotIn("features", candidates[0]["examples"][0])


if __name__ == "__main__":
    unittest.main()
