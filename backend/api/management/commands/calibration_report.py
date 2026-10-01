"""How each confirmed page of a mushaf's calibration went. Prints; changes nothing.

One row per confirmed page, each measured against its confirmation:

* **the engine and the learning**, from the prediction record, as the evaluation reads
  it: the roles the engine's own reading got wrong, how many blobs the confirmed examples
  proposed a role for, and how many of those proposals were wrong;
* **what the reviewer corrected**, from the draft as it was first shown — kept beside
  the prediction since 2026-10-01: the blobs it asked a look at, the roles changed, the
  marks the text typed and how many of those were changed, the small letters the text
  locked, how many of those locks were undone and how many small letters were made by
  hand, and the words whose box ended up different (an edge more than
  ``EDGE_TOLERANCE`` px away, or on another line). A page processed before then has no
  first draft: its words are compared with the engine's first reading instead
  (marked ``~``), and the rest is left blank;
* **minutes** from processing to the first confirmation after it, breaks included.
"""

from collections.abc import Callable
from typing import Any

from django.core.management.base import BaseCommand, CommandError, CommandParser

from api.models import CalibrationReview, CalibrationRevision, CalibrationRevisionKind, Mushaf
from api.services import calibration

Doc = dict[str, Any]


def _drafted(key: str) -> Callable[[Doc], str]:
    """A first-draft count, or a blank where the page has no first draft."""
    return lambda row: str(row[key]) if row["first_draft"] else "—"


def _share(row: Doc) -> str:
    return f"{round(100 * row['learned'] / row['blobs']) if row['blobs'] else 0}%"


#: Each column: its two header lines, its width, and its value.
COLUMNS: list[tuple[str, str, int, Callable[[Doc], str]]] = [
    ("page", "", 4, lambda row: str(row["page"])),
    ("blobs", "", 6, lambda row: str(row["blobs"])),
    ("engine", "wrong", 7, lambda row: str(row["engine_wrong"])),
    ("learning", "decided", 9, _share),
    ("learning", "wrong", 9, lambda row: str(row["learned_wrong"])),
    ("looks", "asked", 6, _drafted("looks")),
    ("roles", "fixed", 6, _drafted("roles")),
    ("text", "typed", 6, _drafted("by_text")),
    ("text", "fixed", 6, _drafted("text_changed")),
    ("small", "locked", 7, _drafted("locks")),
    ("lock", "undone", 7, _drafted("locks_undone")),
    ("small", "by hand", 8, _drafted("by_hand")),
    ("words", "fixed", 6, lambda row: str(row["words"]) if row["first_draft"] else f"~{row['words']}"),
    ("min", "", 5, lambda row: str(row["minutes"])),
]

LEGEND = """\
engine wrong       roles the engine's own reading got wrong (no learning, no text)
learning decided   blobs the confirmed examples proposed a role for
learning wrong     of those proposals, the ones the confirmation contradicts
looks asked        blobs the first draft asked you to look at
roles fixed        roles you changed on the first draft
text typed/fixed   marks the text typed, and how many of those you changed
small locked       small letters on the line the text locked as marks
lock undone        of those, the ones you did not keep as a small letter
small by hand      small letters you made marks yourself
words fixed        words whose box ended up different (~ = against the engine's
                   first reading: the page has no first draft kept)
min                minutes from processing to the first confirmation, breaks included"""


class Command(BaseCommand):
    help = "Print how each confirmed calibration page went. Read-only."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("mushaf_id")

    def handle(self, *args: Any, **options: Any) -> None:
        try:
            mushaf = Mushaf.objects.get(pk=options["mushaf_id"])
        except (Mushaf.DoesNotExist, ValueError) as exc:
            raise CommandError("Use the full mushaf UUID.") from exc
        pages = measure(mushaf)
        if not pages:
            self.stdout.write("No confirmed pages yet.")
            return
        for header in (0, 1):
            self.stdout.write("".join((first, second)[header].rjust(width) for first, second, width, _ in COLUMNS))
        for row in pages:
            self.stdout.write("".join(value(row).rjust(width) for _, _, width, value in COLUMNS))
        self.stdout.write("")
        self.stdout.write(LEGEND)


