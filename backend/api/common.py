"""Shared API schemas reused across multiple view modules."""

from ninja import Schema
from pydantic import Field


class RectSchema(Schema):
    """A bounding box / crop rectangle in original-image pixel coordinates."""

    x: int = Field(ge=0)
    y: int = Field(ge=0)
    w: int = Field(ge=1)
    h: int = Field(ge=1)
