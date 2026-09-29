"""Pure classifier contract and conservative abstention, without database access."""

import copy
import json
import math
import unittest

import numpy as np

from core.word_boundary.examples import (
    DEFAULT_CONFIG,
    FEATURE_COUNT,
    MASK_FEATURES,
    build_index,
    build_type_index,
    feature_vector,
    nearest_by_type,
    predict,
    predict_type,
    predict_types,
)


def descriptor(value=0.0):
    return [value / 32] * MASK_FEATURES + [value / math.sqrt(6)] * 6


def sample(number, value, role="body", page=None, snapshot=None):
    return {
        "sample_id": f"sample-{number}",
        "snapshot_id": snapshot or f"snapshot-{number}",
        "blob_id": number,
        "page_number": page or number + 1,
        "line_number": 1,
        "role": role,
        "features": descriptor(value),
        "extra": {"source": "fixture"},
    }


def supported_samples():
    return [sample(i, 0.01 * (i + 1)) for i in range(5)] + [sample(5, 0.8, "mark")]


def typed(number, value, subtype, snapshot=None):
    """A mark a person typed. In these fixtures the weighted distance between two
    descriptors is exactly the difference of their values."""
    return {
        "features": descriptor(value),
        "subtype": subtype,
        "snapshot_id": snapshot or f"snapshot-{number}",
        "blob_id": number,
    }


class TypeTests(unittest.TestCase):
    def test_close_agreeing_examples_make_a_sure_guess(self):
        index = build_type_index([typed(i, 0.01 * i, "fatha") for i in range(3)])
        found = predict_type(descriptor(0.005), index)
        self.assertEqual((found["subtype"], found["support"], found["sure"]), ("fatha", 3, True))

    def test_one_near_example_is_a_guess_and_an_exact_one_is_sure(self):
        guess = predict_type(descriptor(0.0), build_type_index([typed(0, 0.1, "kasra")]))
        self.assertEqual((guess["subtype"], guess["sure"]), ("kasra", False))
        exact = predict_type(descriptor(0.0), build_type_index([typed(0, 0.0, "sukun")]))
        self.assertEqual((exact["subtype"], exact["sure"]), ("sukun", True))

    def test_nothing_close_enough_is_no_guess(self):
        found = predict_type(descriptor(0.0), build_type_index([typed(0, 0.5, "fatha")]))
        self.assertEqual((found["subtype"], found["distance"]), ("", 0.5))
        self.assertEqual(predict_type(descriptor(0.0), build_type_index([]))["subtype"], "")

    def test_disagreeing_examples_make_no_sure_guess(self):
        index = build_type_index([typed(0, 0.01, "fatha"), typed(1, 0.012, "kasra")])
        found = predict_type(descriptor(0.0), index)
        self.assertEqual((found["subtype"], found["sure"]), ("fatha", False))
        self.assertEqual((found["runner_up"], found["runner_distance"]), ("kasra", 0.012))
        self.assertLess(found["confidence"], 0.6)

    def test_a_common_type_cannot_outvote_a_nearer_rare_one(self):
        # The madda page: one madda typed, and a crowd of fathas only a little further.
        fathas = [typed(i, 0.06 + 0.01 * i, "fatha") for i in range(10)]
        one = predict_type(descriptor(0.0), build_type_index([typed(99, 0.05, "madda"), *fathas]))
        self.assertEqual((one["subtype"], one["sure"]), ("madda", False))
        maddas = [typed(98, 0.05, "madda"), typed(99, 0.055, "madda")]
        two = predict_type(descriptor(0.0), build_type_index([*maddas, *fathas]))
        self.assertEqual((two["subtype"], two["support"], two["sure"]), ("madda", 2, True))

    def test_a_close_rival_type_is_never_sure(self):
        samples = [typed(i, 0.05 + 0.01 * i, "fatha") for i in range(3)]
        samples += [typed(10 + i, 0.055 + 0.01 * i, "madda") for i in range(3)]
        found = predict_type(descriptor(0.0), build_type_index(samples))
        self.assertEqual((found["subtype"], found["sure"]), ("fatha", False))

    def test_one_bitmap_typed_two_ways_is_never_sure(self):
        index = build_type_index([typed(0, 0.0, "fatha"), typed(1, 0.0, "madda"), typed(2, 0.01, "fatha")])
        self.assertIs(predict_type(descriptor(0.0), index)["sure"], False)

    def test_many_marks_at_once_match_one_at_a_time(self):
        samples = [typed(i, 0.02 * i, ("fatha", "kasra", "sukun")[i % 3]) for i in range(12)]
        index = build_type_index(samples)
        queries = [descriptor(0.007 + 0.013 * n) for n in range(20)]

        def verdicts(answers):
            return [(found["subtype"], found["sure"], found["support"], found["runner_up"]) for found in answers]

        self.assertEqual(verdicts(predict_types(queries, index)), verdicts(predict_type(q, index) for q in queries))
        self.assertEqual(predict_types([], index), [])
        excluded = predict_types(queries[:2], index, exclude_snapshot_ids={f"snapshot-{i}" for i in range(12)})
        self.assertEqual([found["subtype"] for found in excluded], ["", ""])

    def test_the_evidence_is_each_near_type_with_its_own_nearest_examples(self):
        samples = [typed(0, 0.05, "madda"), typed(1, 0.06, "madda", snapshot="own")]
        samples += [typed(2 + i, 0.07 + 0.01 * i, "fatha") for i in range(4)]
        found = nearest_by_type(descriptor(0.0), build_type_index(samples), per_type=2)
        scores = [(entry["subtype"], entry["distance"]) for entry in found]
        self.assertEqual(scores, [("madda", 0.055), ("fatha", 0.075)])
        self.assertEqual(
            [(example["blob_id"], example["distance"]) for example in found[0]["examples"]], [(0, 0.05), (1, 0.06)]
        )
        alone = nearest_by_type(descriptor(0.0), build_type_index(samples), exclude_snapshot_ids={"own"})
        self.assertEqual([example["blob_id"] for example in alone[0]["examples"]], [0])

    def test_repeated_identical_glyphs_are_one_piece_of_evidence(self):
        # Twenty copies of one bitmap typed fatha cannot outvote two nearer kasras.
        samples = [typed(i, 0.1, "fatha") for i in range(20)] + [typed(20, 0.02, "kasra"), typed(21, 0.03, "kasra")]
        index = build_type_index(samples)
        self.assertEqual(len(index.types), 3)
        self.assertEqual(predict_type(descriptor(0.0), index)["subtype"], "kasra")

    def test_a_page_can_leave_its_own_examples_out(self):
        index = build_type_index([typed(0, 0.0, "shadda", snapshot="own")])
        self.assertEqual(predict_type(descriptor(0.0), index, exclude_snapshot_ids={"own"})["subtype"], "")

    def test_an_untyped_example_is_refused(self):
        with self.assertRaises(ValueError):
            build_type_index([typed(0, 0.0, "")])


