"""Assemble everything one run of the word-boundary engine needs, from the database.

One call in, a ``WordBoundaryInput`` out. It lives in ``api`` because it is the only
layer allowed to reach into both apps: the pictures come from a mushaf's pages
(``api``), the words from the Quran text (``quran``), and the thing that joins them
is the mushaf's own riwaya.

    mushaf → rawi → qiraa → counting system → which words each aya holds

That chain is the point. Ask for 7:82 on a Hafs mushaf and on a Warsh one and you
get different words, because the two count their ayat differently — and the engine
anchors on aya ornaments, so being handed the wrong aya boundaries would put every
word cut on the page in the wrong place.

Nothing here runs the engine. This phase stops at "the inputs can be produced".
"""

import uuid

from accounts.models import User
from api.models import Mushaf
from api.services import line_images as line_images_service
from api.services import mushaf as mushaf_service
from core.word_boundary import WordBoundaryInput
from quran.models import CountingSystem
from quran.services import words as words_service


def counting_system_for(mushaf: Mushaf) -> CountingSystem:
    """The counting system this mushaf's ayat are numbered in.

    A mushaf without a riwaya cannot be aligned: there is no way to know where its
    ayat end, and guessing Kufi would quietly mis-cut every Warsh or Qalun page.
    """
    system = mushaf.rawi.counting_system if mushaf.rawi else None
    if system is None:
        raise LookupError(
            f"{mushaf.name} has no riwaya set, so its counting system is unknown — "
            f"set one before running word detection."
        )
    return system


def prepare_engine_input(
    mushaf_id: uuid.UUID,
    *,
    user: User | None,
    start: tuple[int, int],
    end: tuple[int, int] | None = None,
    refresh: bool = False,
) -> tuple[WordBoundaryInput, CountingSystem]:
    """Line images and the word stream for one span, ready for the engine.

    ``start`` and ``end`` are ``(sura, aya)`` in the mushaf's own numbering.
    ``end`` defaults to the last aya of the sura the run starts in — a whole sura
    is the natural unit, and a caller that wants less says so.

    ``refresh`` forces every line to be re-cut from the PDF rather than read from
    its exported PNG, which is the answer when erase strokes were edited after the
    last export.
    """
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=user, write=False)
    system = counting_system_for(mushaf)
    if end is None:
        end = (start[0], words_service.sura_last_aya(system, start[0]))

    lines = line_images_service.line_images(mushaf, start=start, end=end, refresh=refresh)
    stream = words_service.word_stream(system, start=start, end=end)
    return (
        WordBoundaryInput(
            lines=lines,
            words=stream,
            separator_template=line_images_service.separator_template(mushaf),
        ),
        system,
    )
