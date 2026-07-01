from django.conf import settings
from django.contrib import admin
from django.urls import path, re_path
from django.views.static import serve as static_serve

from api.api import api
from config.spa import spa_serve

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", api.urls),
    # User uploads (mushaf PDFs, template crops, exported line PNGs). Served
    # here (not just under DEBUG) so the local desktop build works either way.
    re_path(r"^media/(?P<path>.*)$", static_serve, {"document_root": settings.MEDIA_ROOT}),
    # SPA catch-all — must stay last so /admin, /api, /media match first.
    re_path(r"^(?P<path>.*)$", spa_serve),
]
