"""Publishing, the public gallery, and duplicating into another account.

The two properties that matter here:

* publishing grants **read** only — it must never become an edit path;
* duplicating copies the *work* without copying the PDF, so a copy costs no
  storage. That is asserted by counting files on disk, not by trusting the code.
"""

import uuid

from django.core.files.uploadedfile import SimpleUploadedFile
from ninja.errors import HttpError

from api.models import EraseStroke, Line, Mushaf, Page, Segment, VisibilityChoices
from api.services import cloning, gallery
from api.services import mushaf as mushaf_service
from api.tests.helpers import ApiTestCase, MediaTestCase, default_user, make_pdf_bytes, make_user


def _create(owner, name="Owned", pages=3):
    return mushaf_service.create_mushaf(
        owner=owner,
        pdf_file=SimpleUploadedFile("m.pdf", make_pdf_bytes(pages), "application/pdf"),
        name=name,
        qiraa=None,
        first_quran_pdf_page=1,
        last_quran_pdf_page=None,
    )["mushaf"]


def _with_work(owner, name="Worked"):
    """A mushaf carrying a small but complete page/line/segment/stroke tree."""
    mushaf = Mushaf.objects.get(id=_create(owner, name)["id"])
    for page_number in (1, 2):
        page = Page.objects.create(
            mushaf=mushaf,
            page_number=page_number,
            bbox_x=10,
            bbox_y=20,
            bbox_w=500,
            bbox_h=700,
            reviewed=page_number == 1,
        )
        for line_number in (1, 2):
            line = Line.objects.create(
                page=page,
                line_number=line_number,
                bbox_x=10,
                bbox_y=20 * line_number,
                bbox_w=480,
                bbox_h=40,
            )
            Segment.objects.create(
                line=line, segment_order=1, bbox_x=10, bbox_w=200, has_separator=True, aya_number=line_number
            )
            EraseStroke.objects.create(line=line, brush_size=9, points=[[1, 2], [3, 4]])
    return mushaf


class PublishTests(MediaTestCase):
    def setUp(self):
        self.alice = default_user()

    def test_publish_lists_it_and_stamps_the_time(self):
        mushaf = Mushaf.objects.get(id=_create(self.alice, "ToPublish")["id"])
        self.assertEqual(mushaf.visibility, VisibilityChoices.PRIVATE)

        gallery.publish(mushaf.id, user=self.alice, description="A careful pass")

        mushaf.refresh_from_db()
        self.assertEqual(mushaf.visibility, VisibilityChoices.PUBLISHED)
        self.assertEqual(mushaf.description, "A careful pass")
        self.assertIsNotNone(mushaf.published_at)

    def test_republishing_keeps_the_original_timestamp(self):
        """Editing the blurb must not bump it back to the top of the gallery."""
        mushaf = Mushaf.objects.get(id=_create(self.alice, "Stable")["id"])
        gallery.publish(mushaf.id, user=self.alice, description="first")
        mushaf.refresh_from_db()
        first_stamp = mushaf.published_at

        gallery.publish(mushaf.id, user=self.alice, description="second")

        mushaf.refresh_from_db()
        self.assertEqual(mushaf.published_at, first_stamp)
        self.assertEqual(mushaf.description, "second")

    def test_unpublish_clears_it(self):
        mushaf = Mushaf.objects.get(id=_create(self.alice, "Temp")["id"])
        gallery.publish(mushaf.id, user=self.alice)
        gallery.unpublish(mushaf.id, user=self.alice)

        mushaf.refresh_from_db()
        self.assertEqual(mushaf.visibility, VisibilityChoices.PRIVATE)
        self.assertIsNone(mushaf.published_at)

    def test_gallery_lists_only_published(self):
        published = Mushaf.objects.get(id=_create(self.alice, "Shown")["id"])
        _create(self.alice, "Hidden")
        gallery.publish(published.id, user=self.alice)

        listing = gallery.list_published()

        self.assertEqual(listing["total"], 1)
        self.assertEqual([i["name"] for i in listing["items"]], ["Shown"])

    def test_gallery_card_shows_a_name_not_an_email(self):
        mushaf = Mushaf.objects.get(id=_create(self.alice, "Authored")["id"])
        gallery.publish(mushaf.id, user=self.alice)

        card = gallery.list_published()["items"][0]

        self.assertNotIn("@", card["owner_name"])
        self.assertEqual(card["owner_name"], self.alice.public_name)

    def test_card_marks_the_author_as_owner(self):
        """So the card can offer the author the way in, not a copy of their own."""
        mushaf = Mushaf.objects.get(id=_create(self.alice, "Authored")["id"])
        gallery.publish(mushaf.id, user=self.alice)

        self.assertTrue(gallery.list_published(user=self.alice)["items"][0]["is_owner"])
        self.assertFalse(gallery.list_published(user=make_user("bob@example.com"))["items"][0]["is_owner"])
        self.assertFalse(gallery.list_published()["items"][0]["is_owner"])

    def test_card_never_leaks_the_owner_id(self):
        """``owner_id`` is read to compute ``is_owner``; it must not be serialized."""
        mushaf = Mushaf.objects.get(id=_create(self.alice, "Authored")["id"])
        gallery.publish(mushaf.id, user=self.alice)

        self.assertNotIn("owner_id", gallery.list_published(user=self.alice)["items"][0])


