from django.apps import AppConfig


class AccountsConfig(AppConfig):
    name = "accounts"

    def ready(self) -> None:
        # Importing registers the deploy checks; nothing else uses the module.
        from accounts import checks  # noqa: F401
