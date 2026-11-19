"""What keeps Ink's requests to the fingerprint set short.

Costs that grew with every confirmed page:

* learning *which* approvals there are read every confirmation's whole payload;
* requests arriving while the set was being loaded each loaded another copy;
* every build measured most confirmed blobs' descriptors again.

The set itself is stored now (``test_fingerprint_library``); these keep the rest short.
"""

import threading
import time
from unittest import mock

import numpy as np
from django.test import SimpleTestCase

from api.services import calibration_snapshots as snapshots
from api.services import fingerprint_store
from api.services.build_once import BuildOnce
from api.services.calibration_examples import find_confirmed_revisions, load_revision_payloads
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
        [approval] = find_confirmed_revisions(self.mushaf)
        self.assertIn("payload", approval.get_deferred_fields())
        self.assertEqual(approval.review.page_number, 1)

    def test_payloads_are_read_where_the_examples_are_needed(self):
        approved = find_confirmed_revisions(self.mushaf)
        [loaded] = load_revision_payloads(approved)
        self.assertEqual(loaded.pk, approved[0].pk)
        self.assertNotIn("payload", loaded.get_deferred_fields())
        self.assertTrue(loaded.payload["lines"])

    def test_the_set_holds_the_confirmed_page(self):
        library = fingerprint_store.load_current_library(self.mushaf)
        self.assertEqual({ref["page_number"] for ref in library.refs}, {1})
        self.assertGreater(library.examples, 0)


class FeatureFileTests(ConfirmedPageTestCase):
    def snapshot(self):
        line = self.document(2)["lines"][0]
        return snapshots.CalibrationSnapshot.objects.get(pk=line["snapshot_id"])

    def test_descriptors_are_kept_beside_the_snapshot_and_read_back(self):
        snapshot = self.snapshot()
        snapshots.FEATURES_CACHE.clear()
        measured = snapshots.blob_features(snapshot)
        self.assertTrue(saved_features_path(snapshot).exists())
        snapshots.FEATURES_CACHE.clear()
        with mock.patch.object(snapshots, "measure_blob_features", side_effect=AssertionError("measured again")):
            read = snapshots.blob_features(snapshot)
        self.assertEqual(sorted(read), sorted(measured))
        for ident, vector in measured.items():
            np.testing.assert_array_equal(read[ident], vector)

    def test_an_unreadable_file_is_measured_again(self):
        snapshot = self.snapshot()
        snapshots.FEATURES_CACHE.clear()
        measured = snapshots.blob_features(snapshot)
        saved_features_path(snapshot).write_bytes(b"not an archive")
        snapshots.FEATURES_CACHE.clear()
        again = snapshots.blob_features(snapshot)
        self.assertEqual(sorted(again), sorted(measured))
        self.assertIsNotNone(np.load(saved_features_path(snapshot)))


class BuildOnceTests(SimpleTestCase):
    def test_one_key_one_lock_and_other_keys_their_own(self):
        builds = BuildOnce()
        self.assertIs(builds.lock_for("a"), builds.lock_for("a"))
        self.assertIsNot(builds.lock_for("a"), builds.lock_for("b"))

    def test_requests_arriving_during_a_load_wait_for_it(self):
        # Four requests for the same version at once: one load, one library.
        calls = []

        def slow_load(library_row):
            calls.append(1)
            time.sleep(0.2)
            return mock.Mock(groups=[])

        library_row = mock.Mock(pk="set", version=7, limit=0.27, comparison="descriptor32")
        found = []
        fingerprint_store.CURRENT_LIBRARIES.clear()
        with (
            mock.patch.object(fingerprint_store, "load_stored_groups", side_effect=slow_load),
            mock.patch.object(fingerprint_store, "build_library_from_groups", side_effect=lambda *args: object()),
        ):
            threads = [
                threading.Thread(
                    target=lambda: found.append(
                        fingerprint_store.load_library_version(mock.Mock(pk="mushaf"), library_row, None)
                    )
                )
                for _ in range(4)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        fingerprint_store.CURRENT_LIBRARIES.clear()
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(found), 4)
        self.assertTrue(all(library is found[0] for library in found))
