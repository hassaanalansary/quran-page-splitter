"""Auth flow tests against the allauth headless endpoints.

These exist because the user model has no ``username`` column, and several
allauth code paths reach for one. Without
``ACCOUNT_USER_MODEL_USERNAME_FIELD = None`` they die with
``FieldDoesNotExist: User has no field named 'username'`` — which took down both
Google sign-in and ordinary email sign-up.
"""

import json

from allauth.account.models import EmailAddress
from django.contrib.auth import get_user_model
from django.db.utils import IntegrityError
from django.test import TestCase

User = get_user_model()

BROWSER = "/_allauth/browser/v1"


class UserModelTests(TestCase):
    def test_created_without_a_username(self):
        user = User.objects.create_user(email="a@example.com", password="pw")
        self.assertEqual(user.email, "a@example.com")
        self.assertFalse(hasattr(user, "username"))

    def test_email_is_unique(self):
        User.objects.create_user(email="dup@example.com", password="pw")
        with self.assertRaises(IntegrityError):
            User.objects.create_user(email="dup@example.com", password="pw")

    def test_public_name_falls_back_to_the_email_local_part(self):
        """The gallery must never expose a full address as the author name."""
        user = User.objects.create_user(email="someone@example.com", password="pw")
        self.assertEqual(user.public_name, "someone")
        user.display_name = "Someone"
        self.assertEqual(user.public_name, "Someone")

    def test_superuser_flags(self):
        user = User.objects.create_superuser(email="root@example.com", password="pw")
        self.assertTrue(user.is_staff)
        self.assertTrue(user.is_superuser)


class HeadlessAuthTests(TestCase):
    """Drives the real /_allauth endpoints the SPA talks to."""

    def _post(self, path, payload):
        return self.client.post(f"{BROWSER}{path}", data=json.dumps(payload), content_type="application/json")

    def test_signup_creates_a_user(self):
        """Regression: this 500'd on the missing `username` field."""
        resp = self._post("/auth/signup", {"email": "new@example.com", "password": "sufficiently-long-pw"})
        self.assertIn(resp.status_code, (200, 401))  # 401 = created, pending email verification
        self.assertTrue(User.objects.filter(email="new@example.com").exists())

    def test_session_is_401_when_anonymous(self):
        resp = self.client.get(f"{BROWSER}/auth/session")
        self.assertEqual(resp.status_code, 401)
        self.assertFalse(resp.json()["meta"]["is_authenticated"])

    def test_login_then_session_reports_the_user(self):
        user = User.objects.create_user(email="in@example.com", password="sufficiently-long-pw")
        EmailAddress.objects.create(user=user, email=user.email, verified=True, primary=True)

        resp = self._post("/auth/login", {"email": "in@example.com", "password": "sufficiently-long-pw"})
        self.assertEqual(resp.status_code, 200)

        session = self.client.get(f"{BROWSER}/auth/session")
        self.assertEqual(session.status_code, 200)
        self.assertEqual(session.json()["data"]["user"]["email"], "in@example.com")

    def test_login_while_already_signed_in_is_409(self):
        """The SPA relies on this code to redirect instead of showing an error."""
        user = User.objects.create_user(email="dup@example.com", password="sufficiently-long-pw")
        EmailAddress.objects.create(user=user, email=user.email, verified=True, primary=True)
        self.client.force_login(user)

        resp = self._post("/auth/login", {"email": "dup@example.com", "password": "sufficiently-long-pw"})
        self.assertEqual(resp.status_code, 409)

    def test_logout_clears_the_session(self):
        user = User.objects.create_user(email="out@example.com", password="sufficiently-long-pw")
        self.client.force_login(user)

        resp = self.client.delete(f"{BROWSER}/auth/session")
        self.assertEqual(resp.status_code, 401)  # "you are now anonymous"
        self.assertEqual(self.client.get(f"{BROWSER}/auth/session").status_code, 401)


