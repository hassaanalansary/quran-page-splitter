"""Frozen-engine contracts and constrained recovery, without database state."""

import hashlib
import json
from dataclasses import replace
from unittest import TestCase
from unittest.mock import patch

import cv2
import numpy as np
from PIL import Image, ImageDraw

from core.word_boundary.alignment import _advance, _line_end, _with_body
from core.word_boundary.engine import detect_prepared, detect_words
from core.word_boundary.ink import Blob, analyse_line
from core.word_boundary.inputs import BlobConstraint, LineImage, WordBoundaryInput, WordInput
from core.word_boundary.report import as_dict
from core.word_boundary.separators import split_separators
from core.word_boundary.span import _fresh, _settle


def line(xs, label="line-01.png", separators=None, separator_ayat=None):
    image = Image.new("RGBA", (400, 60), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    for x in xs:
        draw.rectangle([x, 20, x + 29, 40], fill=(0, 0, 0, 255))
    return LineImage(image, label, f"test:{label}", separators, separator_ayat)


def words(paws, aya="7:82", first_id=100):
    return [WordInput(f"w{i}", count, 0, 0, aya, first_id + i) for i, count in enumerate(paws)]


def prepared(lines, stream):
    source = WordBoundaryInput(lines, stream, ijam="ignore")
    inks = [analyse_line(item) for item in lines]
    for ink in inks:
        split_separators(ink, None)
    return source, inks


def force(blob, role="body", source="human", paws=1, owner=None):
    blob.locked_role = role
    blob.lock_source = source
    blob.paw_count = paws
    blob.assigned_word_id = owner
    return blob


class FrozenContractTests(TestCase):
    def test_legacy_reports_are_byte_identical(self):
        cases = [
            WordBoundaryInput([line([50, 100, 150, 200], separators=[])], words(p))
            for p in ([1, 2, 1], [2, 2], [1] * 6, [1])
        ]
        cases.append(
            WordBoundaryInput(
                [line([50, 100], label="a", separators=[]), line([100, 200], label="b", separators=[])],
                words([1, 2, 1]),
            )
        )
        payload = json.dumps([as_dict(s, detect_words(s)) for s in cases], sort_keys=True).encode()
        self.assertEqual(
            hashlib.sha256(payload).hexdigest(), "7b380f84387c48e1063fda3536d60eaa17c3bcd92152d33d073ec404bbed9991"
        )

    def test_prepared_never_measures_or_matches(self):
        source, inks = prepared([line([50, 100], separators=[])], words([1, 1]))
        expected = detect_words(source)
        with (
            patch("core.word_boundary.engine.analyse_line", side_effect=AssertionError),
            patch("core.word_boundary.engine.prepare_template", side_effect=AssertionError),
            patch("core.word_boundary.engine.split_symbols", side_effect=AssertionError),
            patch("core.word_boundary.engine.split_separators", side_effect=AssertionError),
        ):
            self.assertEqual(detect_prepared(source, inks), expected)

    def test_filtered_snapshot_keeps_original_component_labels_and_offsets(self):
        source, inks = prepared([line([50, 100, 150], separators=[])], words([1]))
        target = inks[0].components[1]
        inks[0].components = [target]
        result = detect_prepared(source, inks)
        self.assertEqual(result.lines[0].words[0].components, [target.label])
        self.assertEqual(result.lines[0].words[0].end_x, 100)
        self.assertEqual(result.lines[0].crop_offset, (50, 20))

    def test_label_map_is_exact_cc_raster_even_after_separator_removal(self):
        source = line([50, 100, 150], separators=[(100, 130)])
        ink = analyse_line(source)
        expected = cv2.connectedComponentsWithStats(ink.mask.astype(np.uint8), connectivity=8)[1]
        np.testing.assert_array_equal(ink.label_map, expected)
        original = ink.label_map.copy()
        areas = {blob.label: blob.area for blob in ink.components}
        split_separators(ink, None)
        np.testing.assert_array_equal(ink.label_map, original)
        self.assertEqual(ink.label_map.dtype, np.int32)
        for label, area in areas.items():
            self.assertEqual(np.count_nonzero(ink.label_map == label), area)

    def test_blank_has_full_size_zero_raster_and_zero_offsets(self):
        ink = analyse_line(line([]))
        self.assertEqual(ink.label_map.shape, ink.mask.shape)
        self.assertEqual(ink.label_map.dtype, np.int32)
        self.assertFalse(ink.label_map.any())
        self.assertEqual((ink.offset_x, ink.offset_y), (0, 0))


class TransitionTests(TestCase):
    def blob(self):
        return Blob(1, 10, 0, 10, 10, 100, body_score=14)

    def test_locked_roles_select_only_their_branch_without_changing_costs(self):
        for role in ("body", "mark"):
            blob = force(self.blob(), role)
            states = _advance(_fresh(0), blob, 0, words([1]))
            for record in states.values():
                self.assertEqual(bool(record.body_mask), role == "body")
            self.assertEqual(
                min(r.cost for r in states.values()), blob.cost_as_body if role == "body" else blob.cost_as_mark
            )

    def test_body_helper_also_enforces_mark_and_owner_constraints(self):
        blob = force(self.blob(), "mark")
        key, record = next(iter(_fresh(0).items()))
        self.assertEqual(_with_body(record, blob, 0, words([1]), key), [])
        force(blob, owner=999)
        self.assertEqual(_with_body(record, blob, 0, words([1]), key), [])
        self.assertEqual(_advance(_fresh(0), blob, 0, words([1])), {})

    def test_zero_paw_fragment_is_not_a_closed_word(self):
        blob = force(self.blob(), paws=0)
        states = _advance(_fresh(0), blob, 0, words([1]))
        self.assertTrue(states)
        self.assertEqual(_line_end(states), {})
        self.assertIsNone(_settle(states, 1))

    def test_fused_body_contributes_multiple_paws_without_a_penalty(self):
        blob = force(self.blob(), paws=3)
        _, record, _, missed = _settle(_advance(_fresh(0), blob, 0, words([3])), 1)
        self.assertFalse(missed)
        self.assertEqual((record.cost, record.deviations, record.paw_errors), (0, 0, 0))


class ConstraintRecoveryTests(TestCase):
    def test_fragments_before_and_after_main_body_stay_with_the_owner(self):
        for fragment_index in (0, 1):
            source, inks = prepared([line([50, 100], separators=[])], words([1]))
            for index, blob in enumerate(inks[0].components):
                force(blob, paws=0 if index == fragment_index else 1, owner=100)
            result = detect_prepared(source, inks)
            self.assertTrue(result.complete)
            self.assertEqual(result.lines[0].words[0].components, [b.label for b in inks[0].components])
            self.assertEqual(result.lines[0].deviations, 0)

    def test_fragment_can_attach_after_reaching_count_slack_limit(self):
        source, inks = prepared([line([50, 100, 150, 200], separators=[])], words([1]))
        force(inks[0].components[-1], paws=0, owner=100)
        for blob in inks[0].components[:-1]:
            force(blob, owner=100)
        result = detect_prepared(source, inks)
        self.assertTrue(result.complete)
        self.assertEqual(len(result.lines[0].words[0].components), 4)

    def test_assigned_id_is_not_the_word_index(self):
        source, inks = prepared([line([50, 100], separators=[])], words([1, 1], first_id=700))
        for index, blob in enumerate(inks[0].components):
            blob.assigned_word_id = 700 + index
        result = detect_prepared(source, inks)
        self.assertTrue(result.complete)
        self.assertEqual([w.word_id for w in result.lines[0].words], [700, 701])

    def test_impossible_ownership_reports_conflict_and_retains_human_body(self):
        source, inks = prepared([line([50], separators=[])], words([1]))
        blob = force(inks[0].components[0], owner=999)
        result = detect_prepared(source, inks)
        self.assertFalse(result.complete)
        self.assertEqual(result.lines[0].constraint_conflicts, [blob.label])
        self.assertIn("constraint-conflict", result.lines[0].reason)
        self.assertEqual(result.lines[0].components[0].role, "body")
        self.assertTrue(any(s.reason == "constraint-conflict" for s in result.lines[0].segments))

    def test_impossible_aya_does_not_prevent_next_aya_recovery(self):
        source, inks = prepared(
            [line([50, 150, 250], separators=[(150, 180)], separator_ayat=["7:82"])],
            words([1]) + words([1], "7:83", 101),
        )
        bad = force(inks[0].components[0], owner=101)
        result = detect_prepared(source, inks)
        self.assertFalse(result.complete)
        self.assertEqual([w.word_id for w in result.lines[0].words], [101])
        self.assertEqual(result.lines[0].status, "partial")
        self.assertEqual(result.lines[0].constraint_conflicts, [bad.label])

    def test_extra_human_body_after_all_words_prevents_false_success(self):
        source, inks = prepared(
            [line([150, 250], separators=[(150, 180)], separator_ayat=["7:82"]), line([50], "tail", separators=[])],
            words([1]),
        )
        force(inks[1].components[0])
        result = detect_prepared(source, inks)
        self.assertEqual(result.words_consumed, 1)
        self.assertFalse(result.complete)
        self.assertTrue(result.lines[1].constraint_conflicts)

    def test_zero_paw_body_cannot_vanish_at_a_line_break(self):
        source, inks = prepared(
            [line([100], "a", separators=[]), line([100], "b", separators=[])],
            words([1]),
        )
        fragment = force(inks[0].components[0], paws=0)
        result = detect_prepared(source, inks)
        self.assertFalse(result.complete)
        self.assertEqual(result.words_consumed, 0)
        self.assertEqual(result.lines[0].constraint_conflicts, [fragment.label])

    def test_calibration_retry_releases_only_the_failed_aya(self):
        source, inks = prepared(
            [line([50, 100, 150, 250, 300], separators=[(150, 180)], separator_ayat=["7:82"])],
            words([1, 1]) + words([1, 1], "7:83", 102),
        )
        parts = inks[0].components
        force(parts[0], "mark", "calibration")
        force(parts[1], owner=101)
        force(parts[2], "body", "calibration")
        force(parts[3], owner=103)
        result = detect_prepared(source, inks)
        self.assertTrue(result.complete)
        self.assertEqual(result.lines[0].released_locks, [parts[0].label])
        self.assertIsNone(parts[0].locked_role)
        self.assertEqual(parts[1].lock_source, "human")
        self.assertEqual(parts[2].lock_source, "calibration")

    def test_calibration_retry_replays_across_line_breaks(self):
        source, inks = prepared(
            [line([100], "a", separators=[]), line([100], "b", separators=[])],
            words([1, 1]),
        )
        calibration = force(inks[0].components[0], "mark", "calibration")
        force(inks[1].components[0], owner=101)
        result = detect_prepared(source, inks)
        self.assertTrue(result.complete)
        self.assertEqual(result.lines[0].released_locks, [calibration.label])
        self.assertEqual(result.lines[1].released_locks, [])

    def test_failed_retry_retains_human_lock_and_reports_released_calibration(self):
        source, inks = prepared([line([50, 100], separators=[])], words([1, 1]))
        calibration = force(inks[0].components[0], "mark", "calibration")
        human = force(inks[0].components[1], "mark", "human")
        result = detect_prepared(source, inks)
        self.assertFalse(result.complete)
        self.assertEqual(result.lines[0].released_locks, [calibration.label])
        self.assertEqual(human.locked_role, "mark")
        # The retry still cannot reach the end, so the frozen fallback reading is
        # kept and flagged, naming the human lock the boundary resists.
        self.assertIn("constraint-boundary-missed", result.lines[0].reason)
        self.assertEqual(result.lines[0].constraint_conflicts, [human.label])
        self.assertEqual([w.word_id for w in result.lines[0].words], [100])

    def test_no_reading_under_human_locks_is_unresolved_not_manufactured(self):
        source, inks = prepared([line([50], separators=[])], words([1]))
        human = force(inks[0].components[0], "mark", "human")
        result = detect_prepared(source, inks)
        self.assertFalse(result.complete)
        self.assertEqual(result.lines[0].words, [])
        self.assertEqual(result.lines[0].constraint_conflicts, [human.label])
        self.assertIn("constraint-conflict", result.lines[0].reason)

    def test_a_lock_changes_its_own_aya_and_not_the_next(self):
        def fixture():
            # Reading order, right to left: 300 and 250 in aya 7:82, the ornament at
            # 150, then 50 in aya 7:83. Two identical blobs for a one-PAW word tie,
            # and the tie goes to the earlier ink — 300.
            return prepared(
                [line([50, 150, 250, 300], separators=[(150, 180)], separator_ayat=["7:82"])],
                words([1]) + words([1], "7:83", 101),
            )

        plain = detect_prepared(*fixture())
        source, inks = fixture()
        by_x = {blob.x + inks[0].offset_x: blob for blob in inks[0].components}
        force(by_x[250], owner=100)
        constrained = detect_prepared(source, inks)
        self.assertEqual([w.end_x for w in plain.lines[0].words], [300, 50])
        self.assertEqual([w.end_x for w in constrained.lines[0].words], [250, 50])

    def test_retry_preserves_paw_and_ownership_overrides(self):
        source, inks = prepared([line([50], separators=[])], words([3]))
        blob = force(inks[0].components[0], "mark", "calibration", paws=3, owner=100)
        result = detect_prepared(source, inks)
        self.assertTrue(result.complete)
        self.assertEqual((blob.paw_count, blob.assigned_word_id), (3, 100))
        self.assertEqual(result.lines[0].deviations, 0)

    def test_successful_calibration_lock_is_not_released(self):
        source, inks = prepared([line([50], separators=[])], words([1]))
        blob = force(inks[0].components[0], "body", "calibration")
        result = detect_prepared(source, inks)
        self.assertTrue(result.complete)
        self.assertEqual(result.lines[0].released_locks, [])
        self.assertEqual(blob.locked_role, "body")

    def test_direct_and_keyed_constraints_have_same_result(self):
        source, inks = prepared([line([50], separators=[])], words([3]))
        blob = force(inks[0].components[0], paws=3, owner=100)
        expected = detect_prepared(source, inks)
        source = replace(
            source,
            constraints={
                (source.lines[0].source, blob.label): BlobConstraint("body", "human", 3, 100),
            },
        )
        self.assertEqual(detect_words(source), expected)

    def test_unknown_constraint_key_is_not_silently_ignored(self):
        source, inks = prepared([line([50], separators=[])], words([1]))
        source = replace(source, constraints={("unknown-line", 1): BlobConstraint("body", "human")})
        with self.assertRaisesRegex(ValueError, "identify one text component"):
            detect_prepared(source, inks)

    def test_invalid_direct_paw_counts_are_rejected(self):
        for count in (-1, 0.5, True):
            source, inks = prepared([line([50], separators=[])], words([1]))
            inks[0].components[0].paw_count = count
            with self.assertRaisesRegex(ValueError, "non-negative integer"):
                detect_prepared(source, inks)

    def test_prepared_requires_matching_line_count(self):
        with self.assertRaisesRegex(ValueError, "one LineInk per source line"):
            detect_prepared(WordBoundaryInput([line([])], []), [])
