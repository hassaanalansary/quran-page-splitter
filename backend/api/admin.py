from django.contrib import admin

from .models import (
    CountingSystem,
    Mushaf,
    Qiraa,
    Sura,
    SuraAyaCount,
)

admin.site.register(CountingSystem)
admin.site.register(Qiraa)
admin.site.register(Sura)
admin.site.register(SuraAyaCount)
admin.site.register(Mushaf)
