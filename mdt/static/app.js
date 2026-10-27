// SafeSight MDT front end. Vanilla JS. Every server-supplied string reaches the DOM through
// textContent / createElement, never innerHTML.
(function () {
  "use strict";

  const STATUS = {
    downloaded: { label: "Synced", badge: "is-success", color: "#2e9e5b" },
    not_synced: { label: "Not synced", badge: "is-info is-light", color: "#3a78d8" },
    denied: { label: "Denied", badge: "is-warning", color: "#e08a00" },
    failed: { label: "Failed", badge: "is-danger", color: "#d23f3f" },
  };
  const INLINE_IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  const CSRF = (document.querySelector('meta[name="csrf-token"]') || {}).content || "";

  const $ = (id) => document.getElementById(id);
  const state = { aoiId: null, files: [], offline: false, layers: new Map(), busy: false };

  // ---- DOM helpers -------------------------------------------------------
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
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  // ---- API ---------------------------------------------------------------
  async function api(path, options) {
    const opts = Object.assign({ credentials: "same-origin", headers: {} }, options || {});
    if (opts.method && opts.method !== "GET") opts.headers["X-CSRF-Token"] = CSRF;
    const response = await fetch(path, opts);
    if (response.status === 401) {
      window.location.assign("/login");
      throw new Error("Signed out");
    }
    let body = null;
    try {
      body = await response.json();
    } catch (e) {
      body = null;
    }
    if (!response.ok) {
      const err = new Error((body && body.error) || "Request failed (" + response.status + ")");
      err.status = response.status;
      throw err;
    }
    return body;
  }

  // ---- online / offline indicator ---------------------------------------
  function setOffline(offline) {
    state.offline = Boolean(offline);
    const tag = $("conn");
    tag.textContent = state.offline ? "Offline (cached)" : "Online";
    tag.className = "tag " + (state.offline ? "is-warning" : "is-success");
    $("sync-btn").disabled = state.offline || state.busy;
  }

  // ---- map ---------------------------------------------------------------
  const map = L.map("map").setView([51.75, -1.26], 12);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  let aoiLayer = null;
  const fileLayer = L.layerGroup().addTo(map);

  function colorFor(status) {
    return (STATUS[status] || STATUS.not_synced).color;
  }

  function drawArea(geometry) {
    if (aoiLayer) map.removeLayer(aoiLayer);
    aoiLayer = null;
    if (!geometry) return;
    aoiLayer = L.geoJSON(geometry, {
      style: { color: "#1f2d3d", weight: 2, dashArray: "6 4", fillColor: "#3a78d8", fillOpacity: 0.07 },
      interactive: false,
    }).addTo(map);
    map.fitBounds(aoiLayer.getBounds(), { padding: [30, 30] });
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
      style: { color: color, weight: 2, fillColor: color, fillOpacity: 0.15 },
    });
    layer.bindPopup(popupFor(file));
    return layer;
  }

  function drawFiles() {
    fileLayer.clearLayers();
    state.layers.clear();
    for (const file of state.files) {
      const layer = layerFor(file);
      if (!layer) continue;
      fileLayer.addLayer(layer);
      state.layers.set(file.id, layer);
    }
  }

  function focusFile(file) {
    const layer = state.layers.get(file.id);
    if (!layer) return;
    map.fitBounds(layer.getBounds(), { maxZoom: 17, padding: [60, 60] });
    layer.openPopup();
  }

  // ---- area list ---------------------------------------------------------
  function renderAreas(features) {
    const list = $("areas");
    clear(list);
    $("areas-empty").hidden = features.length > 0;
    for (const feature of features) {
      const props = feature.properties || {};
      const id = props.id || feature.id;
      const sub = [props.organization_name, props.group_name].filter(Boolean).join(" / ");
      const button = el(
        "button",
        {
          cls: "item-btn" + (id === state.aoiId ? " is-active" : ""),
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

  async function loadAreas() {
    try {
      const data = await api("/api/areas");
      setOffline(data.offline);
      renderAreas(data.features || []);
    } catch (err) {
      setOffline(true);
      $("areas-empty").hidden = false;
      $("areas-empty").textContent = err.message;
    }
  }

  // ---- file list ---------------------------------------------------------
  function badge(status) {
    const info = STATUS[status] || STATUS.not_synced;
    return el("span", { cls: "tag " + info.badge, text: info.label });
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

  async function loadFiles(aoiId, fallbackArea) {
    $("files-note").hidden = false;
    $("files-note").textContent = "Loading files…";
    try {
      const data = await api("/api/areas/" + encodeURIComponent(aoiId) + "/files");
      if (aoiId !== state.aoiId) return; // user picked another area meanwhile
      setOffline(data.offline);
      state.files = data.files || [];
      if (data.area && data.area.geometry && !fallbackArea) drawArea(data.area.geometry);
      drawFiles();
      renderFiles();
    } catch (err) {
      state.files = [];
      drawFiles();
      renderFiles();
      $("files-note").hidden = false;
      $("files-note").textContent = err.message;
    }
  }

  async function selectArea(aoiId, name, geometry) {
    state.aoiId = aoiId;
    closePreview();
    $("files-section").hidden = false;
    $("area-name").textContent = name || aoiId;
    $("sync-result").hidden = true;
    for (const btn of document.querySelectorAll("#areas .item-btn")) {
      btn.classList.toggle("is-active", btn.getAttribute("data-aoi") === aoiId);
    }
    drawArea(geometry);
    await loadFiles(aoiId, Boolean(geometry));
  }

  // ---- sync --------------------------------------------------------------
  async function syncArea() {
    if (!state.aoiId || state.busy) return;
    const aoiId = state.aoiId;
    const button = $("sync-btn");
    const result = $("sync-result");
    state.busy = true;
    button.disabled = true;
    button.classList.add("is-loading");
    result.hidden = false;
    result.className = "notification is-light is-size-7";
    result.textContent = "Syncing…";
    try {
      const s = await api("/api/areas/" + encodeURIComponent(aoiId) + "/sync", { method: "POST" });
      result.textContent =
        "Downloaded " + s.downloaded + ", skipped " + s.skipped + ", denied " + s.denied +
        ", failed " + s.failed + " (of " + s.total + " files, " + formatSize(s.bytes) + ").";
      result.classList.add(s.failed > 0 ? "is-warning" : "is-success");
      await loadFiles(aoiId, true);
    } catch (err) {
      result.textContent = "Sync failed: " + err.message;
      result.classList.add("is-danger");
    } finally {
      state.busy = false;
      button.classList.remove("is-loading");
      button.disabled = state.offline;
    }
  }

  // ---- preview -----------------------------------------------------------
  function closePreview() {
    $("preview").hidden = true;
    clear($("preview-body"));
  }

  function fileUrl(file) {
    return "/files/" + encodeURIComponent(state.aoiId) + "/" + encodeURIComponent(file.id);
  }

  async function openPreview(file) {
    const body = $("preview-body");
    clear(body);
    $("preview-title").textContent = file.original_filename || file.id;
    $("preview").hidden = false;

    if (file.status !== "downloaded") {
      const info = STATUS[file.status] || STATUS.not_synced;
      const text =
        file.status === "not_synced"
          ? "This file has not been synced. Use Sync area while online to download it."
          : info.label + (file.reason ? ": " + file.reason : "");
      body.appendChild(el("p", { text: text }));
      return;
    }

    const mime = String(file.mime_type || "").split(";")[0].trim().toLowerCase();
    const url = fileUrl(file);
    if (INLINE_IMAGES.includes(mime)) {
      body.appendChild(el("img", { attrs: { src: url, alt: file.original_filename || "" } }));
    } else if (mime === "application/pdf") {
      body.appendChild(el("iframe", { attrs: { src: url, title: file.original_filename || "PDF" } }));
    } else if (mime === "text/plain") {
      const pre = el("pre", { text: "Loading…" });
      body.appendChild(pre);
      try {
        const response = await fetch(url, { credentials: "same-origin" });
        if (!response.ok) throw new Error("HTTP " + response.status);
        pre.textContent = await response.text();
      } catch (err) {
        pre.textContent = "Could not load file: " + err.message;
      }
    } else {
      body.appendChild(el("p", { text: "No inline preview for this file type." }));
      body.appendChild(
        el("a", {
          cls: "button is-link is-small",
          text: "Save file",
          attrs: { href: url, download: file.original_filename || "download" },
        }),
      );
    }
  }

  // ---- wiring ------------------------------------------------------------
  $("sync-btn").addEventListener("click", syncArea);
  $("preview-close").addEventListener("click", closePreview);
  loadAreas();
})();
