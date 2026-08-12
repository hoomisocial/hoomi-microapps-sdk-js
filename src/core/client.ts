/**
 * Bridge client: handshake, pending-request correlation, subscriptions,
 * abort/timeout, and epoch tracking.
 */

import { decodeInboundFrame, encodeCallFrame, utf8ByteLength, PROTOCOL_VERSION, type EventFrame } from './codec.js';
import {
  BridgeUnavailableError,
  HoomiError,
  TimeoutError,
  UserCancelledError,
  errorFromWire,
  toHoomiError,
} from './errors.js';
import { createIdGenerator, isValidMethod } from './ids.js';
import { capabilityNames, type HoomiBootstrap, type Transport } from './transport.js';

export const SDK_VERSION = '0.1.0';

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HostLimits {
  maxPayloadBytes?: number;
  maxSubscriptions?: number;
  backPressGraceMs?: number;
  [key: string]: unknown;
}

export interface HelloResult {
  protocol: number;
  host: { name?: string; version?: string; platform?: string;[key: string]: unknown };
  appId: string;
  scopes: string[];
  capabilities: string[];
  limits: HostLimits;
}

export type BridgeStatus = 'connecting' | 'ready' | 'unavailable' | 'error' | 'disposed';

export interface SubscriptionObserver<T = unknown> {
  next?: (data: T) => void;
  /** Non-terminal stream errors (e.g. a transient GPS failure). */
  error?: (error: HoomiError) => void;
  complete?: () => void;
}

export interface Subscription {
  readonly subId: string;
  readonly closed: boolean;
  /** Idempotent. Sends bridge.unsubscribe; safe to call after stream.done. */
  close(): Promise<void>;
}

export interface BridgeClientOptions {
  transport: Transport | null;
  bootstrap: HoomiBootstrap | null;
  /** Default per-call timeout. <= 0 disables. Default: 30_000 ms. */
  defaultTimeoutMs?: number;
  /** Timeout for the host.hello handshake. Default: 10_000 ms. */
  handshakeTimeoutMs?: number;
}

interface Pending {
  settle: (fn: () => void) => void;
  resolve: (data: unknown) => void;
  reject: (err: HoomiError) => void;
}

interface SubRecord {
  observer: SubscriptionObserver;
  closed: boolean;
}

