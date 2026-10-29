import { test } from "node:test";
import assert from "node:assert/strict";

import { parseWkt, toGeoJSON, intersects, fileFeature } from "../js/geometry.js";

const POINT = { type: "Point", coordinates: [-1.25, 51.75] };

// toGeoJSON warns on bad input; keep the test output clean and let tests assert on it.
function quietly(fn) {
  const original = console.warn;
  const calls = [];
  console.warn = (...args) => calls.push(args);
  try {
    return { result: fn(), warnings: calls };
  } finally {
    console.warn = original;
  }
}

const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const poly = (...rings) => ({ type: "Polygon", coordinates: rings });
const pt = (x, y) => ({ type: "Point", coordinates: [x, y] });
const line = (...coords) => ({ type: "LineString", coordinates: coords });
const AOI = {
  type: "MultiPolygon",
  coordinates: [[sq(0, 0, 10, 10)]],
};

// ---- toGeoJSON / parseWkt (port of tests/test_geometry.py) ---------------------------

test("toGeoJSON: null and undefined give null", () => {
  assert.equal(toGeoJSON(null), null);
  assert.equal(toGeoJSON(undefined), null);
});

test("toGeoJSON: a valid GeoJSON object is returned as given", () => {
  assert.equal(toGeoJSON(POINT), POINT);
});

test("toGeoJSON: WKT point", () => {
  assert.deepEqual(toGeoJSON("POINT (-1.25 51.75)"), POINT);
});

test("toGeoJSON: EWKT strips the SRID, case-insensitively", () => {
  assert.deepEqual(toGeoJSON("SRID=4326;POINT (-1.25 51.75)"), POINT);
  assert.deepEqual(toGeoJSON("srid=4326;point(-1.25 51.75)"), POINT);
});

test("toGeoJSON: EWKT polygon", () => {
  const out = toGeoJSON("SRID=4326;POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))");
  assert.equal(out.type, "Polygon");
  assert.deepEqual(out.coordinates[0][0], [0, 0]);
  assert.equal(out.coordinates[0].length, 5);
});

test("toGeoJSON: malformed input returns null and warns, never throws", () => {
  const { result, warnings } = quietly(() => [
    toGeoJSON("POINT (oops"),
    toGeoJSON({ type: "Nonsense" }),
    toGeoJSON(42),
    toGeoJSON(""),
  ]);
  assert.deepEqual(result, [null, null, null, null]);
  assert.equal(warnings.length, 4);
  assert.match(String(warnings[0][0]).toLowerCase(), /geometry/);
});

test("toGeoJSON: GeoJSON objects with bad or empty coordinates are rejected", () => {
  const bad = [
    { type: "Point" },
    { type: "Point", coordinates: [] },
    { type: "Point", coordinates: ["a", "b"] },
    { type: "Point", coordinates: [1] },
    { type: "Point", coordinates: [NaN, 1] },
    { type: "LineString", coordinates: [[0, 0]] },
    { type: "Polygon", coordinates: [] },
    { type: "Polygon", coordinates: [[[0, 0], [1, 1], [0, 0]]] },
    { type: "MultiPolygon", coordinates: [] },
    { type: "MultiPoint", coordinates: [] },
    { type: "GeometryCollection", geometries: [] },
    [],
  ];
  const { result } = quietly(() => bad.map(toGeoJSON));
  assert.deepEqual(result, bad.map(() => null));
});

test("toGeoJSON: 3D GeoJSON positions are accepted", () => {
  const p = { type: "Point", coordinates: [1, 2, 3] };
  assert.equal(toGeoJSON(p), p);
});

test("parseWkt: MULTIPOLYGON", () => {
  const out = parseWkt("SRID=4326;MULTIPOLYGON (((0 0, 4 0, 4 4, 0 4, 0 0), (1 1, 2 1, 2 2, 1 2, 1 1)), ((10 10, 11 10, 11 11, 10 10)))");
  assert.equal(out.type, "MultiPolygon");
  assert.equal(out.coordinates.length, 2);
  assert.equal(out.coordinates[0].length, 2); // outer ring plus a hole
  assert.deepEqual(out.coordinates[1][0][2], [11, 11]);
});

