// SafeSight MDT front end: the only module that touches `document`. Vanilla JS.
// Every server-supplied string reaches the DOM through textContent / createElement, never
// innerHTML (filenames come from other organisations).
//
// Data flow: client.js talks to SafeSight directly over CORS, sync.js copies files into the
// IndexedDB store, and every screen falls back to the stored manifests when SafeSight cannot be
// reached. The Leaflet global `L` comes from vendor/leaflet.js, loaded by index.html.

import { DEFAULTS } from "../config.js";
import { loadAuth, rememberedBaseUrl, saveTokens, signIn, signOut } from "./auth.js";
import { createSession, getAreaFeature, getAreasGeoJSON, listAreaFiles } from "./client.js";
import { AuthError, SafeSightError, ServerUnavailable } from "./errors.js";
import { fileFeature } from "./geometry.js";
import { normalizeUuid } from "./ids.js";
import { createMemoryStore, isDownloaded, openIdbStore } from "./store.js";
import { syncArea } from "./sync.js";

const STATUS = {
  downloaded: { label: "Synced", badge: "is-success", color: "#2e9e5b" },
  not_synced: { label: "Not synced", badge: "is-info is-light", color: "#3a78d8" },
  denied: { label: "Denied", badge: "is-warning", color: "#e08a00" },
  failed: { label: "Failed", badge: "is-danger", color: "#d23f3f" },
};
const INLINE_IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const PDF = "application/pdf";
const TEXT = "text/plain";
const OCTET_STREAM = "application/octet-stream";
const TEXT_PREVIEW_BYTES = 1024 * 1024;

const $ = (id) => document.getElementById(id);
const state = {
  auth: null,
  session: null,
  store: null,
  storeIsVolatile: false,
  aoiId: null,
  areas: new Map(), // id -> feature, from the last live area list
  hasCache: false,
  files: [],
  offline: false,
  busy: false,
  layers: new Map(),
  previewToken: 0,
  previewUrls: [],
  persisted: false,
  map: null,
  aoiLayer: null,
  fileLayer: null,
};

// ---- DOM helpers -----------------------------------------------------------------------

