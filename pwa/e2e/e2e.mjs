// End-to-end run in a real browser: node pwa/e2e/e2e.mjs
//
// Uses the preinstalled Playwright (no `playwright install`). Starts the mock SafeSight on 10300
// and serves pwa/ on 10200, then drives sign-in, sync, preview and offline use. Console errors,
// page errors and Content Security Policy violations (Chromium reports them as console errors)
// are collected through page listeners, never by injecting code, and fail the run unless a step
// declared them expected.

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startMock } from "./mock-safesight.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = "http://localhost:10200";
const SAFESIGHT = "http://localhost:10300";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

let checks = 0;
const log = (message) => console.log(`ok - ${message}`);
function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  checks += 1;
  log(message);
}

// ---- static server for pwa/ ---------------------------------------------------------------

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
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () =>
      resolve({
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      }),
    );
  });
}

// ---- problem collection -----------------------------------------------------------------

const tileErrors = new Set();
const tiles = { requested: 0, failed: 0, ok: 0 };

function watch(page) {
  const problems = [];
  const state = { expected: [] };
  const isExpected = (text) => state.expected.some((pattern) => pattern.test(text));
  page.on("console", (msg) => {
    const text = msg.text();
    const where = msg.location().url ? ` (${msg.location().url})` : "";
    // OpenStreetMap is not reachable from a sandbox and base-map tiles are not under test here.
    if (/tile\.openstreetmap\.org/.test(where) || /tile\.openstreetmap\.org/.test(text)) {
      tileErrors.add(msg.location().url || text);
      return;
    }
    if (/content security policy|refused to/i.test(text)) problems.push(`CSP violation: ${text}`);
    else if (msg.type() === "error" && !isExpected(text + where)) problems.push(`console error: ${text}${where}`);
  });
  page.on("request", (req) => /tile\.openstreetmap\.org/.test(req.url()) && (tiles.requested += 1));
  page.on("requestfailed", (req) => /tile\.openstreetmap\.org/.test(req.url()) && (tiles.failed += 1));
  page.on("requestfinished", (req) => /tile\.openstreetmap\.org/.test(req.url()) && (tiles.ok += 1));
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  return {
    problems,
    /** Declare console errors that are the expected result of the current step. */
    expect: (...patterns) => (state.expected = patterns),
    expectNothing: () => (state.expected = []),
  };
}

function assertNoProblems(watcher, label) {
  check(watcher.problems.length === 0, `${label}: no console errors, page errors or CSP violations${watcher.problems.length ? `\n  ${watcher.problems.join("\n  ")}` : ""}`);
}

async function newContext(browser, options = {}) {
  const context = await browser.newContext({ baseURL: APP, ...options });
  // No request interception on purpose: with Playwright's routing enabled Chromium skips CORS
  // preflights, and the mock's strict preflight check is part of what this run proves.
  return context;
}

async function signInAs(page, { baseUrl = SAFESIGHT, username = "demo", password = "demo-pass" } = {}) {
  await page.locator("#base-url").fill(baseUrl);
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#signin-btn").click();
}

const AOI_PROBE_500 = /status of 500[\s\S]*\/areas-of-interest\/[^/]+\/files\//;
const SAFESIGHT_UNREACHABLE = /net::ERR_(CONNECTION_REFUSED|INTERNET_DISCONNECTED)[\s\S]*localhost:10300/;

