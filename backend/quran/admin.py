from django.contrib import admin

from .models import Aya, CountingSystem, Qiraa, Rawi, Sura, SuraAyaCount, Word

admin.site.register(CountingSystem)
admin.site.register(Qiraa)
admin.site.register(Rawi)
admin.site.register(Sura)
admin.site.register(SuraAyaCount)


@admin.register(Word)
class WordAdmin(admin.ModelAdmin):
    # 77,433 rows: give it a search box rather than a 3,000-page paginator.
    list_display = ("id", "text", "paw_count")
    search_fields = ("text",)


@admin.register(Aya)
class AyaAdmin(admin.ModelAdmin):
    list_display = ("counting_system", "sura", "number", "start_word")
    list_filter = ("counting_system",)
    list_select_related = ("counting_system", "sura")
