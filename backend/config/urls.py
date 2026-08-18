from django.conf import settings
from django.contrib import admin
from django.urls import include, path, re_path
from django.views.static import serve as static_serve

from api.api import api
from config.spa import spa_serve

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", api.urls),
    # allauth's headless JSON API (login/signup/password/email/social), driven by
    # the SPA. Must precede the catch-all below, which would otherwise swallow it.
    path("_allauth/", include("allauth.headless.urls")),
    # Social providers' OAuth callbacks. HEADLESS_ONLY strips allauth's HTML
    # login/signup views out of this include, but the provider callback routes
    # are added unconditionally (allauth/urls.py) — and Google redirects the
    # browser straight back to one of them, so it has to be routable.
    path("accounts/", include("allauth.urls")),
    # User uploads (mushaf PDFs, template crops, exported line PNGs). Served
    # here (not just under DEBUG) so the local desktop build works either way.
    re_path(r"^media/(?P<path>.*)$", static_serve, {"document_root": settings.MEDIA_ROOT}),
    # SPA catch-all — must stay last so /admin, /api, /media match first.
    re_path(r"^(?P<path>.*)$", spa_serve),
]
