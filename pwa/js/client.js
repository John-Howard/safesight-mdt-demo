// Read-only SafeSight REST client. Functions take a session; errors are SafeSightError subclasses.
// Port of mdt/safesight_client.py. `fetch` is injected so tests (and main.js) control it.
//
// Rules that must hold (see docs/architecture.md, "Other traps"):
//  - never send a `format` query parameter;
//  - follow pagination `next` links by path + query only, on our own base URL, so the bearer
//    token cannot be sent to another host;
//  - on 401, refresh once, store the rotated tokens (and tell onTokens), and retry once.

import {
  AuthError,
  InvalidTokenError,
  NotFound,
  PermissionDenied,
  RateLimited,
  SafeSightError,
  ServerUnavailable,
} from "./errors.js";
import { normalizeUuid } from "./ids.js";
import { intersects, toGeoJSON } from "./geometry.js";

export const PAGE_SIZE = 200;
// How long a server stays marked as needing the scan before the AOI files endpoint is tried again.
export const AOI_FILES_RETRY_MS = 900_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const defaultNow = () => performance.now();

/**
 * @param {object} o
 * @param {string} o.baseUrl SafeSight origin (+ optional path prefix); trailing slashes are dropped
 * @param {{access: string, refresh: string}} o.tokens
 * @param {typeof fetch} o.fetch
 * @param {number} [o.timeoutMs] per-request timeout, until the response headers arrive
 * @param {(tokens: {access: string, refresh: string}) => void} [o.onTokens] called after a refresh
 * @param {() => number} [o.now] monotonic clock in ms (tests inject one)
 */
export function createSession({ baseUrl, tokens, fetch: fetchFn, timeoutMs, onTokens, now }) {
  return {
    baseUrl: String(baseUrl).replace(/\/+$/, ""),
    tokens: { access: tokens.access, refresh: tokens.refresh },
    fetch: fetchFn,
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    onTokens: onTokens ?? (() => {}),
    now: now ?? defaultNow,
  };
}

// ---- transport -----------------------------------------------------------------------

/** One fetch with a timeout. Network failure and timeout become ServerUnavailable(status null). */
async function send(transport, method, url, { headers, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), transport.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const doFetch = transport.fetch; // call unbound: window.fetch throws if `this` is not the window
  try {
    return await doFetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      credentials: "omit", // bearer tokens only; never ambient cookies
    });
  } catch (err) {
    throw new ServerUnavailable(`SafeSight unreachable: ${err?.name || "Error"}`, null, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

async function messageOf(response) {
  try {
    const body = await response.json();
    if (body && typeof body === "object") {
      for (const key of ["error", "detail"]) {
        if (body[key]) return String(body[key]);
      }
    }
  } catch {
    // fall through to the generic message
  }
  return `HTTP ${response.status}`;
}

async function raiseForStatus(response) {
  const { status } = response;
  if (status < 400) return;
  const message = await messageOf(response);
  if (status === 401) throw new AuthError(message);
  if (status === 403) throw new PermissionDenied(message);
  if (status === 404) throw new NotFound(message);
  if (status === 429) throw new RateLimited(message);
  if (status >= 500) throw new ServerUnavailable(message, status);
  throw new SafeSightError(message);
}

async function discard(response) {
  try {
    await response.body?.cancel();
  } catch {
    // nothing useful to do if the body cannot be cancelled
  }
}

async function postTokens(transport, url, payload, authMessage) {
  const response = await send(transport, "POST", url, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.status === 400 || response.status === 401) {
    await discard(response);
    throw new AuthError(authMessage);
  }
  await raiseForStatus(response);
  try {
    const body = await response.json();
    if (typeof body.access !== "string" || typeof body.refresh !== "string") throw new TypeError();
    return { access: body.access, refresh: body.refresh };
  } catch {
    throw new SafeSightError("Unexpected token response from SafeSight");
  }
}

function stripTrailingSlashes(url) {
  return String(url).replace(/\/+$/, "");
}

export function obtainTokens(baseUrl, username, password, { fetch: fetchFn, timeoutMs } = {}) {
  return postTokens(
    { fetch: fetchFn, timeoutMs },
    `${stripTrailingSlashes(baseUrl)}/api/token/`,
    { username, password },
    "Invalid username or password",
  );
}

/** Swap the refresh token for new ones. SafeSight rotates, so both are stored. */
export async function refreshTokens(session) {
  const fresh = await postTokens(
    session,
    `${session.baseUrl}/api/token/refresh/`,
    { refresh: session.tokens.refresh },
    "Session expired; sign in again",
  );
  session.tokens.access = fresh.access;
  session.tokens.refresh = fresh.refresh;
  session.onTokens({ access: fresh.access, refresh: fresh.refresh });
  return session.tokens;
}

/**
 * Read the `user_id` claim (a UUID) from the JWT payload.
 *
 * The signature is deliberately not verified: the token was just received from SafeSight over
 * our own connection, and the value only keys the local cache.
 */
export function userIdFromAccessToken(access) {
  const fail = (cause) =>
    new InvalidTokenError("SafeSight returned an access token with no readable user id", { cause });
  const parts = typeof access === "string" ? access.split(".") : [];
  if (parts.length !== 3) throw fail();
  let claim;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    claim = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))?.user_id;
  } catch (err) {
    throw fail(err);
  }
  const userId = normalizeUuid(claim);
  if (userId === null) throw fail();
  return userId;
}

