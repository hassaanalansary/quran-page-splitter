import uuid

from django.db import models


class TemplateTypeChoices(models.TextChoices):
    SURA_HEADER = "sura_header", "Sura Header"
    AYA_SEPARATOR = "aya_separator", "Aya Separator"


class LineTypeChoices(models.TextChoices):
    SURA_HEADER = "sura_header", "Sura Header"
    BESMELLA = "besmella", "Besmella"
    TEXT = "text", "Text"


class RunStatusChoices(models.TextChoices):
    COMPLETED = "completed", "Completed"
    ABORTED_LINE_DETECTION = "aborted_line_detection", "Aborted Line Detection"
    ERROR = "error", "Error"


class BaseModel(models.Model):
    """A base model for all models"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Qiraa(BaseModel):
    """A table for Qiraat"""

    name = models.CharField(max_length=256, unique=True)
    description = models.TextField(blank=True, default="")


class Sura(models.Model):
    """A table for the swar"""

    number = models.PositiveSmallIntegerField(primary_key=True)
    transliteration = models.CharField(max_length=32, unique=True)
    name_arabic = models.CharField(max_length=32, unique=True)

    class Meta:
        db_table = "sura"
        verbose_name = "Sura"
        verbose_name_plural = "Suras"

    def __str__(self) -> str:
        return f"{self.number}. {self.transliteration} ({self.name_arabic})"


class SuraAyaCount(models.Model):
    """A table for the number of ayat in each sura"""

    sura = models.ForeignKey(Sura, on_delete=models.CASCADE, related_name="aya_counts")
    qiraa = models.ForeignKey(Qiraa, on_delete=models.CASCADE, related_name="sura_aya_counts")
    count = models.PositiveSmallIntegerField()

    class Meta:
        db_table = "sura_aya_count"
        verbose_name = "Sura Aya Count"
        verbose_name_plural = "Sura Aya Counts"
        constraints = (models.UniqueConstraint(fields=["sura", "qiraa"], name="unique_sura_qiraa"),)

    def __str__(self) -> str:
        return f"{self.sura.transliteration} has {self.count} ayat in {self.qiraa.name}"


class Mushaf(BaseModel):
    """A table for Mushafs"""

    qiraa = models.ForeignKey(Qiraa, null=True, on_delete=models.SET_NULL, related_name="mushafs")
    name = models.CharField(max_length=256, unique=True)
    pdf_file = models.FileField(upload_to="mushafs/")
    pdf_sha256 = models.CharField(max_length=64)
    pdf_page_count = models.PositiveSmallIntegerField()
    first_quran_pdf_page = models.PositiveSmallIntegerField(
        default=1, help_text="PDF physical page index (1-based) of the first logical Quran page."
    )
    last_quran_pdf_page = models.PositiveSmallIntegerField(
        help_text="PDF physical page index (1-based) of the last logical Quran page."
    )

    class Meta:
        db_table = "mushaf"
        verbose_name = "Mushaf"
        verbose_name_plural = "Masahef"

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
    image = models.ImageField(upload_to="templates/")
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

    class Meta:
        db_table = "processing_run"
        verbose_name = "Processing Run"
        verbose_name_plural = "Processing Runs"


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
    sura = models.ForeignKey(Sura, null=True, on_delete=models.SET_NULL, related_name="lines")
    line_png = models.ImageField(
        upload_to="lines/", null=True, help_text="Final PNG path after coordinates + erase; set on export"
    )
    bbox_x = models.PositiveIntegerField(help_text="The x coordinate of the bounding box.")
    bbox_y = models.PositiveIntegerField(help_text="The y coordinate of the bounding box.")
    bbox_w = models.PositiveIntegerField(help_text="The width of the bounding box.")
    bbox_h = models.PositiveIntegerField(help_text="The height of the bounding box.")

    class Meta:
        db_table = "line"
        verbose_name = "Line"
        verbose_name_plural = "Lines"


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
