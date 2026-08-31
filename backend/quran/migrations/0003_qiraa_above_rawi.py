"""Introduce the ten qiraat above the twenty rawis, and move the counting system up.

The twenty rows this app inherited are transmitters — Hafs, Warsh, Qalun — and each
pair of them belongs to one qiraa. The counting system is a property of the qiraa,
never of the rawi: both of Asim's rawis count by Kufi, both of Nafi's by the Last
Madinan. Storing it on the rawi let the two halves of a pair disagree, which is a
state that cannot exist.

The data migration reads each qiraa's counting system **out of the rawis it is
being given**, rather than hardcoding it, so whatever the database already holds is
what survives. Only the grouping itself is written down here, because that is the
one fact the database does not know.

On an empty database (a fresh install, or the test runner) there are no rawis to
group, and this does nothing — ``seed_quran`` populates both tables from
``reference_data.json`` instead.
"""

import django.db.models.deletion
from django.db import migrations, models

#: name, Arabic name, and the rawis it transmits — matching the twenty rows
#: already in the table, whose names are wire values and must be spelled exactly.
QIRAAT = [
    ("Nafi", "نافع", ["qalun", "warsh"]),
    ("Ibn-Kathir", "ابن كثير", ["bazzi", "qunbul"]),
    ("Abu-Amr", "أبو عمرو", ["duri", "susi"]),
    ("Ibn-Amir", "ابن عامر", ["Hisham", "Ibn-Dhakwan"]),
    ("Asim", "عاصم", ["Shuba", "Hafs"]),
    ("Hamza", "حمزة", ["Khalaf", "khallad"]),
    ("Al-Kisai", "الكسائي", ["Abu-Al-Harith", "Duri-Kisai"]),
    ("Abu-Jafar", "أبو جعفر", ["Ibn-Wardan", "Ibn-Jammaz"]),
    ("Yaqub", "يعقوب", ["Ruways", "Rawh"]),
    ("Khalaf-Al-Ashir", "خلف العاشر", ["Ishaq", "Idris"]),
]


def group_rawis_under_qiraat(apps, schema_editor):
    Qiraa = apps.get_model("quran", "Qiraa")
    Rawi = apps.get_model("quran", "Rawi")
    for name, name_arabic, rawi_names in QIRAAT:
        rawis = list(Rawi.objects.filter(name__in=rawi_names))
        if not rawis:
            continue
        # Whatever the rawis were already recording. Both of a pair agree in the
        # seeded data; if one were null the other still answers.
        system_id = next((r.counting_system_id for r in rawis if r.counting_system_id), None)
        qiraa = Qiraa.objects.create(name=name, name_arabic=name_arabic, counting_system_id=system_id)
        Rawi.objects.filter(pk__in=[r.pk for r in rawis]).update(qiraa=qiraa)


def flatten_qiraat_back_onto_rawis(apps, schema_editor):
    """Reverse: give each rawi its counting system back, then drop the qiraat.

    Django re-adds ``Rawi.counting_system`` before this runs, so the column is
    there to write into.
    """
    Qiraa = apps.get_model("quran", "Qiraa")
    Rawi = apps.get_model("quran", "Rawi")
    for rawi in Rawi.objects.select_related("qiraa"):
        if rawi.qiraa_id:
            rawi.counting_system_id = rawi.qiraa.counting_system_id
            rawi.save(update_fields=["counting_system"])
    Qiraa.objects.all().delete()


class Migration(migrations.Migration):
    dependencies = [
        ("quran", "0002_rename_reference_tables"),
    ]

    operations = [
        # Safe only because 0002 moved the old rows out of the "qiraa" table.
        migrations.CreateModel(
            name="Qiraa",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=256, unique=True)),
                ("name_arabic", models.CharField(max_length=256, unique=True)),
                ("description", models.TextField(blank=True, default="")),
                (
                    "counting_system",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="qiraat",
                        to="quran.countingsystem",
                    ),
                ),
            ],
            options={"verbose_name": "Qiraa", "verbose_name_plural": "Qiraat", "db_table": "qiraa"},
        ),
        migrations.AddField(
            model_name="rawi",
            name="qiraa",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="rawis",
                to="quran.qiraa",
            ),
        ),
        migrations.RunPython(group_rawis_under_qiraat, flatten_qiraat_back_onto_rawis),
        migrations.RemoveField(model_name="rawi", name="counting_system"),
    ]
