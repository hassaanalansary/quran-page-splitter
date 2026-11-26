# Words are written only by confirming a page in calibration, so the word run's
# per-line verdict and its log pointer have no writer left.

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0029_library_settings"),
    ]

    operations = [
        migrations.DeleteModel(
            name="LineWordStatus",
        ),
        migrations.RemoveField(
            model_name="processjob",
            name="log_path",
        ),
    ]
