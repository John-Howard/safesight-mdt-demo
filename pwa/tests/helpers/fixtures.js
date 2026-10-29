// Shared constants and builders: the JS counterpart of tests/conftest.py.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { reply } from "./fake-fetch.js";

export const BASE = "http://safesight.test";
export const AOI = "11111111-1111-4111-8111-111111111111";
export const FILE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const FILE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const FILE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const USER_A = "aaaa0000-0000-4000-8000-00000000000a";
export const USER_B = "bbbb0000-0000-4000-8000-00000000000b";

export const AREAS_URL = `${BASE}/api/v1/areas-of-interest/geojson/`;
// MultiPolygon covering roughly (-1.3 51.7) to (-1.2 51.8)
export const AREA_GEOMETRY = {
  type: "MultiPolygon",
  coordinates: [[[[-1.3, 51.7], [-1.2, 51.7], [-1.2, 51.8], [-1.3, 51.8], [-1.3, 51.7]]]],
};
export const COVERAGE = {
  type: "Polygon",
  coordinates: [[[-1.26, 51.74], [-1.25, 51.74], [-1.25, 51.75], [-1.26, 51.75], [-1.26, 51.74]]],
};

export function loadFixture(name) {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Unsigned JWT-shaped token; the PWA only reads the payload. */
export function makeJwt(userId = USER_A, claims = {}) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const payload = { ...claims };
  if (userId !== null) payload.user_id = userId;
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

export function fileItem(id, o = {}) {
  const has = (key) => Object.hasOwn(o, key);
  return {
    id,
    original_filename: o.name ?? `${id.slice(0, 4)}.png`,
    mime_type: o.mime ?? "image/png",
    file_size: o.size ?? 5,
    point: has("point") ? o.point : [-1.25, 51.75],
    coverage: o.coverage ?? null,
    can_download: o.canDownload ?? true,
  };
}

export function mockArea(fake, { aoiId = AOI, name = "Zone" } = {}) {
  const feature = {
    type: "Feature",
    id: aoiId,
    geometry: AREA_GEOMETRY,
    properties: { id: aoiId, name },
  };
  fake.on("GET", AREAS_URL, reply({ type: "FeatureCollection", features: [feature] }));
}

export const aoiFilesUrl = (aoiId = AOI) => `${BASE}/api/v1/areas-of-interest/${aoiId}/files/`;

/**
 * Register the listing endpoints for the given fileItem()s. The AOI files endpoint answers 500
 * (a server without the fix), so the client falls back to the scan these routes describe.
 */
export function mockListing(fake, ...items) {
  fake.on("GET", aoiFilesUrl(), reply({}, 500));
  const results = [];
  const features = [];
  for (const it of items) {
    results.push({
      id: it.id,
      original_filename: it.original_filename,
      mime_type: it.mime_type,
      file_size: it.file_size,
      organization_name: "Org",
      group_name: null,
      uploaded_at: "2026-01-01T00:00:00Z",
      has_location: it.point !== null,
    });
    if (it.point !== null) {
      features.push({
        type: "Feature",
        id: it.id,
        geometry: { type: "Point", coordinates: [...it.point] },
        properties: { id: it.id, can_download: it.can_download },
      });
      continue;
    }
    const dual = it.coverage ? { epsg_4326: it.coverage } : null;
    fake.on("GET", `${BASE}/api/v1/files/${it.id}/`, reply({ coverage_area_dual_crs: dual }));
  }
  fake.on(
    "GET",
    `${BASE}/api/v1/files/geojson/`,
    reply({
      count: features.length,
      next: null,
      results: { type: "FeatureCollection", features },
    }),
  );
  fake.on("GET", `${BASE}/api/v1/files/`, reply({ count: results.length, next: null, results }));
}
