"""Tests for the activity feed: event emission + listing."""

from datetime import timedelta

from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone

from api.models import ActivityEvent, ActivityTypeChoices, Mushaf
from api.services import activity, editing, suras
from api.services import mushaf as mushaf_service
from api.tests.helpers import MediaTestCase, bare_mushaf, default_user, make_pdf_bytes, make_png_bytes


def _create(name: str = "ActM", pages: int = 5):
    return mushaf_service.create_mushaf(
        owner=default_user(),
        pdf_file=SimpleUploadedFile("original-scan.pdf", make_pdf_bytes(pages), "application/pdf"),
        name=name,
        qiraa=None,
        first_quran_pdf_page=1,
        last_quran_pdf_page=None,
    )["mushaf"]


class EmissionTests(MediaTestCase):
    def test_create_emits_and_captures_original_filename(self):
        created = _create()
        mushaf = Mushaf.objects.get(id=created["id"])
        self.assertEqual(mushaf.pdf_original_name, "original-scan.pdf")
        event = mushaf.activity_events.get(type=ActivityTypeChoices.MUSHAF_CREATED)
        self.assertEqual(event.payload, {"pdf_original_name": "original-scan.pdf"})

    def test_bounds_patch_emits_only_on_actual_change(self):
        created = _create("ActBounds")
        mushaf_service.update_mushaf(created["id"], {"first_quran_pdf_page": 2}, user=default_user())
        mushaf_service.update_mushaf(created["id"], {"name": "ActBounds2"}, user=default_user())  # no bounds change
        mushaf_service.update_mushaf(created["id"], {"first_quran_pdf_page": 2}, user=default_user())  # unchanged value
        events = ActivityEvent.objects.filter(mushaf_id=created["id"], type=ActivityTypeChoices.BOUNDS_SET)
        self.assertEqual(events.count(), 1)
        self.assertEqual(events.get().payload, {"first": 2, "last": 5})

    def test_template_save_emits(self):
        created = _create("ActTpl")
        mushaf_service.upsert_template(
            mushaf_id=created["id"],
            template_type="sura_header",
            image=SimpleUploadedFile("t.png", make_png_bytes(), "image/png"),
            ignore_x=None,
            ignore_y=None,
            ignore_w=None,
            ignore_h=None,
            user=default_user(),
        )
        event = ActivityEvent.objects.get(mushaf_id=created["id"], type=ActivityTypeChoices.TEMPLATE_SAVED)
        self.assertEqual(event.payload, {"template_type": "sura_header"})

    def test_review_save_emits_only_on_first_review(self):
        suras.seed_reference_data()
        mushaf = bare_mushaf("ActReview")
        bbox = {"x": 0, "y": 0, "w": 10, "h": 10}
        lines = [{"line_number": 1, "type": "text", "bbox_x": 0, "bbox_y": 0, "bbox_w": 5, "bbox_h": 5, "segments": []}]
        editing.save_page(mushaf_id=mushaf.id, page_number=1, bbox=bbox, lines=lines, user=default_user())
        editing.save_page(mushaf_id=mushaf.id, page_number=1, bbox=bbox, lines=lines, user=default_user())  # re-save
        events = ActivityEvent.objects.filter(mushaf=mushaf, type=ActivityTypeChoices.REVIEW_SAVED)
        self.assertEqual(events.count(), 1)
        self.assertEqual(events.get().payload, {"page_number": 1})


class ListEventsTests(MediaTestCase):
    def test_newest_first_with_limit(self):
        created = _create("ActList")
        mushaf = Mushaf.objects.get(id=created["id"])
        base = timezone.now()
        for offset, label in enumerate(("oldest", "middle", "newest")):
            activity.emit(mushaf, ActivityTypeChoices.TEMPLATE_SAVED, {"template_type": label})
            ActivityEvent.objects.filter(mushaf=mushaf, payload={"template_type": label}).update(
                created_at=base + timedelta(seconds=offset)
            )
        events = activity.list_events(mushaf, limit=2)
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["payload"], {"template_type": "newest"})
        self.assertEqual(events[1]["payload"], {"template_type": "middle"})