test("parseWkt: every supported type", () => {
  assert.deepEqual(parseWkt("MULTIPOINT ((1 2), (3 4))"), { type: "MultiPoint", coordinates: [[1, 2], [3, 4]] });
  assert.deepEqual(parseWkt("MULTIPOINT (1 2, 3 4)"), { type: "MultiPoint", coordinates: [[1, 2], [3, 4]] });
  assert.deepEqual(parseWkt("LINESTRING (0 0, 1 1, 2 0)"), line([0, 0], [1, 1], [2, 0]));
  assert.deepEqual(parseWkt("MULTILINESTRING ((0 0, 1 1), (5 5, 6 6))"), {
    type: "MultiLineString",
    coordinates: [[[0, 0], [1, 1]], [[5, 5], [6, 6]]],
  });
  assert.deepEqual(parseWkt("POLYGON ((0 0, 1 0, 1 1, 0 0))"), poly([[0, 0], [1, 0], [1, 1], [0, 0]]));
});

test("parseWkt: Z and M ordinates are dropped", () => {
  assert.deepEqual(parseWkt("POINT Z (1 2 3)"), pt(1, 2));
  assert.deepEqual(parseWkt("POINTZ(1 2 3)"), pt(1, 2));
  assert.deepEqual(parseWkt("POINT M (1 2 3)"), pt(1, 2));
  assert.deepEqual(parseWkt("POINT ZM (1 2 3 4)"), pt(1, 2));
  assert.deepEqual(parseWkt("SRID=4326;LINESTRING Z (0 0 5, 1 1 6)"), line([0, 0], [1, 1]));
  assert.deepEqual(parseWkt("POINT (1 2 3)"), pt(1, 2)); // unlabelled third ordinate
});

test("parseWkt: numbers in exponent form and extra whitespace", () => {
  assert.deepEqual(parseWkt("  POINT(  1e1   -2.5E-1 )  "), pt(10, -0.25));
});

test("parseWkt: EMPTY gives null", () => {
  for (const s of ["POINT EMPTY", "POLYGON EMPTY", "MULTIPOLYGON EMPTY", "SRID=4326;LINESTRING EMPTY"]) {
    assert.equal(parseWkt(s), null, s);
  }
});

test("parseWkt: malformed input gives null and never throws", () => {
  const bad = [
    "",
    "garbage",
    "POINT",
    "POINT (",
    "POINT (1)",
    "POINT (a b)",
    "POINT (1 2) extra",
    "POINT (1 2))",
    "POINT ((1 2",
    "POLYGON ((0 0, 1 0, 1 1))", // too few points
    "POLYGON ((0 0, 1 0, 1 1, 0 1))", // not closed
    "POLYGON (0 0, 1 0, 1 1, 0 0)", // missing ring parentheses
    "LINESTRING (0 0)",
    "CIRCLE (1 2)",
    "GEOMETRYCOLLECTION (POINT (1 2))",
    "POINT (1 2, 3 4)",
    "MULTIPOLYGON ((0 0, 1 1))",
    "POINT (NaN 1)",
    "POINT (Infinity 1)",
    "SRID=;POINT (1 2)",
    null,
    42,
    {},
  ];
  for (const s of bad) {
    assert.equal(parseWkt(s), null, String(s));
  }
});

// ---- fileFeature ---------------------------------------------------------------------

function item(overrides = {}) {
  return {
    id: "f1",
    original_filename: "a.png",
    mime_type: "image/png",
    file_size: 10,
    organization_name: "Org",
    group_name: "Grp",
    uploaded_at: "2026-01-01T00:00:00Z",
    can_download: true,
    geometry: POINT,
    ...overrides,
  };
}

