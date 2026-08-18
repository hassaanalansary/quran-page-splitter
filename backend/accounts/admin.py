"""Admin for the custom user model.

``api/admin.py`` gets away with bare ``admin.site.register`` calls, but the user
model needs the real ``UserAdmin`` so passwords are hashed rather than stored as
whatever was typed into the form.
"""

from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from accounts.forms import UserChangeForm, UserCreationForm
from accounts.models import User


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    form = UserChangeForm
    add_form = UserCreationForm

    ordering = ("email",)
    list_display = ("email", "display_name", "is_active", "is_staff", "date_joined")
    list_filter = ("is_active", "is_staff", "is_superuser")
    search_fields = ("email", "display_name")
    readonly_fields = ("date_joined", "last_login")

    # Tuples rather than lists: ruff's RUF012 wants mutable class attributes
    # annotated ClassVar, but django-stubs declares these as instance variables
    # on ModelAdmin, so ClassVar would be an invalid override.
    fieldsets = (
        (None, {"fields": ("email", "password")}),
        ("Profile", {"fields": ("display_name",)}),
        ("Permissions", {"fields": ("is_active", "is_staff", "is_superuser", "groups", "user_permissions")}),
        ("Dates", {"fields": ("last_login", "date_joined")}),
    )
    add_fieldsets = ((None, {"classes": ("wide",), "fields": ("email", "display_name", "password1", "password2")}),)
