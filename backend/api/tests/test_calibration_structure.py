"""Structure that a person says is text: a sajda or rub' sign, or a piece of an ornament.

The page is page 1 as drawn, with its stray speck by word 1 — a mark the reading gives
to word 1. Its snapshot is then made to say measurement took the speck as structure,
and the page is processed again: the speck is structure, out of the reading, until the
reviewer calls it text. As a symbol it stands for the head of a و that al-Shamarly's
rub' star matched; as a piece of the line's ornament, for the kasra under الرحيم that
the ring took.
"""

from types import SimpleNamespace

from django.test import SimpleTestCase

from api.models import CalibrationReview, CalibrationSnapshot
from api.services import calibration as calibration_service
from api.services import calibration_snapshots as snapshots
from api.services.calibration_examples import (
    collect_library_examples,
    find_confirmed_revisions,
    load_revision_payloads,
)
from api.services.calibration_feature_files import save_features
from api.services.calibration_structure import (
    find_roles_allowed_for_blob,
    is_structure_taken_as_text,
    put_structure_back_into_text,
)
from api.tests.helpers import default_user
from api.tests.test_calibration_api import BODIES, STRAY, CalibrationApiTestCase, drawn_pages
from core.word_boundary.ink import Blob


class StructureTestCase(CalibrationApiTestCase):
    #: What measurement is made to take the speck for: "symbol" or "ornament".
    kind = ""

    def setUp(self):
        super().setUp()
        with drawn_pages(stray=True):
            self.client.post(self.url(1, "/process"))
        line = self.document(1)["lines"][0]
        self.speck = self.blob_at(line, STRAY[0])["id"]
        self.snapshot = CalibrationSnapshot.objects.get(pk=line["snapshot_id"])
        data = self.snapshot.metadata
        data["components"].remove(self.speck)
        if self.kind == "symbol":
            raw = next(blob for blob in data["blobs"] if blob["label"] == self.speck)
            data["symbols"] = [["rub_hizb", [self.speck]]]
            data["symbol_spans"] = [[raw["x"], raw["x"] + raw["w"]]]
        else:
            data["separators"][0].append(self.speck)
        self.snapshot.save(update_fields=["metadata"])
        self.process_again()

    def process_again(self) -> None:
        with drawn_pages(stray=True):
            calibration_service.make_fresh_draft_of_page(
                self.mushaf, 1, expected_revision=self.document(1)["revision"], user=default_user()
            )
        self.doc = self.document(1)

    def speck_of(self, document: dict) -> dict:
        return next(blob for blob in document["lines"][0]["blobs"] if blob["id"] == self.speck)

    def save(self, *, realign: bool = True, **speck) -> dict:
        body = self.draft(self.doc, realign=realign)
        next(blob for blob in body["lines"][0]["blobs"] if blob["id"] == self.speck).update(speck)
        response = self.put(1, body)
        self.assertEqual(response.status_code, 200, response.content)
        self.doc = response.json()
        return self.doc

    def refused(self, **speck) -> int:
        body = self.draft(self.doc)
        next(blob for blob in body["lines"][0]["blobs"] if blob["id"] == self.speck).update(speck)
        return int(self.put(1, body).status_code)


class SymbolTestCase(StructureTestCase):
    kind = "symbol"


class OrnamentTestCase(StructureTestCase):
    kind = "ornament"