test("fileFeature: Feature with the documented property list", () => {
  const feat = fileFeature(item());
  assert.equal(feat.type, "Feature");
  assert.equal(feat.id, "f1");
  assert.deepEqual(feat.geometry, POINT);
  assert.deepEqual(new Set(Object.keys(feat.properties)), new Set([
    "id", "original_filename", "mime_type", "file_size", "organization_name", "group_name", "uploaded_at",
  ]));
  assert.equal(feat.properties.organization_name, "Org");
});

test("fileFeature: null geometry is still returned", () => {
  const feat = fileFeature(item({ geometry: null }));
  assert.equal(feat.geometry, null);
  assert.equal(feat.id, "f1");
});

test("fileFeature: invalid geometry becomes null", () => {
  const { result } = quietly(() => fileFeature(item({ geometry: "garbage" })));
  assert.equal(result.geometry, null);
});

test("fileFeature: missing optional properties become null, not undefined", () => {
  const feat = fileFeature({ id: "x" });
  assert.equal(feat.properties.mime_type, null);
  assert.equal(feat.geometry, null);
});

// ---- intersects ----------------------------------------------------------------------

test("intersects: point inside and outside", () => {
  assert.equal(intersects(pt(5, 5), AOI), true);
  assert.equal(intersects(pt(50, 5), AOI), false);
});

test("intersects: polygon overlap", () => {
  assert.equal(intersects(poly(sq(9, 9, 12, 12)), AOI), true);
});

test("intersects: accepts WKT and is defensive", () => {
  const { result } = quietly(() => [
    intersects("SRID=4326;POINT (5 5)", AOI),
    intersects(null, AOI),
    intersects(POINT, null),
    intersects("junk", AOI),
    intersects({ type: "Bad" }, AOI),
  ]);
  assert.deepEqual(result, [true, false, false, false, false]);
});

test("intersects: point on the AOI edge and on a corner counts", () => {
  assert.equal(intersects(pt(0, 5), AOI), true);
  assert.equal(intersects(pt(10, 10), AOI), true);
  assert.equal(intersects(pt(5, 10), AOI), true);
});

test("intersects: point in a hole is outside, on the hole edge is touching", () => {
  const holey = poly(sq(0, 0, 10, 10), sq(4, 4, 6, 6));
  assert.equal(intersects(pt(5, 5), holey), false);
  assert.equal(intersects(pt(4, 5), holey), true);
  assert.equal(intersects(pt(2, 2), holey), true);
});

test("intersects: polygon wholly inside another, and wholly containing it", () => {
  const inner = poly(sq(2, 2, 3, 3));
  assert.equal(intersects(inner, AOI), true);
  assert.equal(intersects(AOI, inner), true);
});

test("intersects: disjoint polygons", () => {
  assert.equal(intersects(poly(sq(20, 20, 30, 30)), AOI), false);
});

test("intersects: polygons that only share an edge or a corner", () => {
  assert.equal(intersects(poly(sq(10, 0, 20, 10)), AOI), true);
  assert.equal(intersects(poly(sq(10, 10, 20, 20)), AOI), true);
});

test("intersects: crossing polygons with no vertex inside the other (a plus sign)", () => {
  const wide = poly(sq(0, 4, 10, 6));
  const tall = poly(sq(4, 0, 6, 10));
  assert.equal(intersects(wide, tall), true);
});

test("intersects: polygon inside another polygon's hole is disjoint", () => {
  const donut = poly(sq(0, 0, 10, 10), sq(3, 3, 7, 7));
  assert.equal(intersects(poly(sq(4, 4, 6, 6)), donut), false);
  assert.equal(intersects(donut, poly(sq(4, 4, 6, 6))), false);
});

test("intersects: polygon straddling a hole edge intersects", () => {
  const donut = poly(sq(0, 0, 10, 10), sq(3, 3, 7, 7));
  assert.equal(intersects(poly(sq(2, 4, 4, 6)), donut), true);
});

test("intersects: polygon that fills a hole exactly only touches the donut", () => {
  const donut = poly(sq(0, 0, 10, 10), sq(3, 3, 7, 7));
  assert.equal(intersects(poly(sq(3, 3, 7, 7)), donut), true);
});

