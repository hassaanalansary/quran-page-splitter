"""Lightweight translation for user-facing API error messages.

The frontend sends the UI language via the ``Accept-Language`` header;
``LocaleMiddleware`` activates it, so ``get_language()`` reflects the request's
language anywhere downstream (no need to thread ``request`` through services).

This is deliberately a small hand-maintained catalog rather than full gettext /
``.po`` compilation — there are only a handful of user-facing strings, and they
never appear in logs (logs stay English).
"""

from django.utils.translation import get_language

# key -> { language code -> message template (str.format placeholders) }
MESSAGES: dict[str, dict[str, str]] = {
    "mushaf_not_found": {
        "en": "Mushaf not found.",
        "ar": "المصحف غير موجود.",
    },
    "mushaf_name_exists": {
        "en": "A mushaf named {name!r} already exists.",
        "ar": "يوجد مصحف بالاسم {name!r} بالفعل.",
    },
    "bounds_locked": {
        "en": (
            "Cannot change Quran-page bounds after pages are processed; "
            "delete the processed pages (or the mushaf) and reprocess."
        ),
        "ar": (
            "لا يمكن تغيير حدود صفحات القرآن بعد معالجة الصفحات؛ "
            "احذف الصفحات المعالَجة (أو المصحف) وأعد المعالجة."
        ),
    },
    "invalid_template_type": {
        "en": "Invalid template type {template_type!r}.",
        "ar": "نوع قالب غير صالح {template_type!r}.",
    },
    "template_image_required": {
        "en": "An image is required to create a template.",
        "ar": "يلزم توفير صورة لإنشاء قالب.",
    },
    "invalid_line_type": {
        "en": "Invalid line type {line_type!r}.",
        "ar": "نوع سطر غير صالح {line_type!r}.",
    },
    "page_no_finalize": {
        "en": "Page has no data to finalize.",
        "ar": "لا تحتوي الصفحة على بيانات للإنهاء.",
    },
    "page_no_export": {
        "en": "Page has no data to export.",
        "ar": "لا تحتوي الصفحة على بيانات للتصدير.",
    },
    "templates_required": {
        "en": "Both sura_header and aya_separator templates are required before processing.",
        "ar": "يلزم قالبا عنوان السورة وفاصل الآية قبل المعالجة.",
    },
    "run_no_log": {
        "en": "No log for this run.",
        "ar": "لا يوجد سجل لهذا التشغيل.",
    },
    "log_not_found": {
        "en": "Log file not found.",
        "ar": "ملف السجل غير موجود.",
    },
    "pdf_bounds": {
        "en": (
            "Require 1 <= first_quran_pdf_page <= last_quran_pdf_page <= {max} "
            "(got {first}, {last})."
        ),
        "ar": "المطلوب: 1 <= الصفحة الأولى <= الصفحة الأخيرة <= {max} (المُدخَل {first}، {last}).",
    },
    "page_number_range": {
        "en": "page_number must be in 1..{count} (got {page_number}).",
        "ar": "يجب أن يكون رقم الصفحة ضمن 1..{count} (المُدخَل {page_number}).",
    },
    "page_range": {
        "en": "Require 1 <= start <= end <= {count} (got {start}, {end}).",
        "ar": "المطلوب: 1 <= البداية <= النهاية <= {count} (المُدخَل {start}، {end}).",
    },
}

SUPPORTED = ("en", "ar")


def active_lang() -> str:
    """The active request language, narrowed to a supported bare subtag."""
    code = (get_language() or "en").split("-")[0]
    return code if code in SUPPORTED else "en"


def t(key: str, /, **kwargs: object) -> str:
    """Translate ``key`` into the active language, formatting any placeholders."""
    entry = MESSAGES[key]
    template = entry.get(active_lang(), entry["en"])
    return template.format(**kwargs) if kwargs else template
