"""Step through a processing run under a debugger — no HTTP, no polling, no browser.

The point of this command is *observability of the mechanism*. Set breakpoints and
watch a run go through every stage in order, including a cancel, without a browser
or a request in the way::

    # the default: one plain call, everything on the main thread
    uv run python manage.py debug_process --pages 3-8 --rollback

    # stop it after 2 pages and watch the cancel take effect
    uv run python manage.py debug_process --pages 3-8 --cancel-after 2 --rollback

    # exercise the real worker thread + cross-thread cancel, as the UI does
    uv run python manage.py debug_process --pages 3-8 --cancel-after 2 --via job-thread

``--via`` picks how much of the stack is involved:

``service``     call ``processing.process()`` directly. Single-threaded, so the
                debugger steps cleanly through the whole pipeline. Start here.
``job-inline``  go through ``jobs.start()`` but run on this thread — shows the job
                bookkeeping without threads.
``job-thread``  the real thing: a worker thread runs it while this thread polls and
                cancels, exactly like the browser does.

Settings come from the mushaf's most recent run (that is where ``bounds`` lives), so
process something from the UI once before using this.

``--rollback`` wraps everything in a transaction that is rolled back at the end: you
can watch pages being written and keep nothing. Without it, THIS WRITES REAL DATA —
it is a real run against your dev database.
"""

import time
from typing import Any
from uuid import UUID

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from api.models import Mushaf, ProcessingRun
from api.services import jobs as jobs_service
from api.services import processing as processing_service

#: Defaults for anything the stored run settings don't carry.
_FALLBACK = {
    "padding": 4,
    "expected_lines": 15,
    "sura_header_slots": 1,
    "sura_header_threshold": 0.6,
    "max_sura_headers": 3,
    "match_threshold": 0.5,
    "alternate_horizontal_margin": False,
    "prefer_acceleration": True,
    "start_sura": 1,
    "start_aya": 1,
}


