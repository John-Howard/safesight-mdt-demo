import logging

from mdt import geometry

POINT = {"type": "Point", "coordinates": [-1.25, 51.75]}


def test_none():
    assert geometry.to_geojson(None) is None


def test_geojson_dict_passthrough():
    assert geometry.to_geojson(POINT) == POINT


def test_wkt():
    assert geometry.to_geojson("POINT (-1.25 51.75)") == POINT


def test_ewkt_strips_srid():
    assert geometry.to_geojson("SRID=4326;POINT (-1.25 51.75)") == POINT


def test_ewkt_polygon():
    out = geometry.to_geojson("SRID=4326;POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))")
    assert out["type"] == "Polygon"
    assert out["coordinates"][0][0] == [0.0, 0.0]


def test_malformed_returns_none_and_warns(caplog):
    with caplog.at_level(logging.WARNING):
        assert geometry.to_geojson("POINT (oops") is None
        assert geometry.to_geojson({"type": "Nonsense"}) is None
        assert geometry.to_geojson(42) is None
        assert geometry.to_geojson("") is None
    assert "geometry" in caplog.text.lower()


def _item(**kw):
    base = {
        "id": "f1",
        "original_filename": "a.png",
        "mime_type": "image/png",
        "file_size": 10,
        "organization_name": "Org",
        "group_name": "Grp",
        "uploaded_at": "2026-01-01T00:00:00Z",
        "can_download": True,
        "geometry": POINT,
    }
    base.update(kw)
    return base


def test_file_feature():
    feat = geometry.file_feature(_item())
    assert feat["type"] == "Feature"
    assert feat["id"] == "f1"
    assert feat["geometry"] == POINT
    assert set(feat["properties"]) == {
        "id",
        "original_filename",
        "mime_type",
        "file_size",
        "organization_name",
        "group_name",
        "uploaded_at",
    }
    assert feat["properties"]["organization_name"] == "Org"


def test_file_feature_without_geometry_still_returned():
    feat = geometry.file_feature(_item(geometry=None))
    assert feat["geometry"] is None
    assert feat["id"] == "f1"


def test_file_feature_invalid_geometry_becomes_none():
    assert geometry.file_feature(_item(geometry="garbage"))["geometry"] is None


AOI_GEOM = {
    "type": "MultiPolygon",
    "coordinates": [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]],
}


def test_intersects_point_inside_and_outside():
    assert geometry.intersects({"type": "Point", "coordinates": [5, 5]}, AOI_GEOM) is True
    assert geometry.intersects({"type": "Point", "coordinates": [50, 5]}, AOI_GEOM) is False


def test_intersects_polygon_overlap():
    poly = {"type": "Polygon", "coordinates": [[[9, 9], [12, 9], [12, 12], [9, 12], [9, 9]]]}
    assert geometry.intersects(poly, AOI_GEOM) is True


def test_intersects_accepts_wkt_and_is_defensive(caplog):
    assert geometry.intersects("SRID=4326;POINT (5 5)", AOI_GEOM) is True
    assert geometry.intersects(None, AOI_GEOM) is False
    assert geometry.intersects(POINT, None) is False
    assert geometry.intersects("junk", AOI_GEOM) is False
    assert geometry.intersects({"type": "Bad"}, AOI_GEOM) is False
