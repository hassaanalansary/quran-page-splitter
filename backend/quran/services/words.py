"""The word stream the boundary engine aligns against, read out of the database.

The file-backed counterpart is ``core.word_inputs.words_from_ayat``; both produce
the same ``WordInput`` records, and they must agree — the counts here were written
by ``core.arabic`` at seed time, which is the same code that one calls live.

**Everything is asked of a counting system, never of "the Quran".** A mushaf is
printed in a rawi, whose qiraa fixes a counting system, and that is what decides
where each aya ends. Ask for 7:82 in Kufi and in Basran and you get streams that
start on different words and carry different aya labels. That is the whole reason
the ``Aya`` table exists.
"""

from core.word_inputs import WordInput
from quran.models import Aya, CountingSystem, Word


def resolve_aya(counting_system: CountingSystem, sura: int, number: int) -> Aya:
    """The row for one aya, or a clear failure naming the counting system.

    Not every sura:aya exists in every system — that is the point of them — so a
    missing one is a real answer and deserves to say which system it is missing
    from, rather than surfacing as an empty word stream.
    """
    try:
        return Aya.objects.get(counting_system=counting_system, sura_id=sura, number=number)
    except Aya.DoesNotExist:
        raise LookupError(f"{sura}:{number} is not an aya in the {counting_system.name} counting system") from None


def last_word_id(counting_system: CountingSystem, aya: Aya) -> int:
    """The last word of ``aya``: the one before the next aya starts.

    ``Aya`` stores no end because within a system the ayat tile the whole Quran,
    so the end is always the next row's start minus one — and for the very last
    aya, the last word there is.
    """
    following = (
        Aya.objects.filter(counting_system=counting_system, start_word_id__gt=aya.start_word_id)
        .order_by("start_word_id")
        .values_list("start_word_id", flat=True)
        .first()
    )
    if following is not None:
        return following - 1
    return Word.objects.order_by("-id").values_list("id", flat=True).first() or aya.start_word_id


def word_stream(
    counting_system: CountingSystem,
    *,
    start: tuple[int, int],
    end: tuple[int, int],
) -> list[WordInput]:
    """Every word from the start aya through the end aya, each labelled with its aya.

    ``start`` and ``end`` are ``(sura, aya)`` in this counting system's numbering.

    Two range queries do the work — the words, and the ayat that span them — which
    are then walked together. Labelling each word by querying for its aya would be
    one query per word; this is one for all of them.
    """
    first = resolve_aya(counting_system, *start)
    final = resolve_aya(counting_system, *end)
    if final.start_word_id < first.start_word_id:
        raise LookupError(
            f"{start[0]}:{start[1]}..{end[0]}:{end[1]} runs backwards in the {counting_system.name} numbering"
        )
    final_word = last_word_id(counting_system, final)

    ayat = list(
        Aya.objects.filter(
            counting_system=counting_system,
            start_word_id__gte=first.start_word_id,
            start_word_id__lte=final_word,
        ).order_by("start_word_id")
    )
    words = Word.objects.filter(id__gte=first.start_word_id, id__lte=final_word).order_by("id")

    stream: list[WordInput] = []
    position = 0
    for word in words:
        # The ayat are in the same order as the words, so this walks forward once
        # rather than searching per word.
        while position + 1 < len(ayat) and ayat[position + 1].start_word_id <= word.id:
            position += 1
        aya = ayat[position]
        stream.append(
            WordInput(
                text=word.text,
                paws=word.paw_count,
                ijam_above=word.ijam_above,
                ijam_below=word.ijam_below,
                aya=f"{aya.sura_id}:{aya.number}",
                id=word.id,
            )
        )
    return stream


def sura_last_aya(counting_system: CountingSystem, sura: int) -> int:
    """The number of the last aya of a sura in this system — the default run end."""
    number = (
        Aya.objects.filter(counting_system=counting_system, sura_id=sura)
        .order_by("-number")
        .values_list("number", flat=True)
        .first()
    )
    if number is None:
        raise LookupError(f"sura {sura} has no ayat in the {counting_system.name} counting system")
    return number
