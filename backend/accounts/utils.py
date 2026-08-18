"""Hooks allauth calls into."""

from accounts.models import User


def user_display(user: User) -> str:
    """The name allauth puts in its ``display`` field and its emails.

    Without this, allauth falls back to ``str(user)`` — the email address — so
    the UI would greet people by their full address.
    """
    return user.public_name
