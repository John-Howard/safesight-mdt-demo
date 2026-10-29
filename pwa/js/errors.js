// Error types raised by the SafeSight client and the stores. Classes only for Error subclasses.

export class SafeSightError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AuthError extends SafeSightError {}
export class PermissionDenied extends SafeSightError {}
export class NotFound extends SafeSightError {}
export class RateLimited extends SafeSightError {}

/**
 * SafeSight is down or unreachable. `status` is the HTTP status for a 5xx response and
 * null for a network failure (connection refused, CORS, timeout, bad JSON), so callers can
 * tell the two apart. `cause` holds the original fetch error for network failures.
 */
export class ServerUnavailable extends SafeSightError {
  constructor(message, status = null, options) {
    super(message, options);
    this.status = status;
  }
}

/** SafeSight issued an access token we cannot identify a user from. */
export class InvalidTokenError extends SafeSightError {}

/** An AOI, file or user id that is not a UUID; never allowed to become a storage key. */
export class InvalidIdError extends SafeSightError {}
