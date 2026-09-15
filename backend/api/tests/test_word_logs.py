"""The word run's trace: the file it leaves, the report beside it, and who may read them.

Detection has had a per-run log since the beginning and a word run had none, which
made it the one phase whose answer could only be judged by its output. These tests
pin the plumbing rather than the prose: that a run through a job writes a file, that
the job points at it from the moment it is minted, that the tail resumes by byte
offset the way the live viewer needs, and that a job belonging to somebody else is a
404 and not a file.

What the log *says* is the engine's business and is asserted in
``quran.tests.test_word_boundary_trace``.
"""

import json
import os
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import cast

from django.http import FileResponse
from django.test import override_settings

from api.models import ProcessingRun, ProcessJob, ProcessJobKindChoices, ProcessJobStateChoices
from api.services import jobs as jobs_service
from api.services import run_logs, word_runs
from api.tests.helpers import bare_mushaf, default_user, make_user
from api.tests.test_words_api import WordsApiTestCase


class LogAllocationTests(WordsApiTestCase):
    """Minting a log, and the pointer that makes it findable."""

    def test_a_job_run_writes_a_log_and_points_at_it_before_it_starts(self):
        """The pointer is written first on purpose: a run that dies is still traceable."""
        plan = word_runs.preflight(self.mushaf, (2, 5), (2, 7))
        seen: list[str] = []

        def runner(job: ProcessJob) -> None:
            word_runs.run_for_job(
                self.mushaf.id,
                plan,
                user=default_user(),
                on_progress=lambda _lines: seen.append(
                    ProcessJob.objects.values_list("log_path", flat=True).get(pk=job.id)
                ),
                cancelled=lambda: False,
                job_id=job.id,
            )
            jobs_service.settle(job.id, ProcessJobStateChoices.COMPLETED)

        job = jobs_service.start_words(self.mushaf, plan, user=default_user(), runner=runner, inline=True)

        job.refresh_from_db()
        self.assertTrue(job.log_path, "the job should point at its log")
        self.assertEqual(job.log_url, f"/api/mushafs/{self.mushaf.id}/words/jobs/{job.id}/log")
        # Already set by the time the first chunk reported progress.
        self.assertEqual(seen, [job.log_path])

        path = run_logs.resolve(job.log_path)
        assert path is not None
        text = path.read_text(encoding="utf-8")
        self.assertIn("WORD RUN", text)
        self.assertIn("2:5 .. 2:7", text)
        self.assertIn("RUN FINISHED", text)

    def test_a_run_driven_without_a_job_keeps_no_file(self):
        """A test or a direct call has nowhere to record a path, so it writes none."""
        before = set(run_logs.runs_dir().glob("*.log")) if run_logs.runs_dir().exists() else set()
        plan = word_runs.preflight(self.mushaf, (2, 5), (2, 7))

        report = word_runs.run(self.mushaf, plan, user=default_user())

        self.assertEqual(report.log_path, "")
        after = set(run_logs.runs_dir().glob("*.log")) if run_logs.runs_dir().exists() else set()
        self.assertEqual(after, before)

    def test_the_report_lands_beside_the_log_and_describes_the_run(self):
        plan = word_runs.preflight(self.mushaf, (2, 5), (2, 7))
        job = self._run_inline(plan)

        log = run_logs.resolve(job.log_path)
        assert log is not None
        payload = json.loads(run_logs.report_path(log).read_text(encoding="utf-8"))

        self.assertEqual(payload["span"], {"from": "2:5", "to": "2:7"})
        self.assertFalse(payload["cancelled"])
        self.assertEqual(len(payload["chunks"]), len(plan.spans))
        # Each chunk carries the engine's own report, so a line's verdict is in here
        # without anybody having to re-derive it.
        self.assertIn("lines", payload["chunks"][0])
        self.assertIn("totals", payload["chunks"][0])

    def _run_inline(self, plan: word_runs.RunPlan) -> ProcessJob:
        def runner(job: ProcessJob) -> None:
            word_runs.run_for_job(
                self.mushaf.id,
                plan,
                user=default_user(),
                on_progress=lambda _lines: None,
                cancelled=lambda: False,
                job_id=job.id,
            )
            jobs_service.settle(job.id, ProcessJobStateChoices.COMPLETED)

        job = jobs_service.start_words(self.mushaf, plan, user=default_user(), runner=runner, inline=True)
        job.refresh_from_db()
        return job


