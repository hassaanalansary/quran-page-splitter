"""Django Ninja API instance and router registration."""

from ninja import NinjaAPI

from api.views import counting_systems, finalize, mushafs, pages, processing, qiraat, suras

api = NinjaAPI(title="Quran Page Splitter API")

api.add_router("/counting-systems", counting_systems.router)
api.add_router("/qiraat", qiraat.router)
api.add_router("/suras", suras.router)
api.add_router("/mushafs", mushafs.router)
api.add_router("/mushafs", processing.router)
api.add_router("/mushafs", pages.router)
api.add_router("/mushafs", finalize.router)
