"""The project package. Loading it loads the Celery app, so that a task sent from
the web process goes through the app that ``config/settings.py`` configured."""

from config.celery import app as celery_app

__all__ = ("celery_app",)
