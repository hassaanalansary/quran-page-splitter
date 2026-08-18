from pathlib import Path

import environ

BASE_DIR = Path(__file__).resolve().parent.parent

env = environ.Env(
    DEBUG=(bool, False),
    ALLOWED_HOSTS=(list, []),
    CORS_ALLOWED_ORIGINS=(list, []),
    CSRF_TRUSTED_ORIGINS=(list, []),
    EMAIL_PORT=(int, 587),
    EMAIL_USE_TLS=(bool, True),
)
environ.Env.read_env(BASE_DIR / ".env")


# No fallback on purpose: booting a public deployment with a key that is
# published in this repo's history would silently forge every session cookie.
# Copy .env.dist to .env and generate one (the file shows how).
SECRET_KEY = env("SECRET_KEY")

DEBUG = env("DEBUG")

ALLOWED_HOSTS = env("ALLOWED_HOSTS")


INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # allauth requires the sites framework.
    "django.contrib.sites",
    "corsheaders",
    # Accounts must be installed before anything that references the user model.
    "accounts",
    "allauth",
    "allauth.account",
    "allauth.socialaccount",
    "allauth.socialaccount.providers.google",
    # Exposes allauth's flows as JSON under /_allauth/ so the React SPA can drive
    # them; HEADLESS_ONLY below turns off allauth's own HTML views entirely.
    "allauth.headless",
    "api",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    # Compress responses (the review-data payload is large); browsers send
    # Accept-Encoding: gzip and decompress transparently.
    "django.middleware.gzip.GZipMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    # Activates the request language from the Accept-Language header (sent by the
    # SPA with the chosen UI language) so API error messages can be localized.
    # Must sit after SessionMiddleware and before CommonMiddleware.
    "django.middleware.locale.LocaleMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    # Lets Django Ninja read uploaded files on PUT/PATCH (not just POST).
    "ninja.compatibility.files.fix_request_files_middleware",
    # Must come after AuthenticationMiddleware.
    "allauth.account.middleware.AccountMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"


# Postgres in any real deployment; the sqlite default keeps a bare checkout
# runnable. SQLite serializes writes, so it cannot serve concurrent users while
# a processing run is committing a transaction per page.
DATABASES = {"default": env.db("DATABASE_URL", default=f"sqlite:///{BASE_DIR / 'db.sqlite3'}")}


# allauth's brute-force rate limits (login_failed 10/m/ip + 5/300s/key, signup
# 20/m/ip, and so on) are counted in the cache. The LocMemCache default is
# per-process and cleared on restart, so under several workers an attacker gets
# one bucket per worker. Point CACHE_URL at Redis (or a DB cache table) in any
# deployment that runs more than one process.
CACHES = {"default": env.cache("CACHE_URL", default="locmemcache://")}


AUTH_USER_MODEL = "accounts.User"

AUTHENTICATION_BACKENDS = [
    # Kept so the Django admin login and `manage.py` still work.
    "django.contrib.auth.backends.ModelBackend",
    "allauth.account.auth_backends.AuthenticationBackend",
]

SITE_ID = 1


AUTH_PASSWORD_VALIDATORS = [
    {
        "NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.CommonPasswordValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.NumericPasswordValidator",
    },
]

# --- Authentication (django-allauth, headless) ---------------------------
# The SPA drives allauth over JSON at /_allauth/browser/v1/*; allauth renders no
# HTML of its own. Auth rides on Django's session cookie rather than a token
# because the app loads page images with <img src> and downloads lines.zip with
# <a download>, neither of which can carry an Authorization header.
HEADLESS_ONLY = True

#: Only the browser (cookie) client. The token-based "app" client would also be
#: mounted by default; it is off because nothing here uses it.
HEADLESS_CLIENTS = ("browser",)

#: Where allauth's emailed links land. These are React routes — see
#: frontend/src/routes/auth.*.tsx — which read the key and POST it back.
HEADLESS_FRONTEND_URLS = {
    "account_confirm_email": "/auth/verify-email/{key}",
    "account_reset_password": "/auth/forgot",
    "account_reset_password_from_key": "/auth/reset/{key}",
    "account_signup": "/auth/signup",
    "socialaccount_login_error": "/auth/login",
}