function el(tag, opts, children) {
  const node = document.createElement(tag);
  const o = opts || {};
  if (o.cls) node.className = o.cls;
  if (o.text !== undefined && o.text !== null) node.textContent = String(o.text);
  if (o.attrs) for (const [k, v] of Object.entries(o.attrs)) node.setAttribute(k, v);
  if (o.on) for (const [k, fn] of Object.entries(o.on)) node.addEventListener(k, fn);
  for (const child of children || []) node.appendChild(child);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function formatSize(bytes) {
  if (typeof bytes !== "number") return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

const baseMime = (value) => String(value || "").split(";")[0].trim().toLowerCase();
const errorText = (err) => (err && err.message) || "Unexpected error";

// ---- views -----------------------------------------------------------------------------

function showSignIn(message) {
  $("map-view").hidden = true;
  $("signin-view").hidden = false;
  $("base-url").value = rememberedBaseUrl() || DEFAULTS.baseUrl;
  $("password").value = "";
  $("signin-origin").textContent = `This app's origin is ${location.origin}. SafeSight must list it in CORS_ALLOWED_ORIGINS.`;
  showSignInError(message || "");
  const empty = $("base-url").value === "" ? $("base-url") : $("username");
  empty.focus();
}

function showSignInError(message) {
  const box = $("signin-error");
  box.hidden = !message;
  box.textContent = message || "";
}

function signInMessage(err) {
  if (err instanceof AuthError) return err.message;
  if (err instanceof ServerUnavailable) {
    // fetch() rejects with a TypeError for DNS and TLS failures, a down server, mixed content,
    // and a CORS refusal alike; the browser does not say which.
    if (err.cause instanceof TypeError) {
      return `Could not reach SafeSight. Check the URL, that the server is up, and that this app's origin (${location.origin}) is in SafeSight's CORS_ALLOWED_ORIGINS.`;
    }
    if (err.status !== null) return `SafeSight returned an error (HTTP ${err.status}). Try again shortly.`;
    return "SafeSight did not answer in time. Check the URL and your connection.";
  }
  return errorText(err);
}

async function onSignIn(event) {
  event.preventDefault();
  const button = $("signin-btn");
  button.disabled = true;
  button.classList.add("is-loading");
  showSignInError("");
  try {
    const auth = await signIn({
      baseUrl: $("base-url").value,
      username: $("username").value.trim(),
      password: $("password").value,
      fetch: (...args) => window.fetch(...args),
      timeoutMs: DEFAULTS.timeoutMs,
    });
    $("password").value = "";
    showMap(auth);
    requestPersistence();
  } catch (err) {
    showSignInError(signInMessage(err));
  } finally {
    button.disabled = false;
    button.classList.remove("is-loading");
  }
}

function onSignOut() {
  signOut(); // keeps the cached files on this device
  teardownSession();
  showSignIn("");
}

/** SafeSight refused the tokens for good: back to sign-in, cache untouched. */
function handleAuthFailure() {
  signOut();
  teardownSession();
  showSignIn("Your session has expired. Sign in again.");
}

function teardownSession() {
  state.auth = null;
  state.session = null;
  state.aoiId = null;
  state.areas.clear();
  state.files = [];
  state.hasCache = false;
  closePreview();
  if (state.fileLayer) state.fileLayer.clearLayers();
  state.layers.clear();
  drawArea(null);
  clear($("areas"));
  clear($("files"));
  $("files-section").hidden = true;
}

function showMap(auth) {
  state.auth = auth;
  state.session = createSession({
    baseUrl: auth.baseUrl,
    tokens: auth.tokens,
    fetch: (...args) => window.fetch(...args),
    timeoutMs: DEFAULTS.timeoutMs,
    onTokens: (tokens) => saveTokens(tokens),
  });
  $("signin-view").hidden = true;
  $("map-view").hidden = false;
  $("user-name").textContent = auth.username;
  ensureMap();
  state.map.invalidateSize();
  loadAreas();
  updateStorage();
}

// ---- online / offline indicator ----------------------------------------------------------

function setOffline(offline) {
  state.offline = Boolean(offline);
  const tag = $("conn");
  tag.textContent = state.offline ? "Offline (cached)" : "Online";
  tag.className = `tag ${state.offline ? "is-warning" : "is-success"}`;
  refreshButtons();
}

function refreshButtons() {
  $("sync-btn").disabled = state.offline || state.busy;
  $("delete-btn").hidden = !state.hasCache;
  $("delete-btn").disabled = state.busy;
}

/** SafeSight is down or unreachable (network failure, timeout, 5xx): use the stored copy. */
const isUnreachable = (err) => err instanceof ServerUnavailable;
const knownOffline = () => navigator.onLine === false;

// ---- map -------------------------------------------------------------------------------

function ensureMap() {
  if (state.map) return;
  state.map = L.map("map").setView([51.75, -1.26], 12);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    // CORS-mode requests give the service worker cacheable (non-opaque) tile responses.
    crossOrigin: true,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(state.map);
  state.fileLayer = L.layerGroup().addTo(state.map);
}

const colorFor = (status) => (STATUS[status] || STATUS.not_synced).color;

function drawArea(geometry) {
  if (!state.map) return;
  if (state.aoiLayer) state.map.removeLayer(state.aoiLayer);
  state.aoiLayer = null;
  if (!geometry) return;
  state.aoiLayer = L.geoJSON(geometry, {
    style: { color: "#1f2d3d", weight: 2, dashArray: "6 4", fillColor: "#3a78d8", fillOpacity: 0.07 },
    interactive: false,
  }).addTo(state.map);
  state.map.fitBounds(state.aoiLayer.getBounds(), { padding: [30, 30] });
}

function popupFor(file) {
  return el("div", {}, [
    el("div", { cls: "popup-name", text: file.original_filename || file.id }),
    el("button", {
      cls: "button is-small is-link",
      text: "Open",
      attrs: { type: "button" },
      on: { click: () => openPreview(file) },
    }),
  ]);
}

function layerFor(file) {
  const geometry = file.feature && file.feature.geometry;
  if (!geometry) return null;
  const color = colorFor(file.status);
  const layer = L.geoJSON(geometry, {
    pointToLayer: (_f, latlng) =>
      L.circleMarker(latlng, { radius: 9, color: "#ffffff", weight: 2, fillColor: color, fillOpacity: 0.95 }),
    style: { color, weight: 2, fillColor: color, fillOpacity: 0.15 },
  });
  layer.bindPopup(popupFor(file));
  return layer;
}

function drawFiles() {
  state.fileLayer.clearLayers();
  state.layers.clear();
  for (const file of state.files) {
    const layer = layerFor(file);
    if (!layer) continue;
    state.fileLayer.addLayer(layer);
    state.layers.set(file.id, layer);
  }
}

function focusFile(file) {
  const layer = state.layers.get(file.id);
  if (!layer) return;
  state.map.fitBounds(layer.getBounds(), { maxZoom: 17, padding: [60, 60] });
  layer.openPopup();
}

// ---- area list ---------------------------------------------------------------------------

function renderAreas(features) {
  const list = $("areas");
  clear(list);
  $("areas-empty").hidden = features.length > 0;
  $("areas-empty").textContent = "No areas available.";
  for (const feature of features) {
    const props = feature.properties || {};
    const id = props.id || feature.id;
    const sub = [props.organization_name, props.group_name].filter(Boolean).join(" / ");
    const button = el(
      "button",
      {
        cls: `item-btn${id === state.aoiId ? " is-active" : ""}`,
        attrs: { type: "button", "data-aoi": id },
        on: { click: () => selectArea(id, props.name, feature.geometry) },
      },
      [
        el("span", { cls: "item-main" }, [
          el("span", { cls: "item-name", text: props.name || id }),
          el("span", { cls: "item-meta", text: sub }),
        ]),
      ],
    );
    list.appendChild(el("li", {}, [button]));
  }
}

/** The offline area list: one feature per stored manifest. */
async function cachedAreaFeatures() {
  const manifests = await state.store.listManifests(state.auth.userId);
  const features = manifests.map((manifest) => {
    const area = manifest.area || {};
    return {
      type: "Feature",
      id: manifest.aoi_id,
      geometry: area.geometry || null,
      properties: { id: manifest.aoi_id, name: area.name || manifest.aoi_id },
    };
  });
  return features.sort((a, b) => String(a.properties.name).localeCompare(String(b.properties.name)));
}

async function loadAreas() {
  const session = state.session;
  try {
    if (knownOffline()) throw new ServerUnavailable("Offline", null);
    const data = await getAreasGeoJSON(session);
    if (session !== state.session) return;
    setOffline(false);
    const features = data.features || [];
    state.areas = new Map(features.map((f) => [String((f.properties || {}).id ?? f.id), f]));
    renderAreas(features);
  } catch (err) {
    if (session !== state.session) return;
    if (err instanceof AuthError) return handleAuthFailure();
    if (isUnreachable(err)) {
      setOffline(true);
      renderAreas(await cachedAreaFeatures());
      return;
    }
    renderAreas([]);
    $("areas-empty").hidden = false;
    $("areas-empty").textContent = errorText(err);
  }
}

// ---- file list ---------------------------------------------------------------------------

function badge(status) {
  const info = STATUS[status] || STATUS.not_synced;
  return el("span", { cls: `tag ${info.badge}`, text: info.label });
}

function renderFiles() {
  const list = $("files");
  clear(list);
  const note = $("files-note");
  note.hidden = false;
  if (state.offline) note.textContent = "SafeSight is unreachable. Showing cached data.";
  else if (state.files.length === 0) note.textContent = "No files in this area.";
  else note.hidden = true;

  for (const file of state.files) {
    const meta = [file.mime_type, formatSize(file.file_size)].filter(Boolean).join(" · ");
    const row = el(
      "button",
      {
        cls: "item-btn",
        attrs: { type: "button", title: file.reason || "" },
        on: {
          click: () => {
            focusFile(file);
            openPreview(file);
          },
        },
      },
      [
        el("span", { cls: "item-main" }, [
          el("span", { cls: "item-name", text: file.original_filename || file.id }),
          el("span", { cls: "item-meta", text: meta }),
        ]),
        badge(file.status),
      ],
    );
    list.appendChild(el("li", {}, [row]));
  }
}

const fileView = (entry) => ({
  id: entry.id,
  original_filename: entry.original_filename,
  mime_type: entry.mime_type,
  file_size: entry.file_size,
  status: entry.status,
  reason: entry.reason ?? null,
  feature: entry.feature ?? null,
});

const offlinePayload = (manifest) => ({
  offline: true,
  cached: true,
  area: manifest.area,
  files: Object.values(manifest.files).map(fileView),
});

async function liveView(item, manifest, aoiId) {
  let status = "not_synced";
  let reason = null;
  const { store, auth } = state;
  if (await isDownloaded(store, auth.userId, manifest, aoiId, item)) {
    status = "downloaded";
  } else if (!item.can_download) {
    status = "denied";
    reason = "Your role cannot download this file";
  } else if (manifest) {
    const previous = manifest.files[item.id];
    if (previous && (previous.status === "denied" || previous.status === "failed")) {
      status = previous.status;
      reason = previous.reason ?? null;
    }
  }
  return {
    id: item.id,
    original_filename: item.original_filename,
    mime_type: item.mime_type,
    file_size: item.file_size,
    status,
    reason,
    feature: fileFeature(item),
  };
}

/** Live files merged with what is stored; the stored manifest alone when SafeSight is out of reach. */
async function fetchAreaFiles(aoiId) {
  const { store, auth, session } = state;
  const manifest = await store.getManifest(auth.userId, aoiId);
  try {
    if (knownOffline()) throw new ServerUnavailable("Offline", null);
    // The area list was fetched moments ago; ask again only for an area it did not contain.
    const areaFeature = state.areas.get(String(aoiId)) ?? (await getAreaFeature(session, aoiId));
    const items = await listAreaFiles(session, aoiId, areaFeature.geometry);
    const usable = items.filter((item) => normalizeUuid(item.id) !== null);
    const files = [];
    for (const item of usable) files.push(await liveView(item, manifest, aoiId));
    const area = { name: (areaFeature.properties || {}).name, geometry: areaFeature.geometry };
    return { offline: false, cached: manifest !== null, area, files };
  } catch (err) {
    if (!isUnreachable(err)) throw err;
    if (manifest === null) {
      throw new SafeSightError("SafeSight is unreachable and this area has not been synced on this device.");
    }
    return offlinePayload(manifest);
  }
}

async function loadFiles(aoiId, haveGeometry) {
  $("files-note").hidden = false;
  $("files-note").textContent = "Loading files…";
  const session = state.session;
  try {
    const data = await fetchAreaFiles(aoiId);
    if (aoiId !== state.aoiId || session !== state.session) return; // user moved on meanwhile
    setOffline(data.offline);
    state.hasCache = data.cached;
    state.files = data.files || [];
    if (data.area && data.area.geometry && !haveGeometry) drawArea(data.area.geometry);
    drawFiles();
    renderFiles();
    refreshButtons();
  } catch (err) {
    if (session !== state.session) return;
    if (err instanceof AuthError) return handleAuthFailure();
    if (aoiId !== state.aoiId) return;
    state.files = [];
    drawFiles();
    renderFiles();
    $("files-note").hidden = false;
    $("files-note").textContent = errorText(err);
  }
}

async function selectArea(aoiId, name, geometry) {
  state.aoiId = aoiId;
  state.hasCache = false;
  closePreview();
  $("files-section").hidden = false;
  $("area-name").textContent = name || aoiId;
  $("sync-result").hidden = true;
  for (const btn of document.querySelectorAll("#areas .item-btn")) {
    btn.classList.toggle("is-active", btn.getAttribute("data-aoi") === aoiId);
  }
  refreshButtons();
  drawArea(geometry);
  await loadFiles(aoiId, Boolean(geometry));
}

// ---- sync and delete ---------------------------------------------------------------------

async function runSync() {
  if (!state.aoiId || state.busy) return;
  const { aoiId, session, store, auth } = state;
  const button = $("sync-btn");
  const result = $("sync-result");
  state.busy = true;
  refreshButtons();
  button.classList.add("is-loading");
  result.hidden = false;
  result.className = "notification is-light is-size-7";
  result.textContent = "Syncing…";
  try {
    const s = await syncArea({
      session,
      store,
      userId: auth.userId,
      aoiId,
      maxBytes: DEFAULTS.maxSyncBytes,
      onProgress: ({ done, total, current }) => {
        result.textContent = current === null ? "Syncing…" : `Syncing ${done + 1}/${total}…`;
      },
    });
    result.textContent =
      `Downloaded ${s.downloaded}, skipped ${s.skipped}, denied ${s.denied}, failed ${s.failed}` +
      ` (of ${s.total} files, ${formatSize(s.bytes)}).`;
    result.classList.add(s.failed > 0 ? "is-warning" : "is-success");
    if (aoiId === state.aoiId) await loadFiles(aoiId, true);
  } catch (err) {
    if (err instanceof AuthError) return handleAuthFailure();
    result.textContent = isUnreachable(err)
      ? "Sync stopped: SafeSight is unreachable. Files downloaded so far are kept."
      : `Sync failed: ${errorText(err)}`;
    result.classList.add("is-danger");
    if (isUnreachable(err)) setOffline(true);
    if (aoiId === state.aoiId) await loadFiles(aoiId, true);
  } finally {
    state.busy = false;
    button.classList.remove("is-loading");
    refreshButtons();
    updateStorage();
  }
}

async function deleteCachedArea() {
  if (!state.aoiId || state.busy) return;
  const aoiId = state.aoiId;
  const name = $("area-name").textContent || "this area";
  if (!window.confirm(`Delete the cached copy of "${name}" from this device? Files can be synced again while online.`)) {
    return;
  }
  try {
    await state.store.deleteArea(state.auth.userId, aoiId);
  } catch (err) {
    $("sync-result").hidden = false;
    $("sync-result").className = "notification is-light is-size-7 is-danger";
    $("sync-result").textContent = `Could not delete: ${errorText(err)}`;
    return;
  }
  closePreview();
  $("sync-result").hidden = true;
  updateStorage();
  if (!state.offline) {
    await loadFiles(aoiId, true);
    return;
  }
  // Offline, the area exists only as its manifest, which is gone now.
  state.aoiId = null;
  state.files = [];
  state.hasCache = false;
  drawFiles();
  drawArea(null);
  $("files-section").hidden = true;
  clear($("files"));
  await loadAreas();
}

// ---- preview -----------------------------------------------------------------------------

function revokePreviewUrls() {
  for (const url of state.previewUrls) URL.revokeObjectURL(url);
  state.previewUrls = [];
}

function closePreview() {
  state.previewToken += 1;
  revokePreviewUrls();
  $("preview").hidden = true;
  clear($("preview-body"));
}

/** An object URL for the blob under the given media type; revoked when the preview changes. */
function objectUrl(blob, type) {
  const url = URL.createObjectURL(blob.slice(0, blob.size, type));
  state.previewUrls.push(url);
  return url;
}

async function openPreview(file) {
  const token = (state.previewToken += 1);
  revokePreviewUrls();
  const body = $("preview-body");
  clear(body);
  $("preview-title").textContent = file.original_filename || file.id;
  $("preview").hidden = false;

  if (file.status !== "downloaded") {
    const info = STATUS[file.status] || STATUS.not_synced;
    const text =
      file.status === "not_synced"
        ? "This file has not been synced. Use Sync area while online to download it."
        : info.label + (file.reason ? `: ${file.reason}` : "");
    body.appendChild(el("p", { text }));
    return;
  }

  let blob = null;
  try {
    blob = await state.store.getBlob(state.auth.userId, state.aoiId, file.id);
  } catch (err) {
    blob = null;
  }
  if (token !== state.previewToken) return; // another file was opened, or the preview closed
  if (blob === null) {
    body.appendChild(el("p", { text: "This file is no longer stored on this device. Sync the area again while online." }));
    return;
  }

  const mime = baseMime(file.mime_type) || baseMime(blob.type);
  const name = file.original_filename || "download";
  if (INLINE_IMAGES.includes(mime)) {
    body.appendChild(el("img", { attrs: { src: objectUrl(blob, mime), alt: name } }));
  } else if (mime === PDF) {
    const url = objectUrl(blob, PDF);
    body.appendChild(el("iframe", { attrs: { src: url, title: name } }));
    // iOS Safari shows only the first page of a PDF inside an iframe.
    body.appendChild(
      el("div", { cls: "buttons" }, [
        el("a", { cls: "button is-link is-small", text: "Open PDF", attrs: { href: url, target: "_blank", rel: "noopener" } }),
      ]),
    );
  } else if (mime === TEXT) {
    const pre = el("pre", { text: "Loading…" });
    body.appendChild(pre);
    try {
      const text = await blob.slice(0, TEXT_PREVIEW_BYTES, TEXT).text();
      if (token !== state.previewToken) return;
      pre.textContent = blob.size > TEXT_PREVIEW_BYTES ? `${text}\n… (truncated, ${formatSize(blob.size)} in total)` : text;
    } catch (err) {
      pre.textContent = `Could not read file: ${errorText(err)}`;
    }
  } else {
    // Everything else, SVG and HTML included, can carry script: offer a download only, re-typed
    // so the browser never renders it as a document.
    body.appendChild(el("p", { text: "No inline preview for this file type." }));
    body.appendChild(
      el("a", {
        cls: "button is-link is-small",
        text: "Save file",
        attrs: { href: objectUrl(blob, OCTET_STREAM), download: name },
      }),
    );
  }
}

// ---- storage -------------------------------------------------------------------------------

async function updateStorage() {
  const line = $("storage");
  const parts = [];
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      if (typeof usage === "number" && typeof quota === "number") {
        parts.push(`Storage: ${formatSize(usage)} used of ${formatSize(quota)}.`);
      }
    }
  } catch (err) {
    // estimate() is optional; leave the line out
  }
  if (state.storeIsVolatile) parts.push("Offline storage is unavailable in this browser: synced files are lost on reload.");
  else if (state.persisted) parts.push("Protected from automatic cleanup.");
  line.hidden = parts.length === 0;
  line.textContent = parts.join(" ");
}

