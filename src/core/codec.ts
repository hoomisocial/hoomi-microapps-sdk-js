/**
 * Frame codec. Frames are single-line JSON strings, protocol version 1.
 *
 * Well-formed JSON.stringify (ES2019+) escapes lone surrogates, but it does
 * NOT escape U+2028/U+2029 — they are legal raw inside JSON strings yet act
 * as line terminators in JavaScript source. The encoder escapes them itself
 * (mirroring jsStringLiteral in the Dart host) so an encoded frame is always
 * a single line and safe to inline into generated script.
 */

import { HoomiError, type WireError } from './errors.js';
import { isValidId, isValidMethod } from './ids.js';

export const PROTOCOL_VERSION = 1;

/** JS -> host call frame. `n` (nonce) and `e` (epoch) are required on every call. */
export interface CallFrame {
  v: typeof PROTOCOL_VERSION;
  id: string;
  type: 'call';
  method: string;
  params?: unknown;
  n: string;
  e: number;
}

export interface ResultFrame {
  v: number;
  id: string;
  type: 'result';
  ok: boolean;
  data?: unknown;
  error?: WireError;
}

export interface EventFrame {
  v: number;
  type: 'event';
  event: string;
  /** Subscription id for stream.* events. */
  sub?: string;
  data?: unknown;
  error?: WireError;
  /** Optional epoch bump piggybacked on an event. */
  e?: number;
}

export type InboundFrame = ResultFrame | EventFrame;

let encoder: TextEncoder | undefined;

/** Byte length of a string as UTF-8 (what payload caps are measured in). */
export function utf8ByteLength(s: string): number {
  encoder ??= new TextEncoder();
  return encoder.encode(s).length;
}

/** Escape U+2028/U+2029: raw they are valid JSON but break the one-frame-per-line guarantee. */
function escapeLineSeparators(json: string): string {
  return json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function encodeCallFrame(frame: CallFrame): string {
  return escapeLineSeparators(JSON.stringify(frame));
}

/** Generic frame encoder (used by the mock host and tests). */
export function encodeFrame(frame: object): string {
  return escapeLineSeparators(JSON.stringify(frame));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asWireError(v: unknown): WireError {
  if (isRecord(v) && typeof v['code'] === 'string') {
    const w: WireError = { code: v['code'] };
    if (typeof v['message'] === 'string') w.message = v['message'];
    if (typeof v['retryable'] === 'boolean') w.retryable = v['retryable'];
    if ('data' in v) w.data = v['data'];
    return w;
  }
  return { code: 'E_INTERNAL', message: 'Host sent a malformed error object' };
}

/**
 * Decode and validate a host -> JS frame. Throws HoomiError(E_PROTOCOL) on
 * anything that is not a well-formed v1 result/event frame.
 */
export function decodeInboundFrame(raw: string): InboundFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new HoomiError('E_PROTOCOL', 'Host sent a frame that is not valid JSON', { cause });
  }
  if (!isRecord(parsed)) {
    throw new HoomiError('E_PROTOCOL', 'Host frame is not a JSON object');
  }
  if (parsed['v'] !== PROTOCOL_VERSION) {
    throw new HoomiError('E_PROTOCOL', `Unsupported protocol version: ${String(parsed['v'])}`);
  }
  const type = parsed['type'];
  if (type === 'result') {
    const id = parsed['id'];
    // An empty id is legal on failure frames: the host sends id "" when it
    // rejected a frame whose id it could not (or must not) recover.
    if (typeof id !== 'string' || (id !== '' && !isValidId(id))) {
      throw new HoomiError('E_PROTOCOL', 'Result frame has a missing or invalid id');
    }
    if (typeof parsed['ok'] !== 'boolean') {
      throw new HoomiError('E_PROTOCOL', 'Result frame is missing boolean "ok"');
    }
    const frame: ResultFrame = { v: PROTOCOL_VERSION, id, type: 'result', ok: parsed['ok'] };
    if ('data' in parsed) frame.data = parsed['data'];
    if (!frame.ok) frame.error = asWireError(parsed['error']);
    return frame;
  }
  if (type === 'event') {
    const event = parsed['event'];
    if (typeof event !== 'string' || event.length === 0) {
      throw new HoomiError('E_PROTOCOL', 'Event frame is missing "event"');
    }
    const frame: EventFrame = { v: PROTOCOL_VERSION, type: 'event', event };
    if (typeof parsed['sub'] === 'string') frame.sub = parsed['sub'];
    if ('data' in parsed) frame.data = parsed['data'];
    if ('error' in parsed) frame.error = asWireError(parsed['error']);
    if (typeof parsed['e'] === 'number') frame.e = parsed['e'];
    return frame;
  }
  throw new HoomiError('E_PROTOCOL', `Unknown frame type: ${String(type)}`);
}

