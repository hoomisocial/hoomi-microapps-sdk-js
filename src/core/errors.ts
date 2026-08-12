/**
 * Error model for the Hoomi bridge.
 *
 * Invariant: nothing crossing the public API ever rejects with a bare `Error`
 * or a string. Everything is a `HoomiError` (or one of its subclasses), and
 * unknown host error codes map to a generic `HoomiError` — never a crash.
 */

/** Wire error codes the host may send. */
export const ERROR_CODES = [
  'E_UNSUPPORTED',
  'E_NOT_IMPLEMENTED',
  'E_SCOPE_DENIED',
  'E_USER_DENIED',
  'E_PERMISSION_DENIED',
  'E_PERMISSION_DENIED_FOREVER',
  'E_UNAUTHENTICATED',
  'E_INVALID_PARAMS',
  'E_PAYLOAD_TOO_LARGE',
  'E_RATE_LIMITED',
  'E_TIMEOUT',
  'E_UNAVAILABLE',
  'E_CANCELLED',
  'E_PROTOCOL',
  'E_STALE_EPOCH',
  'E_INTERNAL',
] as const;

export type HoomiErrorCode = (typeof ERROR_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

/** Error payload as it appears on the wire. */
export interface WireError {
  code: string;
  message?: string;
  retryable?: boolean;
  data?: unknown;
}

export interface HoomiErrorInit {
  retryable?: boolean;
  data?: unknown;
  cause?: unknown;
}

/**
 * Base class for every error produced by this SDK.
 *
 * `code` is one of the known `HoomiErrorCode` strings, or — for forward
 * compatibility — whatever unknown code the host sent (preserved verbatim so
 * callers can still branch on it; `known` tells you which case you are in).
 */
export class HoomiError extends Error {
  readonly code: HoomiErrorCode | (string & {});
  readonly retryable: boolean;
  readonly data: unknown;
  /** False when the host sent a code this SDK version does not know. */
  readonly known: boolean;

  constructor(code: string, message?: string, init: HoomiErrorInit = {}) {
    super(message ?? code, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'HoomiError';
    this.code = code;
    this.retryable = init.retryable ?? false;
    this.data = init.data;
    this.known = KNOWN_CODES.has(code);
  }
}

/** The user dismissed or declined the flow (E_USER_DENIED / E_CANCELLED). */
export class UserCancelledError extends HoomiError {
  constructor(code: 'E_USER_DENIED' | 'E_CANCELLED' = 'E_USER_DENIED', message?: string, init?: HoomiErrorInit) {
    super(code, message ?? (code === 'E_CANCELLED' ? 'Operation was cancelled' : 'User declined the request'), init);
    this.name = 'UserCancelledError';
  }
}

/**
 * A device permission was denied. `permanent` distinguishes
 * E_PERMISSION_DENIED (show "Retry") from E_PERMISSION_DENIED_FOREVER
 * (show "Open Settings") — do not collapse the two.
 */
export class PermissionDeniedError extends HoomiError {
  readonly permanent: boolean;

  constructor(permanent: boolean, message?: string, init?: HoomiErrorInit) {
    super(
      permanent ? 'E_PERMISSION_DENIED_FOREVER' : 'E_PERMISSION_DENIED',
      message ?? (permanent ? 'Permission permanently denied' : 'Permission denied'),
      init,
    );
    this.name = 'PermissionDeniedError';
    this.permanent = permanent;
  }
}

/** The micro-app was not granted the OAuth-style scope this method needs. */
export class ScopeNotGrantedError extends HoomiError {
  constructor(message?: string, init?: HoomiErrorInit) {
    super('E_SCOPE_DENIED', message ?? 'Required scope not granted', init);
    this.name = 'ScopeNotGrantedError';
  }
}

/** The host does not support this method (E_UNSUPPORTED / E_NOT_IMPLEMENTED). */
export class UnsupportedError extends HoomiError {
  constructor(code: 'E_UNSUPPORTED' | 'E_NOT_IMPLEMENTED' = 'E_UNSUPPORTED', message?: string, init?: HoomiErrorInit) {
    super(code, message ?? 'Not supported by this host', init);
    this.name = 'UnsupportedError';
  }
}

export class TimeoutError extends HoomiError {
  constructor(message?: string, init?: HoomiErrorInit) {
    super('E_TIMEOUT', message ?? 'Bridge call timed out', { retryable: true, ...init });
    this.name = 'TimeoutError';
  }
}

export class RateLimitedError extends HoomiError {
  /** Milliseconds to wait before retrying, when the host provides it. */
  readonly retryAfterMs: number | undefined;

  constructor(message?: string, init?: HoomiErrorInit) {
    super('E_RATE_LIMITED', message ?? 'Rate limited by host', { retryable: true, ...init });
    this.name = 'RateLimitedError';
    const data = init?.data;
    this.retryAfterMs =
      typeof data === 'object' && data !== null && typeof (data as { retryAfterMs?: unknown }).retryAfterMs === 'number'
        ? (data as { retryAfterMs: number }).retryAfterMs
        : undefined;
  }
}

/** No usable bridge: not inside the Hoomi host, or the bridge went away. */
export class BridgeUnavailableError extends HoomiError {
  constructor(message?: string, init?: HoomiErrorInit) {
    super('E_UNAVAILABLE', message ?? 'Hoomi bridge is not available in this environment', init);
    this.name = 'BridgeUnavailableError';
  }
}

/** Map a wire error object to the narrowest matching HoomiError subclass. */
export function errorFromWire(wire: WireError): HoomiError {
  const init: HoomiErrorInit = { data: wire.data };
  if (wire.retryable !== undefined) init.retryable = wire.retryable;
  const message = wire.message;
  switch (wire.code) {
    case 'E_USER_DENIED':
      return new UserCancelledError('E_USER_DENIED', message, init);
    case 'E_CANCELLED':
      return new UserCancelledError('E_CANCELLED', message, init);
    case 'E_PERMISSION_DENIED':
      return new PermissionDeniedError(false, message, init);
    case 'E_PERMISSION_DENIED_FOREVER':
      return new PermissionDeniedError(true, message, init);
    case 'E_SCOPE_DENIED':
      return new ScopeNotGrantedError(message, init);
    case 'E_UNSUPPORTED':
      return new UnsupportedError('E_UNSUPPORTED', message, init);
    case 'E_NOT_IMPLEMENTED':
      return new UnsupportedError('E_NOT_IMPLEMENTED', message, init);
    case 'E_TIMEOUT':
      return new TimeoutError(message, init);
    case 'E_RATE_LIMITED':
      return new RateLimitedError(message, init);
    case 'E_UNAVAILABLE':
      return new BridgeUnavailableError(message, init);
    default:
      // Known-but-plain codes (E_UNAUTHENTICATED, E_INVALID_PARAMS, ...) and
      // unknown codes both land here. Unknown codes are preserved verbatim
      // (`known === false`) so callers can still inspect them.
      return new HoomiError(typeof wire.code === 'string' && wire.code.length > 0 ? wire.code : 'E_INTERNAL', message, init);
  }
}

/**
 * Coerce any thrown value into a HoomiError. Enforces the public-API
 * invariant: user-visible rejections are always HoomiError instances.
 */
export function toHoomiError(value: unknown, fallbackCode: HoomiErrorCode = 'E_INTERNAL'): HoomiError {
  if (value instanceof HoomiError) return value;
  if (value instanceof Error) {
    return new HoomiError(fallbackCode, value.message, { cause: value });
  }
  return new HoomiError(fallbackCode, typeof value === 'string' ? value : 'Unknown error', { cause: value });
}
