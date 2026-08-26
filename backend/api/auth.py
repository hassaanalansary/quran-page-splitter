"""Resolving the caller.

Django types ``request.user`` as ``AbstractBaseUser | AnonymousUser`` because in
general it may be either. Every route that reaches a service is behind
``django_auth`` (see ``api/api.py``), so within those the user is always a real
account — ``current_user`` narrows the type and fails loudly if that assumption
is ever broken by a route registered with ``auth=None`` by mistake.
"""

from django.http import HttpRequest
from ninja.errors import HttpError

from accounts.models import User
from api import i18n


def current_user(request: HttpRequest) -> User:
    """The signed-in account, or 401."""
    user = request.user
    if not isinstance(user, User) or not user.is_authenticated:
        raise HttpError(401, i18n.t("not_authenticated"))
    return user


def optional_user(request: HttpRequest) -> User | None:
    """The signed-in account, or ``None`` for an anonymous visitor.

    For the ``auth=None`` gallery routes, where being signed out is ordinary:
    anyone may browse and download published mushafs. Services still receive the
    user so an owner viewing their own unpublished mushaf through a gallery URL
    is handled by the same check as everywhere else.
    """
    user = request.user
    return user if isinstance(user, User) and user.is_authenticated else None
