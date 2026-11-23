"""The shape of a piece's body: its letters with the dots taken off.

Pure text, like :mod:`core.text.arabic`.

The dots of a letter are blobs of their own (unless a hand prints them touching, and
then the key names them: ``ت:ijamDot``). So the body blob of تنا and the body blob of
بنا are drawn the same, stroke for stroke: a tooth, a tooth, an alef. This dotless
skeleton is the *rasm*. Two keys with one rasm have interchangeable pictures, which is
what lets a key nobody has confirmed yet borrow the pictures of its look-alikes —
pictures only, never the name: the text says which letters a blob is.

A letter's place in its piece changes its shape, so the table is by place::

    ن at the start or in the middle   a tooth, like ب      نا → ٮا, the same as با
    ن at the end                      a bowl                من → مں, not مب → مٮ
    ق at the start or in the middle   like ف              قا → ڡا
    ق at the end                      its own deep tail

Alef's forms are one stroke (the hamza, madda or wasla is a mark), ؤ is a waw with a
hamza, and ة is a heh with two dots.
"""

from __future__ import annotations

from core.text.contents import ContentsKeyError, parse_contents_key

#: Letters whose body is another letter's in every place.
SAME_BODY = {
    "ت": "ب",
    "ث": "ب",
    "ج": "ح",
    "خ": "ح",
    "ذ": "د",
    "ز": "ر",
    "ش": "س",
    "ض": "ص",
    "ظ": "ط",
    "غ": "ع",
    "ة": "ه",
    "أ": "ا",
    "إ": "ا",
    "آ": "ا",
    "ٱ": "ا",
    "ٲ": "ا",
    "ٳ": "ا",
    "ٵ": "ا",
    "ؤ": "و",
}

#: Letters drawn as a tooth at the start or in the middle of a piece, and as their
#: own body at its end.
TOOTH_UNLESS_LAST = {"ن": "ں", "ي": "ى", "ى": "ى", "ئ": "ى"}

#: Letters drawn as another's at the start or in the middle, and as their own at the end.
LIKE_FEH_UNLESS_LAST = {"ق": "ق"}

#: The dotless tooth, ب's body.
TOOTH = "ب"
#: The dotless feh body, ف and ق at the start or in the middle.
FEH = "ف"


def find_body_shape_of_paw(paw: str) -> str:
    """The body shape of one piece: what a blob of exactly these letters looks like
    with its dots printed apart."""
    shape: list[str] = []
    for index, letter in enumerate(paw):
        last = index == len(paw) - 1
        if letter in TOOTH_UNLESS_LAST:
            shape.append(TOOTH_UNLESS_LAST[letter] if last else TOOTH)
        elif letter in LIKE_FEH_UNLESS_LAST:
            shape.append(LIKE_FEH_UNLESS_LAST[letter] if last else FEH)
        else:
            shape.append(SAME_BODY.get(letter, letter))
    return "".join(shape)


def find_body_shape_of_bodies(bodies: tuple[str, ...] | list[str]) -> str:
    """The body shape of a blob of one or more pieces printed touching, piece by piece."""
    return "+".join(find_body_shape_of_paw(paw) for paw in bodies)


def find_body_shape_of_key(text: str) -> str:
    """The body shape a plain body key borrows by — "تنا:" → "ببا"; "" for a key with
    marks, open letters, or no letters (nothing to borrow)."""
    try:
        key = parse_contents_key(text)
    except ContentsKeyError:
        return ""
    if not key.bodies or key.marks != () or None in key.bodies:
        return ""
    return find_body_shape_of_bodies([body for body in key.bodies if body is not None])
