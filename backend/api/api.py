"""Django Ninja API instance and router registration."""

from ninja import NinjaAPI
from ninja.security import django_auth

from api.views import counting_systems, finalize, gallery, mushafs, pages, processing, qiraat, suras

# Session-cookie auth for everything by default; routers opt out with auth=None
# below. ``django_auth`` is a SessionAuth, which is an APIKeyCookie, and those
# enforce CSRF on unsafe methods on their own — there is no csrf= argument on
# NinjaAPI in this version.
api = NinjaAPI(title="Quran Page Splitter API", auth=django_auth)

# Reference data: the same Quranic constants for everyone, and the sign-up and
# create-mushaf screens need them before there is a session.
api.add_router("/counting-systems", counting_systems.router, auth=None)
api.add_router("/qiraat", qiraat.router, auth=None)
api.add_router("/suras", suras.router, auth=None)

# The public gallery. Its own operations set auth individually — browsing and
# downloading are open, duplicating is not — so the whole anonymous surface of
# the project is readable in api/views/gallery.py.
api.add_router("/gallery", gallery.router, auth=None)

api.add_router("/mushafs", mushafs.router)
api.add_router("/mushafs", processing.router)
api.add_router("/mushafs", pages.router)
api.add_router("/mushafs", finalize.router)
