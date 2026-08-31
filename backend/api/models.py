import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone


class TemplateTypeChoices(models.TextChoices):
    SURA_HEADER = "sura_header", "Sura Header"
    AYA_SEPARATOR = "aya_separator", "Aya Separator"


class LineTypeChoices(models.TextChoices):
    SURA_HEADER = "sura_header", "Sura Header"
    BESMELLA = "besmella", "Besmella"
    TEXT = "text", "Text"


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


class VisibilityChoices(models.TextChoices):
    PRIVATE = "private", "Private"
    PUBLISHED = "published", "Published"


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
    export_uniform_size = models.BooleanField(
        default=False,
        help_text=(
            "Pad every exported line PNG on a page out to the size of that page's "
            "largest line, with transparent space. Nothing is ever cropped."
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
    RUNNING = "running", "Running"
    COMPLETED = "completed", "Completed"
    ABORTED_LINE_DETECTION = "aborted_line_detection", "Aborted (line detection)"
    CANCELLED = "cancelled", "Cancelled"
    ERROR = "error", "Error"
    #: The worker that owned this job stopped reporting — a deploy, a crash, or
    #: a killed process. Only ever set by another process noticing the silence.
    INTERRUPTED = "interrupted", "Interrupted"


class ProcessJob(BaseModel):
    """Live state of one processing run.

    This used to be a dataclass in a module-level dict, which meant a restart
    forgot every running job and a status poll answered by a *different* worker
    process knew nothing about it. Keeping it in the database makes the state
    visible to whichever process happens to serve the next request, which is
    what allows more than one worker.

    The row is written by the worker and read by pollers, so it is deliberately
    small and its updates are single-column where possible.
    """

    mushaf = models.ForeignKey(Mushaf, on_delete=models.CASCADE, related_name="process_jobs")
    run = models.ForeignKey(ProcessingRun, null=True, blank=True, on_delete=models.SET_NULL, related_name="jobs")
    started_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="process_jobs",
        help_text="Who asked for this run; used for the per-user concurrency cap.",
    )

    page_range_start = models.PositiveSmallIntegerField()
    page_range_end = models.PositiveSmallIntegerField()
    total = models.PositiveSmallIntegerField(default=0, help_text="Pages in the requested range.")

    state = models.CharField(
        max_length=32, choices=ProcessJobStateChoices.choices, default=ProcessJobStateChoices.RUNNING
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
    started_at = models.DateTimeField(default=timezone.now)
    ended_at = models.DateTimeField(null=True, blank=True)

    stopped_on_page = models.PositiveSmallIntegerField(
        null=True, blank=True, help_text="Page the run came to rest on — what 'Resume from here' uses."
    )
    abort_info = models.JSONField(null=True, blank=True)
    error = models.TextField(blank=True, default="")
    end_sura = models.PositiveSmallIntegerField(null=True, blank=True)
    end_aya = models.PositiveSmallIntegerField(null=True, blank=True)
    log_url = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        db_table = "process_job"
        verbose_name = "Process Job"
        verbose_name_plural = "Process Jobs"
        indexes = (models.Index(fields=["mushaf", "-started_at"], name="process_job_mushaf_recent"),)

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
    bbox_x = models.PositiveIntegerField(help_text="The x coordinate of the bounding box.")
    bbox_y = models.PositiveIntegerField(help_text="The y coordinate of the bounding box.")
    bbox_w = models.PositiveIntegerField(help_text="The width of the bounding box.")
    bbox_h = models.PositiveIntegerField(help_text="The height of the bounding box.")

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
