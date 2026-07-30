"""Retention sweeps for per-run artefacts.

A whole-mushaf run writes megabytes of log, and a run that fails line detection
writes a PNG per line. Both accumulate silently, so each run prunes what came
before it.
"""

import os
import tempfile
from pathlib import Path

from django.test import TestCase

from api.models import ProcessingRun
from api.services.processing import prune_run_debug, prune_run_logs
from api.tests.helpers import bare_mushaf


def _aged(path: Path, order: int) -> Path:
    """Stamp a distinct mtime so "oldest" is unambiguous."""
    os.utime(path, (1_700_000_000 + order, 1_700_000_000 + order))
    return path


class PruneRunDebugTests(TestCase):
    def test_keeps_the_newest_directories_and_deletes_the_rest(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            for order in range(5):
                directory = root / f"run{order}"
                directory.mkdir()
                (directory / "line_01.png").write_bytes(b"png")
                _aged(directory, order)

            removed = prune_run_debug(root, keep=2)

            self.assertEqual(removed, 3)
            self.assertEqual(sorted(p.name for p in root.iterdir()), ["run3", "run4"])

    def test_deletes_directories_that_still_have_contents(self):
        """rmtree, not rmdir — the whole point is that these are not empty."""
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            directory = root / "run0"
            (directory / "nested").mkdir(parents=True)
            (directory / "nested" / "line_01.png").write_bytes(b"png")
            _aged(directory, 0)

            self.assertEqual(prune_run_debug(root, keep=0), 1)
            self.assertFalse(directory.exists())

    def test_a_missing_directory_is_not_an_error(self):
        """The sweep runs on every run; it must never be the thing that fails one."""
        with tempfile.TemporaryDirectory() as raw:
            self.assertEqual(prune_run_debug(Path(raw) / "absent", keep=1), 0)


class PruneRunLogsTests(TestCase):
    def test_clears_log_path_on_rows_whose_file_was_deleted(self):
        """A row keeping a path to a deleted file would offer a dead link."""
        mushaf = bare_mushaf("Retention")

        with tempfile.TemporaryDirectory() as raw:
            runs_dir = Path(raw)
            runs: list[ProcessingRun] = []
            for order in range(3):
                path = runs_dir / f"run{order}.log"
                path.write_text("trace", encoding="utf-8")
                _aged(path, order)
                runs.append(
                    ProcessingRun.objects.create(
                        mushaf=mushaf,
                        settings={},
                        page_range_start=1,
                        page_range_end=1,
                        status="completed",
                        log_path=f"{runs_dir.name}/run{order}.log",
                    )
                )

            removed = prune_run_logs(runs_dir, keep=1)

            self.assertEqual(removed, 2)
            self.assertEqual([p.name for p in runs_dir.glob("*.log")], ["run2.log"])
            # The two pruned rows survive — only their pointer is gone.
            self.assertEqual(
                [ProcessingRun.objects.get(pk=run.pk).log_path for run in runs],
                ["", "", f"{runs_dir.name}/run2.log"],
            )
