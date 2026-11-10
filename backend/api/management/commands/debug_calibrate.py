"""Step through calibrating one page under a debugger — no HTTP, no polling, no browser.

The calibration twin of ``debug_process``. The Calibrate screen's *Process* button
posts to ``api.views.calibration.process_calibration``, which only registers a job and
returns 202; the work runs on a worker thread. This command runs that same work on the
main thread, so a breakpoint anywhere in it stops cleanly::

    # the default: process_page() called directly, everything rolled back
    uv run python manage.py debug_calibrate --page 15 --rollback

    # through start_calibration_page_job() and the job bookkeeping, still on this thread
    uv run python manage.py debug_calibrate --page 179 --via job-inline --rollback

``--via`` picks how much of the stack is involved:

``service``     call ``calibration.process_page()`` directly. Works on any reviewed,
                numbered page, processed or not — the job's "already processed"
                refusal is not on this path. Start here.
``job-inline``  go through ``start_calibration_page_job()``, as the view does, but run
                the job on this thread. Refused, as in the app, for a page whose draft
                is still current.

``--rollback`` wraps everything in a transaction that is rolled back at the end: you
can watch the draft and its revision being written and keep nothing. Without it, THIS
WRITES REAL DATA — a new draft revision of the page, over the one there now.

Two writes a rollback cannot undo, both harmless: a line whose snapshot does not exist
yet is measured and its ``image.png``/``labels.png`` are saved to media before its row
is (the row is rolled back, the files stay); and the in-process caches in
``calibration`` / ``calibration_snapshots`` live until the process ends.

The engine's trace (``core.*``, DEBUG — ~1,500 lines a page) goes to ``--log`` rather
than to the shared ``quran.log``.
"""

import logging
from pathlib import Path
from typing import Any
from uuid import UUID

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from api.models import CalibrationReview, CalibrationRevision, Mushaf
from api.services import calibration as calibration_service
from api.services.jobs.kinds.calibration_page import start_calibration_page_job


class Command(BaseCommand):
    help = "Calibrate one page in the foreground so it can be stepped through in a debugger."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--mushaf", help="Mushaf id or name (default: the most recently updated one).")
        parser.add_argument("--page", type=int, required=True, help="The page to process.")
        parser.add_argument(
            "--via",
            choices=("service", "job-inline"),
            default="service",
            help="How much of the stack to exercise (default: service).",
        )
        parser.add_argument(
            "--rollback",
            action="store_true",
            help="Roll everything back at the end — watch the writes, keep none.",
        )
        parser.add_argument(
            "--log",
            default=str(Path(settings.LOG_DIR) / "debug_calibrate.log"),
            help="Where the engine's DEBUG trace goes (default: logs/debug_calibrate.log).",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        mushaf = _resolve_mushaf(options["mushaf"])
        page = options["page"]
        _route_engine_log(options["log"])
        self.stdout.write(
            self.style.MIGRATE_HEADING(
                f"\n{mushaf.name}  ·  page {page}  ·  via {options['via']}"
                + ("  ·  ROLLBACK" if options["rollback"] else "  ·  WRITES REAL DATA")
            )
        )
        self.stdout.write(f"  engine trace -> {options['log']}")

        if options["rollback"]:
            with transaction.atomic():
                self._dispatch(mushaf, page, options["via"])
                transaction.set_rollback(True)
            self.stdout.write(self.style.WARNING("Rolled back — nothing was kept."))
        else:
            self._dispatch(mushaf, page, options["via"])

    def _dispatch(self, mushaf: Mushaf, page: int, via: str) -> None:
        review = CalibrationReview.objects.filter(mushaf=mushaf, page_number=page).first()
        if via == "service":
            # ⬅ BREAKPOINT HERE, then Step Into: process_page is the whole run.
            done = calibration_service.process_page(
                mushaf,
                page,
                expected_revision=review.revision if review else 0,
                user=mushaf.owner,
                progress=lambda count: self.stdout.write(f"  line {count} measured"),
                cancelled=None,
            )
            self.stdout.write(f"  process_page returned {done}")
        else:
            # The view's own call, minus HTTP. inline=True: the job's runner runs here.
            job = start_calibration_page_job(mushaf, page, user=mushaf.owner, inline=True)
            self.stdout.write(f"  job {job.id}  state={job.state}  error={job.error or '-'}")
        self._report(mushaf, page)

    def _report(self, mushaf: Mushaf, page: int) -> None:
        review = CalibrationReview.objects.filter(mushaf=mushaf, page_number=page).first()
        if review is None:
            return
        revision = CalibrationRevision.objects.filter(review=review, number=review.revision).first()
        document = review.payload
        self.stdout.write(
            self.style.SUCCESS(
                f"\n  draft revision {review.revision}  ({revision.kind if revision else 'no revision row'})"
            )
        )
        self.stdout.write(
            f"  profile         {document.get('profile', {}).get('mode')}  "
            f"pages {document.get('profile', {}).get('pages')}"
        )
        self.stdout.write(f"  issues          {document.get('issues')}")
        for row in document.get("lines", []):
            self.stdout.write(
                f"    line {row['line_number']:>2}  {row['status'] or '-':<10} {len(row['words']):>2} word(s)  "
                f"{row['reason'] or ''}"
            )


def _route_engine_log(path: str) -> None:
    """Send the engine's narration to its own file, as a run log would, and keep it
    out of the shared ``quran.log`` — a DEBUG page trace is ~1,500 lines."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(path, mode="w", encoding="utf-8")
    handler.setFormatter(logging.Formatter("{name:<32} {levelname:<7} {message}", style="{"))
    core = logging.getLogger("core")
    core.handlers = [handler]
    core.setLevel(logging.DEBUG)
    core.propagate = False


def _resolve_mushaf(ref: str | None) -> Mushaf:
    if ref:
        try:
            mushaf = Mushaf.objects.filter(id=UUID(ref)).first()
        except ValueError:
            mushaf = Mushaf.objects.filter(name=ref).first()
        if mushaf is None:
            raise CommandError(f"No mushaf matching {ref!r}.")
        return mushaf
    mushaf = Mushaf.objects.order_by("-updated_at").first()
    if mushaf is None:
        raise CommandError("No mushafs in the database — create one in the app first.")
    return mushaf