test("intersects: lines against polygons", () => {
  assert.equal(intersects(line([-5, 5], [15, 5]), AOI), true); // crosses through
  assert.equal(intersects(line([2, 2], [3, 3]), AOI), true); // wholly inside
  assert.equal(intersects(line([-5, -5], [-1, -1]), AOI), false);
  assert.equal(intersects(line([-5, 0], [15, 0]), AOI), true); // runs along an edge (collinear)
  assert.equal(intersects(line([10, 10], [20, 20]), AOI), true); // touches a corner
  const donut = poly(sq(0, 0, 10, 10), sq(3, 3, 7, 7));
  assert.equal(intersects(line([4, 4], [6, 6]), donut), false); // wholly in the hole
});

test("intersects: line against line, including collinear overlap and near misses", () => {
  assert.equal(intersects(line([0, 0], [10, 10]), line([0, 10], [10, 0])), true);
  assert.equal(intersects(line([0, 0], [5, 0]), line([3, 0], [8, 0])), true); // overlap
  assert.equal(intersects(line([0, 0], [5, 0]), line([6, 0], [8, 0])), false); // collinear gap
  assert.equal(intersects(line([0, 0], [5, 0]), line([5, 0], [8, 3])), true); // endpoint touch
  assert.equal(intersects(line([0, 0], [5, 0]), line([0, 1], [5, 1])), false); // parallel
  assert.equal(intersects(line([0, 0], [1, 1]), line([2, 0], [3, 1])), false);
});

test("intersects: points against lines and points", () => {
  assert.equal(intersects(pt(1, 1), line([0, 0], [2, 2])), true);
  assert.equal(intersects(pt(1, 1.1), line([0, 0], [2, 2])), false);
  assert.equal(intersects(pt(3, 3), line([0, 0], [2, 2])), false); // collinear but beyond
  assert.equal(intersects(pt(1, 1), pt(1, 1)), true);
  assert.equal(intersects(pt(1, 1), pt(1, 2)), false);
});

test("intersects: multi-geometries in any pairing", () => {
  const mp = { type: "MultiPoint", coordinates: [[50, 50], [5, 5]] };
  assert.equal(intersects(mp, AOI), true);
  assert.equal(intersects({ type: "MultiPoint", coordinates: [[50, 50], [60, 60]] }, AOI), false);
  const ml = { type: "MultiLineString", coordinates: [[[50, 50], [60, 60]], [[-1, 5], [11, 5]]] };
  assert.equal(intersects(ml, AOI), true);
  assert.equal(intersects(AOI, ml), true);
  const mpoly = { type: "MultiPolygon", coordinates: [[sq(20, 20, 30, 30)].map((r) => r), [sq(8, 8, 12, 12)]] };
  assert.equal(intersects(mpoly, AOI), true);
  assert.equal(intersects(AOI, mpoly), true);
  const far = { type: "MultiPolygon", coordinates: [[sq(20, 20, 30, 30)], [sq(40, 40, 50, 50)]] };
  assert.equal(intersects(far, AOI), false);
  assert.equal(intersects(mp, mpoly), false);
  assert.equal(intersects(pt(5, 5), ml), true);
});

test("intersects: is symmetric across geometry kinds", () => {
  const kinds = [pt(5, 5), line([0, 0], [10, 10]), poly(sq(4, 4, 6, 6)), pt(20, 20), line([20, 20], [30, 30])];
  for (const a of kinds) {
    for (const b of kinds) {
      assert.equal(intersects(a, b), intersects(b, a), `${a.type} vs ${b.type}`);
    }
  }
});

test("intersects: real-world coordinates from the SafeSight fixtures", () => {
  const aoi = {
    type: "MultiPolygon",
    coordinates: [[[[-1.27, 51.747], [-1.245, 51.747], [-1.245, 51.759], [-1.27, 51.759], [-1.27, 51.747]]]],
  };
  assert.equal(intersects(pt(-1.26, 51.755), aoi), true);
  assert.equal(intersects(pt(-1.21, 51.76), aoi), false);
});
