"""How calibration refuses a request: an HTTP error with a translated message."""

from __future__ import annotations

from typing import NoReturn

from ninja.errors import HttpError

from api import i18n


def refuse_request(key: str, status: int = 409, **kwargs: object) -> NoReturn:
    raise HttpError(status, i18n.t(f"calibration_{key}", **kwargs))
