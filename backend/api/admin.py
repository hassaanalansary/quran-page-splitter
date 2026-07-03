from django.contrib import admin

from .models import (
    CountingSystem,
    EraseStroke,
    Line,
    Mushaf,
    Page,
    Qiraa,
    Segment,
    Sura,
    SuraAyaCount,
)

admin.site.register(CountingSystem)
admin.site.register(Qiraa)
admin.site.register(Sura)
admin.site.register(SuraAyaCount)
admin.site.register(Mushaf)
admin.site.register(Page)
admin.site.register(Line)
admin.site.register(Segment)
admin.site.register(EraseStroke)
