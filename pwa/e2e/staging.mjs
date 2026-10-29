// Smoke run of the PWA against a real SafeSight (staging), with CORS bridged by the test.
//
//   MDT_STAGING_PASSWORD=... NODE_USE_ENV_PROXY=1 node pwa/e2e/staging.mjs
//
// Staging's CORS_ALLOWED_ORIGINS does not list this app's origin, so the browser would refuse
// every call. Requests to SafeSight are therefore intercepted, sent from Node instead, and
// answered with an Access-Control-Allow-Origin header. Everything else (the client, token
// refresh, the AOI files endpoint or scan, downloads, IndexedDB, offline use) is real. CORS
// itself is NOT tested by this run; the mock run in e2e.mjs covers that.
//
// Environment:
//   MDT_STAGING_URL       SafeSight base URL (default https://staging.safesight.covcodelab.dev)
//   MDT_STAGING_USERNAME  account to sign in as (default mdt_demo)
//   MDT_STAGING_PASSWORD  required; the run makes no request without it
//   MDT_STAGING_AOI       name of the area to open (default: the first one listed)
//   MDT_STAGING_SYNC      "0" to skip Sync. Each download is logged in SafeSight's
//                         FileAccessLog, and shared files notify the owning organisation.
//
// django-axes locks an account after repeated failed sign-ins, so a rejected sign-in stops the
// run at once rather than retrying.

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = "http://localhost:10200";
const SAFESIGHT = (process.env.MDT_STAGING_URL || "https://staging.safesight.covcodelab.dev").replace(/\/+$/, "");
const USERNAME = process.env.MDT_STAGING_USERNAME || "mdt_demo";
const PASSWORD = process.env.MDT_STAGING_PASSWORD;
const AOI_NAME = process.env.MDT_STAGING_AOI;
const DO_SYNC = process.env.MDT_STAGING_SYNC !== "0";
const TIMEOUT = 120_000;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};
const INLINE_IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  checks += 1;
  console.log(`ok - ${message}`);
}

function serveStatic(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, APP);
    const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.join(PWA_DIR, path.normalize(rel));
    if (!file.startsWith(PWA_DIR + path.sep)) return void res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// ---- CORS bridge ----------------------------------------------------------------------------

const calls = [];

