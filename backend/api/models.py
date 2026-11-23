import uuid
from typing import Any

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.utils import timezone


class TemplateTypeChoices(models.TextChoices):
    SURA_HEADER = "sura_header", "Sura Header"
    AYA_SEPARATOR = "aya_separator", "Aya Separator"
    #: Printed inline among the words and meaning nothing to the reading order.
    #: Word detection matches them only to take their ink *out* of the line; unlike
    #: an aya separator they close nothing, and nothing about them is stored.
    #: Optional — a mushaf without them still processes, it just misreads the lines
    #: that carry one. Slugs stay within `Template.type`'s max_length of 16.
    SAJDA = "sajda", "Sajda Symbol"
    RUB_HIZB = "rub_hizb", "Rub' al-Hizb Symbol"


class LineTypeChoices(models.TextChoices):
    SURA_HEADER = "sura_header", "Sura Header"
    BESMELLA = "besmella", "Besmella"
    TEXT = "text", "Text"


class LinePngSizeChoices(models.TextChoices):
    """How big an exported line PNG is. Height is what differs: every line keeps the
    page column's width whichever is chosen."""

    #: The line's own box, as cut in Finalize.
    BOX = "box", "Each line's own box"
    #: Centred on a canvas the size of the page's largest line — nothing cropped.
    UNIFORM = "uniform", "Same size across the page"
    #: Cut down to the line's first and last inked row, after every erase.
    TIGHT = "tight", "Tight to the ink"
    #: Cut tight first, then centred on a canvas the size of the page's tallest
    #: tight line: one size across the page, with no more space than the ink needs.
    TIGHT_UNIFORM = "tight_uniform", "Tight, then same size across the page"


#: The sizes that cut each line down to its first and last inked row.
INK_CROPPED_PNG_SIZES = frozenset({LinePngSizeChoices.TIGHT, LinePngSizeChoices.TIGHT_UNIFORM})
#: The sizes that centre every line of a page on one canvas, its largest line's size.
PAGE_SIZED_PNG_SIZES = frozenset({LinePngSizeChoices.UNIFORM, LinePngSizeChoices.TIGHT_UNIFORM})


class RunStatusChoices(models.TextChoices):
    # Set when the run row is created and kept until the run settles. A row left
    # in this state belongs to a run whose process died; the next run on the same
    # mushaf settles it as INTERRUPTED (see services/processing._settle_stale_runs).
    RUNNING = "running", "Running"
    COMPLETED = "completed", "Completed"
    ABORTED_LINE_DETECTION = "aborted_line_detection", "Aborted Line Detection"
    CANCELLED = "cancelled", "Cancelled"
    ERROR = "error", "Error"
    INTERRUPTED = "interrupted", "Interrupted"


class ActivityTypeChoices(models.TextChoices):
    MUSHAF_CREATED = "mushaf_created", "Mushaf Created"
    BOUNDS_SET = "bounds_set", "Bounds Set"
    TEMPLATE_SAVED = "template_saved", "Template Saved"
    RUN_FINISHED = "run_finished", "Run Finished"
    REVIEW_SAVED = "review_saved", "Review Saved"
    LINES_EXPORTED = "lines_exported", "Lines Exported"
    WORDS_DETECTED = "words_detected", "Words Detected"
    WORDS_EDITED = "words_edited", "Words Edited"
    CALIBRATION_SAVED = "calibration_saved", "Calibration Saved"
    CALIBRATION_CONFIRMED = "calibration_confirmed", "Calibration Confirmed"
    CALIBRATION_PROCESSED = "calibration_processed", "Calibration Processed"
    CALIBRATION_EVALUATED = "calibration_evaluated", "Calibration Evaluated"