class DevEmailBackendTests(TestCase):
    """Verification and reset links must survive being printed to a terminal.

    Django encodes utf-8 bodies as quoted-printable, which soft-wraps at 76
    columns and leaves a trailing "=". Mail clients strip it; a terminal does
    not, which split every link in half and made the console backend useless for
    the one thing it is for.
    """

    URL = "http://localhost:5173/auth/reset/37dc2f030d914f1c8953f21a941fd378-ddhb5c-8036d273f909e399f994704413945392"

    def _render(self, backend_class):
        import io

        from django.core.mail import EmailMessage

        stream = io.StringIO()
        backend = backend_class(stream=stream)
        body = (
            "Hello!\n\nYou are receiving this email because you or someone else has requested "
            "a password reset for your user account.\n\n" + self.URL + "\n\nThank you!"
        )
        message = EmailMessage("Password Reset", body, "no-reply@localhost", ["x@example.com"])
        message.connection = backend
        backend.send_messages([message])
        return stream.getvalue()

    def test_the_link_survives_intact(self):
        from config.email import ReadableConsoleEmailBackend

        self.assertIn(self.URL, self._render(ReadableConsoleEmailBackend))

    def test_the_stock_backend_is_the_one_that_breaks_it(self):
        """Pins the reason this backend exists — if Django stops wrapping, drop it."""
        from django.core.mail.backends.console import EmailBackend

        self.assertNotIn(self.URL, self._render(EmailBackend))

    def test_headers_and_body_are_both_shown(self):
        output = self._render(__import__("config.email", fromlist=["x"]).ReadableConsoleEmailBackend)
        self.assertIn("Subject: Password Reset", output)
        self.assertIn("To: x@example.com", output)
        self.assertIn("Thank you!", output)


class RateLimitCacheCheckTests(TestCase):
    """The deploy check that stops brute-force limits being silently per-worker.

    allauth counts its rate limits in the cache, so an unshared cache backend
    turns "5 failed logins per 5 minutes" into five *per worker process*.
    """

    def _run(self, backend: str):
        from accounts.checks import rate_limit_cache_is_shared

        with self.settings(CACHES={"default": {"BACKEND": backend}}):
            return rate_limit_cache_is_shared(app_configs=None)

    def test_locmem_is_flagged(self):
        warnings = self._run("django.core.cache.backends.locmem.LocMemCache")
        self.assertEqual([w.id for w in warnings], ["accounts.W001"])

    def test_dummy_cache_is_flagged(self):
        """Worse than locmem: it stores nothing, so no limit ever trips."""
        self.assertEqual(len(self._run("django.core.cache.backends.dummy.DummyCache")), 1)

    def test_a_shared_backend_passes(self):
        self.assertEqual(self._run("django.core.cache.backends.redis.RedisCache"), [])
        self.assertEqual(self._run("django.core.cache.backends.db.DatabaseCache"), [])

    def test_it_only_runs_under_check_deploy(self):
        """Registered with deploy=True so development is not nagged about it."""
        from django.core.checks import registry

        from accounts.checks import rate_limit_cache_is_shared

        self.assertIn(rate_limit_cache_is_shared, registry.registry.deployment_checks)


class AllauthRateLimitTests(TestCase):
    """The limits themselves are allauth's defaults; pin the ones that matter."""

    def test_brute_force_limits_are_active(self):
        from allauth.account import app_settings

        limits = app_settings.RATE_LIMITS
        self.assertTrue(limits.get("login_failed"), "failed-login limiting is switched off")
        self.assertTrue(limits.get("reset_password"), "password-reset limiting is switched off")
        self.assertTrue(limits.get("signup"), "signup limiting is switched off")


class GoogleCallbackRoutingTests(TestCase):
    """HEADLESS_ONLY strips allauth's HTML views, but the provider callback must
    still be routable — Google redirects the browser straight to it."""

    def test_callback_url_is_mounted(self):
        from django.urls import reverse

        self.assertEqual(reverse("google_callback"), "/accounts/google/login/callback/")

    def test_html_login_view_is_not_mounted(self):
        from django.urls import NoReverseMatch, reverse

        with self.assertRaises(NoReverseMatch):
            reverse("account_login")