async function bridge(route) {
  const req = route.request();
  const cors = {
    "access-control-allow-origin": APP,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  const headers = {};
  for (const name of ["authorization", "content-type", "accept"]) {
    const value = req.headers()[name];
    if (value) headers[name] = value;
  }
  const started = Date.now();
  try {
    const response = await fetch(req.url(), { method: req.method(), headers, body: req.postDataBuffer() ?? undefined });
    const body = Buffer.from(await response.arrayBuffer());
    const url = new URL(req.url());
    calls.push({ method: req.method(), path: url.pathname + url.search, status: response.status, ms: Date.now() - started });
    const out = { ...cors };
    for (const name of ["content-type", "content-disposition"]) {
      const value = response.headers.get(name);
      if (value) out[name] = value;
    }
    return route.fulfill({ status: response.status, headers: out, body });
  } catch (err) {
    calls.push({ method: req.method(), path: req.url(), status: `network error: ${err.cause?.code || err.message}` });
    return route.abort("failed");
  }
}

// ---- run ------------------------------------------------------------------------------------

async function main() {
  if (!PASSWORD) {
    console.error("MDT_STAGING_PASSWORD is not set; nothing was sent to SafeSight.");
    process.exit(2);
  }
  if (!process.env.NODE_USE_ENV_PROXY && (process.env.HTTPS_PROXY || process.env.https_proxy)) {
    console.error("An HTTPS proxy is configured; rerun with NODE_USE_ENV_PROXY=1 so Node's fetch uses it.");
    process.exit(2);
  }

  const server = await serveStatic(10200);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route(`${SAFESIGHT}/**`, bridge);
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  const problems = [];
  const aoiProbeErrors = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const url = msg.location().url || "";
    if (url.includes("tile.openstreetmap.org")) return; // base map is not under test
    // A 5xx/404 from the AOI files probe is how an older SafeSight answers; the client falls back
    // to the scan. Reported in the summary rather than failing the run.
    if (/\/areas-of-interest\/[^/]+\/files\//.test(url)) return void aoiProbeErrors.push(msg.text());
    problems.push(`${msg.text()}${url ? ` (${url})` : ""}`);
  });
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));

  try {
    await page.goto(APP);
    await page.locator("#base-url").fill(SAFESIGHT);
    await page.locator("#username").fill(USERNAME);
    await page.locator("#password").fill(PASSWORD);
    await page.locator("#signin-btn").click();
    await Promise.race([
      page.locator("#map-view").waitFor({ state: "visible" }),
      page.locator("#signin-error").waitFor({ state: "visible" }),
    ]);
    if (await page.locator("#signin-error").isVisible()) {
      throw new Error(`FAILED: sign-in as ${USERNAME}: ${await page.locator("#signin-error").textContent()} (not retrying: django-axes)`);
    }
    check(true, `signed in to ${SAFESIGHT} as ${USERNAME}`);

    const areas = page.locator("#areas .item-btn");
    await areas.first().waitFor();
    const names = await page.locator("#areas .item-name").allTextContents();
    check(names.length > 0, `AOI list shows ${names.length} area(s): ${names.join(", ")}`);
    const target = AOI_NAME ? areas.filter({ hasText: AOI_NAME }).first() : areas.first();
    const aoiLabel = (await target.locator(".item-name").textContent()) || "";
    await target.click();
    // Locator waits only: waitForFunction evaluates code in the page, which the app's CSP blocks.
    await page.locator("#files .item-btn, #files-note:not([hidden]):not(:text-is('Loading files…'))").first().waitFor();
    const fileNames = await page.locator("#files .item-name").allTextContents();
    check(true, `area "${aoiLabel}" lists ${fileNames.length} file(s): ${fileNames.join(", ") || "(none)"}`);
    const usedEndpoint = calls.some((c) => /\/areas-of-interest\/[^/]+\/files\//.test(c.path) && c.status === 200);
    const scanned = calls.some((c) => c.path.startsWith("/api/v1/files/geojson/"));
    console.log(`   membership: ${scanned ? "client-side scan" : usedEndpoint ? "AOI files endpoint" : "unknown"}`);
    if (aoiProbeErrors.length) console.log(`   AOI files endpoint refused, scan used: ${aoiProbeErrors[0]}`);

    if (DO_SYNC && fileNames.length > 0) {
      await page.locator("#sync-btn").click();
      await page.locator("#sync-result", { hasText: /^(Downloaded|Sync failed)/ }).waitFor();
      const result = await page.locator("#sync-result").textContent();
      check(result.startsWith("Downloaded"), `sync: ${result}`);
      // The list reloads after the summary appears; wait for it before reading statuses.
      await page.locator("#files .tag", { hasText: "Not synced" }).first().waitFor({ state: "detached" });
      const badges = await page.locator("#files .tag").allTextContents();
      console.log(`   statuses: ${badges.join(", ")}`);

      const rows = page.locator("#files .item-btn");
      const count = await rows.count();
      for (let i = 0; i < count; i += 1) {
        if ((await rows.nth(i).locator(".tag").textContent()) !== "Synced") continue;
        const meta = (await rows.nth(i).locator(".item-meta").textContent()) || "";
        const mime = meta.split(" · ")[0];
        if (!INLINE_IMAGES.includes(mime)) continue;
        await rows.nth(i).click();
        const img = page.locator("#preview-body img");
        await img.waitFor();
        check((await img.getAttribute("src")).startsWith("blob:"), "synced image previews from a blob: URL");
        await page.locator("#preview-close").click();
        break;
      }

      // Offline: cut SafeSight off and reload. The area and files must come from IndexedDB.
      await context.unroute(`${SAFESIGHT}/**`);
      await context.route(`${SAFESIGHT}/**`, (route) => route.abort("internetdisconnected"));
      await page.reload();
      await page.locator("#conn", { hasText: "Offline" }).waitFor();
      await page.locator("#areas .item-btn", { hasText: aoiLabel }).click();
      await page.locator("#files .item-btn").first().waitFor();
      const offlineNames = await page.locator("#files .item-name").allTextContents();
      check(offlineNames.length === fileNames.length, `offline: cached area lists ${offlineNames.length} file(s)`);
    }

    // The offline step aborts SafeSight requests on purpose.
    const real = problems.filter((p) => !p.startsWith("Failed to load resource: net::ERR_INTERNET_DISCONNECTED"));
    check(real.length === 0, `no console errors or page errors${real.length ? `: ${real.join(" | ")}` : ""}`);
  } finally {
    console.log("\nSafeSight calls (method path -> status, ms):");
    for (const c of calls) console.log(`  ${c.method} ${c.path} -> ${c.status}${c.ms !== undefined ? `, ${c.ms} ms` : ""}`);
    await browser.close();
    server.close();
  }
  console.log(`\nSTAGING PASS: ${checks} checks (CORS bridged by the test, not exercised)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
