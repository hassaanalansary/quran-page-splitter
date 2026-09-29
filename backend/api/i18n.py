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
        "ar": ("لا يمكن تغيير حدود صفحات القرآن بعد معالجة الصفحات؛ احذف الصفحات المعالَجة (أو المصحف) وأعد المعالجة."),
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
    "words_no_riwaya": {
        "en": "Set this mushaf's riwaya before detecting words — it is what says where its ayat end.",
        "ar": "حدّد رواية هذا المصحف قبل كشف الكلمات — فهي التي تحدد نهايات آياته.",
    },
    "words_span_not_found": {
        "en": (
            "{sura}:{aya} is not on any reviewed line of this mushaf. Process the pages that hold "
            "it, and make sure their aya numbering has been reviewed."
        ),
        "ar": (
            "الآية {sura}:{aya} ليست على أي سطر مُراجَع في هذا المصحف. عالج الصفحات التي تحتويها، "
            "وتأكد من مراجعة ترقيم آياتها."
        ),
    },
    "words_span_backwards": {
        "en": "The span {from_sura}:{from_aya}..{to_sura}:{to_aya} runs backwards through this mushaf.",
        "ar": "النطاق {from_sura}:{from_aya}..{to_sura}:{to_aya} يسير عكسيًا في هذا المصحف.",
    },
    "no_active_word_run": {
        "en": "No word detection run is in progress for this mushaf.",
        "ar": "لا توجد عملية كشف كلمات جارية لهذا المصحف.",
    },
    "calibration_not_found": {
        "en": "Page {page} has nothing to calibrate — it is not processed in this mushaf.",
        "ar": "لا يوجد في الصفحة {page} ما يُعاير — فهي غير معالَجة في هذا المصحف.",
    },
    "calibration_not_reviewed": {
        "en": "Review page {page}'s lines and aya separators first; calibration reads the page as reviewed.",
        "ar": "راجع أسطر الصفحة {page} وفواصل آياتها أولًا؛ فالمعايرة تقرأ الصفحة كما رُوجعت.",
    },
    "calibration_not_numbered": {
        "en": "Page {page} has aya segments without a number. Save it in Review so its ayat are numbered.",
        "ar": "في الصفحة {page} مقاطع آيات بلا رقم. احفظها في المراجعة حتى تُرقَّم آياتها.",
    },
    "calibration_already_processed": {
        "en": "Page {page} is already processed for calibration. Its draft is kept; open it instead.",
        "ar": "الصفحة {page} معالَجة للمعايرة بالفعل، ومسودتها محفوظة؛ افتحها بدلًا من ذلك.",
    },
    "calibration_not_processed": {
        "en": "Page {page} has not been processed for calibration yet.",
        "ar": "لم تُعالَج الصفحة {page} للمعايرة بعد.",
    },
    "calibration_stale_revision": {
        "en": "This page changed since you opened it — in another tab, or by a run. Reload it to continue.",
        "ar": "تغيّرت هذه الصفحة منذ فتحتها — في تبويب آخر أو بعملية تشغيل. أعد تحميلها للمتابعة.",
    },
    "calibration_stale_source": {
        "en": (
            "This page's lines changed since it was processed (re-processed, reviewed, or erased). "
            "Process it again to calibrate the current lines."
        ),
        "ar": (
            "تغيّرت أسطر هذه الصفحة منذ معالجتها (أُعيدت معالجتها أو مراجعتها أو مُسح منها شيء). "
            "عالجها من جديد لمعايرة الأسطر الحالية."
        ),
    },
    "calibration_stale_context": {
        "en": (
            "A neighbouring page's lines changed since this page was processed, so it cannot be read again "
            "across them. Process it again — the decisions on its unchanged lines are kept."
        ),
        "ar": (
            "تغيّرت أسطر صفحة مجاورة منذ معالجة هذه الصفحة، فلا يمكن قراءتها من جديد عبرها. "
            "عالجها من جديد — وتبقى القرارات المتّخذة في أسطرها التي لم تتغيّر."
        ),
    },
    "calibration_invalid_edits": {
        "en": "These edits do not match the page they were made on. Reload the page and try again.",
        "ar": "هذه التعديلات لا تطابق الصفحة التي أُجريت عليها. أعد تحميل الصفحة وحاول مجددًا.",
    },
    "calibration_exceptions": {
        "en": "{count} item(s) on this page still disagree with the text. Acknowledge them to confirm.",
        "ar": "ما زال {count} عنصرًا في هذه الصفحة لا يوافق النص. أقرّ بها لتأكيد الصفحة.",
    },
    "calibration_request_reused": {
        "en": "That save was already sent with different content. Reload the page and save again.",
        "ar": "أُرسل هذا الحفظ من قبل بمحتوى مختلف. أعد تحميل الصفحة واحفظ مجددًا.",
    },
    "calibration_no_active_job": {
        "en": "No calibration page is being processed for this mushaf.",
        "ar": "لا تجري معالجة أي صفحة معايرة لهذا المصحف.",
    },
    "page_not_found": {
        "en": "Page {page} is not in this mushaf.",
        "ar": "الصفحة {page} ليست في هذا المصحف.",
    },
    "log_not_found": {
        "en": "Log file not found.",
        "ar": "ملف السجل غير موجود.",
    },
    "pdf_bounds": {
        "en": ("Require 1 <= first_quran_pdf_page <= last_quran_pdf_page <= {max} (got {first}, {last})."),
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
