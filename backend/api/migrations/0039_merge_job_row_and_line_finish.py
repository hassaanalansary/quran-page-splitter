# Joins the two lines of migrations that met when feature/celery-and-docker
# was merged into feature/word-by-word_recognition: the job row (0033 on the
# Celery branch) and the line-finishing fields (0033-0038). They touch
# different models, so nothing runs here.

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("api", "0033_job_described_by_its_row"),
        ("api", "0038_page_sura_header_padding"),
    ]

    operations = []
