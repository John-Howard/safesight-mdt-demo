// Normalise geometry to GeoJSON and test AOI membership. Pure; never throws on bad input.
// Port of mdt/geometry.py with shapely replaced by a small 2D implementation.
// Intersection follows shapely's semantics: touching a boundary counts as intersecting.

const GEOJSON_TYPES = [
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
];

// ---- GeoJSON validation --------------------------------------------------------------

const isNumber = (n) => typeof n === "number" && Number.isFinite(n);
const isPosition = (p) => Array.isArray(p) && p.length >= 2 && p.every(isNumber);
const isLine = (l) => Array.isArray(l) && l.length >= 2 && l.every(isPosition);
// Rings must be closed and have at least 4 positions, as GeoJSON and PostGIS both require.
function isRing(r) {
  if (!Array.isArray(r) || r.length < 4 || !r.every(isPosition)) return false;
  const first = r[0];
  const last = r[r.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}
const isPolygon = (p) => Array.isArray(p) && p.length >= 1 && p.every(isRing);
const nonEmptyOf = (check) => (c) => Array.isArray(c) && c.length >= 1 && c.every(check);

const VALIDATORS = {
  Point: isPosition,
  MultiPoint: nonEmptyOf(isPosition),
  LineString: isLine,
  MultiLineString: nonEmptyOf(isLine),
  Polygon: isPolygon,
  MultiPolygon: nonEmptyOf(isPolygon),
};

function isValidGeometry(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!GEOJSON_TYPES.includes(value.type)) return false;
  return VALIDATORS[value.type](value.coordinates);
}

// ---- WKT / EWKT parsing --------------------------------------------------------------

const SRID_PREFIX = /^\s*SRID=\d+;/i;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const TOKEN = /\s*(\(|\)|,|[^\s(),]+)/y;

function tokenize(text) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  let consumed = 0;
  let match;
  while ((match = TOKEN.exec(text)) !== null) {
    tokens.push(match[1]);
    consumed = TOKEN.lastIndex;
  }
  // Only trailing whitespace may remain.
  if (text.slice(consumed).trim() !== "") return null;
  return tokens;
}

/**
 * Parse "( item, item, ... )" where an item is a coordinate (numbers) or a nested list.
 * Returns nested arrays of number arrays, advancing `cursor.i`; null on malformed input.
 */
function parseList(tokens, cursor) {
  if (tokens[cursor.i] !== "(") return null;
  cursor.i += 1;
  const items = [];
  for (;;) {
    const item = parseItem(tokens, cursor);
    if (item === null) return null;
    items.push(item);
    const next = tokens[cursor.i];
    cursor.i += 1;
    if (next === ",") continue;
    if (next === ")") return items;
    return null;
  }
}

function parseItem(tokens, cursor) {
  if (tokens[cursor.i] === "(") return parseList(tokens, cursor);
  const ordinates = [];
  while (cursor.i < tokens.length && NUMBER.test(tokens[cursor.i])) {
    ordinates.push(Number(tokens[cursor.i]));
    cursor.i += 1;
  }
  if (ordinates.length < 2 || ordinates.length > 4) return null;
  return ordinates.slice(0, 2); // 2D only: Z and M ordinates are ignored
}

const WKT_TYPES = {
  POINT: "Point",
  MULTIPOINT: "MultiPoint",
  LINESTRING: "LineString",
  MULTILINESTRING: "MultiLineString",
  POLYGON: "Polygon",
  MULTIPOLYGON: "MultiPolygon",
};
const DIMENSION_WORDS = ["Z", "M", "ZM"];

/** Split "POINTZ" into ["POINT", "Z"]; returns null for an unknown type word. */
function typeWord(word) {
  if (WKT_TYPES[word]) return { type: WKT_TYPES[word], dimension: false };
  for (const suffix of DIMENSION_WORDS) {
    const base = word.slice(0, -suffix.length);
    if (word.endsWith(suffix) && WKT_TYPES[base]) return { type: WKT_TYPES[base], dimension: true };
  }
  return null;
}