// ---------------------------------------------------------------------------
// Host-side call decoding (shared conformance corpus: protocol/vectors/codec)
// ---------------------------------------------------------------------------

export interface DecodedCall {
  id: string;
  method: string;
  epoch: number;
  nonce: string;
  params: Record<string, unknown>;
}

export type CallDecodeResult =
  | { ok: true; call: DecodedCall }
  | {
      ok: false;
      errorCode: 'E_PROTOCOL' | 'E_INVALID_PARAMS';
      /**
       * Echo target. A recoverable id is echoed so the caller's promise can
       * settle; null when the frame had no id safe to reflect back (hostile
       * or missing ids are never echoed).
       */
      id: string | null;
      message: string;
    };

/**
 * Decode a JS -> host call frame the way the host does. Mirrors the Dart
 * codec in hoomi_microapp; both run protocol/vectors/codec so they cannot
 * drift. Session-level checks (nonce value, epoch freshness, payload cap)
 * are NOT here — they belong to the session, not the codec.
 */
export function decodeCallFrame(raw: string): CallDecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errorCode: 'E_PROTOCOL', id: null, message: 'Frame is not valid JSON' };
  }
  if (!isRecord(parsed)) {
    return { ok: false, errorCode: 'E_PROTOCOL', id: null, message: 'Frame is not a JSON object' };
  }
  const rawId = parsed['id'];
  const id = typeof rawId === 'string' && isValidId(rawId) ? rawId : null;
  if (id === null) {
    return { ok: false, errorCode: 'E_PROTOCOL', id: null, message: 'Call id missing or outside the safe charset' };
  }
  if (parsed['v'] !== PROTOCOL_VERSION) {
    return { ok: false, errorCode: 'E_PROTOCOL', id, message: `Unsupported protocol version: ${String(parsed['v'])}` };
  }
  if (parsed['type'] !== 'call') {
    return { ok: false, errorCode: 'E_PROTOCOL', id, message: `Expected a call frame, got ${String(parsed['type'])}` };
  }
  const method = parsed['method'];
  if (typeof method !== 'string' || !isValidMethod(method)) {
    return { ok: false, errorCode: 'E_PROTOCOL', id, message: `Invalid method name: ${JSON.stringify(method)}` };
  }
  const nonce = parsed['n'];
  if (typeof nonce !== 'string' || nonce.length === 0) {
    return { ok: false, errorCode: 'E_PROTOCOL', id, message: 'Missing nonce' };
  }
  const epoch = parsed['e'];
  if (typeof epoch !== 'number' || !Number.isInteger(epoch)) {
    return { ok: false, errorCode: 'E_PROTOCOL', id, message: 'Missing or non-integer epoch' };
  }
  let params: Record<string, unknown> = {};
  if ('params' in parsed) {
    const p = parsed['params'];
    if (!isRecord(p)) {
      return { ok: false, errorCode: 'E_INVALID_PARAMS', id, message: 'params must be a JSON object' };
    }
    params = p;
  }
  return { ok: true, call: { id, method, epoch, nonce, params } };
}
