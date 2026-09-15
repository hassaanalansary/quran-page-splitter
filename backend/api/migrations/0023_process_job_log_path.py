"""Give a word run somewhere to keep its log.

Detection hangs its log off the ``ProcessingRun`` it creates. A word run creates no
such row — it writes ``LineWord`` rows straight onto existing lines — so until now
there was nowhere to record the file, and the trace of the run that produced a page's
cuts was simply not kept.

The job row is the natural owner: it is the thing that exists for exactly as long as
the run, it is already what the client polls, and it already carries ``log_url``. The
file itself lives in the same directory detection uses, in the same format, read by
the same viewer — see ``api.services.run_logs``.
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("api", "0022_line_word_start_x")]

    operations = [
        migrations.AddField(
            model_name="processjob",
            name="log_path",
            field=models.CharField(
                blank=True,
                default="",
                help_text="Path (relative to settings.LOG_DIR) of this run's detailed log file.",
                max_length=255,
            ),
        ),
    ]
