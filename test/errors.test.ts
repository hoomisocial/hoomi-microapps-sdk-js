import { describe, expect, it } from 'vitest';

import {
  BridgeUnavailableError,
  ERROR_CODES,
  HoomiError,
  PermissionDeniedError,
  RateLimitedError,
  ScopeNotGrantedError,
  TimeoutError,
  UnsupportedError,
  UserCancelledError,
  errorFromWire,
  toHoomiError,
} from '../src/index.js';

describe('errorFromWire maps every known code', () => {
  const expectations: Record<string, (e: HoomiError) => void> = {
    E_UNSUPPORTED: (e) => expect(e).toBeInstanceOf(UnsupportedError),
    E_NOT_IMPLEMENTED: (e) => expect(e).toBeInstanceOf(UnsupportedError),
    E_SCOPE_DENIED: (e) => expect(e).toBeInstanceOf(ScopeNotGrantedError),
    E_USER_DENIED: (e) => expect(e).toBeInstanceOf(UserCancelledError),
    E_PERMISSION_DENIED: (e) => {
      expect(e).toBeInstanceOf(PermissionDeniedError);
      expect((e as PermissionDeniedError).permanent).toBe(false);
    },
    E_PERMISSION_DENIED_FOREVER: (e) => {
      expect(e).toBeInstanceOf(PermissionDeniedError);
      expect((e as PermissionDeniedError).permanent).toBe(true);
    },
    E_UNAUTHENTICATED: (e) => expect(e.constructor).toBe(HoomiError),
    E_INVALID_PARAMS: (e) => expect(e.constructor).toBe(HoomiError),
    E_PAYLOAD_TOO_LARGE: (e) => expect(e.constructor).toBe(HoomiError),
    E_RATE_LIMITED: (e) => expect(e).toBeInstanceOf(RateLimitedError),
    E_TIMEOUT: (e) => expect(e).toBeInstanceOf(TimeoutError),
    E_UNAVAILABLE: (e) => expect(e).toBeInstanceOf(BridgeUnavailableError),
    E_CANCELLED: (e) => expect(e).toBeInstanceOf(UserCancelledError),
    E_PROTOCOL: (e) => expect(e.constructor).toBe(HoomiError),
    E_STALE_EPOCH: (e) => expect(e.constructor).toBe(HoomiError),
    E_INTERNAL: (e) => expect(e.constructor).toBe(HoomiError),
  };

  it('covers exactly the wire code list', () => {
    expect(Object.keys(expectations).sort()).toEqual([...ERROR_CODES].sort());
  });

  for (const code of ERROR_CODES) {
    it(code, () => {
      const err = errorFromWire({ code, message: `msg for ${code}`, data: { k: 1 } });
      expect(err).toBeInstanceOf(HoomiError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`msg for ${code}`);
      expect(err.data).toEqual({ k: 1 });
      expect(err.known).toBe(true);
      expectations[code]?.(err);
    });
  }

  it('the permanent flag never gets lost between the two permission codes', () => {
    const retry = errorFromWire({ code: 'E_PERMISSION_DENIED' }) as PermissionDeniedError;
    const settings = errorFromWire({ code: 'E_PERMISSION_DENIED_FOREVER' }) as PermissionDeniedError;
    expect(retry.permanent).toBe(false);
    expect(settings.permanent).toBe(true);
    expect(retry.code).toBe('E_PERMISSION_DENIED');
    expect(settings.code).toBe('E_PERMISSION_DENIED_FOREVER');
  });

  it('unknown codes map to a generic HoomiError and never crash', () => {
    const err = errorFromWire({ code: 'E_FROM_THE_FUTURE', message: 'new hotness', retryable: true });
    expect(err.constructor).toBe(HoomiError);
    expect(err.code).toBe('E_FROM_THE_FUTURE'); // preserved for forward compat
    expect(err.known).toBe(false);
    expect(err.retryable).toBe(true);
  });

  it('an empty/absent code degrades to E_INTERNAL', () => {
    expect(errorFromWire({ code: '' }).code).toBe('E_INTERNAL');
  });

  it('respects host-provided retryable and defaults to false', () => {
    expect(errorFromWire({ code: 'E_INTERNAL', retryable: true }).retryable).toBe(true);
    expect(errorFromWire({ code: 'E_INTERNAL' }).retryable).toBe(false);
  });

  it('RateLimitedError extracts retryAfterMs from data', () => {
    const err = errorFromWire({ code: 'E_RATE_LIMITED', data: { retryAfterMs: 1500 } }) as RateLimitedError;
    expect(err.retryAfterMs).toBe(1500);
    const noData = errorFromWire({ code: 'E_RATE_LIMITED' }) as RateLimitedError;
    expect(noData.retryAfterMs).toBeUndefined();
  });
});

describe('toHoomiError enforces the no-bare-Error invariant', () => {
  it('passes HoomiError through untouched', () => {
    const original = new TimeoutError();
    expect(toHoomiError(original)).toBe(original);
  });

  it('wraps bare Errors with a cause', () => {
    const bare = new Error('boom');
    const wrapped = toHoomiError(bare);
    expect(wrapped).toBeInstanceOf(HoomiError);
    expect(wrapped.code).toBe('E_INTERNAL');
    expect(wrapped.cause).toBe(bare);
  });

  it('wraps strings and arbitrary values', () => {
    expect(toHoomiError('oops').message).toBe('oops');
    expect(toHoomiError(42).code).toBe('E_INTERNAL');
    expect(toHoomiError(undefined)).toBeInstanceOf(HoomiError);
  });
});
