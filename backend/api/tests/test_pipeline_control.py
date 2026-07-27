"""Tests for the pipeline's steering hooks: cancellation, progress, laziness.

These drive ``core.pipeline`` with a stub page processor — no detection, no DB —
so the control flow is checked on its own: what stops a run, what it reports, and
crucially how much work it does *not* do once cancelled.
"""

from __future__ import annotations

from django.test import SimpleTestCase

from api.tests.helpers import make_png_bytes
from core.config import ExportConfig
from core.page_processor import STATUS_LINE_COUNT_MISMATCH
from core.pipeline import PageOutcome, Pipeline


class StubProcessor:
    """Stands in for PageProcessor: records calls, returns a canned status."""

    def __init__(self, statuses: dict[int, str] | None = None):
        self.statuses = statuses or {}
        self.seen: list[str] = []

    def process(self, ctx, tracker, **kwargs) -> dict:
        self.seen.append(ctx.filename)
        return {
            "filename": ctx.filename,
            "status": self.statuses.get(ctx.page_index, "success"),
            "coordinates": {"page_index": ctx.page_index},
        }


def _pipeline(statuses: dict[int, str] | None = None) -> tuple[Pipeline, StubProcessor]:
    processor = StubProcessor(statuses)
    pipeline = Pipeline(
        processor=processor,  # type: ignore[arg-type]
        export_config=ExportConfig(export_images=False, export_coordinates=True, start_sura=1, start_aya=1),
    )
    return pipeline, processor


def _pages(count: int) -> list[tuple[bytes, str]]:
    png = make_png_bytes((40, 40))
    return [(png, f"{n}.png") for n in range(1, count + 1)]


class CancellationTests(SimpleTestCase):
    def test_stops_at_the_next_page_and_reports_cancelled(self):
        pipeline, processor = _pipeline()
        # Cancel becomes true once two pages are done.
        output = pipeline.run(_pages(5), should_cancel=lambda: len(processor.seen) >= 2)

        self.assertEqual(output["status"], "cancelled")
        self.assertEqual(processor.seen, ["1.png", "2.png"])
        # It stops *before* page 3 — that page was never rendered or detected.
        self.assertEqual(output["cancel_at"], {"page_index": 3, "filename": "3.png"})
        self.assertNotIn("abort_at", output)

    def test_cancelled_before_the_first_page_does_nothing(self):
        pipeline, processor = _pipeline()
        output = pipeline.run(_pages(3), should_cancel=lambda: True)

        self.assertEqual(output["status"], "cancelled")
        self.assertEqual(processor.seen, [])
        self.assertEqual(output["cancel_at"]["page_index"], 1)
        self.assertEqual([r["status"] for r in output["results"]], ["skipped_cancelled"] * 3)

    def test_completed_run_is_untouched_by_an_unset_flag(self):
        pipeline, processor = _pipeline()
        output = pipeline.run(_pages(3), should_cancel=lambda: False)

        self.assertEqual(output["status"], "completed")
        self.assertEqual(len(processor.seen), 3)
        self.assertNotIn("cancel_at", output)

    def test_abort_still_wins_over_a_late_cancel(self):
        # Detection fails on page 2 and the cancel flag is set at the same moment:
        # the abort is the real reason the run stopped, so it must be reported.
        pipeline, processor = _pipeline({2: STATUS_LINE_COUNT_MISMATCH})
        output = pipeline.run(_pages(4), should_cancel=lambda: len(processor.seen) >= 2)

        self.assertEqual(output["status"], "aborted_line_detection")
        self.assertEqual(output["abort_at"]["page_index"], 2)


class LazyImageTests(SimpleTestCase):
    def test_pulls_one_page_at_a_time_and_stops_pulling_when_cancelled(self):
        rendered: list[str] = []

        def source():
            for raw, name in _pages(6):
                rendered.append(name)
                yield raw, name

        names = [f"{n}.png" for n in range(1, 7)]
        pipeline, processor = _pipeline()
        output = pipeline.run(
            source(),
            filenames=names,
            should_cancel=lambda: len(processor.seen) >= 2,
        )

        self.assertEqual(output["status"], "cancelled")
        # The generator was pulled exactly twice: pages 3-6 were never rendered.
        self.assertEqual(rendered, ["1.png", "2.png"])

    def test_short_source_is_reported_not_crashed(self):
        names = [f"{n}.png" for n in range(1, 5)]
        pipeline, _ = _pipeline()
        output = pipeline.run(iter(_pages(2)), filenames=names)

        statuses = [r["status"] for r in output["results"]]
        self.assertEqual(statuses, ["success", "success", "skipped_no_image", "skipped_no_image"])


class ProgressHookTests(SimpleTestCase):
    def test_reports_each_page_as_it_starts_and_finishes(self):
        started: list[tuple[int, str]] = []
        done: list[PageOutcome] = []
        pipeline, _ = _pipeline()

        pipeline.run(_pages(3), on_page_start=lambda i, n: started.append((i, n)), on_page_done=done.append)

        self.assertEqual(started, [(1, "1.png"), (2, "2.png"), (3, "3.png")])
        self.assertEqual([o.page_index for o in done], [1, 2, 3])
        self.assertEqual([o.coordinates for o in done], [{"page_index": n} for n in (1, 2, 3)])

    def test_on_page_done_carries_the_tracker_position(self):
        done: list[PageOutcome] = []
        pipeline, _ = _pipeline()
        pipeline.run(_pages(1), on_page_done=done.append)

        self.assertEqual((done[0].end_sura, done[0].end_aya), (1, 1))
