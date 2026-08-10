"""Serve the Vite-built React SPA from Django (production single-origin).

In development the SPA is served by Vite (which proxies ``/api`` + ``/media`` to
Django). In production we run only Django: it serves the built ``index.html`` and
hashed assets from ``frontend/dist`` and falls back to ``index.html`` for client
routes, while ``/api`` and ``/media`` are matched earlier in the URLconf.
"""

from django.conf import settings
from django.http import FileResponse, Http404, HttpRequest, HttpResponse, HttpResponseBase

FRONTEND_DIST = settings.BASE_DIR.parent / "frontend" / "dist"
SPA_INDEX = FRONTEND_DIST / "index.html"


def _index_response() -> HttpResponseBase:
    if not SPA_INDEX.exists():
        return HttpResponse(
            "<h1>Frontend not built</h1>"
            "<p>Run <code>npm run build</code> in <code>frontend/</code>, "
            "or use the Vite dev server during development.</p>",
            status=503,
            content_type="text/html",
        )
    return FileResponse(SPA_INDEX.open("rb"), content_type="text/html")


def spa_serve(request: HttpRequest, path: str = "") -> HttpResponseBase:
    """Serve a real file from ``dist`` if it exists, else the SPA ``index.html``.

    The path is resolved and confined to ``dist`` to block traversal. Hashed
    assets (``/assets/...``), the favicon, etc. are served directly; every other
    path returns ``index.html`` so the client router can handle it.
    """
    if path:
        candidate = (FRONTEND_DIST / path).resolve()
        try:
            candidate.relative_to(FRONTEND_DIST.resolve())
        except ValueError as exc:
            raise Http404("Not found.") from exc
        if candidate.is_file():
            return FileResponse(candidate.open("rb"))
    return _index_response()
