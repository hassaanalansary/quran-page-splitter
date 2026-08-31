"""Quranic reference data: the text, and where each aya begins in it.

Everything here is the same for every user and every mushaf — the 114 suras, the
six counting systems, the ten qiraat and their twenty rawis, the 77,433 words of
the Uthmani text, and the aya boundaries each counting system draws through them.
No user data lives in this app.

**The global word index is the coordinate space.** ``Word.id`` numbers the words
of the Quran from 1, and every counting system expresses its ayat as start points
in that one numbering. So mapping an aya between two systems is a range
comparison, not a lookup table, and no system is privileged over another —
including Kufi, which is only special at build time because the boundary dataset
happens to be written relative to it.

That is what the word-boundary engine needs: a mushaf is printed in one riwaya,
whose qiraa fixes a counting system, which fixes exactly where each aya ends.
Get that wrong and every ornament anchor on the page lands on the wrong aya.
"""

from django.db import models


class CountingSystem(models.Model):
    """One of the six counting madhhabs, e.g. Kufi. Fixes where ayat end."""

    name = models.CharField(max_length=256, unique=True)
    name_arabic = models.CharField(max_length=256, unique=True)

    class Meta:
        db_table = "counting_system"
        verbose_name = "Counting System"
        verbose_name_plural = "Counting Systems"

    def __str__(self) -> str:
        return f"{self.name} ({self.name_arabic})"


class Qiraa(models.Model):
    """One of the ten canonical recitations, e.g. Asim. Ten rows.

    The counting system belongs here rather than on the rawi: both rawis of a
    qiraa always count its ayat the same way.
    """

    name = models.CharField(max_length=256, unique=True)
    name_arabic = models.CharField(max_length=256, unique=True)
    description = models.TextField(blank=True, default="")
    counting_system = models.ForeignKey(CountingSystem, null=True, on_delete=models.CASCADE, related_name="qiraat")

    class Meta:
        db_table = "qiraa"
        verbose_name = "Qiraa"
        verbose_name_plural = "Qiraat"

    def __str__(self) -> str:
        return f"{self.name} ({self.name_arabic})"


class Rawi(models.Model):
    """One of the twenty transmitters, e.g. Hafs an Asim. Twenty rows.

    This is what a mushaf is actually printed in, and what the API calls a
    "qiraa" on the wire — ``qiraa: "Hafs"`` is this row's ``name``. That name is
    stored inside exported work bundles, so it must not be renamed or re-cased.
    """

    name = models.CharField(max_length=256, unique=True)
    name_arabic = models.CharField(max_length=256, unique=True)
    description = models.TextField(blank=True, default="")
    qiraa = models.ForeignKey(Qiraa, null=True, on_delete=models.CASCADE, related_name="rawis")

    class Meta:
        db_table = "rawi"
        verbose_name = "Rawi"
        verbose_name_plural = "Rawis"

    def __str__(self) -> str:
        return f"{self.name} ({self.name_arabic})"

    @property
    def counting_system(self) -> CountingSystem | None:
        """The counting system this rawi recites by, via its qiraa.

        A property, not a column: storing it here as well would let the two
        disagree. Reads still look the same, so callers only need
        ``select_related("qiraa__counting_system")`` to stay at one query.
        """
        return self.qiraa.counting_system if self.qiraa else None


class Sura(models.Model):
    """A table for the swar"""

    number = models.PositiveSmallIntegerField(primary_key=True)
    transliteration = models.CharField(max_length=32, unique=True)
    name_arabic = models.CharField(max_length=32, unique=True)

    class Meta:
        db_table = "sura"
        verbose_name = "Sura"
        verbose_name_plural = "Suras"

    def __str__(self) -> str:
        return f"{self.number}. {self.transliteration} ({self.name_arabic})"


class SuraAyaCount(models.Model):
    """How many ayat a sura holds in one counting system.

    Derivable by counting :class:`Aya` rows, and kept anyway: it is seeded from a
    source independent of the boundary data, which makes it the cross-check that
    proves the expansion in ``seed_quran`` is right.
    """

    sura = models.ForeignKey(Sura, on_delete=models.CASCADE, related_name="aya_counts")
    counting_system = models.ForeignKey(
        CountingSystem, null=True, on_delete=models.CASCADE, related_name="sura_aya_counts"
    )
    count = models.PositiveSmallIntegerField()

    class Meta:
        db_table = "sura_aya_count"
        verbose_name = "Sura Aya Count"
        verbose_name_plural = "Sura Aya Counts"
        constraints = (models.UniqueConstraint(fields=["sura", "counting_system"], name="unique_sura_counting_system"),)

    def __str__(self) -> str:
        if self.counting_system:
            return f"{self.sura.transliteration} has {self.count} ayat in {self.counting_system.name}"
        return f"{self.sura.transliteration} has {self.count} ayat"


class Word(models.Model):
    """One word of the Uthmani text, numbered from 1 across the whole Quran.

    Deliberately holds nothing that depends on a counting system — no sura, no
    aya, no position-within-aya. Those have six different answers, and a single
    stored answer would quietly bake Kufi into code that is supposed to work for
    any mushaf. Ask :class:`Aya` instead.

    ``paw_count`` and the i'jam counts are pure functions of ``text``, cached
    here because the boundary engine asks for them 77,433 times. They are filled
    by ``core.arabic`` — the same functions the engine itself uses, so a stored
    count and a computed one cannot drift apart.
    """

    id = models.PositiveIntegerField(primary_key=True, help_text="1-based index of this word in the Quran.")
    text = models.CharField(max_length=64, help_text="Uthmani, exactly as Tanzil writes it.")
    paw_count = models.PositiveSmallIntegerField(help_text="Ink blobs this spelling must produce.")
    ijam_above = models.PositiveSmallIntegerField(help_text="Dot groups required above the writing line.")
    ijam_below = models.PositiveSmallIntegerField(help_text="Dot groups required below the writing line.")

    class Meta:
        db_table = "word"
        verbose_name = "Word"
        verbose_name_plural = "Words"
        ordering = ("id",)

    def __str__(self) -> str:
        return f"{self.id}. {self.text}"


class Aya(models.Model):
    """Where one aya starts, in one counting system.

    No end: within a system the ayat tile the whole Quran without gaps, so an aya
    runs up to the word before the next row's ``start_word`` (and the last one
    runs to the end of its sura). Storing the end as well would only create a
    second thing to keep true.
    """

    counting_system = models.ForeignKey(CountingSystem, on_delete=models.CASCADE, related_name="ayat")
    sura = models.ForeignKey(Sura, on_delete=models.CASCADE, related_name="ayat")
    number = models.PositiveSmallIntegerField(help_text="Aya number within its sura, in THIS counting system.")
    start_word = models.ForeignKey(
        Word, on_delete=models.PROTECT, related_name="ayat_starting_here", help_text="First word of the aya."
    )

    class Meta:
        db_table = "aya"
        verbose_name = "Aya"
        verbose_name_plural = "Ayat"
        ordering = ("counting_system", "start_word")
        constraints = (
            models.UniqueConstraint(
                fields=["counting_system", "sura", "number"], name="unique_aya_number_per_counting_system"
            ),
            models.UniqueConstraint(
                fields=["counting_system", "start_word"], name="unique_aya_start_per_counting_system"
            ),
        )

    def __str__(self) -> str:
        return f"{self.sura_id}:{self.number} ({self.counting_system.name}) from word {self.start_word_id}"