async function until(condition, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("FAILED: timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const visible = (locator, timeout = 10000) => locator.waitFor({ state: "visible", timeout });

async function selectOxford(page) {
  await page.locator("#areas .item-btn", { hasText: "Oxford city centre" }).click();
  await visible(page.locator("#files .item-btn").first());
}

const fileRow = (page, name) => page.locator("#files .item-btn", { hasText: name });

async function expectImagePreview(page, name) {
  await fileRow(page, name).click();
  const img = page.locator('#preview-body img[src^="blob:"]');
  await visible(img);
  const box = await img.boundingBox();
  check(box !== null && box.width > 40 && box.height > 30, `${name}: preview shows an <img> with a blob: src (${Math.round(box.width)}x${Math.round(box.height)})`);
}

// ---- scenario 1: desktop, scan path, then offline -------------------------------------------

async function desktopRun(browser) {
  console.log("\n# desktop run (AOI files endpoint answers 500, so the PWA scans)");
  const mock = await startMock({ aoiFiles: "broken" });
  const wrongOrigin = await startMock({ port: 10301, allowedOrigins: ["https://not-the-pwa.example"] });
  const context = await newContext(browser, { viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const watcher = watch(page);
  let mockUp = true;

  try {
    await page.goto("/");
    await visible(page.locator("#signin-view"));
    check(true, "sign-in view is shown when nobody is signed in");
    check((await page.locator("#signin-origin").textContent()).includes(APP), "sign-in view names this app's origin for CORS_ALLOWED_ORIGINS");

    // CORS refused: SafeSight does not list this origin.
    watcher.expect(/blocked by CORS policy/, /net::ERR_FAILED[\s\S]*localhost:10301/);
    await signInAs(page, { baseUrl: "http://localhost:10301" });
    const hint = page.locator("#signin-error");
    await visible(hint);
    const hintText = await hint.textContent();
    check(/Could not reach SafeSight/.test(hintText) && hintText.includes("CORS_ALLOWED_ORIGINS") && hintText.includes(APP), `a CORS refusal gets the specific hint: "${hintText}"`);
    check(wrongOrigin.requests.some((r) => r.method === "OPTIONS" && r.rejectedPreflight), "the refused sign-in stopped at the preflight");

    // Bad credentials.
    watcher.expect(/status of 401[\s\S]*\/api\/token\//);
    await signInAs(page, { password: "wrong" });
    await page.locator("#signin-error", { hasText: "Invalid username or password" }).waitFor({ timeout: 10000 });
    check(true, "bad credentials show 'Invalid username or password'");

    // Good credentials. From here on, Chromium logs two expected failures as console errors: the
    // AOI files endpoint answering 500 (this mock plays a SafeSight before #396, so the PWA falls
    // back to the scan), and, once the mock is stopped, connection refusals to it.
    watcher.expect(AOI_PROBE_500);
    await signInAs(page);
    await visible(page.locator("#map-view"));
    check((await page.locator("#user-name").textContent()) === "demo", "signed in: map view shows the user name");
    await visible(page.locator("#areas .item-btn", { hasText: "Oxford city centre" }));
    check((await page.locator("#areas .item-btn").count()) === 1, "the AOI list shows 'Oxford city centre'");
    check((await page.locator("#conn").textContent()) === "Online", "indicator says Online");

    await selectOxford(page);
    check((await page.locator("#files .item-btn").count()) === 6, "six files are listed for the area (the seventh is outside it)");
    check((await page.locator("#files .tag", { hasText: "Not synced" }).count()) === 6, "all six start as 'Not synced'");
    check(!(await fileRow(page, "headington-outside-area.txt").count()), "the outside file is not listed");

    // Sync.
    await page.locator("#sync-btn").click();
    await page.locator("#sync-result", { hasText: "Downloaded 6" }).waitFor({ timeout: 20000 });
    check(true, "sync result reads 'Downloaded 6'");
    await page.locator("#files .tag", { hasText: /^Synced$/ }).nth(5).waitFor();
    check((await page.locator("#files .tag", { hasText: /^Synced$/ }).count()) === 6, "all six statuses become 'Synced'");
    await visible(page.locator("#delete-btn"));
    check(true, "'Delete cached area' appears once the area is cached");
    const storage = await page.locator("#storage").textContent();
    check(/Storage: .* used of /.test(storage), `storage use is shown: "${storage}"`);

    // Previews.
    await expectImagePreview(page, "ambulance-staging-point.png");

    await fileRow(page, "hydrant-layout.svg").click();
    const save = page.locator('#preview-body a[download="hydrant-layout.svg"]');
    await visible(save);
    check((await save.getAttribute("href")).startsWith("blob:"), "SVG gets a Save link with a blob: href");
    check((await page.locator("#preview-body img, #preview-body iframe, #preview-body object, #preview-body embed, #preview-body svg").count()) === 0, "SVG is never shown inline (no img, iframe, object, embed or svg)");

    await fileRow(page, "station-incident-report.pdf").click();
    await visible(page.locator('#preview-body iframe[src^="blob:"]'));
    await visible(page.locator("#preview-body a", { hasText: "Open PDF" }));
    check(true, "PDF: iframe plus an 'Open PDF' link");

    await fileRow(page, "hydrant-notes.txt").click();
    await page.locator("#preview-body pre", { hasText: "valve key in the red box" }).waitFor();
    check(true, "text file shown in a <pre>");

    await page.locator("#preview-close").click();
    check(await page.locator("#preview").isHidden(), "closing the preview hides it");

    // Survives a reload while online.
    await page.reload();
    await visible(page.locator("#areas .item-btn", { hasText: "Oxford city centre" }));
    check((await page.locator("#conn").textContent()) === "Online", "reload keeps the session (no new sign-in)");
    await selectOxford(page);
    check((await page.locator("#files .tag", { hasText: /^Synced$/ }).count()) === 6, "after reload the files are still 'Synced' (IndexedDB)");

    // Service worker installed and controlling.
    for (let i = 0; i < 50 && context.serviceWorkers().length === 0; i += 1) await page.waitForTimeout(100);
    check(context.serviceWorkers().length > 0, "a service worker is registered");

    // The traffic the mock saw.
    const sawFormat = mock.requests.some((r) => r.query.includes("format"));
    check(!sawFormat, "no request carried a format parameter");
    const downloads = mock.requests.filter((r) => r.method === "GET" && r.path.endsWith("/download/"));
    check(downloads.length === 6, `exactly six downloads were requested (${downloads.length})`);
    check(mock.requests.filter((r) => r.method !== "OPTIONS" && r.path.startsWith("/api/v1/")).every((r) => /^Bearer /.test(r.auth || "")), "every API request carried the bearer token");

    // SafeSight goes away: reload and use the cache.
    await mock.close();
    mockUp = false;
    watcher.expect(AOI_PROBE_500, SAFESIGHT_UNREACHABLE);
    await page.reload();
    await page.locator("#conn", { hasText: "Offline (cached)" }).waitFor({ timeout: 15000 });
    check(true, "SafeSight stopped, page reloaded: indicator says 'Offline (cached)'");
    await visible(page.locator("#areas .item-btn", { hasText: "Oxford city centre" }));
    check(true, "the cached area is still listed");
    await selectOxford(page);
    check((await page.locator("#files .item-btn").count()) === 6, "the cached files are still listed");
    check((await page.locator("#files .tag", { hasText: /^Synced$/ }).count()) === 6, "cached files show as 'Synced'");
    check(await page.locator("#sync-btn").isDisabled(), "Sync area is disabled while offline");
    await expectImagePreview(page, "ambulance-staging-point.png");
    await fileRow(page, "hydrant-layout.svg").click();
    await visible(page.locator('#preview-body a[download="hydrant-layout.svg"]'));
    check(true, "offline: SVG still only offers a Save link");

    // The whole device offline: the shell must come from the service worker cache.
    await context.setOffline(true);
    await page.reload();
    await page.locator("#conn", { hasText: "Offline (cached)" }).waitFor({ timeout: 15000 });
    check(true, "device offline (no network at all): the app shell loads from the service worker");
    await visible(page.locator("#areas .item-btn", { hasText: "Oxford city centre" }));
    await selectOxford(page);
    await expectImagePreview(page, "ambulance-staging-point.png");

    // Delete the cached area while offline.
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#delete-btn").click();
    await page.locator("#areas-empty", { hasText: "No areas available" }).waitFor({ timeout: 10000 });
    check((await page.locator("#areas .item-btn").count()) === 0 && (await page.locator("#files-section").isHidden()), "'Delete cached area' removes the area and its files");
    await context.setOffline(false);

    // Sign out keeps the base URL for next time.
    await page.locator("#signout-btn").click();
    await visible(page.locator("#signin-view"));
    check((await page.locator("#base-url").inputValue()) === SAFESIGHT, "after sign-out the SafeSight URL is prefilled");
    check((await page.locator("#password").inputValue()) === "", "after sign-out the password field is empty");

    assertNoProblems(watcher, "desktop run");
  } finally {
    if (mockUp) await mock.close();
    await wrongOrigin.close();
    await context.close();
  }
}

// ---- scenario 2: iPhone-sized viewport, AOI files endpoint path ------------------------------

async function phoneRun(browser) {
  console.log("\n# phone run (390x844; the AOI files endpoint is supported)");
  const mock = await startMock({ aoiFiles: "supported" });
  const context = await newContext(browser, {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  });
  const page = await context.newPage();
  const watcher = watch(page);
  try {
    await page.goto("/");
    await visible(page.locator("#signin-view"));
    await signInAs(page);
    await visible(page.locator("#map-view"));
    await visible(page.locator("#areas .item-btn", { hasText: "Oxford city centre" }));
    await selectOxford(page);
    check((await page.locator("#files .item-btn").count()) === 6, "phone: six files listed via the AOI files endpoint");
    check(mock.requests.some((r) => /\/areas-of-interest\/[^/]+\/files\/$/.test(r.path) && r.method === "GET"), "phone: the AOI files endpoint was used");
    check(!mock.requests.some((r) => r.path === "/api/v1/files/geojson/"), "phone: no per-file scan requests were needed");
    const areaLists = mock.requests.filter((r) => r.method === "GET" && r.path === "/api/v1/areas-of-interest/geojson/").length;
    check(areaLists === 1, `phone: signing in and opening an area fetched the area list once (${areaLists})`);

    const map = await page.locator("#map").boundingBox();
    const sidebar = await page.locator(".sidebar").boundingBox();
    check(sidebar.y >= map.y + map.height - 1, `phone: the sidebar (y=${Math.round(sidebar.y)}) is stacked below the map (bottom=${Math.round(map.y + map.height)})`);
    check(Math.abs(map.height - 844 * 0.55) < 6, `phone: the map takes about 55% of the height (${Math.round(map.height)}px of 844)`);
    check((await page.locator("html").boundingBox()).width <= 390, "phone: no horizontal overflow");

    await page.locator("#sync-btn").click();
    await page.locator("#sync-result", { hasText: "Downloaded 6" }).waitFor({ timeout: 20000 });
    await page.locator("#files .tag", { hasText: /^Synced$/ }).nth(5).waitFor();
    check(true, "phone: sync completes, six files 'Synced'");

    await expectImagePreview(page, "carfax-scene-photo.png");
    const sheet = await page.locator("#preview").boundingBox();
    check(Math.abs(sheet.x) < 1 && Math.abs(sheet.width - 390) < 1, `phone: the preview is a full-width sheet (x=${Math.round(sheet.x)}, width=${Math.round(sheet.width)})`);
    check(Math.abs(sheet.y + sheet.height - 844) < 1, `phone: the preview sheet sits at the bottom of the screen (bottom=${Math.round(sheet.y + sheet.height)})`);

    // The sheet covers the list on a phone; closing it is part of the flow.
    await page.locator("#preview-close").click();
    check(await page.locator("#preview").isHidden(), "phone: the sheet closes");
    await fileRow(page, "hydrant-layout.svg").click();
    await visible(page.locator('#preview-body a[download="hydrant-layout.svg"]'));
    check((await page.locator("#preview-body img, #preview-body iframe").count()) === 0, "phone: SVG is never inline");

    check(!mock.requests.some((r) => r.query.includes("format")), "phone: no request carried a format parameter");
    assertNoProblems(watcher, "phone run");
  } finally {
    await context.close();
    await mock.close();
  }
}

// ---- scenario 3: token refresh, and losing the session --------------------------------------------

async function sessionRun(browser) {
  console.log("\n# session run (token rotation in the browser, then a revoked session)");
  const mock = await startMock({ aoiFiles: "supported" });
  const context = await newContext(browser, { viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const watcher = watch(page);
  const refreshes = () => mock.requests.filter((r) => r.method === "POST" && r.path === "/api/token/refresh/").length;
  try {
    await page.goto("/");
    await visible(page.locator("#signin-view"));
    await signInAs(page);
    await visible(page.locator("#areas .item-btn", { hasText: "Oxford city centre" }));
    await selectOxford(page);
    await page.locator("#sync-btn").click();
    await page.locator("#sync-result", { hasText: "Downloaded 6" }).waitFor({ timeout: 20000 });
    check(refreshes() === 0, "no token refresh was needed so far");

    // The access token expires: the client refreshes once, retries, and carries on.
    watcher.expect(/status of 401[\s\S]*\/api\/v1\//);
    mock.expireAccessTokens();
    await page.locator("#areas .item-btn", { hasText: "Oxford city centre" }).click();
    await until(() => refreshes() >= 1 && mock.requests.at(-1).path.startsWith("/api/v1/"));
    await page.waitForTimeout(500); // let the retried requests finish
    check((await page.locator("#files .tag", { hasText: /^Synced$/ }).count()) === 6, "the files are listed again after the refresh");
    check(refreshes() === 1, "an expired access token is refreshed exactly once and the request retried");
    const refreshedAt = mock.requests.findIndex((r) => r.path === "/api/token/refresh/");
    check(mock.requests.slice(refreshedAt + 1).filter((r) => r.path.startsWith("/api/v1/")).every((r) => r.auth && r.auth !== mock.requests[refreshedAt - 1]?.auth), "requests after the refresh use the rotated access token");

    // Rotation is persisted: a reload signs in silently with the new refresh token.
    await page.reload();
    await visible(page.locator("#areas .item-btn", { hasText: "Oxford city centre" }));
    check(await page.locator("#signin-view").isHidden(), "after a reload the rotated tokens are still good (no sign-in)");

    // The session is revoked for good: back to the sign-in view, cache kept.
    watcher.expect(/status of 401[\s\S]*\/api\//);
    mock.revokeAllTokens();
    await page.locator("#areas .item-btn", { hasText: "Oxford city centre" }).click();
    await page.locator("#signin-error", { hasText: "session has expired" }).waitFor({ timeout: 15000 });
    check(await page.locator("#map-view").isHidden(), "a rejected refresh sends the user back to the sign-in view");

    watcher.expectNothing();
    await signInAs(page);
    await visible(page.locator("#areas .item-btn", { hasText: "Oxford city centre" }));
    await selectOxford(page);
    check((await page.locator("#files .tag", { hasText: /^Synced$/ }).count()) === 6, "after signing in again the synced files are still there (cache kept)");
    assertNoProblems(watcher, "session run");
  } finally {
    await context.close();
    await mock.close();
  }
}

// ---- main --------------------------------------------------------------------------------------

const staticServer = await serveStatic(10200);
const browser = await chromium.launch();
let failed = false;
try {
  await desktopRun(browser);
  await phoneRun(browser);
  await sessionRun(browser);
  console.log(`\nE2E PASS: ${checks} checks (OpenStreetMap tile requests seen by the page: ${tiles.requested}, finished ${tiles.ok}, failed ${tiles.failed}; ${tileErrors.size} tile console errors ignored)`);
} catch (err) {
  failed = true;
  console.error(`\nE2E FAIL: ${err.message}`);
} finally {
  await browser.close();
  await staticServer.close();
}
process.exit(failed ? 1 : 0);
