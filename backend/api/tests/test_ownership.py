"""Ownership isolation: whose mushafs you can see, and what sharing a file means.

The security property under test is that another account's mushaf is
indistinguishable from one that does not exist.
"""

import uuid

from django.core.files.uploadedfile import SimpleUploadedFile
from ninja.errors import HttpError

from api.models import Mushaf
from api.services import editing
from api.services import export as export_service
from api.services import mushaf as mushaf_service
from api.tests.helpers import ApiTestCase, MediaTestCase, default_user, make_pdf_bytes, make_user


def _create(owner, name="Owned", pages=5):
    return mushaf_service.create_mushaf(
        owner=owner,
        pdf_file=SimpleUploadedFile("m.pdf", make_pdf_bytes(pages), "application/pdf"),
        name=name,
        qiraa=None,
        first_quran_pdf_page=1,
        last_quran_pdf_page=None,
    )["mushaf"]


class ScopingTests(MediaTestCase):
    def setUp(self):
        self.alice = default_user()
        self.bob = make_user("bob@example.com")

    def test_list_shows_only_your_own(self):
        _create(self.alice, "Alice's")
        _create(self.bob, "Bob's")

        alice_names = [m["name"] for m in mushaf_service.list_mushafs(user=self.alice)]
        bob_names = [m["name"] for m in mushaf_service.list_mushafs(user=self.bob)]

        self.assertEqual(alice_names, ["Alice's"])
        self.assertEqual(bob_names, ["Bob's"])

    def test_another_users_mushaf_is_404_not_403(self):
        """403 would confirm the id exists, which is what an id-prober wants."""
        created = _create(self.alice, "Private")
        with self.assertRaises(HttpError) as ctx:
            mushaf_service.get_mushaf(uuid.UUID(str(created["id"])), user=self.bob)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_read_only_access_is_scoped_too(self):
        """`write=False` opens *published* mushafs to everyone, nothing else.

        A private mushaf must still deny on the read path exactly as on the
        write path — see test_gallery for the published side of this seam.
        """
        created = _create(self.alice, "AlsoPrivate")
        with self.assertRaises(HttpError) as ctx:
            mushaf_service.get_mushaf(uuid.UUID(str(created["id"])), user=self.bob, write=False)
        self.assertEqual(ctx.exception.status_code, 404)

    def test_every_read_path_refuses_another_users_mushaf(self):
        created = _create(self.alice, "Guarded")
        mushaf_id = uuid.UUID(str(created["id"]))

        for label, call in [
            ("detail", lambda: mushaf_service.get_mushaf_detail(mushaf_id, user=self.bob)),
            ("stats", lambda: mushaf_service.mushaf_stats(mushaf_id, user=self.bob)),
            ("templates", lambda: mushaf_service.list_templates(mushaf_id, user=self.bob)),
            ("pages", lambda: editing.list_pages(mushaf_id, user=self.bob)),
            ("review_data", lambda: editing.review_data(mushaf_id, user=self.bob)),
            ("page_data", lambda: editing.get_page_data(mushaf_id, 1, user=self.bob)),
            ("coordinates", lambda: export_service.coordinates_json(mushaf_id, user=self.bob)),
        ]:
            with self.subTest(path=label), self.assertRaises(HttpError) as ctx:
                call()
            self.assertEqual(ctx.exception.status_code, 404)

    def test_deleting_someone_elses_mushaf_is_refused(self):
        created = _create(self.alice, "NotYours")
        with self.assertRaises(HttpError):
            mushaf_service.delete_mushaf(uuid.UUID(str(created["id"])), user=self.bob)
        self.assertTrue(Mushaf.objects.filter(id=created["id"]).exists())


class NameUniquenessTests(MediaTestCase):
    def setUp(self):
        self.alice = default_user()
        self.bob = make_user("bob@example.com")

    def test_two_owners_may_use_the_same_name(self):
        """The point of the per-owner constraint: both can keep a 'مصحف المدينة'."""
        _create(self.alice, "مصحف المدينة")
        _create(self.bob, "مصحف المدينة")
        self.assertEqual(Mushaf.objects.filter(name="مصحف المدينة").count(), 2)

    def test_the_same_owner_still_cannot_reuse_a_name(self):
        _create(self.alice, "Twice")
        with self.assertRaises(HttpError) as ctx:
            _create(self.alice, "Twice")
        self.assertEqual(ctx.exception.status_code, 409)

    def test_rename_onto_another_owners_name_is_allowed(self):
        _create(self.alice, "Shared")
        bob_mushaf = _create(self.bob, "BobOriginal")
        updated = mushaf_service.update_mushaf(uuid.UUID(str(bob_mushaf["id"])), {"name": "Shared"}, user=self.bob)
        self.assertEqual(updated["name"], "Shared")


class SharedFileDeletionTests(MediaTestCase):
    """Deleting one mushaf must not destroy a file another still points at.

    Latent until Phase 3: duplication will make copies share the source PDF by
    assigning ``pdf_file.name`` (a path string) rather than copying bytes, which
    is what makes duplication cost no storage. This sets up that exact state.
    """

    def setUp(self):
        self.alice = default_user()
        self.bob = make_user("bob@example.com")

    def _share_pdf(self):
        original = Mushaf.objects.get(id=_create(self.alice, "Original")["id"])
        copy = Mushaf.objects.get(id=_create(self.bob, "Copy")["id"])
        copy.pdf_file.name = original.pdf_file.name  # the Phase 3 duplication move
        copy.thumbnail.name = original.thumbnail.name
        copy.save(update_fields=["pdf_file", "thumbnail"])
        return original, copy

    def test_deleting_one_leaves_the_shared_file_for_the_other(self):
        original, copy = self._share_pdf()
        shared_path = original.pdf_file.name
        storage = original.pdf_file.storage

        mushaf_service.delete_mushaf(original.id, user=self.alice)

        self.assertTrue(
            storage.exists(shared_path),
            "deleting one mushaf destroyed the PDF another still references",
        )
        copy.refresh_from_db()
        self.assertTrue(storage.exists(copy.pdf_file.name))

    def test_deleting_the_last_referrer_does_remove_the_file(self):
        """The guard must not leak files — once nobody points at it, it goes."""
        original, copy = self._share_pdf()
        shared_path = original.pdf_file.name
        storage = original.pdf_file.storage

        mushaf_service.delete_mushaf(original.id, user=self.alice)
        mushaf_service.delete_mushaf(copy.id, user=self.bob)

        self.assertFalse(storage.exists(shared_path))

    def test_an_unshared_file_is_still_deleted(self):
        solo = Mushaf.objects.get(id=_create(self.alice, "Solo")["id"])
        path = solo.pdf_file.name
        storage = solo.pdf_file.storage

        mushaf_service.delete_mushaf(solo.id, user=self.alice)

        self.assertFalse(storage.exists(path))


class ApiScopingTests(ApiTestCase):
    """The same isolation, seen through HTTP."""

    def test_another_users_mushaf_is_404_over_http(self):
        other = make_user("other@example.com")
        created = _create(other, "TheirMushaf")

        for path in [
            f"/api/mushafs/{created['id']}",
            f"/api/mushafs/{created['id']}/stats",
            f"/api/mushafs/{created['id']}/templates",
            f"/api/mushafs/{created['id']}/pages",
            f"/api/mushafs/{created['id']}/review-data",
        ]:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)

    def test_list_endpoint_hides_other_accounts(self):
        other = make_user("other@example.com")
        _create(other, "Theirs")
        _create(self.user, "Mine")

        body = self.client.get("/api/mushafs").json()
        self.assertEqual([m["name"] for m in body], ["Mine"])
