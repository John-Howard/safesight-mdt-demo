// A tiny stand-in for SafeSight, just enough for the PWA's e2e run. Node built-ins only.
//
//   node pwa/e2e/mock-safesight.mjs            # listens on 10300, allows http://localhost:10200
//
// It serves the real SafeSight fixtures from pwa/tests/fixtures, issues JWT-shaped tokens whose
// payload carries a UUID `user_id`, rotates refresh tokens, and speaks CORS the way
// django-cors-headers does: an explicit allow-list of origins, and a preflight that only
// permits the `authorization` and `content-type` request headers. A request that needs any other
// header gets no CORS headers at all, so the browser blocks it and the e2e run fails.

import { readFileSync } from "node:fs";
import http from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const FIXTURES = fileURLToPath(new URL("../tests/fixtures/", import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(`${FIXTURES}${name}`, "utf8"));

export const USER_ID = "d3adb33f-0000-4000-8000-000000000001";
export const CREDENTIALS = { username: "demo", password: "demo-pass" };

// ---- file contents -------------------------------------------------------------------------

function pngBytes(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * (1 + width * 3) + 1 + x * 3;
      rows[at] = r;
      rows[at + 1] = (g + x * 2) % 256;
      rows[at + 2] = (b + y * 2) % 256;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const TILE_PNG = pngBytes(256, 256, [200, 210, 190]);
const HYDRANT_NOTES = "Hydrant notes: valve key in the red box.\nCheck pressure before connecting.\n";
const SVG_WITH_SCRIPT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="document.title=\'pwned\'">' +
  "<script>document.title='pwned'</script><circle cx=\"20\" cy=\"20\" r=\"18\"/></svg>";
const PDF =
  "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\n" +
  "trailer<</Root 1 0 R/Size 4>>\n%%EOF\n";

function contentFor(row) {
  switch (row.mime_type) {
    case "image/png":
      return pngBytes(120, 90, [row.original_filename.length * 7, 90, 160]);
    case "image/svg+xml":
      return Buffer.from(SVG_WITH_SCRIPT);
    case "application/pdf":
      return Buffer.from(PDF);
    default:
      return Buffer.from(row.original_filename.includes("notes") ? HYDRANT_NOTES : `${row.original_filename}\n`);
  }
}

// ---- the server ----------------------------------------------------------------------------

/**
 * @param {object} [o]
 * @param {number} [o.port]
 * @param {string[]} [o.allowedOrigins] origins that get CORS headers
 * @param {"broken"|"supported"} [o.aoiFiles] "broken": the AOI files endpoint answers 500 like a
 *   SafeSight before #396, so the PWA scans; "supported": it answers with can_download.
 */
export async function startMock({
  port = 10300,
  allowedOrigins = ["http://localhost:10200", "http://127.0.0.1:10200"],
  aoiFiles = "broken",
} = {}) {
  const areas = fixture("areas_geojson.json");
  const list = fixture("files_list.json");
  const points = fixture("files_geojson.json");
  const detail = fixture("file_detail_coverage_only.json");
  const contents = new Map();
  for (const row of list.results) {
    contents.set(row.id, contentFor(row));
    row.file_size = contents.get(row.id).length; // sizes the sync will compare against
  }
  detail.file_size = contents.get(detail.id).length;

  const issued = { access: new Set(), refresh: new Set() };
  const requests = [];

  function issueTokens() {
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access = `${b64({ alg: "none", typ: "JWT" })}.${b64({ token_type: "access", exp, user_id: USER_ID, jti: randomUUID() })}.${randomBytes(8).toString("hex")}`;
    const refresh = `refresh-${randomUUID()}`;
    issued.access.add(access);
    issued.refresh.add(refresh);
    return { access, refresh };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const origin = req.headers.origin;
    const record = { method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization || null, origin };
    requests.push(record);

    const cors = {};
    if (origin && allowedOrigins.includes(origin)) {
      cors["Access-Control-Allow-Origin"] = origin;
      cors.Vary = "Origin";
    }
    const send = (status, body, headers = {}) => {
      const isBuffer = Buffer.isBuffer(body);
      res.writeHead(status, {
        ...cors,
        "Content-Type": isBuffer ? "application/octet-stream" : "application/json",
        ...headers,
      });
      res.end(isBuffer ? body : JSON.stringify(body));
    };

    if (req.method === "OPTIONS") {
      const asked = String(req.headers["access-control-request-headers"] || "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
      const extra = asked.filter((h) => !["authorization", "content-type"].includes(h));
      if (!cors["Access-Control-Allow-Origin"] || extra.length > 0) {
        record.rejectedPreflight = extra.length > 0 ? `unexpected headers: ${extra.join(",")}` : "origin not allowed";
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(204, {
        ...cors,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, content-type",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }

    if (url.searchParams.has("format")) return send(404, { detail: "format is not a valid renderer here" });

    const readBody = () =>
      new Promise((resolve) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
          try {
            resolve(JSON.parse(data || "{}"));
          } catch {
            resolve({});
          }
        });
      });

    if (req.method === "POST" && url.pathname === "/api/token/") {
      const body = await readBody();
      if (body.username !== CREDENTIALS.username || body.password !== CREDENTIALS.password) {
        return send(401, { detail: "No active account found with the given credentials" });
      }
      return send(200, issueTokens());
    }
    if (req.method === "POST" && url.pathname === "/api/token/refresh/") {
      const body = await readBody();
      if (!issued.refresh.delete(body.refresh)) return send(401, { detail: "Token is blacklisted" });
      return send(200, issueTokens());
    }

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (req.method !== "GET" || !bearer || !issued.access.has(bearer[1])) {
      return send(401, { detail: "Authentication credentials were not provided or are invalid." });
    }

    if (url.pathname === "/api/v1/areas-of-interest/geojson/") {
      return send(200, areas, { "Content-Type": "application/geo+json" });
    }
    const aoiFilesMatch = /^\/api\/v1\/areas-of-interest\/([^/]+)\/files\/$/.exec(url.pathname);
    if (aoiFilesMatch) {
      if (aoiFiles === "broken") return send(500, { error: "Internal Server Error" });
      const point = new Map(points.results.features.map((f) => [f.id, f]));
      const inside = ["ambulance-staging-point.png", "carfax-scene-photo.png", "hydrant-layout.svg", "hydrant-notes.txt", "station-incident-report.pdf"];
      const rows = list.results.filter((r) => inside.includes(r.original_filename)).map((r) => ({
        ...r,
        location: point.get(r.id).geometry,
        coverage_area: null,
        can_download: true,
      }));
      rows.push({ ...list.results.find((r) => r.id === detail.id), location: null, coverage_area: detail.coverage_area_dual_crs.epsg_4326, can_download: true });
      return send(200, { count: rows.length, next: null, previous: null, results: rows });
    }
    if (url.pathname === "/api/v1/files/") {
      return send(200, list);
    }
    if (url.pathname === "/api/v1/files/geojson/") {
      return send(200, points);
    }
    const fileMatch = /^\/api\/v1\/files\/([^/]+)\/(download\/)?$/.exec(url.pathname);
    if (fileMatch) {
      const [, id, download] = fileMatch;
      const row = list.results.find((r) => r.id === id);
      if (!row) return send(404, { detail: "Not found." });
      if (!download) return send(200, id === detail.id ? detail : row);
      return send(200, contents.get(id), {
        "Content-Type": row.mime_type,
        "Content-Disposition": `attachment; filename="${row.original_filename}"`,
      });
    }
    return send(404, { detail: "Not found." });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port,
    requests,
    /** Make every issued access token invalid, as if an hour had passed. Refresh still works. */
    expireAccessTokens: () => issued.access.clear(),
    /** Invalidate every token, access and refresh: the refresh token has been blacklisted too. */
    revokeAllTokens: () => {
      issued.access.clear();
      issued.refresh.clear();
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mock = await startMock({ aoiFiles: process.env.MOCK_AOI_FILES === "supported" ? "supported" : "broken" });
  console.log(`mock SafeSight on http://localhost:${mock.port} (user ${CREDENTIALS.username} / ${CREDENTIALS.password})`);
}