#: Serves allauth's own OpenAPI spec at /_allauth/openapi.html in dev, which is
#: the authoritative reference for the flow protocol (it is version-specific).
HEADLESS_SERVE_SPECIFICATION = DEBUG

# accounts.User has no username column. Without this, allauth defaults the
# setting to "username" and every flow that populates one — social sign-up and
# ordinary email sign-up alike — dies with
# FieldDoesNotExist: User has no field named 'username'.
ACCOUNT_USER_MODEL_USERNAME_FIELD = None

ACCOUNT_LOGIN_METHODS = {"email"}
# No "password2": the headless signup endpoint takes a single `password` field
# (allauth/headless/account/inputs.py), and the SPA does its own confirm-password
# check before posting.
ACCOUNT_SIGNUP_FIELDS = ["email*", "password1*"]
ACCOUNT_EMAIL_VERIFICATION = "mandatory"
ACCOUNT_UNIQUE_EMAIL = True
ACCOUNT_PREVENT_ENUMERATION = True
#: Otherwise allauth's `display` field falls back to str(user) — the address.
ACCOUNT_USER_DISPLAY = "accounts.utils.user_display"

SOCIALACCOUNT_PROVIDERS = {
    "google": {
        "APP": {
            "client_id": env("GOOGLE_CLIENT_ID", default=""),
            "secret": env("GOOGLE_CLIENT_SECRET", default=""),
            "key": "",
        },
        "SCOPE": ["profile", "email"],
        "AUTH_PARAMS": {"access_type": "online"},
        # Google has already verified the address, so don't re-verify by email.
        "EMAIL_AUTHENTICATION": True,
        "VERIFIED_EMAIL": True,
    }
}

# --- Email ---------------------------------------------------------------
# Console in dev, so verification and password-reset links print to the terminal
# and both flows are testable without an SMTP account.
if env("EMAIL_HOST", default=""):
    EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
    EMAIL_HOST = env("EMAIL_HOST")
    EMAIL_PORT = env("EMAIL_PORT")
    EMAIL_HOST_USER = env("EMAIL_HOST_USER", default="")
    EMAIL_HOST_PASSWORD = env("EMAIL_HOST_PASSWORD", default="")
    EMAIL_USE_TLS = env("EMAIL_USE_TLS")
else:
    # Not Django's console backend: that one prints raw MIME, and quoted-printable
    # soft-wrapping splits every verification link across two lines with a
    # trailing "=". See config/email.py.
    EMAIL_BACKEND = "config.email.ReadableConsoleEmailBackend"

DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", default="no-reply@localhost")


# --- Cross-origin and cookies --------------------------------------------
# Production serves the SPA and the API from one origin, and dev goes through
# the Vite proxy, so this list is normally empty. It must not be "*": browsers
# reject a wildcard origin on credentialed requests, which every API call now is.
CORS_ALLOWED_ORIGINS = env("CORS_ALLOWED_ORIGINS")
CORS_ALLOW_CREDENTIALS = True
CSRF_TRUSTED_ORIGINS = env("CSRF_TRUSTED_ORIGINS")

if DEBUG:
    # The Vite dev server, and Django's own port. Belt and braces: the dev proxy
    # is configured with changeOrigin=false so Host and Origin already agree,
    # but anyone who flips that (Vite's own default is true) would otherwise get
    # an opaque 403 on every write. Never added when DEBUG is off.
    _dev_origins = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ]
    CORS_ALLOWED_ORIGINS = list(dict.fromkeys([*CORS_ALLOWED_ORIGINS, *_dev_origins]))
    CSRF_TRUSTED_ORIGINS = list(dict.fromkeys([*CSRF_TRUSTED_ORIGINS, *_dev_origins]))

# HTTPS-only hardening, off in dev so localhost still works over http.
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
# Separately overridable: behind a TLS-terminating proxy Django sees plain HTTP
# and would redirect forever. Set SECURE_SSL_REDIRECT=False there and let the
# proxy handle it (and set SECURE_PROXY_SSL_HEADER if you want Django to know).
SECURE_SSL_REDIRECT = env.bool("SECURE_SSL_REDIRECT", default=not DEBUG)
SECURE_HSTS_SECONDS = 0 if DEBUG else 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = not DEBUG
SECURE_HSTS_PRELOAD = not DEBUG
SECURE_CONTENT_TYPE_NOSNIFF = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"
# The SPA reads this cookie to set the X-CSRFToken header, so it must not be
# HttpOnly (see frontend/src/lib/api/http.ts).
CSRF_COOKIE_HTTPONLY = False

