"""The Library view's keys: listed on demand, filtered, a page at a time.

The fingerprint set keeps body shapes under the text's spelling of their pieces — a few
thousand keys by the end of a mushaf — so the view never shows them all. It asks::

    list_library_keys      the keys that pass its filters, 40 a page, no pictures:
                             tab        bodies or marks
                             letters    how many letters (4 is "4 or more")
                             first      the first letter, as spelled
                             contains   letters the key holds, in order
                             show       all · has (shapes kept) · none (not confirmed
                                        yet) · touching (a letter holding its mark)
                             sort       common (most often in the text) · fewest shapes
    describe_library_key   one key's groups with their pictures

"none yet" lists the pieces the text has that the set has no shape of: the to-do list
of what the library still needs. How often a key occurs comes from the text
(:mod:`core.text.paw_inventory`), counted once per process.
"""

from __future__ import annotations

from collections import Counter
from functools import lru_cache
from typing import Any

from api.models import Mushaf
from api.services.calibration_library import ShapeImages, group_id_of, load_looks_right_keys
from api.services.fingerprint_store import load_current_set
from core.text.contents import (
    ContentsKey,
    ContentsKeyError,
    describe_contents_parts,
    find_letters_of_key,
    find_role_of_key,
    parse_contents_key,
)
from core.text.paw_inventory import count_paws_of_words
from quran.services.quran_text import DEFAULT_QURAN_TEXT_PATH, load_ayat

Doc = dict[str, Any]

#: Keys a page of the list holds.
KEYS_PER_PAGE = 40
#: The longest run of pieces counted as one key from the text: إلا's two, and a few more.
LONGEST_RUN = 3


@lru_cache(maxsize=1)
def count_text_keys() -> Counter[str]:
    """How often each body key — a piece, or a run of pieces inside a word — occurs in
    the text."""
    words = [word for aya in load_ayat(DEFAULT_QURAN_TEXT_PATH) for word in aya.words]
    return Counter({f"{run}:": count for run, count in count_paws_of_words(words, longest_run=LONGEST_RUN).items()})


def read_key(text: str) -> ContentsKey | None:
    try:
        return parse_contents_key(text)
    except ContentsKeyError:
        return None


def does_key_pass(key: ContentsKey, *, letters: int | None, first: str, contains: str, show: str, shapes: int) -> bool:
    spelled = find_letters_of_key(key)
    if letters is not None and (len(spelled) < letters if letters >= 4 else len(spelled) != letters):
        return False
    if first and not spelled.startswith(first):
        return False
    if contains and contains not in spelled:
        return False
    if show == "has" and not shapes:
        return False
    if show == "none" and shapes:
        return False
    return not (show == "touching" and not key.marks)


def list_library_keys(
    mushaf: Mushaf,
    *,
    tab: str = "bodies",
    letters: int | None = None,
    first: str = "",
    contains: str = "",
    show: str = "all",
    sort: str = "common",
    page: int = 1,
) -> Doc:
    """The keys that pass the filters, a page of them — see the module docstring."""
    library = load_current_set(mushaf).library
    kept = {key: len(where) for key, where in library.by_key.items()}
    text = count_text_keys() if tab == "bodies" else Counter()
    found: list[Doc] = []
    for written in set(kept) | (set(text) if show in ("all", "none") else set()):
        key = read_key(written)
        if key is None or find_role_of_key(key) != ("body" if tab == "bodies" else "mark"):
            continue
        if (key.bodies and None in key.bodies) or (key.marks and None in key.marks):
            continue  # a role alone ("?:", ":?"): nothing to look up by letters
        shapes = kept.get(written, 0)
        if not does_key_pass(key, letters=letters, first=first, contains=contains, show=show, shapes=shapes):
            continue
        found.append(
            {
                "key": written,
                "parts": describe_contents_parts(key),
                "shapes": shapes,
                "text_count": text.get(f"{'+'.join(b for b in key.bodies or () if b)}:", 0),
            }
        )
    if sort == "fewest":
        found.sort(key=lambda item: (item["shapes"], -item["text_count"], item["key"]))
    else:
        found.sort(key=lambda item: (-item["text_count"], -item["shapes"], item["key"]))
    page = max(page, 1)
    start = (page - 1) * KEYS_PER_PAGE
    return {
        "total": len(found),
        "page": page,
        "per_page": KEYS_PER_PAGE,
        "keys": found[start : start + KEYS_PER_PAGE],
    }


def describe_library_key(mushaf: Mushaf, written: str) -> Doc:
    """One key's groups, each fingerprint and its kept shapes with their pictures."""
    current = load_current_set(mushaf)
    library = current.library
    items = [item for item in library.groups if item["key"] == written]
    refs = [ref for item in items for ref in (item["centre"], *(item["members"][i] for i in item["kept"]))]
    shapes = ShapeImages(mushaf, refs, load_looks_right_keys(current.library_row))
    groups = []
    for item in items:
        fingerprint = shapes.describe_shape(item["centre"])
        if fingerprint is None:
            continue
        kept = []
        for index in item["kept"]:
            shape = shapes.describe_shape(item["members"][index])
            if shape is not None:
                kept.append({**shape, "distance": round(item["distance"][index], 4)})
        groups.append({"id": group_id_of(item), "fingerprint": fingerprint, "kept": kept})
    key = read_key(written)
    return {
        "key": written,
        "parts": describe_contents_parts(key) if key is not None else None,
        "text_count": count_text_keys().get(written, 0),
        "groups": groups,
    }