class GalleryDetailTests(ApiTestCase):
    """The read-only detail page's payload."""

    def setUp(self):
        super().setUp()
        self.alice = default_user()
        self.mushaf = _with_work(self.alice, "Detailed")
        gallery.publish(self.mushaf.id, user=self.alice)

    def test_detail_reports_the_work_totals(self):
        detail = gallery.get_published(self.mushaf.id, user=None)

        self.assertEqual(detail["processed_page_count"], 2)
        self.assertEqual(detail["reviewed_page_count"], 1)
        self.assertEqual(detail["line_count"], 4)
        # Nothing has been exported, so the line-images download would be empty.
        self.assertEqual(detail["exported_line_count"], 0)

    def test_detail_carries_the_pdf_range(self):
        detail = gallery.get_published(self.mushaf.id, user=None)

        self.assertEqual(detail["pdf_page_count"], self.mushaf.pdf_page_count)
        self.assertEqual(detail["first_quran_pdf_page"], self.mushaf.first_quran_pdf_page)
        self.assertEqual(detail["last_quran_pdf_page"], self.mushaf.last_quran_pdf_page)

    def test_detail_marks_the_owner(self):
        self.assertTrue(gallery.get_published(self.mushaf.id, user=self.alice)["is_owner"])
        self.assertFalse(gallery.get_published(self.mushaf.id, user=None)["is_owner"])


class PublishedAccessTests(ApiTestCase):
    """Publishing grants read to everyone — and nothing more."""

    def setUp(self):
        super().setUp()
        self.other = make_user("other@example.com")
        self.mushaf = Mushaf.objects.get(id=_create(self.other, "TheirPublished")["id"])

    def _publish(self):
        gallery.publish(self.mushaf.id, user=self.other)

    def test_anonymous_may_browse_and_read_a_published_mushaf(self):
        self._publish()
        self.client.logout()

        self.assertEqual(self.client.get("/api/gallery").status_code, 200)
        self.assertEqual(self.client.get(f"/api/gallery/{self.mushaf.id}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/gallery/{self.mushaf.id}/coordinates").status_code, 200)

    def test_anonymous_cannot_read_an_unpublished_mushaf(self):
        self.client.logout()
        self.assertEqual(self.client.get(f"/api/gallery/{self.mushaf.id}").status_code, 404)

    def test_publishing_does_not_grant_write_access(self):
        """The seam is read-only: a published mushaf is still not editable."""
        self._publish()

        for method, path, kwargs in [
            ("patch", f"/api/mushafs/{self.mushaf.id}", {"data": {"name": "Hijacked"}}),
            ("delete", f"/api/mushafs/{self.mushaf.id}", {}),
            ("post", f"/api/mushafs/{self.mushaf.id}/publish", {"data": {}}),
        ]:
            with self.subTest(path=f"{method} {path}"):
                resp = getattr(self.client, method)(path, content_type="application/json", **kwargs)
                self.assertEqual(resp.status_code, 404)

        self.mushaf.refresh_from_db()
        self.assertEqual(self.mushaf.name, "TheirPublished")

    def test_published_mushaf_is_not_in_your_own_list(self):
        """Someone else's published mushaf belongs in the gallery, not your shelf."""
        self._publish()
        body = self.client.get("/api/mushafs").json()
        self.assertEqual(body, [])

    def test_duplicating_requires_a_session(self):
        self._publish()
        self.client.logout()
        resp = self.client.post(f"/api/gallery/{self.mushaf.id}/duplicate")
        self.assertEqual(resp.status_code, 401)


