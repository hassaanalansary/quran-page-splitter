"""Calibration history survives regeneration, copying, and legacy editing."""

import io
import json
import uuid
import zipfile
from copy import deepcopy
from importlib import import_module
from types import SimpleNamespace

from django.core.exceptions import ValidationError
from django.core.files.base import ContentFile
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from ninja.errors import HttpError

from api.models import (
    CalibrationProfile,
    CalibrationReview,
    CalibrationRevision,
    CalibrationSnapshot,
    Line,
    LineWord,
    LineWordStatus,
    Page,
)
from api.services import bundle, cloning, word_coordinates
from api.tests.helpers import MediaTestCase, bare_mushaf, make_png_bytes


class CalibrationPersistenceTests(MediaTestCase):
    def setUp(self):
        self.mushaf = bare_mushaf("Calibration")
        self.page = Page.objects.create(mushaf=self.mushaf, page_number=7)
        self.line = Line.objects.create(page=self.page, line_number=2, bbox_x=0, bbox_y=0, bbox_w=500, bbox_h=50)
        self.word = LineWord.objects.create(line=self.line, position=0, start_x=200, end_x=150)
        self.status = LineWordStatus.objects.create(line=self.line, status="scored", edited=True)

    def _save(self, *, preserve_legacy=True, end_x=100):
        return word_coordinates.replace_page_words(
            self.page,
            [{"line_id": str(self.line.pk), "words": [{"word_id": None, "start_x": 200, "end_x": end_x}]}],
            counting_system=None,
            preserve_legacy=preserve_legacy,
        )

    def _snapshot(self):
        snapshot = CalibrationSnapshot(
            mushaf=self.mushaf,
            page_number=7,
            line_number=2,
            source_line_id=self.line.pk,
            fingerprint="a" * 64,
            metadata={"crop": [0, 0, 500, 50]},
        )
        snapshot.image.save("image.png", ContentFile(make_png_bytes()), save=False)
        snapshot.labels.save("labels.png", ContentFile(make_png_bytes()), save=False)
        snapshot.save()
        return snapshot

    def _calibration(self):
        snapshot = self._snapshot()
        payload = {
            "lines": [{"snapshot_id": str(snapshot.pk)}],
            "baseline_lines": [{"snapshot_id": str(snapshot.pk)}],
            "context": {"reference": {"snapshot_id": str(snapshot.pk)}},
        }
        review = CalibrationReview.objects.create(
            mushaf=self.mushaf, page_number=7, revision=2, confirmed_revision=1, payload=payload
        )
        CalibrationRevision.objects.create(review=review, number=1, kind="confirmed", payload=payload)
        CalibrationRevision.objects.create(
            review=review, number=2, kind="processed", payload={"draft": payload}, request_id=uuid.uuid4()
        )
        CalibrationProfile.objects.create(
            mushaf=self.mushaf,
            signature="b" * 64,
            mode="active",
            payload={
                "sample_refs": [str(snapshot.pk)],
                "config": {"k": 3},
                "active_approval": True,
                "cached_index": [1, 2],
            },
        )
        return snapshot, review

    def _run(self, lines):
        return word_coordinates.save_word_coordinates(
            SimpleNamespace(
                lines=[
                    SimpleNamespace(
                        words=[], status="unresolved", reason="retry", deviations=3, end_sequences=2, label=str(line.pk)
                    )
                    for line in lines
                ]
            ),
            [SimpleNamespace(line=line, origin_x=0) for line in lines],
            word_range=(1, 100),
        )

    def test_edited_line_is_excluded_from_all_writer_mutations(self):
        before = list(self.line.words.values())
        report = self._run([self.line])
        self.assertEqual(list(self.line.words.values()), before)
        self.status.refresh_from_db()
        self.assertEqual(self.status.status, "scored")
        self.assertTrue(self.status.edited)
        self.assertEqual(report.protected_line_ids, {self.line.pk})
        self.assertEqual((report.words_written, report.lines_written, report.lines_cleared), (0, 0, 0))
        self.assertEqual(report.unresolved, [])

    def test_confirmed_page_protects_fresh_lines_but_not_other_pages(self):
        self.status.edited = False
        self.status.save()
        CalibrationReview.objects.create(mushaf=self.mushaf, page_number=7, confirmed_revision=1)
        page = Page.objects.create(mushaf=self.mushaf, page_number=8)
        other = Line.objects.create(page=page, line_number=1, bbox_x=0, bbox_y=0, bbox_w=10, bbox_h=10)
        report = self._run([self.line, other])
        self.assertEqual(report.protected_line_ids, {self.line.pk})
        self.assertEqual(report.unresolved, [str(other.pk)])
        self.status.refresh_from_db()
        self.assertEqual(self.status.status, "scored")
        self.assertEqual(other.word_status.status, "unresolved")

    def test_manual_replace_archives_before_and_after_without_inventing_labels(self):
        self._save()
        review = CalibrationReview.objects.get(mushaf=self.mushaf, page_number=7)
        self.assertEqual(review.revision, 2)
        self.assertIsNone(review.confirmed_revision)
        self.assertEqual(review.payload["legacy_lines"][0]["words"][0]["end_x"], 100)
        self.assertEqual(review.revisions.get(number=1).payload["legacy_lines"][0]["words"][0]["end_x"], 150)
        self.assertFalse(CalibrationSnapshot.objects.exists())
        self.assertFalse(review.revisions.exclude(kind="legacy").exists())
        self._save()
        review.refresh_from_db()
        self.assertEqual(review.revision, 2)

    def test_parent_can_manage_revision_without_legacy_increment(self):
        review = CalibrationReview.objects.create(mushaf=self.mushaf, page_number=7, revision=9)
        self._save(preserve_legacy=False)
        review.refresh_from_db()
        self.assertEqual(review.revision, 9)
        self.assertFalse(review.revisions.exists())
        self.assertEqual(self.line.words.get().end_x, 100)

    def test_hand_made_words_on_a_line_with_no_status_are_protected_without_a_fake_verdict(self):
        """The engine writes a status wherever it writes words, so words without one
        are a person's — and inventing an "unresolved" verdict for them would count the
        line in every needs-review total."""
        self.status.delete()
        self._save()
        self.assertFalse(LineWordStatus.objects.filter(line=self.line).exists())
        self.assertEqual(self._run([self.line]).protected_line_ids, {self.line.pk})
        self.assertEqual(self.line.words.get().end_x, 100)

    def test_bulk_line_deletion_archives_edits_and_keeps_snapshots(self):
        snapshot = self._snapshot()
        line_id = self.line.pk
        self.page.lines.all().delete()
        snapshot.refresh_from_db()
        self.assertEqual(snapshot.source_line_id, line_id)
        review = CalibrationReview.objects.get(mushaf=self.mushaf, page_number=7)
        self.assertEqual(review.payload["legacy_lines"][0]["line_id"], str(line_id))
        self.assertEqual(review.payload["legacy_lines"][0]["words"][0]["word_id"], None)
        self.assertEqual(review.revisions.count(), 1)

    def test_page_deletion_keeps_numeric_review_identity(self):
        self.page.delete()
        self.assertTrue(CalibrationReview.objects.filter(mushaf=self.mushaf, page_number=7).exists())

    def test_mushaf_deletion_does_not_resurrect_reviews(self):
        self._calibration()
        self.mushaf.delete()
        self.assertFalse(CalibrationReview.objects.exists())
        self.assertFalse(CalibrationSnapshot.objects.exists())

    def test_revision_is_immutable_and_requests_are_unique(self):
        _, review = self._calibration()
        revision = review.revisions.get(number=2)
        revision.payload = {"replacement": True}
        with self.assertRaises(ValidationError):
            revision.save()
        with self.assertRaises(IntegrityError), transaction.atomic():
            CalibrationRevision.objects.create(
                review=review, number=3, kind="processed", request_id=revision.request_id
            )
        with self.assertRaises(IntegrityError), transaction.atomic():
            CalibrationRevision.objects.create(review=review, number=1, kind="processed")

    def test_data_migration_captures_existing_edited_boundaries(self):
        executor = MigrationExecutor(connection)
        historical = executor.loader.project_state([("api", "0026_calibration_persistence")]).apps
        migration = import_module("api.migrations.0026_calibration_persistence")
        migration.preserve_legacy_boundaries(historical, SimpleNamespace(connection=connection))
        review = CalibrationReview.objects.get(mushaf=self.mushaf, page_number=7)
        self.assertEqual(review.revision, 1)
        self.assertEqual(
            review.payload,
            {
                "legacy_lines": [
                    {
                        "line_number": 2,
                        "line_id": str(self.line.pk),
                        "words": [{"word_id": None, "position": 0, "start_x": 200, "end_x": 150}],
                    }
                ]
            },
        )
        self.assertEqual(review.revisions.get().payload, review.payload)
        self.assertEqual(review.revisions.get().kind, "legacy")
        self.assertIsNone(review.confirmed_revision)

    def _assert_copied(self, target, source_snapshot):
        snapshot = target.calibration_snapshots.get()
        self.assertNotEqual(snapshot.pk, source_snapshot.pk)
        # The copy's own line, with the original's id kept as provenance.
        copied_line = target.pages.get(page_number=7).lines.get(line_number=2)
        self.assertEqual(snapshot.source_line_id, copied_line.pk)
        self.assertEqual(snapshot.metadata["source_line_id"], str(self.line.pk))
        self.assertEqual(snapshot.metadata["source_mushaf_id"], str(self.mushaf.pk))
        for name in ("image", "labels"):
            stored = getattr(snapshot, name)
            source = getattr(source_snapshot, name)
            self.assertNotEqual(stored.name, source.name)
            self.assertTrue(stored.name.startswith(f"mushafs/{target.pk}/calibration/"))
            with stored.open("rb") as copied, source.open("rb") as original:
                self.assertEqual(copied.read(), original.read())
        review = target.calibration_reviews.get()
        self.assertEqual((review.revision, review.confirmed_revision), (2, 1))
        self.assertEqual(review.payload["baseline_lines"][0]["snapshot_id"], str(snapshot.pk))
        self.assertEqual(review.payload["context"]["reference"]["snapshot_id"], str(snapshot.pk))
        self.assertEqual(review.revisions.get(number=1).payload["lines"][0]["snapshot_id"], str(snapshot.pk))
        self.assertEqual(review.revisions.get(number=1).kind, "confirmed")
        profile = target.calibration_profiles.get()
        self.assertEqual(profile.mode, "shadow")
        self.assertEqual(profile.payload, {"sample_refs": [str(snapshot.pk)], "config": {"k": 3}})
        self.assertTrue(copied_line.word_status.edited)
        self.assertEqual(copied_line.words.get().end_x, 150)

    def test_clone_copies_history_and_independent_files_with_shadow_profile(self):
        source_snapshot, _ = self._calibration()
        target = cloning.duplicate(self.mushaf, owner=self.mushaf.owner)
        self._assert_copied(target, source_snapshot)
        self.mushaf.delete()
        self.assertTrue(
            target.calibration_snapshots.get().image.storage.exists(target.calibration_snapshots.get().image.name)
        )

    def test_bundle_v2_round_trip_and_v1_compatibility(self):
        source_snapshot, _ = self._calibration()
        _, output = bundle.build(self.mushaf.pk, user=self.mushaf.owner)
        with output:
            data = output.read()
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertEqual(json.loads(archive.read("manifest.json"))["schema"], "mushaf-work/v2")
            self.assertIn("calibration.json", archive.namelist())
            members = {name: archive.read(name) for name in archive.namelist()}
        target = bare_mushaf("Imported", owner=self.mushaf.owner)
        bundle.apply_bundle(target.pk, SimpleUploadedFile("work.zip", data), user=target.owner)
        self._assert_copied(target, source_snapshot)

        manifest = json.loads(members["manifest.json"])
        manifest["schema"] = "mushaf-work/v1"
        legacy = io.BytesIO()
        with zipfile.ZipFile(legacy, "w") as archive:
            archive.writestr("manifest.json", json.dumps(manifest))
            archive.writestr("pages.json", members["pages.json"])
        old_target = bare_mushaf("Legacy import", owner=self.mushaf.owner)
        bundle.apply_bundle(old_target.pk, SimpleUploadedFile("v1.zip", legacy.getvalue()), user=old_target.owner)
        self.assertEqual(old_target.pages.count(), 1)
        self.assertFalse(old_target.calibration_reviews.exists())

    def test_import_appends_history_without_mutating_target_revisions(self):
        self._calibration()
        target = bare_mushaf("Existing target", owner=self.mushaf.owner)
        review = CalibrationReview.objects.create(mushaf=target, page_number=7, revision=1)
        original = CalibrationRevision.objects.create(
            review=review, number=1, kind="legacy", payload={"original": True}
        )
        _, output = bundle.build(self.mushaf.pk, user=self.mushaf.owner)
        with output:
            bundle.apply_bundle(target.pk, SimpleUploadedFile("work.zip", output.read()), user=target.owner)
        review.refresh_from_db()
        original.refresh_from_db()
        self.assertEqual((review.revision, review.confirmed_revision), (3, 2))
        self.assertEqual(original.payload, {"original": True})

    def test_missing_snapshot_file_rejects_bundle_and_rolls_back_rows(self):
        self._calibration()
        _, output = bundle.build(self.mushaf.pk, user=self.mushaf.owner)
        corrupt = io.BytesIO()
        with output, zipfile.ZipFile(output) as source, zipfile.ZipFile(corrupt, "w") as archive:
            for name in source.namelist():
                if not name.endswith("/labels.png"):
                    archive.writestr(name, source.read(name))
        target = bare_mushaf("Corrupt", owner=self.mushaf.owner)
        with self.assertRaises(HttpError):
            bundle.apply_bundle(target.pk, SimpleUploadedFile("bad.zip", corrupt.getvalue()), user=target.owner)
        self.assertFalse(target.calibration_snapshots.exists())
        self.assertFalse(target.pages.exists())

    def test_recursive_reference_remapping_does_not_mutate_source_payload(self):
        snapshot, _ = self._calibration()
        payload = bundle.serialize_calibration(self.mushaf)
        before = deepcopy(payload)
        target = bare_mushaf("Direct copy", owner=self.mushaf.owner)
        bundle.restore_calibration(target, payload, lambda *_: make_png_bytes())
        self.assertEqual(payload, before)
        self.assertNotEqual(target.calibration_reviews.get().payload["lines"][0]["snapshot_id"], str(snapshot.pk))