/** Ask the browser not to evict our data under storage pressure. Safari may refuse; that is fine. */
async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) state.persisted = await navigator.storage.persist();
  } catch (err) {
    state.persisted = false;
  }
  updateStorage();
}

// ---- start up ----------------------------------------------------------------------------

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").catch((err) => {
    console.warn("Service worker not registered:", err);
  });
}

async function openStore() {
  try {
    return await openIdbStore();
  } catch (err) {
    console.warn("IndexedDB unavailable, using memory only:", err);
    state.storeIsVolatile = true;
    return createMemoryStore();
  }
}

async function main() {
  $("signin-form").addEventListener("submit", onSignIn);
  $("signout-btn").addEventListener("click", onSignOut);
  $("sync-btn").addEventListener("click", runSync);
  $("delete-btn").addEventListener("click", deleteCachedArea);
  $("preview-close").addEventListener("click", closePreview);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePreview();
  });
  window.addEventListener("offline", () => state.session && setOffline(true));
  window.addEventListener("online", () => {
    if (state.session && !state.busy) loadAreas();
  });

  registerServiceWorker();
  state.store = await openStore();
  const auth = loadAuth();
  if (auth) showMap(auth);
  else showSignIn("");
}

main().catch((err) => {
  console.error("SafeSight MDT failed to start:", err);
  showSignIn(`Could not start: ${errorText(err)}`);
});
