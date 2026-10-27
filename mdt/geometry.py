"""Normalise geometry to GeoJSON and test AOI membership. Never raises on bad input."""

import json
import logging
import re
from typing import Any, Optional

import shapely
from shapely import wkt
from shapely.geometry import shape

log = logging.getLogger(__name__)

_SRID_PREFIX = re.compile(r"^\s*SRID=\d+;", re.IGNORECASE)


def _to_shape(value: Any):
    """Return a non-empty shapely geometry, or None (with a warning) for bad input."""
    if value is None:
        return None
    try:
        if isinstance(value, dict):
            geom = shape(value)
        elif isinstance(value, str):
            geom = wkt.loads(_SRID_PREFIX.sub("", value))
        else:
            log.warning("Ignoring geometry of unsupported type %s", type(value).__name__)
            return None
    except Exception as exc:  # shapely raises several error types for malformed input
        log.warning("Ignoring malformed geometry: %s", exc)
        return None
    if geom.is_empty:
        log.warning("Ignoring empty geometry")
        return None
    return geom


def to_geojson(value: Any) -> Optional[dict]:
    """GeoJSON dict (returned as given once validated), WKT or EWKT -> GeoJSON dict."""
    geom = _to_shape(value)
    if geom is None:
        return None
    if isinstance(value, dict):
        return value
    return json.loads(shapely.to_geojson(geom))


def intersects(geometry: Any, aoi_geometry: Any) -> bool:
    geom = _to_shape(geometry)
    aoi = _to_shape(aoi_geometry)
    if geom is None or aoi is None:
        return False
    try:
        return bool(geom.intersects(aoi))
    except Exception as exc:
        log.warning("Geometry intersection failed: %s", exc)
        return False


_PROPERTIES = (
    "id",
    "original_filename",
    "mime_type",
    "file_size",
    "organization_name",
    "group_name",
    "uploaded_at",
)


def file_feature(item: dict) -> dict:
    """GeoJSON Feature for an iter_area_files item. Geometry may be null."""
    return {
        "type": "Feature",
        "id": item.get("id"),
        "geometry": to_geojson(item.get("geometry")),
        "properties": {key: item.get(key) for key in _PROPERTIES},
    }
