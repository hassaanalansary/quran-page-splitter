"""ORM <-> coordinate mapping for pages, lines, and segments.

Four responsibilities:
  * ``write_coords_to_page`` — engine output dict -> rows (structure only)
  * ``page_to_dict``         — rows -> editor dict (flat bbox fields, DB type values)
  * ``renumber_from``        — recompute sura/aya forward from one edited page
  * ``renumber_mushaf``      — the same walk over a whole mushaf, validated first

**The walk is the only writer of ``Line.sura`` and ``Segment.aya_number``.** Those
two columns are a cache of a derivation, not measurements, and detection must not
write them: a processing run sees only its own page range and numbers it from its
own seed, so two runs over different ranges disagree and the mushaf ends up holding
one range's numbering spliced into another's. Detection writes structure — line
boxes, types, cuts, ``has_separator`` — and the walk turns that into numbers once.
"""

from dataclasses import dataclass, field

from django.conf import settings
from django.db import transaction
from django.db.models import Prefetch, QuerySet

from api.models import Line, LineTypeChoices, Mushaf, Page, ProcessingRun, Segment
from quran.models import SuraAyaCount

# Engine line-type string -> DB LineTypeChoices value.
_ENGINE_TO_DB_TYPE = {
    "sura_header": LineTypeChoices.SURA_HEADER,
    "besmella": LineTypeChoices.BESMELLA,
    "text": LineTypeChoices.TEXT,
}


# ---------------------------------------------------------------------------
# Write: engine coordinate dict -> rows
# ---------------------------------------------------------------------------
def write_coords_to_page(*, mushaf: Mushaf, page_number: int, run: ProcessingRun, coord_page: dict) -> Page:
    """Persist one engine coordinate page into Page + Line + Segment rows.

    Replaces any existing rows for that logical page (reprocessing overwrites it).
    """
    crop = coord_page.get("crop_box")
    # Machine output is unreviewed; (re)processing clears any prior review flag.
    defaults: dict = {"last_run": run, "reviewed": False}
    if crop:
        defaults |= {
            "bbox_x": crop["x"],
            "bbox_y": crop["y"],
            "bbox_w": crop["w"],
            "bbox_h": crop["h"],
        }
    page, _ = Page.objects.update_or_create(mushaf=mushaf, page_number=page_number, defaults=defaults)
    page.lines.all().delete()
    for line_data in coord_page.get("lines", []):
        _write_engine_line(page, line_data)
    return page


def _write_engine_line(page: Page, line_data: dict) -> None:
    """Write one engine line as *structure only*.

    ``sura`` and ``aya_number`` are deliberately left null. Detection finds where
    the lines and the separators are; it does not get to decide the numbering,
    because it only ever sees the page range of its own run and numbers that range
    from that run's own seed. Two runs over different ranges then disagree, which
    is how a third of one mushaf's segments ended up contradicting the rest of it.

    ``renumber_mushaf`` fills both columns from a single forward walk once the run
    finishes. Until it does they stay null — visibly missing rather than quietly
    wrong, which is the whole point of not writing a guess here.
    """
    engine_type = line_data["type"]
    bbox = line_data["line_bbox"]
    line = Line.objects.create(
        page=page,
        line_number=line_data["line_number"],
        type=_ENGINE_TO_DB_TYPE[engine_type],
        sura_id=None,
        bbox_x=bbox["x"],
        bbox_y=bbox["y"],
        bbox_w=bbox["w"],
        bbox_h=bbox["h"],
    )
    if engine_type == "text":
        Segment.objects.bulk_create(
            [
                Segment(
                    line=line,
                    segment_order=index,
                    bbox_x=segment["bbox"]["x"],
                    bbox_w=segment["bbox"]["w"],
                    has_separator=segment["has_separator"],
                    aya_number=None,
                )
                for index, segment in enumerate(line_data.get("segments", []), start=1)
            ]
        )


# ---------------------------------------------------------------------------
# Read: rows -> editor dict (flat bbox fields, DB type values)
# ---------------------------------------------------------------------------
def page_to_dict(page: Page) -> dict:
    """Serialize a page's rows into the editor's coordinate representation."""
    return {
        "page_number": page.page_number,
        "bbox": page_column(page),
        "lines": [_line_to_dict(line) for line in _ordered_lines(page)],
    }


def _ordered_lines(page: Page) -> QuerySet[Line]:
    return page.lines.order_by("line_number").prefetch_related(
        Prefetch("segments", queryset=Segment.objects.order_by("segment_order")),
        "erase_strokes",
    )


def _page_bbox(page: Page) -> dict | None:
    if page.bbox_x is None:
        return None
    return {"x": page.bbox_x, "y": page.bbox_y, "w": page.bbox_w, "h": page.bbox_h}