function buildUrl(session, path, params) {
  let url = `${session.baseUrl}${path}`;
  const query = params ? new URLSearchParams(params).toString() : "";
  if (query) url += `${url.includes("?") ? "&" : "?"}${query}`;
  return url;
}

/** Authenticated request. One refresh and retry on 401, then map errors. Returns the Response. */
export async function request(session, method, path, { params } = {}) {
  const url = buildUrl(session, path, params);
  let refreshed = false;
  for (;;) {
    const response = await send(session, method, url, {
      headers: { Authorization: `Bearer ${session.tokens.access}` },
    });
    if (response.status === 401 && !refreshed) {
      await discard(response);
      await refreshTokens(session);
      refreshed = true;
      continue;
    }
    await raiseForStatus(response);
    return response;
  }
}

async function json(response) {
  try {
    return await response.json();
  } catch (err) {
    throw new ServerUnavailable("SafeSight returned invalid JSON", null, { cause: err });
  }
}

// ---- simple reads --------------------------------------------------------------------

export async function getAreasGeoJSON(session) {
  return json(await request(session, "GET", "/api/v1/areas-of-interest/geojson/"));
}

export async function getAreaFeature(session, aoiId) {
  const areas = await getAreasGeoJSON(session);
  for (const feature of areas?.features ?? []) {
    const props = feature.properties || {};
    if (String(props.id ?? feature.id) === String(aoiId)) return feature;
  }
  throw new NotFound("Area of interest not found");
}

export async function getFileDetail(session, fileId) {
  return json(await request(session, "GET", `/api/v1/files/${encodeURIComponent(fileId)}/`));
}

/** The file's bytes and its media type (lower-cased, parameters stripped). */
export async function downloadFile(session, fileId) {
  const response = await request(session, "GET", `/api/v1/files/${encodeURIComponent(fileId)}/download/`);
  let blob;
  try {
    blob = await response.blob();
  } catch (err) {
    throw new ServerUnavailable("Download interrupted", null, { cause: err });
  }
  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  return { blob, contentType };
}

// ---- pagination ----------------------------------------------------------------------

/** Follow `next` links only on our own base URL, so the bearer token cannot leak. */
function localPath(session, nextUrl) {
  let parts;
  let prefix;
  try {
    parts = new URL(nextUrl, `${session.baseUrl}/`);
    prefix = new URL(session.baseUrl).pathname.replace(/\/+$/, "");
  } catch (err) {
    throw new ServerUnavailable("SafeSight returned an invalid next link", null, { cause: err });
  }
  // A base URL with a path prefix: SafeSight's absolute next link already contains it.
  const path = prefix && parts.pathname.startsWith(`${prefix}/`) ? parts.pathname.slice(prefix.length) : parts.pathname;
  return `${path}${parts.search}`;
}

/** Each page's `results` value, following `next`. */
async function walk(session, path, params) {
  const pages = [];
  let nextPath = path;
  let nextParams = params;
  while (nextPath) {
    const body = await json(await request(session, "GET", nextPath, { params: nextParams }));
    pages.push(body?.results);
    nextPath = body?.next ? localPath(session, body.next) : null;
    nextParams = undefined;
  }
  return pages;
}

async function coveragePolygon(session, fileId) {
  const detail = await getFileDetail(session, fileId);
  return detail?.coverage_area_dual_crs?.epsg_4326 ?? null;
}

// ---- which files are in an AOI -------------------------------------------------------

