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

from api.models import Mushaf
from api.services.calibration_progress import measure

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