# Run processing jobs on the request thread instead of a worker thread. Off in
# real use (the point of a job is that the request returns immediately); tests
# turn it on so a POST settles before it returns, keeping them deterministic and
# free of cross-thread DB visibility problems. See api/services/jobs.py.
PROCESS_JOBS_INLINE = False

# --- Processing concurrency ----------------------------------------------
# Detection is CPU-bound OpenCV work, so these are about protecting the box
# rather than the database. Without them ten people pressing Process at once
# means ten heavy threads competing, and everyone's run crawls.
MAX_CONCURRENT_JOBS = env.int("MAX_CONCURRENT_JOBS", default=2)
MAX_CONCURRENT_JOBS_PER_USER = env.int("MAX_CONCURRENT_JOBS_PER_USER", default=1)

#: How long a job may go without a heartbeat before another process may declare
#: its worker dead. Must comfortably exceed the slowest single page, since the
#: worker only reports between pages — too low and a live run gets settled out
#: from under itself.
JOB_HEARTBEAT_TIMEOUT_SECONDS = env.int("JOB_HEARTBEAT_TIMEOUT_SECONDS", default=300)


LANGUAGE_CODE = "en-us"

# Languages the API localizes error messages into (see api/i18n.py). Constrains
# LocaleMiddleware's Accept-Language negotiation to these.
LANGUAGES = [
    ("en", "English"),
    ("ar", "Arabic"),
]

TIME_ZONE = "UTC"

USE_I18N = True

USE_TZ = True


STATIC_URL = "static/"

MEDIA_URL = "media/"
MEDIA_ROOT = BASE_DIR / "media"

# --- Logging -------------------------------------------------------------
# Console (INFO, minus the engine trace) for the dev server + a rotating file
# (DEBUG) with everything. The processing pipeline additionally attaches a
# per-run file handler for that run's own log (see services/processing.py),
# which is what the in-app log viewer tails.
LOG_DIR = BASE_DIR / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

#: Per-run log files kept under ``LOG_DIR/runs``; the oldest beyond this are
#: deleted when a new run starts. A run whose log has been pruned still lists
#: normally — fetching it just 404s.
RUN_LOG_RETENTION = 30

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "detailed": {"format": "{asctime}  {name:<26}  {levelname:<7}  {message}", "style": "{"},
        "console": {"format": "{levelname:<7} {name}: {message}", "style": "{"},
    },
    "filters": {
        "quiet_engine_trace": {"()": "config.logging_filters.QuietEngineTrace"},
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "level": "INFO",
            "formatter": "console",
            "filters": ["quiet_engine_trace"],
        },
        "file": {
            "class": "logging.handlers.RotatingFileHandler",
            "filename": str(LOG_DIR / "quran.log"),
            "maxBytes": 5 * 1024 * 1024,
            "backupCount": 3,
            "encoding": "utf-8",
            "level": "DEBUG",
            "formatter": "detailed",
        },
    },
    "root": {"handlers": ["console", "file"], "level": "INFO"},
    "loggers": {
        "core": {"level": "DEBUG", "propagate": True},
        "api": {"level": "INFO", "propagate": True},
    },
}

# The test runner used to skip api's migrations (MIGRATION_MODULES = {"api": None})
# and build its schema straight from the models, which was a little faster.
#
# That cannot work now that `api` models reference `accounts.User`. `migrate`
# creates tables for *unmigrated* apps before it runs anybody's migrations, so
# `api` would be built before `accounts` had made `app_user` — and PostgreSQL,
# unlike SQLite, refuses a REFERENCES to a table that does not exist yet.
#
# Letting the migrations run costs a few seconds per test session and buys real
# coverage of them: exactly the check that would have caught 0006's
# SQLite-only SQL before it blocked the PostgreSQL cutover.