const UNKNOWN_SUB_BUFFER_CAP = 32;

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export class BridgeClient {
  #transport: Transport;
  #nonce: string;
  #epoch: number;
  #appId: string;
  #appVersion: string;
  #locale: string;
  #scopes: string[];
  #capabilities: string[];
  #limits: HostLimits = {};
  #hello: HelloResult | null = null;

  #status: BridgeStatus;
  #statusListeners = new Set<(status: BridgeStatus) => void>();

  #nextId = createIdGenerator('c');
  #pending = new Map<string, Pending>();
  #subs = new Map<string, SubRecord>();
  #unknownSubBuffer = new Map<string, EventFrame[]>();

  #listeners = new Map<string, Set<(data: unknown, frame: EventFrame) => void>>();
  #loadFrame: EventFrame | null = null;

  #readyPromise: Promise<HelloResult>;
  #disconnectRx: (() => void) | null = null;
  #defaultTimeoutMs: number;

  constructor(options: BridgeClientOptions) {
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;

    if (!options.transport || !options.bootstrap) {
      this.#transport = null as unknown as Transport; // never dereferenced: every call short-circuits on status
      this.#nonce = '';
      this.#epoch = 0;
      this.#appId = '';
      this.#appVersion = '';
      this.#locale = '';
      this.#scopes = [];
      this.#capabilities = [];
      this.#status = 'unavailable';
      this.#readyPromise = Promise.reject(new BridgeUnavailableError());
      this.#readyPromise.catch(() => {}); // avoid unhandled rejection when nobody awaits ready()
      return;
    }

    const b = options.bootstrap;
    this.#transport = options.transport;
    this.#nonce = b.nonce;
    this.#epoch = b.epoch;
    this.#appId = b.appId;
    this.#appVersion = b.appVersion ?? '';
    this.#locale = b.locale ?? '';
    this.#scopes = [...b.grantedScopes];
    this.#capabilities = capabilityNames(b.capabilities);
    this.#status = 'connecting';
    this.#disconnectRx = this.#transport.connect((raw) => this.#handleRaw(raw));
    this.#readyPromise = this.#handshake(handshakeTimeoutMs);
    this.#readyPromise.catch(() => {});
  }

  async #handshake(timeoutMs: number): Promise<HelloResult> {
    try {
      const data = await this.call('host.hello', { sdk: SDK_VERSION, protocol: PROTOCOL_VERSION }, { timeoutMs });
      const r = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
      const protocol = typeof r['protocol'] === 'number' ? r['protocol'] : PROTOCOL_VERSION;
      if (protocol !== PROTOCOL_VERSION) {
        throw new HoomiError('E_PROTOCOL', `Host speaks protocol ${protocol}, SDK speaks ${PROTOCOL_VERSION}`);
      }
      const hello: HelloResult = {
        protocol,
        host: (typeof r['host'] === 'object' && r['host'] !== null ? r['host'] : {}) as HelloResult['host'],
        appId: typeof r['appId'] === 'string' ? r['appId'] : this.#appId,
        scopes: asStringArray(r['scopes']),
        capabilities: 'capabilities' in r ? capabilityNames(r['capabilities']) : [],
        limits: (typeof r['limits'] === 'object' && r['limits'] !== null ? r['limits'] : {}) as HostLimits,
      };
      this.#hello = hello;
      this.#appId = hello.appId;
      if (hello.scopes.length > 0 || 'scopes' in r) this.#scopes = hello.scopes;
      if (hello.capabilities.length > 0 || 'capabilities' in r) this.#capabilities = hello.capabilities;
      this.#limits = hello.limits;
      this.#setStatus('ready');
      return hello;
    } catch (err) {
      const mapped = toHoomiError(err, 'E_UNAVAILABLE');
      if (this.#status !== 'disposed') {
        this.#setStatus(mapped instanceof BridgeUnavailableError ? 'unavailable' : 'error');
      }
      throw mapped;
    }
  }

  get status(): BridgeStatus {
    return this.#status;
  }

  get appId(): string {
    return this.#appId;
  }

  get appVersion(): string {
    return this.#appVersion;
  }

  get locale(): string {
    return this.#locale;
  }

  get epoch(): number {
    return this.#epoch;
  }

  get scopes(): readonly string[] {
    return this.#scopes;
  }

  get capabilities(): readonly string[] {
    return this.#capabilities;
  }

  get limits(): Readonly<HostLimits> {
    return this.#limits;
  }

  get hello(): HelloResult | null {
    return this.#hello;
  }

  get activeSubscriptionCount(): number {
    return this.#subs.size;
  }

  /** Resolves once the host.hello handshake has completed. */
  ready(): Promise<HelloResult> {
    return this.#readyPromise;
  }

  onStatusChange(listener: (status: BridgeStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  #setStatus(status: BridgeStatus): void {
    if (this.#status === status || this.#status === 'disposed') return;
    this.#status = status;
    for (const l of [...this.#statusListeners]) {
      try {
        l(status);
      } catch {
        /* listener errors must not break the bridge */
      }
    }
  }

  /**
   * Subscribe to host-pushed events. `lifecycle.load` is replayed: if it
   * already arrived, the handler is invoked on a microtask with the cached
   * payload, so late subscribers (React mounting after the handshake) never
   * miss the launch params.
   */
  on(event: string, handler: (data: unknown, frame: EventFrame) => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(handler);
    if (event === 'lifecycle.load' && this.#loadFrame) {
      const frame = this.#loadFrame;
      queueMicrotask(() => {
        if (set.has(handler)) {
          try {
            handler(frame.data, frame);
          } catch {
            /* ignore */
          }
        }
      });
    }
    return () => {
      set.delete(handler);
    };
  }

  #emit(event: string, data: unknown, frame: EventFrame): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(data, frame);
      } catch {
        /* listener errors must not break the bridge */
      }
    }
  }

  call(method: string, params?: unknown, options: CallOptions = {}): Promise<unknown> {
    if (this.#status === 'disposed') {
      return Promise.reject(new BridgeUnavailableError('Bridge client has been disposed'));
    }
    if (this.#status === 'unavailable' && !this.#hello) {
      return Promise.reject(new BridgeUnavailableError());
    }
    if (!isValidMethod(method)) {
      return Promise.reject(new HoomiError('E_INVALID_PARAMS', `Invalid method name: ${JSON.stringify(method)}`));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new UserCancelledError('E_CANCELLED', 'Call aborted before send'));
    }
    return this.#dispatch(method, params, options);
  }

  async #dispatch(method: string, params: unknown, options: CallOptions): Promise<unknown> {
    if (method !== 'host.hello') {
      // All calls wait for the handshake; its failure propagates as HoomiError.
      await this.#readyPromise;
    }
    if (options.signal?.aborted) {
      throw new UserCancelledError('E_CANCELLED', 'Call aborted before send');
    }

    const id = this.#nextId();
    const frame = encodeCallFrame({
      v: PROTOCOL_VERSION,
      id,
      type: 'call',
      method,
      ...(params !== undefined ? { params } : {}),
      n: this.#nonce,
      e: this.#epoch,
    });

    const cap = this.#limits.maxPayloadBytes;
    if (typeof cap === 'number' && cap > 0 && utf8ByteLength(frame) > cap) {
      throw new HoomiError('E_PAYLOAD_TOO_LARGE', `Call frame exceeds host payload cap of ${cap} bytes`, {
        data: { method, bytes: utf8ByteLength(frame), maxPayloadBytes: cap },
      });
    }

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signal = options.signal;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        this.#pending.delete(id);
      };
      const pending: Pending = {
        settle: (fn) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        },
        resolve: (data) => pending.settle(() => resolve(data)),
        reject: (err) => pending.settle(() => reject(err)),
      };
      const onAbort = () => pending.reject(new UserCancelledError('E_CANCELLED', `Call to ${method} was aborted`));

      const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(
          () => pending.reject(new TimeoutError(`Call to ${method} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      this.#pending.set(id, pending);

      this.#transport.send(frame).then(
        (raw) => this.#handleRaw(raw, id),
        (err) =>
          pending.reject(
            err instanceof HoomiError ? err : new BridgeUnavailableError('Bridge transport failed', { cause: err }),
          ),
      );
    });
  }

  /** Route one inbound frame (from the send() promise or from window.__hoomiRx). */
  #handleRaw(raw: string, originId?: string): void {
    if (this.#status === 'disposed') return;
    let frame;
    try {
      frame = decodeInboundFrame(raw);
    } catch (err) {
      // Malformed frame. If it arrived as the direct response to a call we
      // still know which call it belongs to; fail that call instead of
      // letting it dangle until timeout.
      if (originId !== undefined) {
        this.#pending.get(originId)?.reject(toHoomiError(err, 'E_PROTOCOL'));
      }
      return;
    }

    if (frame.type === 'result') {
      const pending = this.#pending.get(frame.id);
      if (!pending) {
        // Late (post-timeout), duplicate, or foreign id: dropped by design.
        // But if this was the direct response to a *different* pending call,
        // that call will never get an answer — settle it now. The host sends
        // id "" when it rejected a frame before it could recover the id
        // (e.g. over the payload cap, pre-parse); in that case its error is
        // authoritative for the originating call.
        if (originId !== undefined && frame.id !== originId) {
          const origin = this.#pending.get(originId);
          if (origin) {
            if (!frame.ok && frame.error) {
              origin.reject(errorFromWire(frame.error));
            } else {
              origin.reject(
                new HoomiError('E_PROTOCOL', `Host answered call ${originId} with mismatched id "${frame.id}"`),
              );
            }
          }
        }
        return;
      }
      if (frame.ok) pending.resolve(frame.data);
      else pending.reject(errorFromWire(frame.error ?? { code: 'E_INTERNAL' }));
      return;
    }

    // Event frame.
    if (typeof frame.e === 'number' && frame.e > this.#epoch) {
      this.#epoch = frame.e; // host bumped the epoch (e.g. after re-auth)
    }
    if (frame.event.startsWith('stream.') && frame.sub !== undefined) {
      this.#routeStream(frame);
      return;
    }
    if (frame.event === 'lifecycle.load') {
      this.#loadFrame = frame;
    } else if (frame.event === 'lifecycle.scopesChanged') {
      const d = frame.data as { scopes?: unknown } | undefined;
      if (d && Array.isArray(d.scopes)) this.#scopes = asStringArray(d.scopes);
    }
    this.#emit(frame.event, frame.data, frame);
  }

  #routeStream(frame: EventFrame): void {
    const subId = frame.sub as string;
    const record = this.#subs.get(subId);
    if (!record) {
      // Stream event raced ahead of the bridge.subscribe result: buffer it.
      const buf = this.#unknownSubBuffer.get(subId) ?? [];
      if (buf.length < UNKNOWN_SUB_BUFFER_CAP) buf.push(frame);
      this.#unknownSubBuffer.set(subId, buf);
      return;
    }
    this.#deliverStream(record, frame, subId);
  }

  #deliverStream(record: SubRecord, frame: EventFrame, subId: string): void {
    if (record.closed) return;
    try {
      if (frame.event === 'stream.data') {
        record.observer.next?.(frame.data);
      } else if (frame.event === 'stream.error') {
        record.observer.error?.(errorFromWire(frame.error ?? { code: 'E_INTERNAL' }));
      } else if (frame.event === 'stream.done') {
        record.closed = true;
        this.#subs.delete(subId);
        record.observer.complete?.();
      }
    } catch {
      /* observer errors must not break the bridge */
    }
  }

  /**
   * Open a host-side stream via bridge.subscribe. The returned subscription
   * is guaranteed not to leak: if `options.signal` aborts (or the client is
   * disposed) while the subscribe call is in flight, the subscription is
   * closed as soon as it materialises instead of being dropped on the floor.
   */
  async subscribe(
    method: string,
    params: unknown,
    observer: SubscriptionObserver,
    options: CallOptions = {},
  ): Promise<Subscription> {
    // Deliberately do NOT forward options.signal to the underlying call: an
    // abort mid-flight would reject locally while the host still created the
    // subscription, leaking it. We let the call finish, then close if needed.
    const result = (await this.call('bridge.subscribe', { method, params }, { timeoutMs: options.timeoutMs ?? this.#defaultTimeoutMs })) as {
      subId?: unknown;
    };
    const subId = typeof result?.subId === 'string' ? result.subId : null;
    if (!subId) {
      throw new HoomiError('E_PROTOCOL', 'Host bridge.subscribe result is missing subId');
    }

    const record: SubRecord = { observer, closed: false };
    let closePromise: Promise<void> | null = null;
    const close = (): Promise<void> => {
      if (closePromise) return closePromise;
      record.closed = true;
      this.#subs.delete(subId);
      this.#unknownSubBuffer.delete(subId);
      closePromise =
        this.#status === 'disposed'
          ? Promise.resolve()
          : this.call('bridge.unsubscribe', { subId }).then(
              () => undefined,
              () => undefined, // best effort; the host GCs subs on unload anyway
            );
      return closePromise;
    };

    if (options.signal?.aborted || this.#status === 'disposed') {
      void close();
      throw new UserCancelledError('E_CANCELLED', `Subscription to ${method} was aborted`);
    }

    this.#subs.set(subId, record);
    const buffered = this.#unknownSubBuffer.get(subId);
    if (buffered) {
      this.#unknownSubBuffer.delete(subId);
      for (const f of buffered) this.#deliverStream(record, f, subId);
    }
    options.signal?.addEventListener('abort', () => void close(), { once: true });

    return {
      subId,
      get closed() {
        return record.closed;
      },
      close,
    };
  }

  dispose(): void {
    if (this.#status === 'disposed') return;
    const pendings = [...this.#pending.values()];
    this.#pending.clear();
    this.#setStatus('disposed');
    this.#status = 'disposed';
    for (const p of pendings) {
      p.reject(new BridgeUnavailableError('Bridge client has been disposed'));
    }
    for (const [subId, record] of [...this.#subs]) {
      record.closed = true;
      this.#subs.delete(subId);
      try {
        record.observer.complete?.();
      } catch {
        /* ignore */
      }
    }
    this.#unknownSubBuffer.clear();
    this.#listeners.clear();
    this.#statusListeners.clear();
    this.#loadFrame = null;
    this.#disconnectRx?.();
    this.#disconnectRx = null;
  }
}
