from django.apps import AppConfig


class ApiConfig(AppConfig):
    name = "api"

    def ready(self) -> None:
        # Imported for its receivers; see api/signals.py.
        from api import signals  # noqa: F401