class LogEndpointTests(WordsApiTestCase):
    """Reading a word run's log over HTTP."""

    def setUp(self):
        super().setUp()
        self.job = ProcessJob.objects.create(
            kind=ProcessJobKindChoices.WORDS,
            mushaf=self.mushaf,
            page_range_start=1,
            page_range_end=1,
            total=3,
            state=ProcessJobStateChoices.COMPLETED,
        )
        log_rel, self.log = run_logs.allocate()
        # Bytes, not text: ``write_text`` translates the newlines on Windows, and
        # these assertions are about the tail's byte offsets rather than the
        # platform's idea of a line ending.
        self.log.write_bytes(b"first line\nsecond line\n")
        run_logs.report_path(self.log).write_text('{"span": {"from": "2:5"}}', encoding="utf-8")
        ProcessJob.objects.filter(pk=self.job.pk).update(log_path=log_rel)

    def _drain(self, response: FileResponse) -> bytes:
        """Read a streamed response and release the file it holds open.

        Both file endpoints stream, and the test client does not close a streaming
        response for you. On Windows the still-open handle then blocks the temporary
        LOG_DIR from being removed at ``tearDownClass``.

        The **file**, deliberately, and not ``response.close()``:
        ``HttpResponseBase.close`` fires ``request_finished``, whose receiver closes
        the database connection — and inside a ``TestCase``'s atomic block that
        breaks every test after this one, with a traceback about psycopg that says
        nothing about the response.
        """
        try:
            # The union in the stub covers the async response too; these are sync.
            return b"".join(cast(Iterator[bytes], response.streaming_content))
        finally:
            if response.file_to_stream is not None:
                response.file_to_stream.close()

    def test_the_whole_file_comes_back_as_text(self):
        response = self.client.get(self.url(f"/jobs/{self.job.id}/log"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._drain(response).decode(), "first line\nsecond line\n")

    def test_the_tail_resumes_from_an_offset(self):
        first = self.client.get(self.url(f"/jobs/{self.job.id}/log/tail")).json()
        self.assertEqual(first["text"], "first line\nsecond line\n")
        self.assertEqual(first["offset"], first["size"])

        # Nothing new yet — the run is over.
        again = self.client.get(self.url(f"/jobs/{self.job.id}/log/tail?offset={first['offset']}")).json()
        self.assertEqual(again["text"], "")
        self.assertFalse(again["reset"])

        # It grew: only the new bytes come back.
        with self.log.open("ab") as handle:
            handle.write(b"third line\n")
        more = self.client.get(self.url(f"/jobs/{self.job.id}/log/tail?offset={first['offset']}")).json()
        self.assertEqual(more["text"], "third line\n")

    def test_a_shorter_file_than_the_offset_asks_the_reader_to_start_over(self):
        response = self.client.get(self.url(f"/jobs/{self.job.id}/log/tail?offset=9999")).json()
        self.assertTrue(response["reset"])
        self.assertEqual(response["text"], "first line\nsecond line\n")

    def test_the_report_is_served_as_a_download(self):
        response = self.client.get(self.url(f"/jobs/{self.job.id}/report"))
        self.assertEqual(response.status_code, 200)
        self.assertIn("attachment", response["Content-Disposition"])
        self.assertEqual(json.loads(self._drain(response)), {"span": {"from": "2:5"}})

    def test_a_job_with_no_log_is_a_404_rather_than_an_empty_file(self):
        bare = ProcessJob.objects.create(
            kind=ProcessJobKindChoices.WORDS,
            mushaf=self.mushaf,
            page_range_start=1,
            page_range_end=1,
        )
        self.assertEqual(self.client.get(self.url(f"/jobs/{bare.id}/log")).status_code, 404)

    def test_a_missing_report_is_a_404_even_when_the_log_is_there(self):
        """A run still going has a log and no report yet; say so rather than guess."""
        run_logs.report_path(self.log).unlink()
        self.assertEqual(self.client.get(self.url(f"/jobs/{self.job.id}/log")).status_code, 200)
        self.assertEqual(self.client.get(self.url(f"/jobs/{self.job.id}/report")).status_code, 404)

    def test_a_detection_job_is_not_reachable_through_the_words_endpoint(self):
        """The two kinds share a table; the log routes must not."""
        detection = ProcessJob.objects.create(
            mushaf=self.mushaf,
            page_range_start=1,
            page_range_end=1,
            log_path=self.job.log_path,
        )
        self.assertEqual(self.client.get(self.url(f"/jobs/{detection.id}/log")).status_code, 404)

    def test_another_users_mushaf_is_not_reachable(self):
        """404, not 403 — a stranger learns nothing about what exists."""
        self.client.force_login(make_user("someone-else@example.com"))
        self.assertEqual(self.client.get(self.url(f"/jobs/{self.job.id}/log")).status_code, 404)
        self.assertEqual(self.client.get(self.url(f"/jobs/{self.job.id}/log/tail")).status_code, 404)
        self.assertEqual(self.client.get(self.url(f"/jobs/{self.job.id}/report")).status_code, 404)


class LogPathSafetyTests(WordsApiTestCase):
    def test_a_stored_path_that_climbs_out_of_the_log_directory_resolves_to_nothing(self):
        """A stored value is data. It must not be able to name a file outside LOG_DIR."""
        job = ProcessJob.objects.create(
            kind=ProcessJobKindChoices.WORDS,
            mushaf=self.mushaf,
            page_range_start=1,
            page_range_end=1,
            log_path="../../settings.py",
        )
        self.assertEqual(self.client.get(self.url(f"/jobs/{job.id}/log")).status_code, 404)


class PruneSweepsBothTablesTests(WordsApiTestCase):
    """Both engines mint from one directory, so one sweep has to clear both pointers."""

    def test_a_pruned_log_clears_the_job_that_pointed_at_it_and_takes_its_report(self):
        mushaf = bare_mushaf("Sweep")
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            jobs, runs = [], []
            for order in range(3):
                log = directory / f"run{order}.log"
                log.write_text("trace", encoding="utf-8")
                run_logs.report_path(log).write_text("{}", encoding="utf-8")
                _aged(log, order)
                relative = f"{directory.name}/run{order}.log"
                jobs.append(
                    ProcessJob.objects.create(
                        kind=ProcessJobKindChoices.WORDS,
                        mushaf=mushaf,
                        page_range_start=1,
                        page_range_end=1,
                        log_path=relative,
                        log_url=f"/api/mushafs/{mushaf.id}/words/jobs/x/log",
                    )
                )
                runs.append(
                    ProcessingRun.objects.create(
                        mushaf=mushaf,
                        settings={},
                        page_range_start=1,
                        page_range_end=1,
                        status="completed",
                        log_path=relative,
                    )
                )

            self.assertEqual(run_logs.prune(directory, keep=1), 2)

            self.assertEqual([p.name for p in sorted(directory.glob("*.log"))], ["run2.log"])
            # The report goes with its log; keeping one without the other is worse
            # than keeping neither.
            self.assertEqual([p.name for p in sorted(directory.glob("*.json"))], ["run2.json"])
            self.assertEqual(
                [ProcessJob.objects.get(pk=job.pk).log_path for job in jobs],
                ["", "", f"{directory.name}/run2.log"],
            )
            # The dead link goes too, or the UI would keep offering it.
            self.assertEqual([ProcessJob.objects.get(pk=job.pk).log_url for job in jobs[:2]], ["", ""])
            self.assertEqual(
                [ProcessingRun.objects.get(pk=run.pk).log_path for run in runs],
                ["", "", f"{directory.name}/run2.log"],
            )

    @override_settings(RUN_LOG_RETENTION=-1)
    def test_a_negative_retention_keeps_everything(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            (directory / "run0.log").write_text("trace", encoding="utf-8")
            self.assertEqual(run_logs.prune(directory), 0)
            self.assertTrue((directory / "run0.log").exists())


def _aged(path: Path, order: int) -> Path:
    """Stamp a distinct mtime so "oldest" is unambiguous."""
    os.utime(path, (1_700_000_000 + order, 1_700_000_000 + order))
    return path