const isCoordinate = (c) => Array.isArray(c) && c.length === 2 && typeof c[0] === "number";
const isList = (c) => Array.isArray(c) && !isCoordinate(c);

/** Map the parsed nesting onto GeoJSON `coordinates` for the type, or null on a mismatch. */
function shapeCoordinates(type, items) {
  switch (type) {
    case "Point":
      return items.length === 1 && isCoordinate(items[0]) ? items[0] : null;
    case "MultiPoint": {
      // Both "(1 2, 3 4)" and "((1 2), (3 4))" are in use.
      const flat = items.map((i) => (isList(i) && i.length === 1 ? i[0] : i));
      return flat.every(isCoordinate) ? flat : null;
    }
    case "LineString":
      return items.every(isCoordinate) ? items : null;
    case "MultiLineString":
    case "Polygon":
      return items.every((i) => isList(i) && i.every(isCoordinate)) ? items : null;
    default: // MultiPolygon
      return items.every((poly) => isList(poly) && poly.every((r) => isList(r) && r.every(isCoordinate)))
        ? items
        : null;
  }
}

/** WKT or EWKT -> GeoJSON geometry, or null on any malformed input or EMPTY. Never throws. */
export function parseWkt(text) {
  if (typeof text !== "string") return null;
  try {
    const tokens = tokenize(text.replace(SRID_PREFIX, ""));
    if (tokens === null || tokens.length === 0) return null;
    const head = typeWord(tokens[0].toUpperCase());
    if (head === null) return null;
    let i = 1;
    if (DIMENSION_WORDS.includes((tokens[i] || "").toUpperCase())) i += 1;
    if ((tokens[i] || "").toUpperCase() === "EMPTY") return null;
    const cursor = { i };
    const items = parseList(tokens, cursor);
    if (items === null || cursor.i !== tokens.length) return null;
    const coordinates = shapeCoordinates(head.type, items);
    if (coordinates === null) return null;
    const geometry = { type: head.type, coordinates };
    return isValidGeometry(geometry) ? geometry : null;
  } catch {
    return null;
  }
}

/** GeoJSON object (returned as given once validated), WKT or EWKT -> GeoJSON, else null. */
export function toGeoJSON(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const parsed = parseWkt(value);
    if (parsed === null) console.warn("Ignoring malformed or empty geometry");
    return parsed;
  }
  if (typeof value === "object" && isValidGeometry(value)) return value;
  console.warn("Ignoring malformed geometry of unsupported shape");
  return null;
}

// ---- intersection --------------------------------------------------------------------

/** Break any geometry into points, lines (arrays of positions) and polygons (arrays of rings). */
function decompose(geometry) {
  const parts = { points: [], lines: [], polygons: [] };
  const { type, coordinates: c } = geometry;
  if (type === "Point") parts.points.push(c);
  else if (type === "MultiPoint") parts.points.push(...c);
  else if (type === "LineString") parts.lines.push(c);
  else if (type === "MultiLineString") parts.lines.push(...c);
  else if (type === "Polygon") parts.polygons.push(c);
  else parts.polygons.push(...c);
  return parts;
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function onSegment(p, a, b) {
  if (cross(a, b, p) !== 0) return false;
  return (
    p[0] >= Math.min(a[0], b[0]) &&
    p[0] <= Math.max(a[0], b[0]) &&
    p[1] >= Math.min(a[1], b[1]) &&
    p[1] <= Math.max(a[1], b[1])
  );
}

/** Do closed segments a-b and c-d share any point (crossing, touching or collinear overlap)? */
function segmentsIntersect(a, b, c, d) {
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d);
}

const OUTSIDE = 0;
const INSIDE = 1;
const BOUNDARY = 2;

