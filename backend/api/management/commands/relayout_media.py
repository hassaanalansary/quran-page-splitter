"""Move existing media into the per-mushaf layout.

Everything a mushaf owns now lives under ``media/mushafs/<id>/`` — its cover,
its template crops and its exported line PNGs — while the source PDF moves to a
shared, content-addressed ``media/pdfs/<sha256>.pdf``. See ``api.models`` for
why the PDF is the exception.

``upload_to`` only decides where *new* files land, so anything already on disk
needs moving and its stored path rewriting. That is this command::

    uv run python manage.py relayout_media --dry-run   # show the plan
    uv run python manage.py relayout_media             # do it

Safe to re-run: files already in the new layout are skipped, so an interrupted
run is fixed by running it again. Rows whose file has gone missing are reported
and left alone rather than being pointed at a path with nothing behind it.

It also collapses the duplicate PDFs left by uploads from before repeat-upload
dedupe existed — Django suffixed those (``<sha>.pdf`` *and* ``<sha>_qRCEHgI.pdf``),
so every redundant copy of a ~150 MB scan is reclaimed here.
"""

from collections import defaultdict
from typing import Any

from django.core.files.base import File
from django.core.files.storage import default_storage
from django.core.management.base import BaseCommand, CommandParser
from django.db import transaction

from api.models import Line, Mushaf, Template, mushaf_dir


class Command(BaseCommand):
    help = "Move media into the per-mushaf directory layout (mushafs/<id>/ + pdfs/<sha>.pdf)."

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would move without touching disk or the database.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        self.dry_run = options["dry_run"]
        self.moved = 0
        self.skipped = 0
        self.reclaimed = 0
        self.missing: list[str] = []

        if self.dry_run:
            self.stdout.write(self.style.WARNING("DRY RUN - nothing will be written.\n"))

        with transaction.atomic():
            self._move_pdfs()
            self._move_thumbnails()
            self._move_templates()
            self._move_lines()
            if self.dry_run:
                transaction.set_rollback(True)

        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS(f"{self.moved} file(s) relocated, {self.skipped} already in place."))
        if self.reclaimed:
            self.stdout.write(self.style.SUCCESS(f"{self.reclaimed} duplicate PDF(s) removed."))
        for note in self.missing:
            self.stdout.write(self.style.ERROR(f"missing on disk, left alone: {note}"))

    # -- helpers --------------------------------------------------------------
    @staticmethod
    def _stored_name(field: Any) -> str:
        """``FileField.name`` narrowed to a real path ("" when the row has none)."""
        return field.name or ""

    def _relocate(self, old: str, new: str, *, label: str) -> bool:
        """Copy ``old`` to ``new`` and delete the original. True if it moved."""
        if old == new:
            self.skipped += 1
            return False
        if not default_storage.exists(old):
            self.missing.append(f"{label} -> {old}")
            return False
        self.stdout.write(f"  {old}\n    -> {new}")
        if self.dry_run:
            self.moved += 1
            return True
        if not default_storage.exists(new):
            with default_storage.open(old, "rb") as source:
                default_storage.save(new, File(source))
        default_storage.delete(old)
        self.moved += 1
        return True

    # -- the four kinds of file -----------------------------------------------
    def _move_pdfs(self) -> None:
        """Content-address the PDFs, collapsing pre-dedupe duplicates as we go."""
        self.stdout.write(self.style.MIGRATE_HEADING("PDFs -> pdfs/<sha256>.pdf"))
        by_sha: dict[str, list[Mushaf]] = defaultdict(list)
        for mushaf in Mushaf.objects.exclude(pdf_file="").only("id", "pdf_file", "pdf_sha256"):
            by_sha[mushaf.pdf_sha256].append(mushaf)

        for sha, rows in by_sha.items():
            target = f"pdfs/{sha}.pdf"
            # Prefer a row already holding a readable file as the one to move.
            source = next((m for m in rows if default_storage.exists(self._stored_name(m.pdf_file))), None)
            if source is None:
                self.missing.append(f"pdf {sha}")
                continue

            if not default_storage.exists(target):
                self._relocate(self._stored_name(source.pdf_file), target, label=f"pdf {sha}")

            # Every row with these bytes now shares the one file; the leftovers
            # (Django's `_qRCEHgI` collision copies) are redundant.
            for row in rows:
                old = self._stored_name(row.pdf_file)
                if old == target:
                    self.skipped += 1
                    continue
                if default_storage.exists(old):
                    self.stdout.write(f"  duplicate removed: {old}")
                    if not self.dry_run:
                        default_storage.delete(old)
                    self.reclaimed += 1
                row.pdf_file.name = target
                if not self.dry_run:
                    row.save(update_fields=["pdf_file"])

    def _move_thumbnails(self) -> None:
        """Covers were shared by hash; each mushaf now keeps its own copy."""
        self.stdout.write(self.style.MIGRATE_HEADING("Thumbnails -> mushafs/<id>/thumbnail.png"))
        rows = list(Mushaf.objects.exclude(thumbnail="").exclude(thumbnail=None).only("id", "thumbnail"))
        # How many rows still point at each old path, so the file is only
        # deleted once the last of them has taken its own copy.
        refs: dict[str, int] = defaultdict(int)
        for mushaf in rows:
            refs[self._stored_name(mushaf.thumbnail)] += 1

        for mushaf in rows:
            old = self._stored_name(mushaf.thumbnail)
            new = f"{mushaf_dir(mushaf.id)}/thumbnail.png"
            if old == new:
                self.skipped += 1
                continue
            if not default_storage.exists(old):
                self.missing.append(f"thumbnail {mushaf.id} -> {old}")
                continue
            self.stdout.write(f"  {old}\n    -> {new}")
            if not self.dry_run:
                if not default_storage.exists(new):
                    with default_storage.open(old, "rb") as source:
                        default_storage.save(new, File(source))
                refs[old] -= 1
                if refs[old] == 0:
                    default_storage.delete(old)
                mushaf.thumbnail.name = new
                mushaf.save(update_fields=["thumbnail"])
            self.moved += 1

    def _move_templates(self) -> None:
        self.stdout.write(self.style.MIGRATE_HEADING("Templates -> mushafs/<id>/templates/"))
        for template in Template.objects.exclude(image="").only("id", "image", "type", "mushaf"):
            new = f"{mushaf_dir(template.mushaf_id)}/templates/{template.type}.png"
            old = self._stored_name(template.image)
            if self._relocate(old, new, label=f"template {template.id}") and not self.dry_run:
                template.image.name = new
                template.save(update_fields=["image"])

    def _move_lines(self) -> None:
        """Exported PNGs, renamed to mirror the lines.zip layout."""
        self.stdout.write(self.style.MIGRATE_HEADING("Line PNGs -> mushafs/<id>/lines/page-NNNN/line-NN.png"))
        lines = (
            Line.objects.exclude(line_png="")
            .exclude(line_png=None)
            .select_related("page")
            .only("id", "line_png", "line_number", "page__page_number", "page__mushaf")
            .order_by("page__mushaf_id", "page__page_number", "line_number")
        )
        for line in lines.iterator(chunk_size=500):
            new = (
                f"{mushaf_dir(line.page.mushaf_id)}/lines/"
                f"page-{line.page.page_number:04d}/line-{line.line_number:02d}.png"
            )
            old = self._stored_name(line.line_png)
            if self._relocate(old, new, label=f"line {line.id}") and not self.dry_run:
                line.line_png.name = new
                line.save(update_fields=["line_png"])
