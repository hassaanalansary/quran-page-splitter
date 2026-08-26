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
        "en": "You already have a mushaf named {name!r}.",
        "ar": "لديك بالفعل مصحف بالاسم {name!r}.",
    },
    "not_authenticated": {
        "en": "Sign in to continue.",
        "ar": "سجّل الدخول للمتابعة.",
    },
    "too_many_jobs": {
        "en": "The server is already running as many processing jobs as it can. Try again shortly.",
        "ar": "الخادم يشغّل بالفعل أقصى عدد ممكن من عمليات المعالجة. حاول بعد قليل.",
    },
    "too_many_jobs_for_user": {
        "en": "You already have {count} processing job(s) running. Wait for one to finish, or cancel it.",
        "ar": "لديك بالفعل {count} عملية معالجة قيد التشغيل. انتظر انتهاء إحداها أو ألغِها.",
    },
    "bundle_invalid": {
        "en": "That file is not a readable work bundle.",
        "ar": "هذا الملف ليس حزمة عمل صالحة للقراءة.",
    },
    "bundle_schema_unknown": {
        "en": "Unsupported bundle format {schema!r}; this server reads {expected!r}.",
        "ar": "صيغة حزمة غير مدعومة {schema!r}؛ هذا الخادم يقرأ {expected!r}.",
    },
    "bundle_pdf_mismatch": {
        "en": (
            "This bundle was made from a different PDF (bundle {bundle}…, this mushaf {target}…). "
            "Import it onto a mushaf built from the same file."
        ),
        "ar": (
            "أُنشئت هذه الحزمة من ملف PDF مختلف (الحزمة {bundle}…، هذا المصحف {target}…). "
            "استوردها إلى مصحف مبني على الملف نفسه."
        ),
    },
    "bundle_has_pages": {
        "en": "This mushaf already has {count} processed page(s). Choose replace to overwrite them.",
        "ar": "هذا المصحف يحتوي بالفعل على {count} صفحة معالَجة. اختر الاستبدال للكتابة فوقها.",
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
    "lines_no_export": {
        "en": "No exported line images yet — run the line export first.",
        "ar": "لا توجد صور أسطر مُصدَّرة بعد — نفّذ تصدير الأسطر أولًا.",
    },
    "templates_required": {
        "en": "Both sura_header and aya_separator templates are required before processing.",
        "ar": "يلزم قالبا عنوان السورة وفاصل الآية قبل المعالجة.",
    },
    "run_no_log": {
        "en": "No log for this run.",
        "ar": "لا يوجد سجل لهذا التشغيل.",
    },
    "process_already_running": {
        "en": "This mushaf is already being processed. Wait for it to finish, or cancel it first.",
        "ar": "تجري معالجة هذا المصحف بالفعل. انتظر حتى تنتهي، أو ألغِها أولًا.",
    },
    "no_active_process": {
        "en": "No processing run is in progress for this mushaf.",
        "ar": "لا توجد عملية معالجة جارية لهذا المصحف.",
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