class Command(BaseCommand):
    help = "Run the processing pipeline in the foreground so it can be stepped through in a debugger."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument("--mushaf", help="Mushaf id or name (default: the most recently updated one).")
        parser.add_argument("--pages", default="3-5", help="Logical page range, e.g. 3-8 (default: 3-5).")
        parser.add_argument(
            "--cancel-after",
            type=int,
            default=None,
            metavar="N",
            help="Request a cancel once N pages have been saved.",
        )
        parser.add_argument(
            "--via",
            choices=("service", "job-inline", "job-thread"),
            default="service",
            help="How much of the stack to exercise (default: service).",
        )
        parser.add_argument(
            "--rollback",
            action="store_true",
            help="Roll everything back at the end — watch the writes, keep none.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        mushaf = _resolve_mushaf(options["mushaf"])
        start, end = _parse_range(options["pages"])
        # 0 means "never cancel" — the launch.json prompt offers it as the opt-out.
        options["cancel_after"] = options["cancel_after"] or None
        params = _settings_for(mushaf) | {"page_range_start": start, "page_range_end": end}

        self.stdout.write(
            self.style.MIGRATE_HEADING(
                f"\n{mushaf.name}  ·  pages {start}-{end}  ·  via {options['via']}"
                + (f"  ·  cancel after {options['cancel_after']}" if options["cancel_after"] else "")
                + ("  ·  ROLLBACK" if options["rollback"] else "  ·  WRITES REAL DATA")
            )
        )

        if options["rollback"]:
            # Per-page transactions nest as savepoints, so one outer rollback
            # discards the run row and every page it wrote.
            with transaction.atomic():
                self._dispatch(mushaf, params, options)
                transaction.set_rollback(True)
            self.stdout.write(self.style.WARNING("Rolled back — nothing was kept."))
        else:
            self._dispatch(mushaf, params, options)

    # ------------------------------------------------------------------

    def _dispatch(self, mushaf: Mushaf, params: dict, options: dict) -> None:
        if options["via"] == "job-thread":
            self._run_threaded(mushaf, params, options["cancel_after"])
        else:
            self._run_foreground(mushaf, params, options)

    def _run_foreground(self, mushaf: Mushaf, params: dict, options: dict) -> None:
        """Everything on this thread — the configuration to actually step through."""
        cancel_after = options["cancel_after"]
        saved_so_far = 0

        def on_progress(phase: str, page: int | None, saved: int) -> None:
            nonlocal saved_so_far
            saved_so_far = saved
            self.stdout.write(f"  {phase:<10} page={page if page is not None else '-':<5} saved={saved}")

        def should_cancel() -> bool:
            # ⬅ BREAKPOINT HERE to watch the cancel decision on every page.
            return cancel_after is not None and saved_so_far >= cancel_after

        if options["via"] == "service":
            result = processing_service.process(
                mushaf, **params, should_cancel=should_cancel, on_progress=on_progress
            )
        else:  # job-inline
            jobs_service.reset()
            job = jobs_service.start(mushaf, params, inline=True)
            result = {
                "status": job.state,
                "pages_saved": job.pages_saved,
                "stopped_on_page": job.stopped_on_page,
                "run_id": job.run_id,
                "log_url": job.log_url,
            }
        self._report(result)

    def _run_threaded(self, mushaf: Mushaf, params: dict, cancel_after: int | None) -> None:
        """The real path: a worker thread runs it, this thread polls and cancels."""
        jobs_service.reset()
        job = jobs_service.start(mushaf, params)
        self.stdout.write(f"  job {job.id} started on a worker thread")

        cancelled = False
        while not job.finished:
            # ⬅ BREAKPOINT HERE is the browser's poll, in a loop you control.
            self.stdout.write(
                f"  poll  state={job.state:<10} phase={job.phase:<10} "
                f"page={job.current_page} saved={job.pages_saved}"
            )
            if cancel_after is not None and not cancelled and job.pages_saved >= cancel_after:
                jobs_service.request_cancel(mushaf.id)
                cancelled = True
                self.stdout.write(self.style.WARNING("  cancel requested"))
            time.sleep(0.25)

        self._report(
            {
                "status": job.state,
                "pages_saved": job.pages_saved,
                "stopped_on_page": job.stopped_on_page,
                "run_id": job.run_id,
                "log_url": job.log_url,
                "error": job.error,
            }
        )

    def _report(self, result: dict) -> None:
        style = self.style.SUCCESS if result.get("status") == "completed" else self.style.WARNING
        self.stdout.write(style(f"\n  status          {result.get('status')}"))
        self.stdout.write(f"  pages_saved     {result.get('pages_saved')}")
        self.stdout.write(f"  stopped_on_page {result.get('stopped_on_page')}  ← resume from here")
        self.stdout.write(f"  run_id          {result.get('run_id')}")
        self.stdout.write(f"  log             {result.get('log_url')}\n")
        if result.get("error"):
            self.stdout.write(self.style.ERROR(f"  error           {result['error']}"))


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


def _parse_range(text: str) -> tuple[int, int]:
    try:
        start_text, _, end_text = text.partition("-")
        start = int(start_text)
        end = int(end_text) if end_text else start
    except ValueError:
        raise CommandError(f"Bad --pages {text!r}; expected e.g. 3-8.") from None
    if start < 1 or end < start:
        raise CommandError(f"Bad --pages {text!r}; need 1 <= start <= end.")
    return start, end


def _settings_for(mushaf: Mushaf) -> dict:
    """Detection settings from the mushaf's last run — that is where `bounds` lives."""
    last = ProcessingRun.objects.filter(mushaf=mushaf).order_by("-created_at").first()
    if last is None or not last.settings.get("bounds"):
        raise CommandError(
            f"{mushaf.name!r} has no previous run to borrow settings from. "
            "Process a couple of pages from the UI first, then re-run this."
        )
    return {**_FALLBACK, **last.settings}