class ReadingChecks:
    """The same for either kind of structure."""

    def test_structure_is_left_out_of_the_reading(self):
        speck = self.speck_of(self.doc)
        self.assertEqual((speck["role"], speck["initial_role"], speck["allocations"]), (self.kind, self.kind, []))
        self.assertEqual(self.doc["lines"][0]["words"][0]["end_x"], BODIES[0][0])

    def test_called_text_it_is_read_with_the_line(self):
        speck = self.speck_of(self.save(decided={"paws": [], "marks": [None]}))
        self.assertEqual((speck["role"], speck["allocations"]), ("mark", [{"word_id": 1, "paws": 0}]))
        self.assertEqual(self.doc["lines"][0]["words"][0]["end_x"], STRAY[0])

    def test_released_it_is_structure_again(self):
        self.save(decided={"paws": [], "marks": [None]})
        speck = self.speck_of(self.save(decided=None, allocations=[]))
        self.assertEqual((speck["role"], speck["allocations"]), (self.kind, []))
        self.assertEqual(self.doc["lines"][0]["words"][0]["end_x"], BODIES[0][0])

    def test_given_back_to_structure_by_hand(self):
        self.save(decided={"paws": [], "marks": [None]})
        speck = self.speck_of(self.save(decided=None, allocations=[]))
        self.assertEqual((speck["role"], speck["decided"], speck["allocations"]), (self.kind, None, []))

    def test_the_decision_holds_when_the_page_is_processed_again(self):
        self.save(decided={"paws": [], "marks": [None]})
        self.process_again()
        speck = self.speck_of(self.doc)
        self.assertEqual((speck["role"], speck["decided"]), ("mark", {"paws": [], "marks": [None]}))
        self.assertEqual(speck["allocations"], [{"word_id": 1, "paws": 0}])

    def test_structure_belongs_to_no_word(self):
        self.assertEqual(self.refused(decided=None, allocations=[{"word_id": 1, "paws": 0}]), 422)

    def test_it_is_erased_only_once_it_is_text(self):
        self.assertEqual(self.refused(erased=True), 422)
        speck = self.speck_of(self.save(decided={"paws": [], "marks": [None]}, erased=True))
        self.assertEqual((speck["role"], speck["erased"], speck["allocations"]), ("mark", True, []))

    def test_its_shape_is_measured(self):
        snapshots.FEATURES_CACHE.clear()
        self.assertIn(self.speck, snapshots.blob_features(self.snapshot))

    def test_a_file_saved_before_structure_was_measured_is_measured_again(self):
        snapshots.FEATURES_CACHE.clear()
        measured = snapshots.blob_features(self.snapshot)
        save_features(self.snapshot, {ident: vector for ident, vector in measured.items() if ident != self.speck})
        snapshots.FEATURES_CACHE.clear()
        self.assertIn(self.speck, snapshots.blob_features(self.snapshot))

    def test_once_confirmed_as_text_it_teaches_the_library(self):
        self.save(decided={"paws": [], "marks": [None]})
        self.assertEqual(self.confirm(1, self.draft(self.doc)).status_code, 200)
        examples = collect_library_examples(self.mushaf, load_revision_payloads(find_confirmed_revisions(self.mushaf)))
        here = (str(self.snapshot.pk), self.speck)
        found = [sample for sample in examples if (sample["snapshot_id"], sample["blob_id"]) == here]
        self.assertEqual([sample["role"] for sample in found], ["mark"])


class SymbolTests(ReadingChecks, SymbolTestCase):
    pass


class OrnamentPieceTests(ReadingChecks, OrnamentTestCase):
    def ring_of(self, document: dict) -> dict:
        return next(blob for blob in document["lines"][0]["blobs"] if blob.get("ring"))

    def test_the_draft_names_the_ring_among_the_pieces(self):
        self.assertEqual((self.ring_of(self.doc)["role"], self.speck_of(self.doc)["ring"]), ("ornament", False))

    def test_the_ring_never_becomes_text(self):
        body = self.draft(self.doc)
        ring = self.ring_of(self.doc)["id"]
        next(blob for blob in body["lines"][0]["blobs"] if blob["id"] == ring)["decided"] = {
            "paws": [None],
            "marks": None,
        }
        self.assertEqual(self.put(1, body).status_code, 422)

    def test_the_rings_shape_is_not_measured(self):
        snapshots.FEATURES_CACHE.clear()
        self.assertNotIn(self.ring_of(self.doc)["id"], snapshots.blob_features(self.snapshot))

    def test_a_draft_made_before_rings_were_marked_keeps_every_piece(self):
        review = CalibrationReview.objects.get(mushaf=self.mushaf, page_number=1)
        for blob in review.payload["lines"][0]["blobs"]:
            blob.pop("ring", None)
        review.save(update_fields=["payload"])
        self.assertEqual(self.refused(decided={"paws": [], "marks": [None]}), 422)


def draft_blob(role: str, initial_role: str, *, explicit: bool = False, **changes) -> dict:
    """A draft blob; ``explicit``, a person decided its role."""
    decided = None
    if explicit:
        decided = {"paws": [], "marks": [None]} if role == "mark" else {"paws": [None], "marks": None}
    return {"id": 1, "role": role, "initial_role": initial_role, "decided": decided, **changes}


def blob(label: int, x: int, w: int = 10) -> Blob:
    return Blob(label=label, x=x, y=0, w=w, h=10, area=100, preferred="body" if label == 1 else "mark-only")


def labels(blobs: list[Blob]) -> list[int]:
    return [b.label for b in blobs]


