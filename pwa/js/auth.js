// Token persistence plus sign-in / sign-out helpers.
//
// SECURITY NOTE: the access and refresh tokens live in localStorage under `mdt.auth`, which any
// script running on this origin can read. That is accepted for a demo / API-testing tool: the
// page loads no third-party scripts and carries a strict CSP (script-src 'self'), and every
// server-supplied string reaches the DOM via textContent. A production deployment should keep
// tokens out of script reach (an HttpOnly cookie behind a backend-for-frontend, as the Flask
// MDT does) instead.
//
// The password is never stored. `mdt.baseUrl` remembers the last SafeSight URL separately so the
// sign-in form is prefilled after sign-out. Every storage access is wrapped in try/catch: storage
// can be missing or throw (private windows, blocked site data), and the app must still run.

import { obtainTokens, userIdFromAccessToken } from "./client.js";
import { SafeSightError } from "./errors.js";
import { normalizeUuid } from "./ids.js";

export const AUTH_KEY = "mdt.auth";
export const BASE_URL_KEY = "mdt.baseUrl";

function resolveStorage(options) {
  if (options && "storage" in options) return options.storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(options, key) {
  try {
    return resolveStorage(options)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(options, key, value) {
  try {
    resolveStorage(options)?.setItem(key, value);
  } catch {
    // storage unavailable or full: the session simply will not survive a reload
  }
}

function remove(options, key) {
  try {
    resolveStorage(options)?.removeItem(key);
  } catch {
    // nothing useful to do
  }
}

/** A clean `http(s)://host[:port][/prefix]` with no trailing slash, or SafeSightError. */
export function normalizeBaseUrl(input) {
  const text = typeof input === "string" ? input.trim() : "";
  let url;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new SafeSightError("Enter the full SafeSight URL, starting with http:// or https://");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The stored `{baseUrl, username, userId, tokens}` if it is intact, else null. */
export function loadAuth(options) {
  const text = read(options, AUTH_KEY);
  if (text === null) return null;
  try {
    const auth = JSON.parse(text);
    const userId = normalizeUuid(auth?.userId);
    const { access, refresh } = auth?.tokens ?? {};
    if (userId === null || typeof auth.username !== "string") return null;
    if (typeof access !== "string" || typeof refresh !== "string") return null;
    return {
      baseUrl: normalizeBaseUrl(auth.baseUrl),
      username: auth.username,
      userId,
      tokens: { access, refresh },
    };
  } catch {
    return null;
  }
}

export function saveAuth(auth, options) {
  write(options, AUTH_KEY, JSON.stringify(auth));
}

/** Persist rotated tokens (the client calls this through `onTokens`). */
export function saveTokens(tokens, options) {
  const auth = loadAuth(options);
  if (auth === null) return;
  saveAuth({ ...auth, tokens: { access: tokens.access, refresh: tokens.refresh } }, options);
}

export function rememberedBaseUrl(options) {
  return read(options, BASE_URL_KEY) ?? "";
}

/**
 * Exchange credentials for tokens, work out the user id, and persist the result.
 * Throws AuthError, ServerUnavailable (its `cause` is the fetch TypeError when the network or
 * CORS blocked the request), InvalidTokenError or SafeSightError (for an unusable URL).
 */
export async function signIn({ baseUrl, username, password, fetch: fetchFn, timeoutMs, storage }) {
  const options = storage === undefined ? undefined : { storage };
  const cleanUrl = normalizeBaseUrl(baseUrl);
  const tokens = await obtainTokens(cleanUrl, username, password, { fetch: fetchFn, timeoutMs });
  const auth = {
    baseUrl: cleanUrl,
    username,
    userId: userIdFromAccessToken(tokens.access),
    tokens,
  };
  saveAuth(auth, options);
  write(options, BASE_URL_KEY, cleanUrl);
  return auth;
}

/** Forget the tokens. The cached files stay on the device. */
export function signOut(options) {
  remove(options, AUTH_KEY);
}
