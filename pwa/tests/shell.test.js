// Static checks on the app shell: what is precached, what index.html references, the CSP, and
// the "no innerHTML / no format=" rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; " +
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org; " +
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*; frame-src blob:; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'; worker-src 'self'";

function shellFiles() {
  const block = /const SHELL_FILES = \[([\s\S]*?)\];/.exec(read("sw.js"))[1];
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const normalise = (p) => p.replace(/^\.\//, "");

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

test("every precached file exists", () => {
  for (const file of shellFiles()) {
    const path = normalise(file);
    assert.ok(path === "" || existsSync(join(ROOT, path)), `${file} is listed in sw.js but missing`);
  }
});

test("the precache list has no duplicates", () => {
  const files = shellFiles().map(normalise);
  assert.equal(new Set(files).size, files.length);
});

test("everything index.html references locally is precached", () => {
  const html = read("index.html");
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|data:|blob:)/.test(u));
  assert.ok(refs.length >= 6);
  const cached = new Set(shellFiles().map(normalise));
  for (const ref of refs) assert.ok(cached.has(normalise(ref)), `${ref} is referenced by index.html but not precached`);
});

test("every module imported by the JS is precached", () => {
  const cached = new Set(shellFiles().map(normalise));
  for (const file of ["config.js", ...walk(join(ROOT, "js")).map((f) => relative(ROOT, f))]) {
    const source = read(file);
    for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const target = relative(ROOT, resolve(ROOT, dirname(file), match[1]));
      assert.ok(cached.has(target), `${file} imports ${match[1]} which is not precached`);
      assert.ok(existsSync(join(ROOT, target)), `${file} imports missing ${target}`);
    }
  }
  assert.ok(cached.has("js/main.js"));
});

test("the stylesheets' url() assets are precached", () => {
  const cached = new Set(shellFiles().map(normalise));
  for (const css of ["vendor/leaflet.css", "app.css"]) {
    for (const match of read(css).matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      if (/^(data:|https?:|#)/.test(match[1])) continue;
      const target = relative(ROOT, resolve(ROOT, dirname(css), match[1].split(/[?#]/)[0]));
      assert.ok(existsSync(join(ROOT, target)), `${css} -> ${target} missing`);
      assert.ok(cached.has(target), `${css} references ${target} which is not precached`);
    }
  }
});

test("index.html: the CSP meta is exactly the specified policy", () => {
  const html = read("index.html");
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  assert.ok(csp, "CSP meta tag present");
  assert.equal(csp[1], EXPECTED_CSP);
});

test("index.html: no inline scripts, styles, style attributes or event handlers", () => {
  const html = read("index.html");
  for (const script of html.matchAll(/<script\b[^>]*>/gi)) assert.match(script[0], /\bsrc="/, script[0]);
  assert.ok(!/<script[^>]*>\s*\S/i.test(html.replace(/<script[^>]*\bsrc="[^"]*"[^>]*>\s*<\/script>/gi, "")), "inline script body");
  assert.ok(!/<style\b/i.test(html), "style element");
  assert.ok(!/\sstyle\s*=/i.test(html), "style attribute");
  assert.ok(!/\son[a-z]+\s*=/i.test(html), "inline event handler");
  assert.ok(!/javascript:/i.test(html));
});

test("index.html: iOS and install metadata", () => {
  const html = read("index.html");
  assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png"/);
  assert.match(html, /<meta name="theme-color"/);
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest"/);
  assert.match(html, /<script type="module" src="js\/main\.js">/);
});

test("manifest.webmanifest: name, standalone display, icons that exist", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));
  assert.equal(manifest.name, "SafeSight MDT");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.start_url);
  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"));
  const cached = new Set(shellFiles().map(normalise));
  for (const icon of manifest.icons) {
    assert.equal(icon.type, "image/png");
    assert.ok(existsSync(join(ROOT, icon.src)), icon.src);
    assert.ok(cached.has(normalise(icon.src)), `${icon.src} not precached`);
  }
});

test("icons are PNGs of the right size", () => {
  for (const [file, size] of [["icons/icon-192.png", 192], ["icons/icon-512.png", 512], ["icons/apple-touch-icon.png", 180]]) {
    const bytes = readFileSync(join(ROOT, file));
    assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", file);
    assert.equal(bytes.readUInt32BE(16), size, `${file} width`);
    assert.equal(bytes.readUInt32BE(20), size, `${file} height`);
  }
});

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

test("our JS never uses innerHTML-style sinks, eval, or a format parameter", () => {
  const files = ["config.js", "sw.js", ...walk(join(ROOT, "js")).map((f) => relative(ROOT, f))];
  const banned = [
    [/\binnerHTML\b/, "innerHTML"],
    [/\bouterHTML\b/, "outerHTML"],
    [/\binsertAdjacentHTML\b/, "insertAdjacentHTML"],
    [/\bdocument\.write\b/, "document.write"],
    [/\beval\s*\(/, "eval"],
    [/\bnew Function\b/, "new Function"],
    [/[?&"'`]format=/, "format= query parameter"],
    [/\bformat\s*:\s*["'`]/, "format query parameter"],
  ];
  for (const file of files) {
    const source = stripComments(read(file));
    for (const [pattern, label] of banned) assert.ok(!pattern.test(source), `${file} uses ${label}`);
  }
});

test("only main.js touches the document", () => {
  for (const file of walk(join(ROOT, "js")).map((f) => relative(ROOT, f))) {
    if (file === "js/main.js") continue;
    assert.ok(!/\bdocument\b/.test(stripComments(read(file))), `${file} touches document`);
  }
});

test("package.json has no dependencies and a test script", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.type, "module");
  assert.ok(pkg.scripts.test);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});