def measure(mushaf: Mushaf) -> list[Doc]:
    """Every confirmed page's row, in page order."""
    rows = []
    reviews = CalibrationReview.objects.filter(mushaf=mushaf, confirmed_revision__isnull=False)
    for review in reviews.order_by("page_number"):
        confirmed = calibration._approval(review)
        if confirmed is None:
            continue
        processed = CalibrationRevision.objects.filter(
            review=review, number=confirmed.payload.get("processed_revision"), kind=CalibrationRevisionKind.PROCESSED
        ).first()
        if processed is None:
            continue
        # Time is measured to the page's first confirmation after it was processed: a
        # later re-confirmation is a correction, not how long the page took.
        finished = (
            CalibrationRevision.objects.filter(
                review=review, kind=CalibrationRevisionKind.CONFIRMED, number__gt=processed.number
            )
            .order_by("number")
            .first()
        )
        rows.append(_page(review.page_number, processed, confirmed, finished or confirmed))
    return rows


def _page(
    page: int, processed: CalibrationRevision, confirmed: CalibrationRevision, finished: CalibrationRevision
) -> Doc:
    final = {
        (row["snapshot_id"], blob["id"]): blob for row in confirmed.payload.get("lines", []) for blob in row["blobs"]
    }
    text = {key for key, blob in final.items() if blob["role"] in calibration.TEXT_ROLES}
    engine = learned = learned_wrong = 0
    for row in processed.payload.get("lines", []):
        for blob in row["blobs"]:
            key = (row["snapshot_id"], blob["id"])
            if key not in text:
                continue
            right = final[key]["role"]
            engine += blob["role"] != right
            if blob.get("proposed_role") in calibration.TEXT_ROLES:
                learned += 1
                learned_wrong += blob["proposed_role"] != right
    truth = calibration._placements(confirmed.payload.get("lines", []), page)
    found: Doc = {
        "page": page,
        "blobs": len(text),
        "engine_wrong": engine,
        "learned": learned,
        "learned_wrong": learned_wrong,
        "minutes": max(0, round((finished.created_at - processed.created_at).total_seconds() / 60)),
    }
    shown = processed.payload.get("shown")
    if shown is None:
        found.update(
            first_draft=False, words=_different(calibration._placements_of(processed.payload, page), truth, page)
        )
        return found
    counts = dict.fromkeys(("looks", "roles", "by_text", "text_changed", "locks", "locks_undone", "by_hand"), 0)
    for row in shown["lines"]:
        for ident, first in row["blobs"].items():
            blob = final.get((row["snapshot_id"], int(ident)))
            if blob is None:
                continue
            small = blob["role"] == "mark" and blob.get("subtype") == "smallLetter"
            counts["looks"] += first["look"]
            counts["roles"] += first["role"] != blob["role"]
            if first["by_text"]:
                counts["by_text"] += 1
                counts["text_changed"] += blob["role"] != "mark" or blob.get("subtype", "") != first["subtype"]
            if first["text_lock"]:
                counts["locks"] += 1
                counts["locks_undone"] += not small
            elif small and first["role"] == "body":
                counts["by_hand"] += 1
    drafted = [
        {
            "line_number": row["line_number"],
            "words": [{"word_id": w, "start_x": s, "end_x": e} for w, s, e in row["words"]],
        }
        for row in shown["lines"]
    ]
    found.update(counts, first_draft=True, words=_different(calibration._placements(drafted, page), truth, page))
    return found


def _different(
    found: dict[int, list[calibration.Placement]], truth: dict[int, list[calibration.Placement]], page: int
) -> int:
    """How many words were placed otherwise than confirmed — moved, on another line,
    missing, doubled or extra."""
    return sum(calibration._word_errors(found, truth, page).values())