class RuleTests(SimpleTestCase):
    def test_which_roles_a_blob_may_take(self):
        self.assertEqual(find_roles_allowed_for_blob(draft_blob("ornament", "ornament", ring=True)), ("ornament",))
        self.assertEqual(find_roles_allowed_for_blob(draft_blob("ornament", "ornament")), ("ornament",))
        piece = draft_blob("ornament", "ornament", ring=False)
        self.assertEqual(set(find_roles_allowed_for_blob(piece)), {"ornament", "body", "mark"})
        self.assertEqual(set(find_roles_allowed_for_blob(draft_blob("symbol", "symbol"))), {"symbol", "body", "mark"})
        self.assertEqual(set(find_roles_allowed_for_blob(draft_blob("body", "mark"))), {"body", "mark"})

    def test_only_a_persons_decision_makes_structure_text(self):
        self.assertTrue(is_structure_taken_as_text(draft_blob("mark", "symbol", explicit=True)))
        self.assertTrue(is_structure_taken_as_text(draft_blob("mark", "ornament", explicit=True)))
        self.assertTrue(is_structure_taken_as_text(draft_blob("body", "symbol", ownership_explicit=True)))
        self.assertFalse(is_structure_taken_as_text(draft_blob("mark", "symbol")))
        self.assertFalse(is_structure_taken_as_text(draft_blob("symbol", "symbol", explicit=True)))
        self.assertFalse(is_structure_taken_as_text(draft_blob("mark", "mark", explicit=True)))

    def test_a_symbol_goes_back_into_the_text_where_it_was_measured(self):
        letter, dot, head, fatha = blob(1, 300), blob(2, 100), blob(3, 200), blob(4, 205, w=5)
        ink = SimpleNamespace(
            components=[letter, dot],
            bodies=[letter],
            marks=[dot],
            separators=[],
            symbols=[("rub_hizb", [head, fatha]), ("sajda", [blob(5, 10)])],
            symbol_spans=[(200, 210), (10, 20)],
        )
        put_structure_back_into_text(ink, {3, 4})
        self.assertEqual(labels(ink.components), [1, 3, 4, 2])
        self.assertEqual((labels(ink.bodies), labels(ink.marks)), ([1], [3, 4, 2]))
        self.assertEqual([(name, labels(group)) for name, group in ink.symbols], [("sajda", [5])])
        self.assertEqual(ink.symbol_spans, [(10, 20)])

    def test_an_ornaments_piece_goes_back_and_its_ring_stays(self):
        letter, ring, digit, kasra = blob(1, 300), blob(6, 20, w=95), blob(7, 60), blob(8, 30)
        ink = SimpleNamespace(
            components=[letter],
            bodies=[letter],
            marks=[],
            separators=[[ring, digit, kasra]],
            symbols=[],
            symbol_spans=[],
        )
        put_structure_back_into_text(ink, {8})
        self.assertEqual(labels(ink.components), [1, 8])
        self.assertEqual([labels(group) for group in ink.separators], [[6, 7]])

    def test_an_ornament_is_never_left_without_its_ring(self):
        ring, digit = blob(6, 20, w=95), blob(7, 60)
        ink = SimpleNamespace(
            components=[], bodies=[], marks=[], separators=[[ring, digit]], symbols=[], symbol_spans=[]
        )
        put_structure_back_into_text(ink, {6, 7})
        self.assertEqual(([labels(group) for group in ink.separators], ink.components), ([[6, 7]], []))

    def test_a_line_with_nothing_to_give_back_is_left_alone(self):
        components = [blob(1, 300)]
        ink = SimpleNamespace(
            components=components, separators=[[blob(6, 20)]], symbols=[("sajda", [blob(5, 10)])], symbol_spans=[]
        )
        put_structure_back_into_text(ink, {9})
        self.assertIs(ink.components, components)

    def test_the_ring_is_an_ornaments_largest_piece(self):
        metadata = {
            "blobs": [{"label": 6, "area": 900}, {"label": 7, "area": 40}, {"label": 9, "area": 700}],
            "separators": [[7, 6], [9]],
        }
        self.assertEqual(snapshots.find_ornament_rings(metadata), {6, 9})

    def test_structure_is_no_body_or_mark_mistake(self):
        document = {"lines": [{"snapshot_id": "a", "blobs": [{"id": 1, "role": "symbol"}, {"id": 2, "role": "body"}]}]}
        truth = {("a", 1): "mark", ("a", 2): "mark"}
        self.assertEqual(calibration_service.count_role_errors(document, truth), {"body_as_mark": 0, "mark_as_body": 1})
