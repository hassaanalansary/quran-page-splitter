"""What the word-boundary engine is handed, and how to build it from files.

The engine used to fetch its own inputs — open image paths, parse the Tanzil file,
work out PAW counts as it went. That is what welded it to a command line. Here the
inputs become a contract it is *given*, so the same engine runs on a directory of
PNGs, on rows from the database, or on anything else that can produce a picture and
a list of words.

Pure text and Pillow: no Django, no cv2. The database side lives in
``quran.services.words`` and ``api.services.line_images``, which build these same
three types.

**Images, not paths.** A line image can come from a file, from ``Line.line_png``, or
from a PDF page cropped with a ``Line`` row's coordinates — and one of them may be
cropped again at an aya boundary before it arrives. The engine must not know or
care, so it never sees a filename it could open.

**Numbers, not spelling.** ``WordInput`` carries the PAW count and the i'jam counts
rather than leaving the engine to derive them from the text. Everything Arabic
happens on this side of the line, in ``core.text.arabic``; the engine does arithmetic on
ink and alignment on counts.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from PIL import Image

from core.text import Aya, ijam_groups, paw_count


@dataclass(frozen=True)
class LineImage:
    """One line of a mushaf, ready to be measured."""

    image: Image.Image
    #: Short name for report rows — "line-03.png", or "page-0166/line-03".
    label: str
    #: Where it came from, for the machine-readable report. Free-form.
    source: str = ""
    #: Ornament x-spans in this image's own coordinates, when the caller already
    #: knows them — the process phase found them once and there is no sense paying
    #: for that twice. ``None`` means "find them yourself", which is what a bare
    #: directory of PNGs will always say.
    separators: list[tuple[int, int]] | None = None
    #: Which aya each of ``separators`` closes, as "sura:aya", when the caller
    #: knows. The database does: its segments are numbered and reviewed. An
    #: ornament is the one place the page states a boundary outright, and a label
    #: turns that into *which* boundary — so a reading whose cursor has drifted can
    #: be put back on the right word instead of on the next one after wherever it
    #: happened to stop. ``None``, or a short list, simply falls back to counting
    #: from the cursor.
    separator_ayat: list[str] | None = None


@dataclass(frozen=True)
class WordInput:
    """One word of the text, with everything its spelling predicts about its ink."""

    text: str
    #: Disconnected ink blobs this spelling must produce.
    paws: int
    #: Dot groups it must carry above and below the writing line.
    ijam_above: int
    ijam_below: int
    #: "7:82". Consecutive words sharing this are one aya; a change is a boundary.
    aya: str
    #: ``Word.id`` when the stream came from the database, so a caller can map the
    #: engine's output back to a row. ``None`` when it came from a text file.
    id: int | None = None


#: Whether a word's expected dots are worth checking against this mushaf's page.
#:
#: The distinction the engine got wrong once, and must not get wrong again: the
#: Quran text says which letters are conventionally distinguished by dots, and says
#: nothing whatever about whether a given mushaf draws them. Those are two
#: questions, and only the first is settled by knowing the text.
#:
#: * ``report`` — expect them. Every word's floor is checked and a shortfall is
#:   flagged for review. The default, and what the engine has always done.
#: * ``ignore`` — do not check at all, for a script whose dotting this table does
#:   not describe. On such a mushaf the check is not merely useless but actively
#:   misleading, flagging lines that are perfectly correct.
#:
#: Maghribi is the case that forces the choice: ``ف`` takes its dot **below**
#: there, and a mushaf may leave final ``ي`` undotted altogether, so every word
#: containing them would be reported short. Differences of dot *number* are
#: already absorbed — ``ijam_groups`` counts groups, so Maghribi's one-dot ``ق``
#: and this table's two agree at one group.
#:
#: **There is deliberately no "enforce".** A mode that let the floor *reject* a
#: reading was built and removed: it cannot bite where it would matter. An
#: ornament-closed stretch pins ``require_end``, the DP keys on
#: ``(word_index, blobs_taken)``, and equal-rank readings are merged — so by the
#: time any filter runs there is exactly one candidate left, and the reading that
#: preserved the dot was discarded when the word closed. Offering a setting that
#: claims a strength the engine does not have would be worse than not offering it.
#: ``IjamModeTests`` pins that, and it becomes possible only if the DP is ever
#: taught to keep i'jam-distinct alternatives.
IjamMode = Literal["report", "ignore"]


@dataclass(frozen=True)
class WordBoundaryInput:
    """Everything one run of the engine needs."""

    lines: list[LineImage]
    words: list[WordInput]
    #: The mushaf's aya ornament, for lines whose separators were not supplied.
    #: ``None`` is fine — the shape detector runs either way.
    separator_template: Image.Image | None = None
    #: What this mushaf's script guarantees about i'jam — see :data:`IjamMode`.
    #: Defaults to the reading that is safe for a mushaf nobody has characterised.
    ijam: IjamMode = "report"
    #: Symbols this mushaf prints *inside* its text lines that are not words — the
    #: sajda marker and the rub'-al-hizb rosette — keyed by a name for the trace.
    #:
    #: They have to be given rather than found, because nothing in the text
    #: predicts them: unlike an aya ornament, which the process phase already
    #: located and hands over, these were never looked for. And they have to be
    #: *removed*, because the alternative is the engine reading them as letters and
    #: every word after one landing in the wrong place.
    #:
    #: Fixed across a mushaf, which is what makes one template each enough.
    symbol_templates: Mapping[str, Image.Image] = field(default_factory=dict)


def images_from_paths(paths: Iterable[Path]) -> list[LineImage]:
    """Open line images from disk, in the order given.

    Each file is read and detached from its handle, so nothing is left open while
    a long run works through several hundred lines.
    """
    lines: list[LineImage] = []
    for path in paths:
        with Image.open(path) as handle:
            handle.load()
            image = handle.copy()
        lines.append(LineImage(image=image, label=path.name, source=str(path)))
    return lines


def words_from_ayat(ayat: Iterable[Aya]) -> list[WordInput]:
    """Flatten Tanzil ayat into the word stream, counting PAWs and i'jam.

    The counterpart of the database's ``word_stream``, and it must agree with it:
    both call ``core.text.arabic``, which is why that module exists.
    """
    stream: list[WordInput] = []
    for aya in ayat:
        for text in aya.words:
            above, below = ijam_groups(text)
            stream.append(
                WordInput(
                    text=text,
                    paws=paw_count(text),
                    ijam_above=above,
                    ijam_below=below,
                    aya=aya.key,
                )
            )
    return stream


def aya_starts(words: list[WordInput]) -> list[int]:
    """Word index at which each aya of the stream begins, plus an end sentinel.

    The engine anchors ornaments on these: an ornament may only close an aya, so
    the boundaries have to be addressable as positions in the stream.
    """
    starts = [index for index, word in enumerate(words) if index == 0 or word.aya != words[index - 1].aya]
    return [*starts, len(words)]