// baseUrl -> session.now() when we learned the AOI files endpoint cannot be used (an old server,
// or one that does not report can_download). Only that verdict is stored, so a server that needs
// the scan is not probed, and does not log a 500, on every request. The entry expires after
// AOI_FILES_RETRY_MS and is dropped on read, so one transient 5xx does not pin a server to the
// scan, and an upgraded SafeSight is noticed without a reload of the app.
const unsupportedServers = new Map();

export function resetAoiFilesCache() {
  unsupportedServers.clear();
}

function markUnsupported(session) {
  unsupportedServers.set(session.baseUrl, session.now());
}

function isUnsupported(session) {
  const marked = unsupportedServers.get(session.baseUrl);
  if (marked === undefined) return false;
  if (session.now() - marked >= AOI_FILES_RETRY_MS) {
    unsupportedServers.delete(session.baseUrl);
    return false;
  }
  return true;
}

/**
 * Every result of the AOI files endpoint, or null when this server can't be used.
 *
 * null means the endpoint failed with a 5xx or 404 (SafeSight before #396), or its results lack
 * `can_download`. Network failures, auth, permission and rate-limit errors propagate. All pages
 * are read before anything is returned, so a failure on a later page falls back cleanly.
 */
async function fetchAoiFiles(session, aoiId) {
  const path = `/api/v1/areas-of-interest/${encodeURIComponent(aoiId)}/files/`;
  const results = [];
  try {
    for (const page of await walk(session, path, { page_size: PAGE_SIZE })) results.push(...(page || []));
  } catch (err) {
    if (err instanceof NotFound) return null;
    if (err instanceof ServerUnavailable && err.status !== null) return null;
    throw err; // includes a network failure: the scan would fail too, and the UI goes offline
  }
  // Without can_download a viewer's sync would attempt one doomed download per file, each a
  // denied row in SafeSight's FileAccessLog. The scan's can_download pre-check avoids that.
  if (results.length > 0 && !results.every((row) => row && "can_download" in row)) return null;
  return results;
}

function areaFileItem(row) {
  return {
    id: String(row.id),
    original_filename: row.original_filename ?? null,
    mime_type: row.mime_type ?? null,
    file_size: row.file_size ?? null,
    organization_name: row.organization_name ?? null,
    group_name: row.group_name ?? null,
    uploaded_at: row.uploaded_at ?? null,
    can_download: Boolean(row.can_download),
    geometry: toGeoJSON(row.location) || toGeoJSON(row.coverage_area),
  };
}

/** Client-side AOI membership: list the files, then intersect each with the AOI. */
async function scanAreaFiles(session, aoiGeometry) {
  const query = { is_published: "true", page_size: PAGE_SIZE };
  const rows = [];
  for (const page of await walk(session, "/api/v1/files/", query)) rows.push(...(page || []));

  const points = new Map();
  for (const page of await walk(session, "/api/v1/files/geojson/", query)) {
    for (const feature of page?.features ?? []) {
      const props = feature.properties || {};
      points.set(String(props.id || feature.id), {
        geometry: feature.geometry,
        can_download: props.can_download ?? true,
      });
    }
  }

  const items = [];
  for (const row of rows) {
    const fileId = String(row.id);
    let geometry;
    let canDownload;
    const point = points.get(fileId);
    if (point) {
      geometry = point.geometry;
      canDownload = point.can_download;
    } else if (row.has_location) {
      continue; // located, but SafeSight gave us no geometry for it
    } else {
      geometry = await coveragePolygon(session, fileId);
      canDownload = true;
    }
    if (!intersects(geometry, aoiGeometry)) continue;
    items.push({
      id: fileId,
      original_filename: row.original_filename ?? null,
      mime_type: row.mime_type ?? null,
      file_size: row.file_size ?? null,
      organization_name: row.organization_name ?? null,
      group_name: row.group_name ?? null,
      uploaded_at: row.uploaded_at ?? null,
      can_download: Boolean(canDownload),
      geometry,
    });
  }
  return items;
}

/**
 * The files whose point or coverage polygon intersects the AOI.
 *
 * Uses SafeSight's AOI files endpoint when it works and reports `can_download`, and otherwise
 * computes membership client-side (see docs/architecture.md). Never sends a `format` parameter.
 */
export async function listAreaFiles(session, aoiId, aoiGeometry) {
  if (!isUnsupported(session)) {
    const results = await fetchAoiFiles(session, aoiId);
    if (results !== null) {
      // An empty list cannot tell a server with can_download from one without, so it counts as
      // supported for this call only and nothing is remembered.
      return results.map(areaFileItem);
    }
    markUnsupported(session);
  }
  return scanAreaFiles(session, aoiGeometry);
}