class BaseModel(models.Model):
    """A base model for all models"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


# ── Media layout ─────────────────────────────────────────────────────────────
# Everything a mushaf owns lives under ``mushafs/<mushaf id>/`` — its thumbnail,
# its template crops and its exported line PNGs — so one directory holds one
# mushaf's work and deleting it takes the lot.
#
# The source PDF is the deliberate exception: it stays content-addressed in a
# shared ``pdfs/<sha256>.pdf``. A FileField stores a *path*, so several rows can
# address one file, and that is what makes duplicating a mushaf from the gallery
# (and re-uploading a PDF someone already holds) cost zero storage on a ~150 MB
# scan. ``services.mushaf._delete_if_unshared`` refcounts it before deleting.


def mushaf_dir(mushaf_id: uuid.UUID | str) -> str:
    return f"mushafs/{mushaf_id}"


def thumbnail_path(instance: "Mushaf", filename: str) -> str:
    return f"{mushaf_dir(instance.id)}/thumbnail.png"


def template_path(instance: "Template", filename: str) -> str:
    return f"{mushaf_dir(instance.mushaf_id)}/templates/{filename}"


def line_png_path(instance: "Line", filename: str) -> str:
    # ``filename`` arrives as "page-0007/line-03.png" so the stored tree mirrors
    # the layout of the lines.zip download.
    return f"{mushaf_dir(instance.page.mushaf_id)}/lines/{filename}"


def calibration_file_path(instance: "CalibrationSnapshot", filename: str) -> str:
    return f"{mushaf_dir(instance.mushaf_id)}/calibration/{instance.id}/{filename}"


class VisibilityChoices(models.TextChoices):
    PRIVATE = "private", "Private"
    PUBLISHED = "published", "Published"


class IjamModeChoices(models.TextChoices):
    """Whether this mushaf's script draws dots the way the stored text expects.

    Mirrors ``core.word_boundary.inputs.IjamMode`` — the engine takes the value,
    the database is only where a mushaf's answer is kept. See that docstring for
    why there is no third, enforcing mode.
    """

    REPORT = "report", "Report a word that lost a dot"
    IGNORE = "ignore", "Do not check dots"


class Mushaf(BaseModel):
    """A table for Mushafs"""

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="mushafs",
        help_text="Who created this mushaf. Deleting the account deletes their mushafs.",
    )
    # The riwaya this mushaf is printed in — Hafs, Warsh, Qalun. It is what fixes
    # the counting system, and so where every aya ends. The API still calls this
    # "qiraa" on the wire (``qiraa: "Hafs"``), which is the colloquial name and
    # the one stored inside exported bundles; services/mushaf.py maps between them.
    rawi = models.ForeignKey("quran.Rawi", null=True, on_delete=models.SET_NULL, related_name="mushafs")
    # Unique per owner, not globally — two people may each keep their own
    # "مصحف المدينة". See the constraint in Meta.
    name = models.CharField(max_length=256)
    pdf_file = models.FileField(upload_to="pdfs/")
    pdf_original_name = models.CharField(
        max_length=255,
        blank=True,
        default="",
        help_text="Filename of the uploaded PDF (the stored file is renamed to its hash).",
    )
    pdf_sha256 = models.CharField(max_length=64)
    pdf_page_count = models.PositiveSmallIntegerField()
    thumbnail = models.ImageField(
        upload_to=thumbnail_path,
        null=True,
        blank=True,
        help_text="Small render of the first physical PDF page (the cover), for list views.",
    )
    first_quran_pdf_page = models.PositiveSmallIntegerField(
        default=1, help_text="PDF physical page index (1-based) of the first logical Quran page."
    )
    last_quran_pdf_page = models.PositiveSmallIntegerField(
        help_text="PDF physical page index (1-based) of the last logical Quran page."
    )
    visibility = models.CharField(
        max_length=16,
        choices=VisibilityChoices.choices,
        default=VisibilityChoices.PRIVATE,
        help_text="Published mushafs appear in the public gallery and can be duplicated by anyone.",
    )
    published_at = models.DateTimeField(null=True, blank=True)
    ijam_mode = models.CharField(
        max_length=16,
        choices=IjamModeChoices.choices,
        default=IjamModeChoices.REPORT,
        help_text=(
            "Whether word detection checks each word against the dots its spelling "
            "expects. The stored text describes one convention: Maghribi puts fa's "
            "dot below where it puts it above, and a mushaf may leave a final ya "
            "undotted, so on those every such word reads as short. Set this to "
            "'ignore' there. It is a fact about the printing, like the riwaya, and "
            "is not guessed."
        ),
    )
    line_png_size = models.CharField(
        max_length=16,
        choices=LinePngSizeChoices.choices,
        default=LinePngSizeChoices.BOX,
        help_text=(
            "How tall each exported line PNG is: the line's own box; padded with "
            "transparent space to the page's largest line; cut to its first and "
            "last inked row; or cut so, then padded to the page's tallest cut line. "
            "Only future exports follow a change."
        ),
    )
    description = models.TextField(
        blank=True,
        default="",
        help_text="Shown on the gallery card — what this mushaf is and how complete the work is.",
    )
    duplicated_from = models.ForeignKey(
        "self",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="duplicates",
        help_text=("The gallery mushaf this was copied from. SET_NULL so a copy outlives its source being deleted."),
    )

    class Meta:
        db_table = "mushaf"
        verbose_name = "Mushaf"
        verbose_name_plural = "Masahef"
        constraints = (models.UniqueConstraint(fields=["owner", "name"], name="unique_owner_mushaf_name"),)

    def __str__(self) -> str:
        return self.name


class Template(BaseModel):
    """A table for Templates"""

    mushaf = models.ForeignKey(Mushaf, on_delete=models.CASCADE, related_name="templates")
    type = models.CharField(
        max_length=16,
        choices=TemplateTypeChoices.choices,
        default=TemplateTypeChoices.SURA_HEADER,
    )
    image = models.ImageField(upload_to=template_path)
    ignore_rects = models.JSONField(
        default=dict,
        blank=True,
        help_text=(
            "A JSON object containing the coordinates of the rectangles to ignore in the template image."
            "The format is {'x': int, 'y': int, 'width': int, 'height': int}."
        ),
    )

    class Meta:
        db_table = "template"
        verbose_name = "Template"
        verbose_name_plural = "Templates"
        constraints = (models.UniqueConstraint(fields=["mushaf", "type"], name="unique_mushaf_type"),)

    def __str__(self) -> str:
        return f"{self.type} template for {self.mushaf.name}"


class ProcessingRun(BaseModel):
    """A table for Processing Runs"""

    mushaf = models.ForeignKey(Mushaf, on_delete=models.CASCADE, related_name="processing_runs")
    settings = models.JSONField(
        default=dict,
        blank=True,
        help_text=(
            "A JSON object containing the settings used for the processing run."
            "The format is {'setting_name': setting_value}."
            "The settings include padding, expected_lines, sura_header_slots, sura_header_threshold, max_sura_headers,"
            " match_threshold, alternate_horizontal_margin, prefer_acceleration, start_sura, start_aya, bounds"
        ),
    )
    page_range_start = models.PositiveSmallIntegerField(
        help_text="The logical page number of the first page of the PDF to process. The first page is 1."
    )
    page_range_end = models.PositiveSmallIntegerField(
        help_text="The logical page number of the last page of the PDF to process."
    )
    status = models.CharField(
        max_length=32,
        choices=RunStatusChoices.choices,
        default=RunStatusChoices.COMPLETED,
    )
    abort_info = models.TextField(blank=True, default="")
    log_path = models.CharField(
        max_length=255,
        blank=True,
        default="",
        help_text="Path (relative to settings.LOG_DIR) of this run's detailed log file.",
    )

    class Meta:
        db_table = "processing_run"
        verbose_name = "Processing Run"
        verbose_name_plural = "Processing Runs"


class ProcessJobStateChoices(models.TextChoices):
    #: Requested, and waiting for a worker to claim it. Not final: a queued job
    #: holds its mushaf exactly as a running one does.
    QUEUED = "queued", "Queued"
    RUNNING = "running", "Running"
    COMPLETED = "completed", "Completed"
    ABORTED_LINE_DETECTION = "aborted_line_detection", "Aborted (line detection)"
    CANCELLED = "cancelled", "Cancelled"
    ERROR = "error", "Error"
    #: The worker that owned this job stopped reporting — a deploy, a crash, or
    #: a killed process. Only ever set by another process noticing the silence.
    INTERRUPTED = "interrupted", "Interrupted"


class ProcessJobKindChoices(models.TextChoices):
    DETECTION = "detection", "Page detection"
    WORDS = "words", "Word boundaries"
    #: One page processed for calibration review. Its own kind so the word-run
    #: screen, which polls the latest ``words`` job, never mistakes it for a run.
    CALIBRATION = "calibration", "Calibration page"
    #: Many pages processed for calibration review, one after another. It counts
    #: pages, where a one-page job counts that page's lines — hence a kind of its own.
    CALIBRATION_BATCH = "calibration_batch", "Calibration pages"
    #: The mushaf's fingerprint set regrouped from its confirmed pages.
    LIBRARY_REBUILD = "library_rebuild", "Library rebuild"


class ProcessJob(BaseModel):
    """Live state of one long-running run, of either kind.

    This used to be a dataclass in a module-level dict, which meant a restart
    forgot every running job and a status poll answered by a *different* worker
    process knew nothing about it. Keeping it in the database makes the state
    visible to whichever process happens to serve the next request, which is
    what allows more than one worker.

    The row is written by the worker and read by pollers, so it is deliberately
    small and its updates are single-column where possible.

    **The row describes the whole job.** ``kind`` says which runner does the work
    and ``params`` holds that runner's inputs, so a worker needs nothing but the
    job's id to run it. A job starts ``queued`` and becomes ``running`` when a
    worker claims it (``api.services.jobs.claiming``).

    **Both kinds of run share this table on purpose.** Word detection could have had
    its own, and then two things would break: the concurrency caps count CPU-bound
    work, and two tables would let a box run twice what it was configured for; and
    ``refuse_if_mushaf_has_active_job`` would stop guarding the case that matters most —
    a *detection* run overlapping a *word* run on one mushaf, where
    ``write_coords_to_page`` deletes the page's ``Line`` rows and takes every
    ``LineWord`` with them by cascade.
    """

    kind = models.CharField(
        max_length=32,
        choices=ProcessJobKindChoices.choices,
        default=ProcessJobKindChoices.DETECTION,
        help_text="Which engine this run drives. Detection walks pages; words walks lines.",
    )
    mushaf = models.ForeignKey(Mushaf, on_delete=models.CASCADE, related_name="process_jobs")
    run = models.ForeignKey(ProcessingRun, null=True, blank=True, on_delete=models.SET_NULL, related_name="jobs")
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="process_jobs",
        help_text="Who asked for this job. The per-user limit counts by it, and the runner acts as this user.",
    )
    params = models.JSONField(
        default=dict,
        blank=True,
        help_text="The runner's inputs, as the request gave them. What they are depends on the kind.",
    )

    page_range_start = models.PositiveSmallIntegerField()
    page_range_end = models.PositiveSmallIntegerField()
    total = models.PositiveSmallIntegerField(default=0, help_text="Pages in the requested range.")

    state = models.CharField(
        max_length=32, choices=ProcessJobStateChoices.choices, default=ProcessJobStateChoices.QUEUED
    )
    phase = models.CharField(
        max_length=16, default="starting", help_text="starting/rendering/detecting/saving/finished."
    )
    current_page = models.PositiveSmallIntegerField(null=True, blank=True)
    pages_saved = models.PositiveSmallIntegerField(
        default=0, help_text="Pages actually written — durable, not an estimate."
    )

    cancel_requested = models.BooleanField(
        default=False,
        help_text="Polled by the worker between pages. A flag rather than a signal, so any process can set it.",
    )
    heartbeat_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text=(
            "Last sign of life from the worker. What lets another process tell a "
            "long page apart from a worker that died."
        ),
    )
    requested_at = models.DateTimeField(
        default=timezone.now, help_text="When the job was asked for. A queued job has been requested, not started."
    )
    run_started_at = models.DateTimeField(
        null=True, blank=True, help_text="When a worker claimed the job and began. Null while it is queued."
    )
    claimed_by_worker = models.CharField(
        max_length=255,
        blank=True,
        default="",
        help_text="The name of the worker that claimed the job. A stopping worker flags its own jobs by it.",
    )
    ended_at = models.DateTimeField(null=True, blank=True)

    stopped_on_page = models.PositiveSmallIntegerField(
        null=True, blank=True, help_text="Page the run came to rest on — what 'Resume from here' uses."
    )
    abort_info = models.JSONField(null=True, blank=True)
    error = models.TextField(blank=True, default="")
    #: Detection *reports* where it ended up; a word run is *asked* for a span, so it
    #: fills the start pair too and both ends are known before it begins.
    start_sura = models.PositiveSmallIntegerField(null=True, blank=True)
    start_aya = models.PositiveSmallIntegerField(null=True, blank=True)
    end_sura = models.PositiveSmallIntegerField(null=True, blank=True)
    end_aya = models.PositiveSmallIntegerField(null=True, blank=True)
    lines_done = models.PositiveIntegerField(
        null=True, blank=True, help_text="Word runs only: lines written so far. Detection counts pages instead."
    )
    log_url = models.CharField(max_length=255, blank=True, default="")
    report = models.JSONField(
        null=True,
        blank=True,
        help_text=(
            "Calibration batches only: what happened to each page of the range — processed, "
            "skipped and why, or failed. Written as the run goes, so a poll can show it."
        ),
    )

    class Meta:
        db_table = "process_job"
        verbose_name = "Process Job"
        verbose_name_plural = "Process Jobs"
        indexes = (models.Index(fields=["mushaf", "-requested_at"], name="process_job_mushaf_recent"),)

    def __str__(self) -> str:
        return f"{self.state} job for {self.mushaf_id} ({self.page_range_start}-{self.page_range_end})"


class Page(BaseModel):
    """A table for Pages"""

    mushaf = models.ForeignKey(Mushaf, on_delete=models.CASCADE, related_name="pages")
    page_number = models.PositiveSmallIntegerField(
        default=1, help_text="The logical page number of the Quran. The first page is 1."
    )
    source_pdf_page = models.PositiveSmallIntegerField(null=True, help_text="The page number of the source PDF.")
    last_run = models.ForeignKey(ProcessingRun, null=True, on_delete=models.SET_NULL, related_name="pages")
    bbox_x = models.PositiveIntegerField(null=True, help_text="The x coordinate of the bounding box.")
    bbox_y = models.PositiveIntegerField(null=True, help_text="The y coordinate of the bounding box.")
    bbox_w = models.PositiveIntegerField(null=True, help_text="The width of the bounding box.")
    bbox_h = models.PositiveIntegerField(null=True, help_text="The height of the bounding box.")
    reviewed = models.BooleanField(
        default=False,
        help_text="True once a user has saved this page in review; reset to False on (re)process.",
    )
    lines_finalized = models.BooleanField(
        default=False,
        help_text=(
            "True once a user has marked this page's line cuts finished in Finalize. "
            "Reset to False whenever the page's lines are rebuilt: (re)process or a review save."
        ),
    )
    line_padding = models.SmallIntegerField(
        null=True,
        help_text=(
            "The padding the page's lines were given in Finalize, in px above and below, as "
            "of its last save there (the value most of its lines share). Null until then, "
            "and again whenever the lines are rebuilt. The latest checked pages' agreeing "
            "value is applied to a page still null when it opens."
        ),
    )
    sura_header_padding = models.SmallIntegerField(
        null=True,
        help_text=(
            "The padding the page's sura headers were given in Finalize, in px above and "
            "below, as of its last save there (the value most of them share). Null on a page "
            "without one, until then, and again whenever the lines are rebuilt. The latest "
            "checked pages' agreeing value — and whether their headers' edge ink was erased — "
            "is applied to the headers of a page opening with its lines unpadded."
        ),
    )

    class Meta:
        db_table = "page"
        verbose_name = "Page"
        verbose_name_plural = "Pages"
        constraints = (models.UniqueConstraint(fields=["mushaf", "page_number"], name="unique_mushaf_page_number"),)

    def __str__(self) -> str:
        return f"Page {self.page_number} of {self.mushaf.name}"


class Line(BaseModel):
    """A table for Lines"""

    page = models.ForeignKey(Page, on_delete=models.CASCADE, related_name="lines")
    line_number = models.PositiveSmallIntegerField(default=1, help_text="The line number in the page.")
    type = models.CharField(
        max_length=16,
        choices=LineTypeChoices.choices,
        default=LineTypeChoices.TEXT,
    )
    sura = models.ForeignKey("quran.Sura", null=True, on_delete=models.SET_NULL, related_name="lines")
    line_png = models.ImageField(
        upload_to=line_png_path, null=True, help_text="Final PNG path after coordinates + erase; set on export"
    )
    line_png_trim_top = models.PositiveIntegerField(
        default=0,
        help_text=(
            "Rows a tight export cut off the top of the line's box, so the PNG's place "
            "on the page can still be told (data export). 0 for any other size."
        ),
    )
    line_png_trim_bottom = models.PositiveIntegerField(
        default=0, help_text="Rows a tight export cut off the bottom of the line's box. 0 for any other size."
    )
    bbox_x = models.PositiveIntegerField(help_text="The x coordinate of the bounding box.")
    bbox_y = models.PositiveIntegerField(help_text="The y coordinate of the bounding box.")
    bbox_w = models.PositiveIntegerField(help_text="The width of the bounding box.")
    bbox_h = models.PositiveIntegerField(help_text="The height of the bounding box.")
    erase_edge_ink = models.BooleanField(
        default=False,
        help_text=(
            "Cut from the exported PNG every piece of ink touching the line's top or "
            "bottom edge: a neighbouring line showing through. A rule, not a mask, so "
            "it is worked out again whenever the line's box changes."
        ),
    )

    class Meta:
        db_table = "line"
        verbose_name = "Line"
        verbose_name_plural = "Lines"
        ordering = ("line_number",)


class EraseStroke(BaseModel):
    """A table for Erase Strokes"""

    line = models.ForeignKey(Line, on_delete=models.CASCADE, related_name="erase_strokes")
    brush_size = models.PositiveSmallIntegerField(default=12)
    points = models.JSONField(
        default=list,
        help_text=("A JSON array containing the coordinates of the points in the stroke.The format is [[x, y], ...]."),
    )

    class Meta:
        db_table = "erase_stroke"
        verbose_name = "Erase Stroke"
        verbose_name_plural = "Erase Strokes"


class Segment(BaseModel):
    """A table for Segments"""

    line = models.ForeignKey(Line, on_delete=models.CASCADE, related_name="segments")
    segment_order = models.PositiveSmallIntegerField(default=1, help_text="The segment number in the line.")
    bbox_x = models.PositiveIntegerField(help_text="The x coordinate of the bounding box.")
    bbox_w = models.PositiveIntegerField(help_text="The width of the bounding box.")
    has_separator = models.BooleanField(default=False, help_text="Whether the segment has a separator or not.")
    aya_number = models.PositiveSmallIntegerField(null=True, help_text="The aya number in the sura.")

    class Meta:
        db_table = "segment"
        verbose_name = "Segment"
        verbose_name_plural = "Segments"
        ordering = ("segment_order",)


class LineWord(BaseModel):
    """Where one word ends on one line of a mushaf. **The cut is the product.**

    Written by ``services.word_coordinates`` from the boundary engine's output, and
    corrected by hand through the page-words endpoint. The one number this project
    wants from the engine is ``end_x``.

    **``word`` is a label, not the identity.** The Quran text is supplied to help the
    engine align ink to spelling; it is not a claim about what this mushaf prints. A
    riwaya other than Hafs may carry a word the stored text does not have — an added
    حرف جر — and a reviewer adding that cut has no row to point at. So it is nullable,
    and a null means "there is a word here that the text does not name".

    **Both edges are stored.** The end alone used to be enough: a word's right edge
    was taken to be the previous word's ``end_x``, which needs no second column to
    keep true. But that span is not the word — measured over sura 7 the printed gap
    between two words runs to a median of 13px, so a highlight drawn that way covers
    the whitespace before the word as well as the word. People reading a mushaf want
    the word lit, so the right edge is now measured and kept.

    **``start_x`` is the LARGER number.** Arabic runs right to left, so a word starts
    at its right edge and ends at its left one: ``start_x > end_x`` for every sane
    row, and anything walking from one to the other has to count down. Both come from
    the same place — the word's letter bodies, marks excluded, so a tashkeel leaning
    past its letter moves neither edge.

    Boxes do **not** tile the line, and they may overlap. The gap between two words is
    real, and about 7% of words have ink reaching under a neighbour — a tail sweeping
    left below the next word — so its box genuinely starts inside that neighbour's.
    Both are stored as measured.

    **No sura or aya column**, for the reason :class:`quran.models.Word` has none:
    that question has six different answers, one per counting system, and a single
    stored answer would bake one of them in. Ask ``quran.Aya`` for the word range of
    an aya and filter on ``word`` instead — reference data that has been reviewed,
    rather than ``Segment.aya_number``, which is a cache of a derivation.

    **Reading order is stored, not measured.** These rows used to be ordered by
    ``-end_x``: right to left, no rank to renumber, and defined for a word with no
    label. That argument only holds while the engine's x is right, and the engine is
    predicted to be wrong — a badly read line comes back with its words out of
    order along the page, and sorting by geometry then reports the mushaf as reading
    in an order it does not. So ``position`` carries the sequence, and the edges are
    the extent of the ink a reviewer confirmed for the word — rows are written only
    when a page is confirmed in calibration.
    """

    line = models.ForeignKey(Line, on_delete=models.CASCADE, related_name="words")
    word = models.ForeignKey(
        "quran.Word",
        null=True,
        on_delete=models.PROTECT,
        related_name="+",
        help_text="Which word of the Quran this is, by its global index. Null where this mushaf "
        "carries a word the stored text does not have.",
    )
    position = models.PositiveSmallIntegerField(
        help_text="Where this word falls in the line's reading order, from 0. The sequence the "
        "words table gives, not the order the cuts happen to sit in.",
    )
    start_x = models.PositiveIntegerField(
        help_text="Page x where the word starts — its RIGHT edge, since Arabic runs right to "
        "left, so this is the LARGER of the two.",
    )
    end_x = models.PositiveIntegerField(
        help_text="Page x where the word ends — its LEFT edge, since Arabic runs right to left."
    )

    class Meta:
        db_table = "line_word"
        verbose_name = "Line Word"
        verbose_name_plural = "Line Words"
        ordering = ("position",)
        constraints = (
            # Repeated NULLs are allowed by a unique index, so added words are
            # unaffected while a labelled word still cannot appear twice on a line.
            models.UniqueConstraint(fields=["line", "word"], name="unique_line_word"),
            # One word to a slot. Nothing constrains end_x any more: two words of a
            # badly read line may land on the same pixel, and that is a thing to show
            # the reviewer stacked up and let them pull apart, not a write to refuse.
            #
            # Deferred, because renumbering a line is a permutation and Postgres
            # checks a unique constraint per ROW as an UPDATE runs, not at the end of
            # the statement: moving 0→1 while 1→0 collides halfway through even
            # though the settled state is sound. What must be unique is where the
            # transaction lands, which is exactly what deferring says.
            models.UniqueConstraint(
                fields=["line", "position"],
                name="unique_line_word_position",
                deferrable=models.Deferrable.DEFERRED,
            ),
        )

    def __str__(self) -> str:
        return f"word {self.word_id or '?'} ends at x={self.end_x}"


class CalibrationSnapshot(BaseModel):
    """One text line's ink, measured once over its full box, kept for good.

    **Why a copy and not the Line.** Re-processing a page deletes its ``Line`` rows,
    and a label a reviewer gave a blob is only meaningful against the exact pixels
    it was given on. So the pixels come along: ``image`` is the line as the engine
    measured it, ``labels`` the same size with every pixel's blob id encoded in its
    RGB value (0 is background), and ``metadata`` every blob's geometry and evidence.
    The page and line are *numbers*, not foreign keys, for the same reason.

    **Why the full line box.** A word run cuts the first and last line of a span at
    an aya boundary, and a cut image gets new blob numbers and a re-measured writing
    band. A snapshot is taken once per line, uncut; a span selects blobs from it.

    Immutable. ``fingerprint`` hashes everything the measurement depends on, so a
    changed source makes a new snapshot rather than editing an old one.
    """

    mushaf = models.ForeignKey(Mushaf, on_delete=models.CASCADE, related_name="calibration_snapshots")
    page_number = models.PositiveSmallIntegerField()
    line_number = models.PositiveSmallIntegerField()
    #: The ``Line`` it was cut from, while that row lasts. Not a key: provenance only.
    source_line_id = models.UUIDField(null=True, blank=True)
    fingerprint = models.CharField(max_length=64)
    metadata = models.JSONField(default=dict)
    image = models.FileField(upload_to=calibration_file_path, max_length=255)
    labels = models.FileField(upload_to=calibration_file_path, max_length=255)

    class Meta:
        db_table = "calibration_snapshot"
        verbose_name = "Calibration Snapshot"
        verbose_name_plural = "Calibration Snapshots"
        constraints = (models.UniqueConstraint(fields=["mushaf", "fingerprint"], name="unique_calibration_snapshot"),)

    def __str__(self) -> str:
        return f"p{self.page_number}:l{self.line_number} snapshot of {self.mushaf_id}"


class CalibrationReview(BaseModel):
    """One page's calibration review: the working draft and a pointer to its approval.

    ``payload`` is the **draft** — mutable, saved as often as the reviewer likes, and
    never a source of examples. ``revision`` counts every change to it, so a tab
    holding an older number is refused rather than allowed to overwrite newer work.
    ``confirmed_revision`` names the :class:`CalibrationRevision` that is approved;
    re-editing a confirmed page leaves that approval in force until it is replaced.

    Keyed by page *number*, so it outlives re-processing the page.
    """

    mushaf = models.ForeignKey(Mushaf, on_delete=models.CASCADE, related_name="calibration_reviews")
    page_number = models.PositiveSmallIntegerField()
    revision = models.PositiveIntegerField(default=0)
    confirmed_revision = models.PositiveIntegerField(null=True, blank=True)
    payload = models.JSONField(default=dict)

    class Meta:
        db_table = "calibration_review"
        verbose_name = "Calibration Review"
        verbose_name_plural = "Calibration Reviews"
        constraints = (models.UniqueConstraint(fields=["mushaf", "page_number"], name="unique_calibration_review"),)

    def __str__(self) -> str:
        return f"p{self.page_number} review r{self.revision} of {self.mushaf_id}"


class CalibrationRevisionKind(models.TextChoices):
    #: What the engine proposed before anyone touched the page — the prediction
    #: record evaluation compares against. Written once per processing.
    PROCESSED = "processed", "Processed"
    #: An approval: the only kind that supplies examples.
    CONFIRMED = "confirmed", "Confirmed"
    #: Word boundaries a person corrected before calibration existed, archived so a
    #: re-processed page cannot take them with it. No blob labels — none were given.
    LEGACY = "legacy", "Legacy boundaries"


class CalibrationRevision(BaseModel):
    """An immutable record in a review's history.

    Written at the three moments that must never be rewritten — see
    :class:`CalibrationRevisionKind`. Drafts are *not* revisions: they change on
    every save, and keeping each one would store the whole page again each time.
    """

    review = models.ForeignKey(CalibrationReview, on_delete=models.CASCADE, related_name="revisions")
    number = models.PositiveIntegerField()
    kind = models.CharField(max_length=16, choices=CalibrationRevisionKind.choices)
    payload = models.JSONField(default=dict)
    #: A confirmation's own habit counts (``core.word_boundary.habits``): what the page
    #: adds to its mushaf's, and takes off again when it is confirmed anew.
    habits = models.JSONField(default=dict, blank=True)
    #: The client's id for the request that wrote this, so a retried confirmation
    #: returns the first answer instead of approving the page twice.
    request_id = models.UUIDField(null=True, blank=True)

    class Meta:
        db_table = "calibration_revision"
        verbose_name = "Calibration Revision"
        verbose_name_plural = "Calibration Revisions"
        ordering = ("number",)
        constraints = (
            models.UniqueConstraint(fields=["review", "number"], name="unique_calibration_revision"),
            models.UniqueConstraint(fields=["review", "request_id"], name="unique_calibration_request"),
        )

    def __str__(self) -> str:
        return f"{self.kind} r{self.number} of {self.review_id}"

    def save(self, *args: Any, **kwargs: Any) -> None:
        if not self._state.adding:
            raise ValidationError("Calibration revisions are immutable; create a new revision.")
        super().save(*args, **kwargs)


class CalibrationSettings(BaseModel):
    """How the mushaf's fingerprint library compares shapes: local, never carried by a
    copy or an import."""

    mushaf = models.OneToOneField(Mushaf, on_delete=models.CASCADE, related_name="calibration_settings")
    revision = models.PositiveIntegerField(default=0)
    #: How the fingerprint library compares two blobs (``core.word_boundary.library.COMPARISONS``).
    comparison = models.CharField(max_length=32, default="descriptor32")
    #: The library's LIMIT, in the comparison's own units; null means its default.
    library_limit = models.FloatField(null=True, blank=True)

    class Meta:
        db_table = "calibration_settings"


class FingerprintLibrary(BaseModel):
    """A mushaf's one stored fingerprint set: what every page's lookups read.

    Updated at every Confirm (``api.services.fingerprint_updates``), regrouped only on a
    Rebuild (``api.services.fingerprint_rebuild``). ``version`` counts every change, so a
    server process holding an older copy knows to reload it; 0 means never built.
    ``comparison`` and ``limit`` are what the set was grouped with, which may trail the
    settings while a Rebuild after a new LIMIT is still running. ``needs_rebuild`` is
    set when a check found the set disagreeing with the confirmed pages.
    """

    mushaf = models.OneToOneField(Mushaf, on_delete=models.CASCADE, related_name="fingerprint_library")
    version = models.PositiveIntegerField(default=0)
    comparison = models.CharField(max_length=32, default="descriptor32")
    limit = models.FloatField()
    feature_version = models.PositiveIntegerField(default=0)
    library_version = models.PositiveIntegerField(default=0)
    needs_rebuild = models.BooleanField(default=False)
    #: How the hand prints, summed over the confirmed pages' own counts
    #: (``core.word_boundary.habits``): a quick copy of what they say, kept in step by
    #: the same updates as the shapes.
    habits = models.JSONField(default=dict, blank=True)

    class Meta:
        db_table = "fingerprint_library"
        verbose_name = "Fingerprint Library"
        verbose_name_plural = "Fingerprint Libraries"

    def __str__(self) -> str:
        return f"fingerprint set v{self.version} of {self.mushaf_id}"


class FingerprintGroup(BaseModel):
    """One fingerprint of a kind — a contents key — and the shapes kept beside it."""

    library = models.ForeignKey(FingerprintLibrary, on_delete=models.CASCADE, related_name="groups")
    #: body | mark, as the key says.
    role = models.CharField(max_length=8)
    #: What its blobs hold (``core.text.contents``): "لو:", ":fatha", a letter with its mark.
    key = models.TextField(db_index=True)
    #: A plain body's shape with the dots off (``core.text.rasm``), what a key with few
    #: shapes of its own borrows by; "" for anything else.
    shape = models.TextField(blank=True, default="", db_index=True)

    class Meta:
        db_table = "fingerprint_group"
        verbose_name = "Fingerprint Group"
        verbose_name_plural = "Fingerprint Groups"

    def __str__(self) -> str:
        return f"{self.key} group of {self.library_id}"


class FingerprintShape(BaseModel):
    """One confirmed blob the set keeps: a group's fingerprint, or one of the up to 11
    shapes kept beside it.

    There is no blob table: a blob is a snapshot and a blob id, its geometry in the
    snapshot's metadata and its label in its page's confirmed revision. ``features``
    holds its raw descriptor (``examples.feature_vector``, 1,030 float64 numbers), so a
    lookup never measures anything.
    """

    library = models.ForeignKey(FingerprintLibrary, on_delete=models.CASCADE, related_name="shapes")
    group = models.ForeignKey(FingerprintGroup, on_delete=models.CASCADE, related_name="shapes")
    snapshot = models.ForeignKey(CalibrationSnapshot, on_delete=models.CASCADE, related_name="fingerprint_shapes")
    blob_id = models.PositiveIntegerField()
    #: The confirmation it was learned from, while that revision lasts.
    revision = models.ForeignKey(
        CalibrationRevision, on_delete=models.SET_NULL, null=True, blank=True, related_name="fingerprint_shapes"
    )
    is_fingerprint = models.BooleanField(default=False)
    #: To its group's fingerprint, in the comparison's units.
    distance = models.FloatField(default=0.0)
    #: A person found it right: never dropped by the spread rule, and a looks-right
    #: fingerprint stays a fingerprint through a Rebuild.
    looks_right = models.BooleanField(default=False)
    features = models.BinaryField()

    class Meta:
        db_table = "fingerprint_shape"
        verbose_name = "Fingerprint Shape"
        verbose_name_plural = "Fingerprint Shapes"
        constraints = (
            models.UniqueConstraint(fields=["library", "snapshot", "blob_id"], name="unique_fingerprint_shape"),
        )

    def __str__(self) -> str:
        return f"blob {self.blob_id} of {self.snapshot_id} in {self.group_id}"


class RemovedShape(BaseModel):
    """A confirmed blob a person took out of the fingerprint set, so a Rebuild never
    brings it back and Restore is possible. It counts while the blob is still confirmed
    as the key it was removed as."""

    mushaf = models.ForeignKey(Mushaf, on_delete=models.CASCADE, related_name="removed_shapes")
    snapshot = models.ForeignKey(CalibrationSnapshot, on_delete=models.CASCADE, related_name="removed_shapes")
    blob_id = models.PositiveIntegerField()
    role = models.CharField(max_length=8)
    key = models.TextField()

    class Meta:
        db_table = "removed_shape"
        verbose_name = "Removed Shape"
        verbose_name_plural = "Removed Shapes"
        constraints = (models.UniqueConstraint(fields=["mushaf", "snapshot", "blob_id"], name="unique_removed_shape"),)

    def __str__(self) -> str:
        return f"removed: {self.key} blob {self.blob_id} of {self.snapshot_id}"


class ActivityEvent(BaseModel):
    """A table for Activity Events (the per-mushaf audit feed)"""

    mushaf = models.ForeignKey(Mushaf, on_delete=models.CASCADE, related_name="activity_events")
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="activity_events",
        help_text=(
            "Who did it. Null for events recorded before accounts existed, and for "
            "anything a background worker does on nobody's behalf."
        ),
    )
    type = models.CharField(max_length=32, choices=ActivityTypeChoices.choices)
    payload = models.JSONField(
        default=dict,
        blank=True,
        help_text=(
            "Event details keyed by type, e.g. {'template_type': ...} for template_saved,"
            " {'run_id', 'run_number', 'status', 'pages_saved', 'page_range_start', 'page_range_end'}"
            " for run_finished, {'page_number': ...} for review_saved."
        ),
    )

    class Meta:
        db_table = "activity_event"
        verbose_name = "Activity Event"
        verbose_name_plural = "Activity Events"

    def __str__(self) -> str:
        return f"{self.type} on {self.mushaf.name}"
