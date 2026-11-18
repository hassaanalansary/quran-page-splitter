"""What keeps Ink's requests to the fingerprint library short.

Three costs that grew with every confirmed page:

* learning *which* approvals a page's library comes from read every confirmation's
  whole payload, on every request;
* requests arriving while a library was being built each built another copy;
* every build measured most confirmed blobs' descriptors again.
"""

import threading
import time
from unittest import mock

import numpy as np
from django.test import SimpleTestCase

from api.services import calibration as calibration_service
from api.services import calibration_snapshots as snapshots
from api.services.build_once import BuildOnce
from api.services.calibration_feature_files import saved_features_path
from api.tests.test_calibration_api import CalibrationApiTestCase


class ConfirmedPageTestCase(CalibrationApiTestCase):
    """Page 1 processed and confirmed; page 2 processed."""

    def setUp(self):
        super().setUp()
        self.process(1)
        self.assertEqual(self.confirm(1, self.draft(self.document(1))).status_code, 200)
        self.process(2)


class ApprovedTests(ConfirmedPageTestCase):
    def test_approvals_are_read_without_their_payloads(self):
        [approval] = calibration_service._approved(self.mushaf, 2)
        self.assertIn("payload", approval.get_deferred_fields())
        self.assertEqual(approval.review.page_number, 1)
        self.assertEqual(calibration_service._approved(self.mushaf, 1), [])

    def test_payloads_are_read_where_the_examples_are_needed(self):
        approved = calibration_service._approved(self.mushaf, 2)
        [loaded] = calibration_service.approvals_with_payloads(approved)
        self.assertEqual(loaded.pk, approved[0].pk)
        self.assertNotIn("payload", loaded.get_deferred_fields())
        self.assertTrue(loaded.payload["lines"])

    def test_the_library_and_its_signature_are_what_they_were(self):
        profile, library = calibration_service.profile_for(self.mushaf, 2)
        self.assertEqual(profile.payload["pages"], [1])
        self.assertGreater(library.examples, 0)


class FeatureFileTests(ConfirmedPageTestCase):
    def snapshot(self):
        line = self.document(2)["lines"][0]
        return snapshots.CalibrationSnapshot.objects.get(pk=line["snapshot_id"])

    def test_descriptors_are_kept_beside_the_snapshot_and_read_back(self):
        snapshot = self.snapshot()
        snapshots._FEATURES.clear()
        measured = snapshots.blob_features(snapshot)
        self.assertTrue(saved_features_path(snapshot).exists())
        snapshots._FEATURES.clear()
        with mock.patch.object(snapshots, "measure_blob_features", side_effect=AssertionError("measured again")):
            read = snapshots.blob_features(snapshot)
        self.assertEqual(sorted(read), sorted(measured))
        for ident, vector in measured.items():
            np.testing.assert_array_equal(read[ident], vector)

    def test_an_unreadable_file_is_measured_again(self):
        snapshot = self.snapshot()
        snapshots._FEATURES.clear()
        measured = snapshots.blob_features(snapshot)
        saved_features_path(snapshot).write_bytes(b"not an archive")
        snapshots._FEATURES.clear()
        again = snapshots.blob_features(snapshot)
        self.assertEqual(sorted(again), sorted(measured))
        self.assertIsNotNone(np.load(saved_features_path(snapshot)))


class BuildOnceTests(SimpleTestCase):
    def test_one_key_one_lock_and_other_keys_their_own(self):
        builds = BuildOnce()
        self.assertIs(builds.lock_for("a"), builds.lock_for("a"))
        self.assertIsNot(builds.lock_for("a"), builds.lock_for("b"))

    def test_requests_arriving_during_a_build_wait_for_it(self):
        # Four requests for one page's library at once: one build, one library.
        calls = []

        def slow_build(samples, *, method, limit):
            calls.append(1)
            time.sleep(0.2)
            return object()

        profile = mock.Mock(signature="same", payload={"revisions": [], "comparison": None, "limit": None})
        mushaf = mock.Mock(pk="mushaf")
        revisions = mock.MagicMock()
        revisions.objects.filter.return_value.select_related.return_value.defer.return_value = []
        found = []
        calibration_service._LIBRARIES.clear()
        with (
            mock.patch.object(calibration_service, "build_library", side_effect=slow_build),
            mock.patch.object(calibration_service, "_samples", return_value=[]),
            mock.patch.object(calibration_service, "CalibrationRevision", revisions),
        ):
            threads = [
                threading.Thread(target=lambda: found.append(calibration_service._library_of(mushaf, profile)))
                for _ in range(4)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        calibration_service._LIBRARIES.clear()
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(found), 4)
        self.assertTrue(all(library is found[0] for library in found))
