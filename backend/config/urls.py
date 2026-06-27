"""
URL configuration for config project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/6.0/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""

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
