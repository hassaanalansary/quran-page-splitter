from django.contrib import admin

from .models import (
    EraseStroke,
    Line,
    Mushaf,
    Page,
    Segment,
)

# The reference tables (counting systems, qiraat, rawis, suras, aya counts) are
# registered by the ``quran`` app, which owns them.
admin.site.register(Mushaf)
admin.site.register(Page)
admin.site.register(Line)
admin.site.register(Segment)
admin.site.register(EraseStroke)
