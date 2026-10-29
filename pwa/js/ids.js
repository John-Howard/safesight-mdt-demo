// UUID validation shared by the client (user_id claim) and the stores (storage keys).

import { InvalidIdError } from "./errors.js";

const UUID = /^([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i;

/** Canonical lower-case hyphenated UUID, or null. */
export function normalizeUuid(value) {
  if (typeof value !== "string") return null;
  const match = UUID.exec(value);
  if (!match) return null;
  return match.slice(1).join("-").toLowerCase();
}

/** Canonical UUID or throw InvalidIdError. */
export function validId(value) {
  const id = normalizeUuid(value);
  if (id === null) throw new InvalidIdError("id is not a UUID");
  return id;
}