/** Where is `p` relative to one ring: ray casting, with an explicit on-boundary check. */
function locateInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[j];
    const b = ring[i];
    if (onSegment(p, a, b)) return BOUNDARY;
    if (a[1] > p[1] !== b[1] > p[1]) {
      const xAtY = a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (p[0] < xAtY) inside = !inside;
    }
  }
  return inside ? INSIDE : OUTSIDE;
}

/** Where is `p` relative to a polygon (outer ring first, then holes)? */
function locateInPolygon(p, rings) {
  const outer = locateInRing(p, rings[0]);
  if (outer !== INSIDE) return outer;
  for (let i = 1; i < rings.length; i += 1) {
    const hole = locateInRing(p, rings[i]);
    if (hole === BOUNDARY) return BOUNDARY;
    if (hole === INSIDE) return OUTSIDE;
  }
  return INSIDE;
}

const touchesPolygon = (p, rings) => locateInPolygon(p, rings) !== OUTSIDE;

function pointOnLine(p, line) {
  for (let i = 1; i < line.length; i += 1) {
    if (onSegment(p, line[i - 1], line[i])) return true;
  }
  return false;
}

function linesIntersect(a, b) {
  for (let i = 1; i < a.length; i += 1) {
    for (let j = 1; j < b.length; j += 1) {
      if (segmentsIntersect(a[i - 1], a[i], b[j - 1], b[j])) return true;
    }
  }
  return false;
}

function lineCrossesRings(line, rings) {
  return rings.some((ring) => linesIntersect(line, ring));
}

function linePolygon(line, rings) {
  if (lineCrossesRings(line, rings)) return true;
  // No edge contact: the line is wholly inside the polygon or wholly outside it.
  return touchesPolygon(line[0], rings);
}

function polygonPolygon(a, b) {
  for (const ringA of a) {
    if (lineCrossesRings(ringA, b)) return true;
  }
  // No edges meet: one polygon is wholly inside the other (and not in a hole), or they are apart.
  return touchesPolygon(a[0][0], b) || touchesPolygon(b[0][0], a);
}

function anyPair(listA, listB, test) {
  return listA.some((x) => listB.some((y) => test(x, y)));
}

function partsIntersect(a, b) {
  const pointEq = (p, q) => p[0] === q[0] && p[1] === q[1];
  return (
    anyPair(a.points, b.points, pointEq) ||
    anyPair(a.points, b.lines, pointOnLine) ||
    anyPair(b.points, a.lines, pointOnLine) ||
    anyPair(a.points, b.polygons, touchesPolygon) ||
    anyPair(b.points, a.polygons, touchesPolygon) ||
    anyPair(a.lines, b.lines, linesIntersect) ||
    anyPair(a.lines, b.polygons, linePolygon) ||
    anyPair(b.lines, a.polygons, linePolygon) ||
    anyPair(a.polygons, b.polygons, polygonPolygon)
  );
}

/** Do two geometries (GeoJSON or WKT) share any point? False for missing or invalid input. */
export function intersects(a, b) {
  const geomA = toGeoJSON(a);
  const geomB = toGeoJSON(b);
  if (geomA === null || geomB === null) return false;
  try {
    return partsIntersect(decompose(geomA), decompose(geomB));
  } catch (err) {
    console.warn("Geometry intersection failed:", err);
    return false;
  }
}

// ---- file features -------------------------------------------------------------------

const PROPERTIES = [
  "id",
  "original_filename",
  "mime_type",
  "file_size",
  "organization_name",
  "group_name",
  "uploaded_at",
];

/** GeoJSON Feature for an area-file item. Geometry may be null. */
export function fileFeature(item) {
  const properties = {};
  for (const key of PROPERTIES) properties[key] = item[key] ?? null;
  return {
    type: "Feature",
    id: item.id ?? null,
    geometry: toGeoJSON(item.geometry),
    properties,
  };
}
