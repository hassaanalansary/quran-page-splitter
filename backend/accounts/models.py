"""The account model: email is the identifier, there is no username column.

Introduced together with the Postgres cutover so that ``AUTH_USER_MODEL`` points
here from the schema's very first migration. Swapping the user model on a
database that already has ``auth_user`` rows and an ``django_admin_log.user_id``
foreign key is the painful path; building the schema against it is not.
"""

import uuid
from typing import Any, ClassVar

from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.contrib.auth.models import PermissionsMixin
from django.db import models
from django.utils import timezone


class UserManager(BaseUserManager["User"]):
    """Creates users keyed on a normalized email rather than a username."""

    use_in_migrations = True

    def _create_user(self, email: str, password: str | None, **extra: Any) -> "User":
        if not email:
            raise ValueError("Users must have an email address.")
        user = self.model(email=self.normalize_email(email), **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email: str, password: str | None = None, **extra: Any) -> "User":
        extra.setdefault("is_staff", False)
        extra.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra)

    def create_superuser(self, email: str, password: str | None = None, **extra: Any) -> "User":
        extra.setdefault("is_staff", True)
        extra.setdefault("is_superuser", True)
        if extra.get("is_staff") is not True:
            raise ValueError("Superuser must have is_staff=True.")
        if extra.get("is_superuser") is not True:
            raise ValueError("Superuser must have is_superuser=True.")
        return self._create_user(email, password, **extra)


class User(AbstractBaseUser, PermissionsMixin):
    """An account. UUID pk to match the convention in ``api.models.BaseModel``."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(unique=True)
    display_name = models.CharField(
        max_length=120,
        blank=True,
        default="",
        help_text="Shown as the author on published mushafs. Never the email address.",
    )
    is_staff = models.BooleanField(default=False, help_text="Can sign in to the Django admin.")
    is_active = models.BooleanField(default=True)
    date_joined = models.DateTimeField(default=timezone.now)

    objects = UserManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS: ClassVar[list[str]] = []

    class Meta:
        # Not "user" — that is a reserved word in Postgres and would need
        # quoting everywhere it appeared in raw SQL.
        db_table = "app_user"
        verbose_name = "User"
        verbose_name_plural = "Users"

    def __str__(self) -> str:
        return self.email

    @property
    def public_name(self) -> str:
        """The name shown publicly in the gallery.

        Falls back to the email's local part so someone who never set a display
        name is not published as their full address.
        """
        return self.display_name or self.email.split("@")[0]
