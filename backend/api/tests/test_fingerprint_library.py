"""The mushaf's one stored fingerprint set (docs/plans/fingerprint-set.md).

The pages of :mod:`api.tests.test_calibration_library`: page 1 confirmed with its dots
typed ijamDot and its bars fatha, page 2 processed.
"""

import io
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from django.core.management import call_command

from api.models import (
    CalibrationSettings,
    FingerprintLibrary,
    FingerprintShape,
    ProcessJob,
    ProcessJobKindChoices,
    ProcessJobStateChoices,
    RemovedShape,
)
from api.services import calibration, cloning, fingerprint_rebuild, fingerprint_store
from api.services.fingerprint_rows import load_stored_groups
from api.services.fingerprint_updates import check_every_shape_matches_labels
from api.services.jobs.creation import create_queued_job
from api.tests.test_calibration_api import BAR, DOT, drawn_pages
from api.tests.test_calibration_library import LibraryTestCase


class FingerprintSetTestCase(LibraryTestCase):
    def library_row(self) -> FingerprintLibrary:
        return FingerprintLibrary.objects.get(mushaf=self.mushaf)

    def kinds(self) -> list[tuple[str, str]]:
        return [group.kind for group in load_stored_groups(self.library_row()).groups]

    def shape_keys_of_page(self, page: int) -> set[tuple[str, int]]:
        return {
            shape.key
            for group in load_stored_groups(self.library_row()).groups
            for shape in group.shapes()
            if shape.page_number == page
        }


class ConfirmTests(FingerprintSetTestCase):
    def test_a_confirm_grows_the_set_and_bumps_its_version(self):
        before = self.library_row().version
        self.assertEqual(self.shape_keys_of_page(2), set())
        body = self.draft(self.doc)
        for index in (0, 1):
            self.type_mark(body, index, DOT[0], "ijamDot")
            self.type_mark(body, index, BAR[0], "fatha")
        self.assertEqual(self.confirm(2, body).status_code, 200)
        self.assertGreater(self.library_row().version, before)
        # Page 2 prints its shapes exactly like page 1's fingerprints: nothing new to keep.
        kinds = self.kinds()
        self.assertEqual(
            sorted(kind for kind in kinds if kind[0] == "mark"), [("mark", ":fatha"), ("mark", ":ijamDot")]
        )
        self.assertTrue(any(role == "body" for role, _ in kinds))

    def test_a_reconfirm_with_a_retyped_mark_moves_its_shape(self):
        body = self.draft(self.document(1))
        for index in (0, 1):
            self.type_mark(body, index, BAR[0], "kasra")
        self.assertEqual(self.confirm(1, body).status_code, 200)
        self.assertIn(("mark", ":kasra"), self.kinds())
        self.assertNotIn(("mark", ":fatha"), self.kinds())
        self.assertFalse(self.library_row().needs_rebuild)


class LookupTests(FingerprintSetTestCase):
    def test_requests_never_build_once_the_set_is_stored(self):
        fingerprint_store.CURRENT_LIBRARIES.clear()
        with mock.patch.object(fingerprint_rebuild, "build_library", side_effect=AssertionError("built")):
            self.library(2)
            self.compare(self.draft(self.doc), self.doc["lines"][0], self.blob_at(self.doc["lines"][0], BAR[0]))

    def test_processing_a_confirmed_page_hides_its_own_shapes(self):
        revision = self.document(1)["revision"]
        with drawn_pages(bar=True):
            calibration.make_fresh_draft_of_page(self.mushaf, 1, expected_revision=revision)
        record = self.document(1)["library"]
        self.assertTrue(record["hid_own_page"])
        self.assertEqual((record["pages"], record["examples"]), ([], 0))
        hidden = fingerprint_store.load_current_library(self.mushaf, hiding_page=1)
        self.assertEqual(hidden.refs, [])

    def test_a_set_from_older_code_is_regrouped_at_its_first_use(self):
        FingerprintLibrary.objects.filter(mushaf=self.mushaf).update(library_version=0)
        library = fingerprint_store.load_current_library(self.mushaf)
        self.assertGreater(library.fingerprints, 0)
        self.assertNotEqual(self.library_row().library_version, 0)


