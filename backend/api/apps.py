from django.apps import AppConfig


class ApiConfig(AppConfig):
    name = "api"

    def ready(self) -> None:
        # Connects the receivers of Celery's worker signals. They fire only inside a
        # Celery worker: see the module.
        from api.services.jobs import worker_events  # noqa: F401
