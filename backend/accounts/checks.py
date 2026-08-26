"""Deployment checks for the account-security settings.

Registered with ``deploy=True``, so they run under ``manage.py check --deploy``
(the standard pre-deploy gate) and stay out of the way during development —
the same convention Django's own ``security.W0xx`` checks follow.
"""

from collections.abc import Sequence
from typing import Any

from django.apps.config import AppConfig
from django.conf import settings
from django.core.checks import CheckMessage, Tags, Warning, register

#: Cache backends that cannot hold a rate-limit counter shared across processes.
_UNSHARED_CACHE_BACKENDS = {
    "django.core.cache.backends.locmem.LocMemCache",
    "django.core.cache.backends.dummy.DummyCache",
}


@register(Tags.security, deploy=True)
def rate_limit_cache_is_shared(
    *,
    app_configs: Sequence[AppConfig] | None = None,
    databases: Sequence[str] | None = None,
    **kwargs: Any,
) -> list[CheckMessage]:
    """allauth counts brute-force attempts in the cache, so the cache must be shared.

    With the in-memory default every worker process keeps its own counters:
    ``login_failed`` at "5 per 5 minutes per account" silently becomes five per
    worker, and a restart clears the count. DummyCache is worse — it stores
    nothing, so the limits never trigger at all.
    """
    backend = settings.CACHES.get("default", {}).get("BACKEND", "")
    if backend not in _UNSHARED_CACHE_BACKENDS:
        return []
    return [
        Warning(
            f"CACHES['default'] uses {backend}, which is not shared between processes. "
            "allauth's brute-force rate limits are counted there, so each worker gets "
            "its own bucket and the limits reset on restart.",
            hint=(
                "Set CACHE_URL in .env — redis://127.0.0.1:6379/1 if you have Redis, "
                "otherwise django.core.cache.backends.db.DatabaseCache with "
                "`manage.py createcachetable` needs no extra service."
            ),
            id="accounts.W001",
        )
    ]
