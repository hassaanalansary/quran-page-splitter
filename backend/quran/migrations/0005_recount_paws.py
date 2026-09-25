"""Recount ``Word.paw_count`` after the joining table was corrected.

``paw_count`` is stored, computed once at seed time, so correcting
``core.text.arabic`` fixes nothing already in a database. Every run on an existing
mushaf would keep demanding the blob count the old table produced.

What changed, and why it has to be a data migration rather than a re-seed: the
word table is keyed by the word's position in the Quran and is referenced by
``api.LineWord`` rows that hold a reviewer's hand-corrected cuts. Re-seeding would
delete and recreate those keys. This only rewrites the one column that is wrong.

341 rows move — 338 down where a medial ``ى`` was counted as a break it does not
make (``يَغْشَىٰهَا``, ``أَدْرَىٰكَ``, ``ٱلتَّوْرَىٰةِ``), and 3 up where a bare hamza
was fused onto the letter before it (``مِّلْءُ``, ``دِفْءٌ``, ``ٱلْخَبْءَ``).
"""

from __future__ import annotations

from django.db import migrations

#: Recomputed from ``Word.text``, so this stays right if the table is corrected
#: again. ``seed_words`` already sources the value from the same function, on the
#: stated principle that what is stored and what the engine computes cannot be
#: allowed to disagree.
from core.text import paw_count


def recount(apps, schema_editor):
    Word = apps.get_model("quran", "Word")
    changed = []
    for word in Word.objects.all().only("id", "text", "paw_count").iterator(chunk_size=5000):
        correct = paw_count(word.text)
        if correct != word.paw_count:
            word.paw_count = correct
            changed.append(word)
    Word.objects.bulk_update(changed, ["paw_count"], batch_size=2000)


def noop(apps, schema_editor):
    """Nothing to undo: the previous values were wrong, not merely different."""


class Migration(migrations.Migration):
    dependencies = [("quran", "0004_word_aya")]

    operations = [migrations.RunPython(recount, noop)]