def page_column(page: Page) -> dict | None:
    """The page's text-column bounds, used to crop uniform-width line PNGs.

    Processed pages carry a real crop box. Manually-added pages carry only a 1x1
    placeholder, so the column is DERIVED from the union (bounding box) of their
    line boxes — each line's x/w already tracks its content, so the union is the
    text column. Nothing is stored; it re-derives as the page is edited.
    """
    if page.bbox_x is not None and page.bbox_w is not None and page.bbox_w > 1:
        return {"x": page.bbox_x, "y": page.bbox_y, "w": page.bbox_w, "h": page.bbox_h}
    lines = list(page.lines.all())
    if not lines:
        return _page_bbox(page)
    left = min(line.bbox_x for line in lines)
    top = min(line.bbox_y for line in lines)
    right = max(line.bbox_x + line.bbox_w for line in lines)
    bottom = max(line.bbox_y + line.bbox_h for line in lines)
    return {"x": left, "y": top, "w": right - left, "h": bottom - top}


def _line_to_dict(line: Line) -> dict:
    return {
        "id": str(line.id),
        "line_number": line.line_number,
        "type": line.type,
        "sura_number": line.sura_id,
        "bbox_x": line.bbox_x,
        "bbox_y": line.bbox_y,
        "bbox_w": line.bbox_w,
        "bbox_h": line.bbox_h,
        "segments": [
            {
                "id": str(segment.id),
                "segment_order": segment.segment_order,
                "bbox_x": segment.bbox_x,
                "bbox_w": segment.bbox_w,
                "has_separator": segment.has_separator,
                "aya_number": segment.aya_number,
                "sura_number": line.sura_id,
            }
            for segment in line.segments.all()
        ],
        "erase_strokes": [
            {"brush_size": stroke.brush_size, "points": stroke.points}
            for stroke in line.erase_strokes.all()
        ],
        "line_png": _line_png_url(line),
    }


def _line_png_url(line: Line) -> str | None:
    """Leading-slash media URL of the exported PNG, or None if never exported."""
    name = line.line_png.name
    if not name:
        return None
    return "/" + (settings.MEDIA_URL + name).lstrip("/")


# ---------------------------------------------------------------------------
# Renumber: recompute sura/aya forward across consecutive pages
# ---------------------------------------------------------------------------
def renumber_from(page: Page) -> None:
    """Recompute sura/aya from ``page`` forward through consecutive pages.

    Seeded from the previous page's exit state (or the run's start for the first
    page). Stops at a page-number gap or once a page yields no change (the shift
    has converged, so everything downstream is already correct).
    """
    sura, aya = entry_state(page)
    current: Page | None = page
    while current is not None:
        changed, (sura, aya) = _renumber_page(current, sura, aya)
        if not changed:
            break
        current = _consecutive(current, 1)


def entry_state(page: Page) -> tuple[int, int]:
    previous = _consecutive(page, -1)
    if previous is not None:
        return _exit_state(previous)
    run = page.last_run
    if run is not None and isinstance(run.settings, dict):
        return (
            int(run.settings.get("start_sura", 1)),
            int(run.settings.get("start_aya", 1)),
        )
    return 1, 1


def _exit_state(page: Page) -> tuple[int, int]:
    last_line = page.lines.order_by("-line_number").first()
    if last_line is None:
        return 1, 1
    sura = last_line.sura_id or 1
    if last_line.type != LineTypeChoices.TEXT:
        return sura, 1
    last_seg = last_line.segments.order_by("-segment_order").first()
    if last_seg is None or last_seg.aya_number is None:
        return sura, 1
    return sura, last_seg.aya_number + (1 if last_seg.has_separator else 0)


def _renumber_page(page: Page, sura: int, aya: int) -> tuple[bool, tuple[int, int]]:
    line_updates: list[Line] = []
    seg_updates: list[Segment] = []
    for line in _ordered_lines(page):
        if line.type == LineTypeChoices.SURA_HEADER and aya != 1:
            sura += 1
            aya = 1
        if line.sura_id != sura:
            line.sura_id = sura
            line_updates.append(line)
        if line.type == LineTypeChoices.TEXT:
            for segment in line.segments.all():
                if segment.aya_number != aya:
                    segment.aya_number = aya
                    seg_updates.append(segment)
                if segment.has_separator:
                    aya += 1
    if line_updates:
        Line.objects.bulk_update(line_updates, ["sura"])
    if seg_updates:
        Segment.objects.bulk_update(seg_updates, ["aya_number"])
    return bool(line_updates or seg_updates), (sura, aya)


def _consecutive(page: Page, delta: int) -> Page | None:
    return Page.objects.filter(mushaf_id=page.mushaf_id, page_number=page.page_number + delta).first()


# ---------------------------------------------------------------------------
# Renumber a whole mushaf, and say where it does not add up
# ---------------------------------------------------------------------------
@dataclass
class RenumberPlan:
    """What one forward walk over a mushaf would write, and whether it adds up."""

    pages: int
    lines_changed: int
    segments_changed: int
    exit_state: tuple[int, int]
    #: Suras whose separator count disagrees with the counting system — each one
    #: a page where a separator was missed or invented. Reported, not fatal: see
    #: :func:`renumber_mushaf` for why the numbering is still written.
    problems: list[str] = field(default_factory=list)

    @property
    def clean(self) -> bool:
        return not self.problems

    @property
    def changes(self) -> int:
        return self.lines_changed + self.segments_changed