class RebuildTests(FingerprintSetTestCase):
    def test_a_rebuild_keeps_looks_right_and_leaves_removals_out(self):
        fatha = FingerprintShape.objects.get(library=self.library_row(), group__key=":fatha")
        fatha.looks_right = True
        fatha.save()
        dot = FingerprintShape.objects.get(library=self.library_row(), group__key=":ijamDot")
        RemovedShape.objects.create(
            mushaf=self.mushaf, snapshot=dot.snapshot, blob_id=dot.blob_id, role="mark", key=":ijamDot"
        )
        version = self.library_row().version
        fingerprint_rebuild.rebuild_fingerprint_set(self.mushaf)
        library_row = self.library_row()
        self.assertGreater(library_row.version, version)
        kept = FingerprintShape.objects.get(library=library_row, group__key=":fatha", is_fingerprint=True)
        self.assertEqual((kept.snapshot_id, kept.blob_id, kept.looks_right), (fatha.snapshot_id, fatha.blob_id, True))
        self.assertFalse(
            FingerprintShape.objects.filter(library=library_row, snapshot=dot.snapshot, blob_id=dot.blob_id).exists()
        )

    def test_a_failed_check_flags_the_set_for_a_rebuild(self):
        self.assertTrue(check_every_shape_matches_labels(self.mushaf).passed)
        FingerprintShape.objects.filter(library=self.library_row(), group__key=":fatha").update(blob_id=9999)
        found = check_every_shape_matches_labels(self.mushaf)
        self.assertFalse(found.passed)
        self.assertTrue(self.library_row().needs_rebuild)
        self.assertTrue(self.library(2)["needs_rebuild"])


class TransferTests(FingerprintSetTestCase):
    def test_a_copy_carries_an_identical_set(self):
        target = cloning.duplicate(self.mushaf, owner=self.mushaf.owner)
        source = load_stored_groups(self.library_row()).groups
        copied = load_stored_groups(FingerprintLibrary.objects.get(mushaf=target)).groups
        self.assertEqual([group.kind for group in copied], [group.kind for group in source])
        self.assertEqual(
            [(shape.blob_id, shape.page_number) for group in copied for shape in group.shapes()],
            [(shape.blob_id, shape.page_number) for group in source for shape in group.shapes()],
        )
        self.assertTrue(
            all(
                shape.snapshot_id != original.snapshot_id
                for shape, original in zip(copied[0].shapes(), source[0].shapes(), strict=True)
            )
        )

    def test_restart_leaves_nothing_behind(self):
        RemovedShape.objects.create(
            mushaf=self.mushaf,
            snapshot_id=self.doc["lines"][0]["snapshot_id"],
            blob_id=1,
            role="mark",
            key=":fatha",
        )
        with TemporaryDirectory() as directory:
            call_command(
                "restart_calibration",
                str(self.mushaf.pk),
                apply=True,
                backup=Path(directory) / "backup.zip",
                stdout=io.StringIO(),
            )
        self.assertFalse(FingerprintLibrary.objects.filter(mushaf=self.mushaf).exists())
        self.assertFalse(RemovedShape.objects.filter(mushaf=self.mushaf).exists())
        self.assertFalse(self.mushaf.calibration_reviews.exists())


class RebuildJobTests(FingerprintSetTestCase):
    def settings_url(self) -> str:
        return f"/api/mushafs/{self.mushaf.id}/calibration/settings"

    def test_a_new_limit_rebuilds_the_set_in_the_background_keeping_looks_right(self):
        fatha = FingerprintShape.objects.get(library=self.library_row(), group__key=":fatha")
        fatha.looks_right = True
        fatha.save()
        version = self.library_row().version
        response = self.client.put(self.settings_url(), {"revision": 0, "limit": 0.5}, content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        job = ProcessJob.objects.filter(mushaf=self.mushaf, kind=ProcessJobKindChoices.LIBRARY_REBUILD).get()
        self.assertEqual(job.state, ProcessJobStateChoices.COMPLETED)
        library_row = self.library_row()
        self.assertEqual(library_row.limit, 0.5)
        self.assertGreater(library_row.version, version)
        kept = FingerprintShape.objects.get(library=library_row, group__key=":fatha", is_fingerprint=True)
        self.assertEqual((kept.blob_id, kept.looks_right), (fatha.blob_id, True))

    def test_the_same_limit_again_starts_nothing(self):
        response = self.client.put(self.settings_url(), {"revision": 0, "limit": 0.27}, content_type="application/json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertFalse(ProcessJob.objects.filter(kind=ProcessJobKindChoices.LIBRARY_REBUILD).exists())

    def test_a_new_limit_is_refused_while_another_job_holds_the_mushaf(self):
        create_queued_job(
            kind=ProcessJobKindChoices.DETECTION,
            mushaf=self.mushaf,
            requested_by=None,
            params={},
            first_page=1,
            last_page=1,
            total=1,
        )
        response = self.client.put(self.settings_url(), {"revision": 0, "limit": 0.5}, content_type="application/json")
        self.assertEqual(response.status_code, 409, response.content)
        self.assertFalse(CalibrationSettings.objects.filter(mushaf=self.mushaf, library_limit=0.5).exists())

    def test_the_rebuild_button_starts_a_job(self):
        version = self.library_row().version
        response = self.client.post(f"/api/mushafs/{self.mushaf.id}/calibration/library/rebuild")
        self.assertEqual(response.status_code, 202, response.content)
        self.assertEqual(response.json()["job"]["kind"], "library_rebuild")
        self.assertGreater(self.library_row().version, version)
        polled = self.client.get(f"/api/mushafs/{self.mushaf.id}/calibration/job").json()["job"]
        self.assertEqual((polled["kind"], polled["state"]), ("library_rebuild", "completed"))
