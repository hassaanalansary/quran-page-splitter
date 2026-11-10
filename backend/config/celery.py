"""The Celery app. A worker is started with ``celery -A config worker``.

Only jobs run through it (``api/tasks.py``), and only when ``JOB_RUNNER`` is
``celery``. The settings are the ``CELERY_…`` names in ``config/settings.py``.
"""

import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

app = Celery("quran_page_splitter")
# Every CELERY_… name in the Django settings becomes the Celery setting of that name.
app.config_from_object("django.conf:settings", namespace="CELERY")
# Finds the ``tasks.py`` of each installed app.
app.autodiscover_tasks()