class FeatureVectorTests(unittest.TestCase):
    def test_centered_aspect_preserving_raster_and_balanced_blocks(self):
        vector = np.array(feature_vector(np.ones((8, 4), bool), w=4, h=8, area=32, band_height=8, peak_offset=-4))
        raster = vector[:MASK_FEATURES].reshape(32, 32) * 32
        expected = np.zeros((32, 32))
        expected[:, 8:24] = 1
        np.testing.assert_allclose(raster, expected)
        self.assertEqual(vector.size, FEATURE_COUNT)
        np.testing.assert_allclose(vector[MASK_FEATURES:] * math.sqrt(6), [1 / 3, 1 / 2, 1 / 3, 1, 1 / 3, -1 / 3])
        self.assertLessEqual(np.linalg.norm(vector[:MASK_FEATURES]), 1)
        self.assertLessEqual(np.linalg.norm(vector[MASK_FEATURES:]), 1)

    def test_uniform_scaling_preserves_descriptor(self):
        mask = np.array([[True, False, True], [True, True, False]])
        enlarged = np.repeat(np.repeat(mask, 4, axis=0), 4, axis=1)
        small = feature_vector(mask, w=3, h=2, area=4, band_height=3, peak_offset=2)
        large = feature_vector(enlarged, w=12, h=8, area=64, band_height=12, peak_offset=8)
        np.testing.assert_allclose(small, large, atol=1e-14)

    def test_large_glyph_preserves_thin_ink_when_downsampled(self):
        mask = np.zeros((128, 128), bool)
        mask[:, 0] = True
        vector = feature_vector(mask, w=128, h=128, area=128, band_height=32, peak_offset=0)
        self.assertAlmostEqual(sum(vector[:MASK_FEATURES]) * 32, 8)
        self.assertLessEqual(np.linalg.norm(vector[:MASK_FEATURES]), 1)

    def test_invalid_masks_and_geometry_are_rejected(self):
        kwargs = {"w": 2, "h": 2, "area": 4, "band_height": 2, "peak_offset": 0}
        for mask in (np.ones((2, 2), int), np.ones((4,), bool), np.zeros((2, 2), bool)):
            with self.subTest(mask=mask), self.assertRaises(ValueError):
                feature_vector(mask, **kwargs)
        for overrides in ({"w": 3}, {"band_height": 0}, {"area": 0}, {"peak_offset": math.nan}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                feature_vector(np.ones((2, 2), bool), **(kwargs | overrides))


class IndexTests(unittest.TestCase):
    def test_exact_dedup_preserves_provenance_and_opposite_labels(self):
        samples = [sample(0, 0.1), sample(1, 0.1), sample(2, 0.1, "mark"), sample(3, 0.100001)]
        index = build_index(samples)
        self.assertEqual(index["sample_count"], 4)
        self.assertEqual(index["unique_count"], 3)
        self.assertEqual([ref["sample_id"] for ref in index["samples"][0]["refs"]], ["sample-0", "sample-1"])
        self.assertEqual(index, json.loads(json.dumps(index, allow_nan=False)))
        samples[0]["extra"]["source"] = "changed"
        self.assertEqual(index["samples"][0]["refs"][0]["extra"]["source"], "fixture")

    def test_repeated_ids_cannot_manufacture_support(self):
        original = sample(0, 0.01)
        index = build_index([original] * 5 + [sample(5, 0.8, "mark")])
        self.assertEqual(index["unique_count"], 2)
        self.assertIsNone(predict(descriptor(), index)["proposed_role"])
        for overrides in ({"features": descriptor(0.02)}, {"role": "mark"}, {"snapshot_id": "other"}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                build_index([original, original | overrides])

    def test_invalid_config_and_features_are_rejected(self):
        for config in (
            {"min_support": 6},
            {"max_neighbors": 6},
            {"chunk_size": 0},
            {"version": 2},
            {"max_distance": math.inf},
            {"min_margin": -1},
            {"max_distance_ratio": 1},
            {"mask_weight": 0.8},
            {"activate": True},
            {"min_support": True},
        ):
            with self.subTest(config=config), self.assertRaises(ValueError):
                build_index([], config)
        for features in ([0.0], [math.nan] * FEATURE_COUNT, [math.inf] * FEATURE_COUNT):
            with self.subTest(features=features[:1]), self.assertRaises(ValueError):
                build_index([sample(0, 0.1) | {"features": features}])


class PredictionTests(unittest.TestCase):
    def test_five_close_unanimous_groups_with_separated_opposite_propose(self):
        for role, opposite in (("body", "mark"), ("mark", "body")):
            samples = supported_samples()
            for entry in samples:
                entry["role"] = opposite if entry["role"] == "mark" else role
            result = predict(descriptor(), build_index(samples))
            self.assertEqual(result["proposed_role"], role)
            self.assertEqual(result["support_count"], 5)
            self.assertEqual(result["distinct_pages"], 5)
            self.assertEqual(len(result["neighbors"]), 5)
            self.assertEqual(result["reasons"], [])
            self.assertGreater(result["confidence"], 0)
            self.assertLessEqual(result["confidence"], 1)
            self.assertAlmostEqual(result["nearest_opposite_distance"], 0.8)
            self.assertAlmostEqual(result["neighbors"][-1]["distance"], 0.05)
            self.assertEqual(result["mode"], "shadow")
            self.assertFalse(result["validated"])
            self.assertEqual(result["config"]["min_support"], 5)

    def test_unanimity_alone_does_not_propose(self):
        cases = [
            (supported_samples()[:-1], "missing_opposite"),
            ([sample(i, 0.2 + i * 0.01) for i in range(5)] + [sample(5, 0.8, "mark")], "too_far"),
            ([entry | {"page_number": 1} for entry in supported_samples()], "insufficient_pages"),
            ([*supported_samples()[:4], sample(5, 0.8, "mark")], "insufficient_support"),
            ([*supported_samples()[:5], sample(5, 0.14, "mark")], "insufficient_margin"),
        ]
        for samples, reason in cases:
            with self.subTest(reason=reason):
                result = predict(descriptor(), build_index(samples))
                self.assertIsNone(result["proposed_role"])
                self.assertEqual(result["confidence"], 0)
                self.assertIn(reason, result["reasons"])

    def test_ratio_is_required_in_addition_to_absolute_margin(self):
        samples = [sample(i, 0.10 + i * 0.005) for i in range(5)] + [sample(5, 0.23, "mark")]
        result = predict(descriptor(), build_index(samples))
        self.assertGreater(result["margin"], DEFAULT_CONFIG["min_margin"])
        self.assertIn("insufficient_ratio", result["reasons"])
        self.assertIsNone(result["proposed_role"])

    def test_conflicting_labels_and_near_opposite_abstain(self):
        for value in (0.01, 0.001, 0):
            result = predict(descriptor(), build_index([*supported_samples(), sample(6, value, "mark")]))
            self.assertIn("mixed_neighbors", result["reasons"])
            self.assertIsNone(result["proposed_role"])

    def test_more_than_five_support_groups_cannot_hide_near_opposite(self):
        samples = [sample(i, 0.001 * i) for i in range(12)] + [sample(12, 0.02, "mark")]
        result = predict(descriptor(), build_index(samples))
        self.assertEqual(len(result["neighbors"]), 5)
        self.assertIn("insufficient_margin", result["reasons"])
        self.assertIsNone(result["proposed_role"])

    def test_exact_duplicates_do_not_inflate_support(self):
        samples = [sample(i, 0.01) for i in range(20)] + [sample(20, 0.8, "mark")]
        result = predict(descriptor(), build_index(samples))
        self.assertEqual(len(result["neighbors"]), 2)
        self.assertIsNone(result["proposed_role"])

    def test_exclusions_apply_to_all_refs_support_and_opposite_evidence(self):
        samples = [*supported_samples(), sample(6, 0.01, snapshot="retained")]
        index = build_index(samples)
        result = predict(descriptor(), index, {"snapshot-0"})
        self.assertEqual(result["proposed_role"], "body")
        self.assertEqual(result["neighbors"][0]["snapshot_id"], "retained")
        self.assertEqual(len(result["neighbors"][0]["refs"]), 1)
        result = predict(descriptor(), index, {"snapshot-0", "retained"})
        self.assertIsNone(result["proposed_role"])
        result = predict(descriptor(), index, {"snapshot-5"})
        self.assertIn("missing_opposite", result["reasons"])
        result = predict(descriptor(), index, {entry["snapshot_id"] for entry in samples})
        self.assertEqual(result["neighbors"], [])
        self.assertEqual(result["eligible_count"], 0)

    def test_page_diversity_uses_surviving_refs_and_distinct_groups(self):
        samples = [entry | {"page_number": 1} for entry in supported_samples()]
        samples += [sample(6, 0.01, page=2), sample(7, 0.01, page=3)]
        index = build_index(samples)
        self.assertEqual(predict(descriptor(), index)["distinct_pages"], 2)
        excluded = {"snapshot-6", "snapshot-7"}
        self.assertIn("insufficient_pages", predict(descriptor(), index, excluded)["reasons"])
        index = build_index(samples, {"min_distinct_pages": 3})
        self.assertIsNone(predict(descriptor(), index)["proposed_role"])

    def test_chunked_search_matches_direct_weighted_distances(self):
        rng = np.random.default_rng(42)
        samples = [sample(i, 0, "mark" if i % 3 == 0 else "body") for i in range(37)]
        for entry in samples:
            entry["features"] = rng.random(FEATURE_COUNT).tolist()
        query = rng.random(FEATURE_COUNT)
        expected = sorted(
            (np.linalg.norm(np.array(entry["features"]) - query) / math.sqrt(2), entry["sample_id"])
            for entry in samples
        )[:5]
        for chunk_size in (1, 4, 256):
            result = predict(query.tolist(), build_index(samples, {"chunk_size": chunk_size}))
            self.assertEqual([entry["sample_id"] for entry in result["neighbors"]], [item[1] for item in expected])
            np.testing.assert_allclose(
                [entry["distance"] for entry in result["neighbors"]], [item[0] for item in expected]
            )

    def test_json_roundtrip_empty_index_and_no_mutation(self):
        index = json.loads(json.dumps(build_index(supported_samples())))
        before = copy.deepcopy(index)
        result = predict(descriptor(), index)
        self.assertEqual(result, json.loads(json.dumps(result, allow_nan=False)))
        result["neighbors"][0]["refs"][0]["extra"]["source"] = "changed"
        result["config"]["min_support"] = 1
        self.assertEqual(index, before)
        self.assertEqual(DEFAULT_CONFIG["min_support"], 5)
        empty = predict(descriptor(), build_index([]))
        self.assertIsNone(empty["proposed_role"])
        self.assertEqual(empty["neighbors"], [])
        self.assertEqual(empty["confidence"], 0)
        with self.assertRaises(ValueError):
            predict(descriptor(), index | {"version": 999})


if __name__ == "__main__":
    unittest.main()