def plan_renumber(mushaf: Mushaf) -> RenumberPlan:
    """Walk the mushaf without writing, and check the result against the qiraa.

    The walk is the same one ``_renumber_page`` performs — seed from the first
    page's entry state, a sura header starts the next sura, every ``has_separator``
    segment closes an aya. Here it only counts what *would* change, and then asks
    an independent question: does each sura's ornament count match the number of
    ayat that sura has in this mushaf's counting system?

    That check comes from a source with no connection to this pipeline — the
    ``quran`` app's seeded ``SuraAyaCount`` — so agreement is evidence rather than
    a restatement. A mismatch means a separator was missed or invented on some
    page, which shifts every aya after it in that sura: worth reporting loudly,
    and worth fixing in review rather than in this column.

    Only **fully covered** suras are checked. A run over 50 pages sees a slice of a
    sura and can never match its full count; flagging those would be noise.
    """
    counting_system = mushaf.rawi.counting_system if mushaf.rawi else None
    expected: dict[int, int] = {}
    if counting_system is not None:
        expected = dict(
            SuraAyaCount.objects.filter(counting_system=counting_system).values_list("sura_id", "count")
        )

    pages = list(
        Page.objects.filter(mushaf=mushaf)
        .order_by("page_number")
        .prefetch_related(Prefetch("lines", queryset=Line.objects.order_by("line_number").prefetch_related("segments")))
    )
    if not pages:
        return RenumberPlan(pages=0, lines_changed=0, segments_changed=0, exit_state=(1, 1))

    lines_changed = segments_changed = 0
    ornaments: dict[int, int] = {}
    checkable: set[int] = set()
    sura = aya = 1

    for group in _contiguous_groups(pages):
        # Each run of consecutive pages is walked on its own. Carrying the cursor
        # across a page-number gap would be inventing numbering for pages that are
        # not there — two of these mushafs hold 50-odd pages scattered over the
        # whole book.
        sura, aya = entry_state(group[0])
        entered_at: dict[int, int] = {sura: aya}
        for page in group:
            for line in page.lines.all():
                if line.type == LineTypeChoices.SURA_HEADER and aya != 1:
                    # The sura just left was seen end to end only if this walk also
                    # saw it begin; otherwise its separator count means nothing.
                    if entered_at.get(sura) == 1:
                        checkable.add(sura)
                    sura += 1
                    aya = 1
                    entered_at.setdefault(sura, 1)
                if line.sura_id != sura:
                    lines_changed += 1
                if line.type != LineTypeChoices.TEXT:
                    continue
                for segment in sorted(line.segments.all(), key=lambda s: s.segment_order):
                    if segment.aya_number != aya:
                        segments_changed += 1
                    if segment.has_separator:
                        ornaments[sura] = ornaments.get(sura, 0) + 1
                        aya += 1
        # The sura the group ends inside is never complete — the next page is missing.

    system_name = counting_system.name if counting_system else "?"
    problems = [
        f"sura {number}: the walk counted {ornaments.get(number, 0)} separators, "
        f"{system_name} has {expected[number]} ayat"
        for number in sorted(checkable)
        if number in expected and ornaments.get(number, 0) != expected[number]
    ]
    return RenumberPlan(
        pages=len(pages),
        lines_changed=lines_changed,
        segments_changed=segments_changed,
        exit_state=(sura, aya),
        problems=problems,
    )


def _contiguous_groups(pages: list[Page]) -> list[list[Page]]:
    """Split page-number-ordered pages into runs with no gaps."""
    groups: list[list[Page]] = [[pages[0]]]
    for page in pages[1:]:
        if page.page_number == groups[-1][-1].page_number + 1:
            groups[-1].append(page)
        else:
            groups.append([page])
    return groups


def renumber_mushaf(mushaf: Mushaf, *, dry_run: bool = False) -> RenumberPlan:
    """Rewrite every ``Line.sura`` and ``Segment.aya_number`` from one forward walk.

    Unlike ``renumber_from`` this never stops early: it is repairing rows that a
    second writer left behind, so a page that happens to already agree says nothing
    about the pages after it.

    It writes **even when the validation finds a sura that does not add up**, and
    hands the problems back for the caller to report. That is deliberate: the walk
    is a coherent forward pass over reviewed structure, so it is the best answer
    available, and the alternative to writing it is leaving the columns null —
    which empties the coordinates export, since ``export.coordinates_json`` skips
    segments without an aya. A missed separator makes the numbering *shift*; it
    does not make it worthless. The problems list is a diagnostic pointing at the
    pages that still need a human, not a reason to store nothing.
    """
    plan = plan_renumber(mushaf)
    if dry_run or not plan.changes:
        return plan

    pages = list(Page.objects.filter(mushaf=mushaf).order_by("page_number"))
    with transaction.atomic():
        for group in _contiguous_groups(pages):
            sura, aya = entry_state(group[0])
            for page in group:
                _, (sura, aya) = _renumber_page(page, sura, aya)
    return plan
