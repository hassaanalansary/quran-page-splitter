# The library prices every reading now: the experimental opt-in that switched it on goes.

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0031_library_check"),
    ]

    operations = [
        migrations.RemoveField(model_name="calibrationsettings", name="experimental"),
    ]