class DuplicateTests(MediaTestCase):
    def setUp(self):
        self.alice = default_user()
        self.bob = make_user("bob@example.com")

    def test_copies_the_whole_tree(self):
        source = _with_work(self.alice)

        copy = cloning.duplicate(source, owner=self.bob)

        self.assertEqual(copy.owner_id, self.bob.pk)
        self.assertEqual(copy.pages.count(), source.pages.count())
        self.assertEqual(
            Line.objects.filter(page__mushaf=copy).count(),
            Line.objects.filter(page__mushaf=source).count(),
        )
        self.assertEqual(
            Segment.objects.filter(line__page__mushaf=copy).count(),
            Segment.objects.filter(line__page__mushaf=source).count(),
        )
        self.assertEqual(
            EraseStroke.objects.filter(line__page__mushaf=copy).count(),
            EraseStroke.objects.filter(line__page__mushaf=source).count(),
        )

    def test_geometry_and_review_state_survive(self):
        source = _with_work(self.alice)
        copy = cloning.duplicate(source, owner=self.bob)

        page = copy.pages.get(page_number=1)
        self.assertEqual((page.bbox_x, page.bbox_y, page.bbox_w, page.bbox_h), (10, 20, 500, 700))
        self.assertTrue(page.reviewed)
        self.assertFalse(copy.pages.get(page_number=2).reviewed)

        segment = Segment.objects.filter(line__page=page, line__line_number=1).first()
        self.assertIsNotNone(segment)
        self.assertTrue(segment.has_separator)
        self.assertEqual(segment.aya_number, 1)

    def test_segments_stay_attached_to_the_right_line(self):
        """The FK re-pointing is the part most likely to go subtly wrong."""
        source = _with_work(self.alice)
        copy = cloning.duplicate(source, owner=self.bob)

        for page_number in (1, 2):
            for line_number in (1, 2):
                line = Line.objects.get(page__mushaf=copy, page__page_number=page_number, line_number=line_number)
                aya_numbers = list(line.segments.values_list("aya_number", flat=True))
                self.assertEqual(aya_numbers, [line_number], f"page {page_number} line {line_number}")

    def test_the_pdf_is_shared_not_copied(self):
        """The whole point: a duplicate must add no bytes to disk."""
        source = _with_work(self.alice)
        storage = source.pdf_file.storage
        _, files_before = storage.listdir("pdfs")

        copy = cloning.duplicate(source, owner=self.bob)

        _, files_after = storage.listdir("pdfs")
        self.assertEqual(len(files_after), len(files_before), "duplication wrote a second copy of the PDF")
        self.assertEqual(copy.pdf_file.name, source.pdf_file.name)

    def test_the_copy_gets_its_own_cover(self):
        """Unlike the PDF, the thumbnail is a few KB and belongs to the copy's
        own directory — so its media folder is self-contained."""
        source = _with_work(self.alice)

        copy = cloning.duplicate(source, owner=self.bob)

        self.assertNotEqual(copy.thumbnail.name, source.thumbnail.name)
        self.assertEqual(copy.thumbnail.name, f"mushafs/{copy.id}/thumbnail.png")
        self.assertTrue(copy.thumbnail.storage.exists(copy.thumbnail.name))

    def test_exported_pngs_are_not_carried_over(self):
        """Line PNGs are derived output; the new owner re-exports them."""
        source = _with_work(self.alice)
        line = Line.objects.filter(page__mushaf=source).first()
        line.line_png.save("x.png", SimpleUploadedFile("x.png", b"not-a-real-png"), save=True)

        copy = cloning.duplicate(source, owner=self.bob)

        self.assertFalse(any(line.line_png for line in Line.objects.filter(page__mushaf=copy)))

    def test_the_copy_is_independent_of_its_source(self):
        source = _with_work(self.alice)
        copy = cloning.duplicate(source, owner=self.bob)

        copy_page = copy.pages.get(page_number=1)
        copy_page.lines.all().delete()

        self.assertEqual(source.pages.get(page_number=1).lines.count(), 2)

    def test_the_copy_starts_private_and_records_its_origin(self):
        source = _with_work(self.alice)
        gallery.publish(source.id, user=self.alice)
        source.refresh_from_db()

        copy = cloning.duplicate(source, owner=self.bob)

        self.assertEqual(copy.visibility, VisibilityChoices.PRIVATE)
        self.assertEqual(copy.duplicated_from_id, source.id)

    def test_a_name_clash_gets_a_copy_suffix(self):
        source = _with_work(self.alice, "Madinah")
        _create(self.bob, "Madinah")

        first = cloning.duplicate(source, owner=self.bob)
        second = cloning.duplicate(source, owner=self.bob)

        self.assertEqual(first.name, "Madinah (copy)")
        self.assertEqual(second.name, "Madinah (copy 2)")

    def test_no_clash_keeps_the_original_name(self):
        source = _with_work(self.alice, "Unclashed")
        self.assertEqual(cloning.duplicate(source, owner=self.bob).name, "Unclashed")

    def test_you_cannot_duplicate_someone_elses_private_mushaf(self):
        source = _with_work(self.alice, "Private")
        with self.assertRaises(HttpError) as ctx:
            cloning.duplicate_by_id(uuid.UUID(str(source.id)), owner=self.bob)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertFalse(Mushaf.objects.filter(owner=self.bob).exists())

    def test_deleting_the_source_leaves_the_copy_and_its_pdf_intact(self):
        """Together with the refcount guard: the copy must keep working."""
        source = _with_work(self.alice, "Origin")
        copy = cloning.duplicate(source, owner=self.bob)
        shared = copy.pdf_file.name
        storage = copy.pdf_file.storage

        mushaf_service.delete_mushaf(source.id, user=self.alice)

        copy.refresh_from_db()
        self.assertTrue(storage.exists(shared))
        self.assertEqual(copy.pages.count(), 2)
        self.assertIsNone(copy.duplicated_from_id)  # SET_NULL, so the copy survives


class DuplicateApiTests(ApiTestCase):
    def test_duplicate_endpoint_copies_into_the_caller(self):
        other = make_user("other@example.com")
        source = _with_work(other, "Public")
        gallery.publish(source.id, user=other)

        resp = self.client.post(f"/api/gallery/{source.id}/duplicate")

        self.assertEqual(resp.status_code, 201)
        copy = Mushaf.objects.get(id=resp.json()["id"])
        self.assertEqual(copy.owner_id, self.user.pk)
        self.assertEqual(copy.pages.count(), 2)

    def test_cannot_duplicate_an_unpublished_mushaf(self):
        other = make_user("other@example.com")
        source = _with_work(other, "StillPrivate")

        resp = self.client.post(f"/api/gallery/{source.id}/duplicate")

        self.assertEqual(resp.status_code, 404)
        self.assertFalse(Mushaf.objects.filter(owner=self.user).exists())
