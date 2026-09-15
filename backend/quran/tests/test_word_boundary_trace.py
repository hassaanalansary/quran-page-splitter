"""What the word-boundary engine says while it works.

The trace is not decoration: it is the only account of *why* a line came out the way
it did, and the first thing read when one comes out wrong. So the things a reader
navigates by are pinned here — the phase headings, one entry per line, the ornament
count, and the verdict of every line that wants a look — while the exact wording is
deliberately left free.

Pinned separately from the result because they answer to different pressures: the
result is a contract other code depends on, the trace is a contract a *person*
depends on. Both can break without the other noticing.

Nothing here configures logging. The engine narrates through ``logging`` and decides
nothing about where that goes, which is what lets the same call write a per-run file
in the web app (``api.services.run_logs``), print to a terminal from the CLI, and
cost only a level check in a test that does not ask.
"""

import logging

from django.test import SimpleTestCase

from core.word_boundary import WordBoundaryInput, detect_words
from quran.tests.test_word_boundary import _line, _words

ENGINE = "core.word_boundary"


class RunTraceTests(SimpleTestCase):
    """The spine a reader scrolls through."""

    def _trace(self, source: WordBoundaryInput, level: int = logging.INFO) -> list[str]:
        with self.assertLogs(ENGINE, level=level) as captured:
            detect_words(source)
        return [record.getMessage() for record in captured.records]

    def test_the_run_names_its_own_size_before_it_starts(self):
        """A run that went wrong is usually a run asked for the wrong thing."""
        messages = self._trace(
            WordBoundaryInput(lines=[_line([50, 100, 150, 200])], words=_words([1, 2, 1])),
        )
        header = next(m for m in messages if "WORD BOUNDARY RUN" in m)
        self.assertIn("1 line(s)", header)
        self.assertIn("3 word(s)", header)
        self.assertIn("7:82", header)

    def test_every_phase_announces_itself(self):
        messages = self._trace(WordBoundaryInput(lines=[_line([50, 100, 150, 200])], words=_words([1, 2, 1])))
        joined = "\n".join(messages)
        for phase in ("measuring ink", "aligning", "RUN SUMMARY"):
            self.assertIn(phase, joined, f"the trace should mark the {phase!r} phase")

    def test_each_line_is_reported_by_its_own_label(self):
        """Labels, not indices: the reviewer knows the page and line, not the offset."""
        source = WordBoundaryInput(
            lines=[
                _line([50, 100, 150], label="page-0161/line-03"),
                _line([50, 100, 150], label="page-0161/line-04"),
            ],
            words=_words([1, 1, 1, 1, 1, 1]),
        )
        joined = "\n".join(self._trace(source))
        self.assertIn("page-0161/line-03", joined)
        self.assertIn("page-0161/line-04", joined)
        self.assertIn("[1/2]", joined)
        self.assertIn("[2/2]", joined)

    def test_the_ink_measurement_reports_the_band_and_the_components(self):
        """The two numbers every role argument is settled against."""
        joined = "\n".join(self._trace(WordBoundaryInput(lines=[_line([50, 100, 150])], words=_words([1, 1, 1]))))
        self.assertIn("writing band", joined)
        self.assertIn("3 component(s)", joined)
        self.assertIn("tight crop", joined)

    def test_a_supplied_ornament_is_named_and_the_detectors_are_said_to_be_skipped(self):
        source = WordBoundaryInput(
            lines=[_line([50, 100, 150, 200], separators=[(95, 135)])],
            words=_words([1, 1, 1], aya="7:82"),
        )
        joined = "\n".join(self._trace(source))
        self.assertIn("supplied by the caller", joined)
        self.assertIn("detectors skipped", joined)

    def test_the_summary_counts_the_verdicts_and_names_the_lines_to_look_at(self):
        """Two blobs and six words: the line cannot account for them, and must say so."""
        source = WordBoundaryInput(
            lines=[_line([50, 100], label="line-09.png")],
            words=_words([1, 1, 1, 1, 1, 1]),
        )
        with self.assertLogs(ENGINE, level=logging.INFO) as captured:
            result = detect_words(source)

        messages = [record.getMessage() for record in captured.records]
        joined = "\n".join(messages)
        summary = messages.index(next(m for m in messages if "RUN SUMMARY" in m))
        after = "\n".join(messages[summary:])

        self.assertEqual(result.lines[0].status, "unresolved")
        self.assertIn("unresolved", after)
        self.assertIn("lines worth a look", after)
        self.assertIn("line-09.png", after)
        # And the reason it stopped is in the body, where the run was still going.
        self.assertIn("withdrawing this line's cuts", joined)

    def test_the_summary_says_when_the_span_was_not_accounted_for(self):
        source = WordBoundaryInput(lines=[_line([50, 100])], words=_words([1, 1, 1, 1, 1, 1]))
        after = "\n".join(m for m in self._trace(source) if "INCOMPLETE" in m or "accounted" in m)
        self.assertIn("INCOMPLETE", after)

    def test_a_clean_run_is_reported_as_accounted_for(self):
        source = WordBoundaryInput(lines=[_line([50, 100, 150])], words=_words([1, 1, 1]))
        joined = "\n".join(self._trace(source))
        self.assertIn("accounted for", joined)
        self.assertNotIn("INCOMPLETE", joined)


class EvidenceTraceTests(SimpleTestCase):
    """DEBUG carries the per-component evidence — the level you turn on for one line."""

    def test_every_component_is_priced_in_the_debug_trace(self):
        with self.assertLogs(ENGINE, level=logging.DEBUG) as captured:
            detect_words(WordBoundaryInput(lines=[_line([50, 100, 150])], words=_words([1, 1, 1])))

        debug = "\n".join(r.getMessage() for r in captured.records if r.levelno == logging.DEBUG)
        # Each blob with the score that decides what it costs to read either way.
        self.assertEqual(debug.count("prefers"), 3)
        self.assertIn("score=", debug)

    def test_every_placed_word_is_named_with_what_it_wanted_and_what_it_got(self):
        with self.assertLogs(ENGINE, level=logging.DEBUG) as captured:
            detect_words(WordBoundaryInput(lines=[_line([50, 100, 150])], words=_words([1, 1, 1])))

        debug = "\n".join(r.getMessage() for r in captured.records if r.levelno == logging.DEBUG)
        self.assertIn("paws want 1 got 1", debug)
        for text in ("w0", "w1", "w2"):
            self.assertIn(text, debug)

    def test_the_component_evidence_stays_out_of_the_info_trace(self):
        """A whole sura is 27,000 components; INFO has to stay readable."""
        with self.assertLogs(ENGINE, level=logging.INFO) as captured:
            detect_words(WordBoundaryInput(lines=[_line([50, 100, 150])], words=_words([1, 1, 1])))

        self.assertNotIn("prefers", "\n".join(r.getMessage() for r in captured.records))
