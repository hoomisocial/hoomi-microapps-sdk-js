/**
 * Mock Hoomi host. Emulates the real host's *constraints*, not just its
 * happy path: nonce/epoch validation, id and method grammar, payload caps,
 * subscription quotas, scope and permission enforcement, and the back-press
 * grace timeout. A mock that is nicer than the real host produces micro-apps
 * that work on a laptop and fail on device.
 */

import { decodeCallFrame, encodeFrame, utf8ByteLength } from '../core/codec.js';
import { HoomiError } from '../core/errors.js';
import { isValidMethod } from '../core/ids.js';
import type { HoomiBootstrap, Transport } from '../core/transport.js';
import type { GeoPosition, HoomiPage, HoomiProduct, JsonValue, LaunchPayload, UserProfile } from '../api/types.js';
import { isScenarioName, type ScenarioName } from './scenarios.js';
import { TrackLog } from './trackLog.js';

export type PermissionDomain = 'location' | 'camera' | 'microphone' | 'bluetooth';
export type PermissionState = 'granted' | 'prompt' | 'denied' | 'denied_forever';

/**
 * One storefront page the signed-in mock user owns, plus what it lists.
 *
 * Products hang off the seed rather than off `page` because they are not part
 * of a page's wire shape: `pages.get` never returns a product list.
 */
export interface MockPageSeed {
  page: HoomiPage;
  products?: HoomiProduct[];
}

export interface MockLimits {
  maxPayloadBytes: number;
  maxSubscriptions: number;
  backPressGraceMs: number;
  /** Unread fixes a tracking session holds before evicting the oldest. */
  maxTrackedFixes: number;
  /** How long a tracking session runs before the host stops it. */
  maxTrackingMs: number;
}

export interface MockHostOptions {
  appId?: string;
  scopes?: string[];
  permissions?: Partial<Record<PermissionDomain, PermissionState>>;
  latencyMs?: number;
  /** Random jitter added on top of latencyMs. */
  jitterMs?: number;
  /** 0..1 probability that any call fails with retryable E_INTERNAL. */
  failureRate?: number;
  offline?: boolean;
  /** Log protocol violations loudly and record them on the handle. */
  strict?: boolean;
  /** Only used by installMockHost: render the DevTools overlay panel. */
  panel?: boolean;
  /** Seed for the deterministic PRNG driving jitter/failures/fake data. */
  seed?: number;
  scenario?: ScenarioName;
  launchParams?: Record<string, JsonValue>;
  limits?: Partial<MockLimits>;
  epoch?: number;
  capabilities?: string[];
  user?: Partial<UserProfile>;
  /**
   * Storefront pages the signed-in user owns. Any `pageId` outside this set
   * answers `E_SCOPE_DENIED`. Defaults to one page with one product.
   */
  pages?: MockPageSeed[];
  rateLimit?: { burst: number; refillPerSec: number } | null;
}

export interface RecordedCall {
  id: string;
  method: string;
  params: unknown;
  at: number;
}

export interface FrameLogEntry {
  dir: 'in' | 'out' | 'push';
  frame: string;
  at: number;
}

export interface MockCallContext {
  method: string;
  id: string;
  appId: string;
}

export type MockMethodHandler = (params: unknown, ctx: MockCallContext) => unknown | Promise<unknown>;

export interface MockStreamController {
  data(data: unknown): void;
  error(code: string, message?: string): void;
  done(): void;
}

/** Returns a cleanup function, called on unsubscribe/reset. */
export type MockStreamDriver = (params: unknown, stream: MockStreamController) => (() => void) | void;

export interface MockHostHandle {
  /** Every frame that crossed the mock bridge, oldest first. */
  readonly frames: readonly FrameLogEntry[];
  /** Every accepted call, oldest first. */
  readonly calls: readonly RecordedCall[];
  /** Protocol violations observed (always recorded; strict mode logs them). */
  readonly violations: readonly string[];
  readonly scenario: ScenarioName;
  readonly activeSubscriptionCount: number;

  /** Override a method. Returns a function that removes the override. */
  on(method: string, handler: MockMethodHandler): () => void;
  /** Register a stream driver for a subscribable method. */
  onStream(method: string, driver: MockStreamDriver): () => void;
  /** Force a method to fail with the given wire code. */
  fail(method: string, code: string, message?: string): () => void;
  /** Set base latency (and optionally jitter) applied to every call. */
  delay(latencyMs: number, jitterMs?: number): void;

  setScopes(scopes: string[]): void;
  grant(...scopes: string[]): void;
  revoke(...scopes: string[]): void;
  setPermission(domain: PermissionDomain, state: PermissionState): void;
  /**
   * Replace the set of pages the signed-in user owns. Everything not seeded
   * here is treated as somebody else's page: `E_SCOPE_DENIED`.
   */
  setPages(pages: MockPageSeed[]): void;
  setOffline(offline: boolean): void;
  /**
   * Record a fix into the running tracking session, as if the device moved.
   * Returns its `seq`. Throws when no session is actively tracking.
   */
  pushTrackFix(fix?: Partial<GeoPosition>): number;
  /** End the tracking session as the host's time limit would. */
  expireTracking(): void;
  /** End the tracking session as a dead location source would (GPS off). */
  failTracking(): void;
  /** Whether the page has asked for the screen to stay awake. */
  readonly keepScreenOn: boolean;
  /** Bump the host epoch: in-flight SDK epochs become stale (E_STALE_EPOCH). */
  setEpoch(epoch: number, announce?: boolean): void;

  /** Push an event frame to the page. */
  emit(event: string, data?: unknown, extra?: { sub?: string; e?: number }): void;
  /**
   * Simulate a hardware back press. Resolves once the SDK acks or the
   * back-press grace timeout elapses (timedOut: true, treated as unhandled).
   */
  pressBack(): Promise<{ handled: boolean; timedOut: boolean }>;
  /** Resolves with the first past-or-future call to `method`. */
  waitFor(method: string, opts?: { timeoutMs?: number }): Promise<RecordedCall>;

  applyScenario(name: ScenarioName): void;
  /** Restore the state derived from the original options; clears logs. */
  reset(): void;
  uninstall(): void;
}

const SCOPE_BY_PREFIX: Record<string, string> = {
  user: 'profile',
  location: 'location',
  camera: 'camera',
  audio: 'microphone',
  wallet: 'wallet',
  jobs: 'jobs',
  pages: 'pages',
  ble: 'ble',
  iot: 'iot',
};

/**
 * Scopes a method needs on top of its namespace's. Background tracking is a
 * separate authority from reading location while the app is on screen.
 */
const EXTRA_SCOPE_BY_METHOD: Record<string, string> = {
  'location.startTracking': 'location.background',
  'location.readTrack': 'location.background',
  'location.stopTracking': 'location.background',
};

/** Methods where `accuracy: 'high'` needs the `location.fine` scope. */
const ACCURACY_METHODS = new Set(['location.getCurrent', 'location.watch', 'location.startTracking']);

/** Fixes a tracking session has already recorded when it starts (see the vectors README). */
const TRACK_FIXTURE_FIXES = 3;
/** Minimum gap between `location.trackAvailable` hints, as on the host. */
const TRACK_NUDGE_INTERVAL_MS = 1_000;

interface MockTracking {
  trackingId: string;
  startedAt: number;
  expiresAt: number;
  state: 'active' | 'expired' | 'failed';
  log: TrackLog;
  expiry: ReturnType<typeof setTimeout> | undefined;
  cooldown: ReturnType<typeof setTimeout> | undefined;
  nudgeOwed: boolean;
}

const PERMISSION_BY_PREFIX: Record<string, PermissionDomain> = {
  location: 'location',
  camera: 'camera',
  audio: 'microphone',
  ble: 'bluetooth',
};

/** Methods that show host UI the user could cancel. */
const INTERACTIVE_METHODS = new Set([
  'camera.capture',
  'camera.pickImage',
  'camera.scanCode',
  'ble.requestDevice',
  'wallet.requestPayment',
  'ui.openExternal',
]);

const NETWORK_METHODS = new Set([
  'user.getIdToken',
  'wallet.getBalance',
  'wallet.requestPayment',
  'wallet.getPaymentStatus',
  // The page catalogue lives on the backend, so these fail offline like any
  // other server-backed read.
  'pages.list',
  'pages.get',
  'pages.listProducts',
  'iot.listDevices',
  'iot.readTelemetry',
  'iot.sendCommand',
]);

const DEFAULT_SCOPES = ['profile', 'location', 'location.fine', 'location.background', 'camera', 'microphone', 'wallet', 'jobs', 'pages', 'ble', 'iot'];
const DEFAULT_CAPABILITIES = [
  'lifecycle',
  'ui',
  'storage',
  'system',
  'user',
  'location',
  'camera',
  'audio',
  'wallet',
  'jobs',
  'pages',
  'ble',
  'iot',
];

/**
 * One page with one product, so `pages.*` answers something useful out of the
 * box. Replace with `setPages()` or the `pages` option.
 */
const DEFAULT_PAGES: MockPageSeed[] = [
  {
    page: {
      id: 1,
      name: 'Kopi Senayan',
      description: 'Single-origin beans, ground to order.',
      category: 'Food & Beverage',
      logoUrl: 'https://example.invalid/pages/1/logo.png',
      bannerUrl: 'https://example.invalid/pages/1/banner.jpg',
      followers: 1_284,
    },
    products: [
      {
        id: 101,
        pageId: 1,
        name: 'Flat White 250ml',
        priceMinor: 28_000,
        currency: 'HOOMI',
        description: 'Double ristretto, steamed milk.',
        stock: 42,
        imageUrls: ['https://example.invalid/products/101.jpg'],
      },
    ],
  },
];

/**
 * The stand-in media every capture method hands back: real (if minimal)
 * `data:` URIs rather than `mock://` placeholders, so an app that renders what
 * it got is exercising the actual contract. A `mock://` string is not
 * resolvable by anything — an `<img src>` pointed at one fails silently, which
 * is exactly the class of bug a mock is supposed to surface on a laptop.
 *
 * - photo: a genuine 160-byte 1×1 JPEG.
 * - audio: a valid 44-byte silent WAV (header only, zero samples).
 */
const MOCK_PHOTO_DATA_URI =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const MOCK_AUDIO_DATA_URI = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

/**
 * `byteLength` is *derived* from the URI, never written next to it by hand:
 * the pair has to stay consistent, and the real host reports the size of the
 * bytes it is actually returning. An app that trusts `byteLength` to decide
 * whether to upload inline would be misled by a number that drifted.
 *
 * Size before base64 expansion, as the field promises.
 */
function dataUriByteLength(dataUri: string): number {
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

const DEFAULT_LIMITS: MockLimits = {
  maxPayloadBytes: 262_144,
  maxSubscriptions: 8,
  backPressGraceMs: 350,
  maxTrackedFixes: 10_000,
  maxTrackingMs: 8 * 60 * 60 * 1000,
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

class WireFailure extends Error {
  constructor(
    readonly code: string,
    override readonly message: string,
    readonly retryable = false,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** Throw inside an on(...) handler to fail the call with a specific code. */
export function mockError(code: string, message = code, data?: unknown, retryable = false): Error {
  return new WireFailure(code, message, retryable, data);
}

interface ActiveSub {
  subId: string;
  method: string;
  cleanup: (() => void) | undefined;
}

/**
 * `payeeRef` is kept for realism but never leaves the host, and neither does
 * an idempotency key: the app-facing handle for a payment is `paymentId`.
 */
interface StoredPayment {
  paymentId: string;
  status: string;
  amountMinor: number;
  currency: string;
  orderId: string | undefined;
  payeeRef: string;
}

/**
 * The wire-visible projection of a page: exactly the v1 result shape, with
 * absent optionals omitted rather than sent as `null`, like the Dart host's
 * `toJson`. Seeds carrying extra keys do not leak them — a mock that is more
 * generous than the real host produces micro-apps that break on device.
 */
function pageView(page: HoomiPage): Record<string, unknown> {
  return {
    id: page.id,
    name: page.name,
    ...(page.description !== undefined ? { description: page.description } : {}),
    ...(page.category !== undefined ? { category: page.category } : {}),
    ...(page.logoUrl !== undefined ? { logoUrl: page.logoUrl } : {}),
    ...(page.bannerUrl !== undefined ? { bannerUrl: page.bannerUrl } : {}),
    followers: page.followers,
  };
}

/**
 * Same for a product — and note what is *not* here: no seller or user id.
 * These are the signed-in user's own products, so there is no counterparty to
 * name, and a stable identifier on this payload would be something two
 * micro-apps could join on. `priceMinor` is integer minor units, the same rule
 * the wallet enforces; the catalogue's string prices are parsed by the host,
 * so a price never reaches the page as a string.
 */
function productView(product: HoomiProduct): Record<string, unknown> {
  return {
    id: product.id,
    pageId: product.pageId,
    name: product.name,
    priceMinor: product.priceMinor,
    currency: product.currency,
    ...(product.description !== undefined ? { description: product.description } : {}),
    stock: product.stock,
    imageUrls: [...product.imageUrls],
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MockHost implements MockHostHandle {
  readonly #options: MockHostOptions;
  #nonce: string;
  #epoch: number;
  #appId = '';
  #scopes = new Set<string>();
  #capabilities: string[] = [];
  #permissions = new Map<PermissionDomain, PermissionState>();
  #limits: MockLimits = { ...DEFAULT_LIMITS };
  #tracking: MockTracking | null = null;
  #keepScreenOn = false;
  #latencyMs = 0;
  #jitterMs = 0;
  #failureRate = 0;
  #offline = false;
  #strict = false;
  #cancelEverything = false;
  #scenario: ScenarioName = 'happy';
  #rateLimit: { burst: number; refillPerSec: number } | null = null;
  #tokens = 0;
  #lastRefill = 0;
  #rand: () => number = Math.random;
  #launchParams: Record<string, JsonValue> = {};
  #user: UserProfile = { id: 'u-mock-1' };

  #frames: FrameLogEntry[] = [];
  #calls: RecordedCall[] = [];
  #violations: string[] = [];
  #waiters = new Map<string, Array<(call: RecordedCall) => void>>();
  #handlers = new Map<string, MockMethodHandler>();
  #streamDrivers = new Map<string, MockStreamDriver>();
  #failures = new Map<string, { code: string; message: string }>();

  #storage = new Map<string, JsonValue>();
  #balance = 12_500_000;
  #payments = new Map<string, StoredPayment>();
  #jobs = new Map<string, { jobId: string; name: string; runAt: number; payload?: Record<string, JsonValue> }>();
  #pages = new Map<number, HoomiPage>();
  #products = new Map<number, HoomiProduct[]>();
  #bleConnected = new Set<string>();
  #recordings = new Map<string, { recordingId: string; startedAt: number }>();
  #subs = new Map<string, ActiveSub>();
  #seq = 0;
  #helloSeen = false;
  #backWaiters = new Map<string, (handled: boolean) => void>();
  #rxSinks = new Set<(frame: string) => void>();
  #uninstalled = false;
  #onUninstall: Array<() => void> = [];

  constructor(options: MockHostOptions = {}) {
    this.#options = options;
    this.#nonce = '';
    this.#epoch = 0;
    this.#applyOptions();
  }

  #applyOptions(): void {
    const o = this.#options;
    this.#rand = mulberry32(o.seed ?? 0x600d5eed);
    this.#nonce = `mock-nonce-${Math.floor(this.#rand() * 0xffffffff).toString(16)}-${Math.floor(this.#rand() * 0xffffffff).toString(16)}`;
    this.#epoch = o.epoch ?? 1;
    this.#appId = o.appId ?? 'app.mock.demo';
    this.#scopes = new Set(o.scopes ?? DEFAULT_SCOPES);
    this.#capabilities = [...(o.capabilities ?? DEFAULT_CAPABILITIES)];
    this.#permissions = new Map<PermissionDomain, PermissionState>([
      ['location', 'prompt'],
      ['camera', 'prompt'],
      ['microphone', 'prompt'],
      ['bluetooth', 'prompt'],
    ]);
    for (const [k, v] of Object.entries(o.permissions ?? {})) {
      if (v) this.#permissions.set(k as PermissionDomain, v);
    }
    this.#limits = { ...DEFAULT_LIMITS, ...(o.limits ?? {}) };
    this.#latencyMs = o.latencyMs ?? 0;
    this.#jitterMs = o.jitterMs ?? 0;
    this.#failureRate = o.failureRate ?? 0;
    this.#offline = o.offline ?? false;
    this.#strict = o.strict ?? false;
    this.#cancelEverything = false;
    this.#rateLimit = o.rateLimit ?? null;
    this.#tokens = this.#rateLimit?.burst ?? 0;
    this.#lastRefill = Date.now();
    this.#scenario = 'happy';
    this.#launchParams = { ...(o.launchParams ?? {}) };
    this.#user = {
      id: 'u-mock-1',
      displayName: 'Mock User',
      email: 'mock.user@example.com',
      avatarUrl: 'https://example.invalid/avatar.png',
      ...(o.user ?? {}),
    };
    this.#balance = 12_500_000;
    this.setPages(o.pages ?? DEFAULT_PAGES);
    if (o.scenario) this.applyScenario(o.scenario);
  }

  // -- wiring -------------------------------------------------------------

  bootstrap(): HoomiBootstrap {
    return {
      nonce: this.#nonce,
      epoch: this.#epoch,
      appId: this.#appId,
      appVersion: '1.0.0',
      protocol: 1,
      // The real host publishes capabilities as a boolean map.
      capabilities: Object.fromEntries(this.#capabilities.map((c) => [c, true])),
      grantedScopes: [...this.#scopes],
      locale: 'en-US',
    };
  }

  transport(): Transport {
    return {
      send: (frame) => this.handleCall(frame),
      connect: (onFrame) => {
        this.#rxSinks.add(onFrame);
        return () => this.#rxSinks.delete(onFrame);
      },
    };
  }

  addRxSink(sink: (frame: string) => void): () => void {
    this.#rxSinks.add(sink);
    return () => this.#rxSinks.delete(sink);
  }

  addUninstallHook(fn: () => void): void {
    this.#onUninstall.push(fn);
  }

  #push(frame: object): void {
    if (this.#uninstalled) return;
    const raw = encodeFrame(frame);
    this.#frames.push({ dir: 'push', frame: raw, at: Date.now() });
    for (const sink of [...this.#rxSinks]) {
      try {
        sink(raw);
      } catch {
        /* page-side errors are not the host's problem */
      }
    }
  }

  // -- handle API ----------------------------------------------------------

  get frames(): readonly FrameLogEntry[] {
    return this.#frames;
  }

  get calls(): readonly RecordedCall[] {
    return this.#calls;
  }

  get violations(): readonly string[] {
    return this.#violations;
  }

  get scenario(): ScenarioName {
    return this.#scenario;
  }

  get activeSubscriptionCount(): number {
    return this.#subs.size;
  }

  get keepScreenOn(): boolean {
    return this.#keepScreenOn;
  }

  pushTrackFix(fix: Partial<GeoPosition> = {}): number {
    const tracking = this.#tracking;
    if (!tracking || tracking.state !== 'active') {
      throw new Error('[hoomi-mock] pushTrackFix: not tracking — call location.startTracking first');
    }
    const seq = tracking.log.record(this.#trackFix(fix));
    this.#nudgeTracking(tracking);
    return seq;
  }

  expireTracking(): void {
    this.#endTracking('expired');
  }

  failTracking(): void {
    this.#endTracking('failed');
  }

  #trackFix(fix: Partial<GeoPosition>): GeoPosition {
    return { latitude: -6.2, longitude: 106.8, accuracy: 10, timestamp: Date.now(), isMocked: false, ...fix };
  }

  /** At once when idle, then at most one per interval — the host's rule. */
  #nudgeTracking(tracking: MockTracking): void {
    if (tracking.cooldown !== undefined) {
      tracking.nudgeOwed = true;
      return;
    }
    this.#push({
      v: 1,
      type: 'event',
      event: 'location.trackAvailable',
      data: { trackingId: tracking.trackingId, lastSeq: tracking.log.lastSeq },
    });
    tracking.cooldown = setTimeout(() => {
      tracking.cooldown = undefined;
      if (tracking.nudgeOwed) {
        tracking.nudgeOwed = false;
        this.#nudgeTracking(tracking);
      }
    }, TRACK_NUDGE_INTERVAL_MS);
  }

  /** Recording stops; the log stays readable until the page stops the session. */
  #endTracking(state: 'expired' | 'failed'): void {
    const tracking = this.#tracking;
    if (!tracking || tracking.state !== 'active') return;
    tracking.state = state;
    if (tracking.expiry !== undefined) clearTimeout(tracking.expiry);
    tracking.expiry = undefined;
    this.#push({
      v: 1,
      type: 'event',
      event: 'location.trackAvailable',
      data: { trackingId: tracking.trackingId, lastSeq: tracking.log.lastSeq },
    });
  }

  #disposeTracking(): void {
    const tracking = this.#tracking;
    if (!tracking) return;
    if (tracking.expiry !== undefined) clearTimeout(tracking.expiry);
    if (tracking.cooldown !== undefined) clearTimeout(tracking.cooldown);
    this.#tracking = null;
  }

  #requireTracking(p: Record<string, unknown>, method: string): MockTracking {
    const trackingId = this.#requireString(p, 'trackingId', method);
    const tracking = this.#tracking;
    if (!tracking || tracking.trackingId !== trackingId) {
      throw new WireFailure('E_INVALID_PARAMS', `Unknown tracking session "${trackingId}"`);
    }
    return tracking;
  }

  #describeTracking(tracking: MockTracking, resumed: boolean): Record<string, unknown> {
    return {
      trackingId: tracking.trackingId,
      startedAt: tracking.startedAt,
      expiresAt: tracking.expiresAt,
      maxBufferedFixes: this.#limits.maxTrackedFixes,
      state: tracking.state,
      resumed,
    };
  }

  on(method: string, handler: MockMethodHandler): () => void {
    this.#handlers.set(method, handler);
    return () => {
      if (this.#handlers.get(method) === handler) this.#handlers.delete(method);
    };
  }

  onStream(method: string, driver: MockStreamDriver): () => void {
    this.#streamDrivers.set(method, driver);
    return () => {
      if (this.#streamDrivers.get(method) === driver) this.#streamDrivers.delete(method);
    };
  }

  fail(method: string, code: string, message?: string): () => void {
    const entry = { code, message: message ?? `Mock failure for ${method}: ${code}` };
    this.#failures.set(method, entry);
    return () => {
      if (this.#failures.get(method) === entry) this.#failures.delete(method);
    };
  }

  delay(latencyMs: number, jitterMs = 0): void {
    this.#latencyMs = latencyMs;
    this.#jitterMs = jitterMs;
  }

  setScopes(scopes: string[]): void {
    this.#scopes = new Set(scopes);
    this.#announceScopes();
  }

  grant(...scopes: string[]): void {
    for (const s of scopes) this.#scopes.add(s);
    this.#announceScopes();
  }

  revoke(...scopes: string[]): void {
    for (const s of scopes) this.#scopes.delete(s);
    this.#announceScopes();
  }

  #announceScopes(): void {
    this.#push({ v: 1, type: 'event', event: 'lifecycle.scopesChanged', data: { scopes: [...this.#scopes] } });
  }

  setPermission(domain: PermissionDomain, state: PermissionState): void {
    this.#permissions.set(domain, state);
  }

  setPages(pages: MockPageSeed[]): void {
    this.#pages.clear();
    this.#products.clear();
    for (const seed of pages) {
      // Copied, not aliased: a test that mutates its seed afterwards must not
      // be able to reach inside the host.
      this.#pages.set(seed.page.id, { ...seed.page });
      this.#products.set(
        seed.page.id,
        (seed.products ?? []).map((product) => ({ ...product, imageUrls: [...product.imageUrls] })),
      );
    }
  }

  setOffline(offline: boolean): void {
    this.#offline = offline;
  }

  setEpoch(epoch: number, announce = false): void {
    this.#epoch = epoch;
    if (announce) {
      this.#push({ v: 1, type: 'event', event: 'lifecycle.epochChanged', e: epoch, data: { epoch } });
    }
  }

  emit(event: string, data?: unknown, extra?: { sub?: string; e?: number }): void {
    const frame: Record<string, unknown> = { v: 1, type: 'event', event };
    if (data !== undefined) frame['data'] = data;
    if (extra?.sub !== undefined) frame['sub'] = extra.sub;
    if (extra?.e !== undefined) frame['e'] = extra.e;
    this.#push(frame);
  }

  pressBack(): Promise<{ handled: boolean; timedOut: boolean }> {
    const pressId = `bp-${++this.#seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#backWaiters.delete(pressId);
        resolve({ handled: false, timedOut: true });
      }, this.#limits.backPressGraceMs);
      this.#backWaiters.set(pressId, (handled) => {
        clearTimeout(timer);
        this.#backWaiters.delete(pressId);
        resolve({ handled, timedOut: false });
      });
      this.#push({ v: 1, type: 'event', event: 'lifecycle.backPress', data: { pressId } });
    });
  }

  waitFor(method: string, opts: { timeoutMs?: number } = {}): Promise<RecordedCall> {
    const existing = this.#calls.find((c) => c.method === method);
    if (existing) return Promise.resolve(existing);
    const timeoutMs = opts.timeoutMs ?? 5_000;
    return new Promise((resolve, reject) => {
      const list = this.#waiters.get(method) ?? [];
      const timer = setTimeout(() => {
        const current = this.#waiters.get(method);
        if (current) {
          const i = current.indexOf(entry);
          if (i >= 0) current.splice(i, 1);
        }
        reject(new HoomiError('E_TIMEOUT', `waitFor(${method}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const entry = (call: RecordedCall) => {
        clearTimeout(timer);
        resolve(call);
      };
      list.push(entry);
      this.#waiters.set(method, list);
    });
  }

  applyScenario(name: ScenarioName): void {
    if (!isScenarioName(name)) return;
    this.#scenario = name;
    switch (name) {
      case 'happy':
        break;
      case 'deny-all':
        for (const d of ['location', 'camera', 'microphone', 'bluetooth'] as const) this.#permissions.set(d, 'denied');
        break;
      case 'deny-forever':
        for (const d of ['location', 'camera', 'microphone', 'bluetooth'] as const)
          this.#permissions.set(d, 'denied_forever');
        break;
      case 'cancel-everything':
        this.#cancelEverything = true;
        break;
      case 'slow-3g':
        this.#latencyMs = 1_200;
        this.#jitterMs = 600;
        break;
      case 'offline':
        this.#offline = true;
        break;
      case 'rate-limited':
        this.#rateLimit = { burst: 3, refillPerSec: 0.5 };
        this.#tokens = 3;
        this.#lastRefill = Date.now();
        break;
      case 'no-scopes':
        this.#scopes = new Set();
        break;
    }
  }

  reset(): void {
    for (const sub of this.#subs.values()) sub.cleanup?.();
    this.#subs.clear();
    this.#frames = [];
    this.#calls = [];
    this.#violations = [];
    this.#waiters.clear();
    this.#handlers.clear();
    this.#streamDrivers.clear();
    this.#failures.clear();
    this.#storage.clear();
    this.#payments.clear();
    this.#jobs.clear();
    this.#bleConnected.clear();
    this.#recordings.clear();
    this.#backWaiters.clear();
    this.#disposeTracking();
    this.#keepScreenOn = false;
    this.#helloSeen = false;
    this.#applyOptions();
  }

  uninstall(): void {
    if (this.#uninstalled) return;
    this.#uninstalled = true;
    this.#disposeTracking();
    for (const sub of this.#subs.values()) sub.cleanup?.();
    this.#subs.clear();
    this.#rxSinks.clear();
    for (const fn of this.#onUninstall.splice(0)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }

  // -- call handling --------------------------------------------------------

  async handleCall(raw: string): Promise<string> {
    this.#frames.push({ dir: 'in', frame: raw, at: Date.now() });
    const respond = (frame: object): string => {
      const encoded = encodeFrame(frame);
      this.#frames.push({ dir: 'out', frame: encoded, at: Date.now() });
      return encoded;
    };
    const failure = (id: string, code: string, message: string, retryable = false, data?: unknown): string =>
      respond({
        v: 1,
        id,
        type: 'result',
        ok: false,
        error: { code, message, retryable, ...(data !== undefined ? { data } : {}) },
      });

    // Like the real host: the payload cap is enforced BEFORE parsing, so an
    // oversized frame gets an error frame with an empty id — the id is never
    // recovered from a frame that was refused this early.
    if (utf8ByteLength(raw) > this.#limits.maxPayloadBytes) {
      return failure('', 'E_PAYLOAD_TOO_LARGE', `Frame exceeds ${this.#limits.maxPayloadBytes} bytes`, false, {
        maxPayloadBytes: this.#limits.maxPayloadBytes,
      });
    }

    // Shared codec (protocol/vectors/codec): echoes recoverable ids, never
    // reflects hostile ones (empty id instead).
    const decoded = decodeCallFrame(raw);
    if (!decoded.ok) {
      this.#violation(decoded.message);
      return failure(decoded.id ?? '', decoded.errorCode, decoded.message);
    }
    const { id, method, epoch, nonce, params } = decoded.call;
    if (nonce !== this.#nonce) {
      this.#violation(`bad nonce on ${method}`);
      return failure(id, 'E_PROTOCOL', 'Bad nonce');
    }
    if (epoch !== this.#epoch) {
      return failure(id, 'E_STALE_EPOCH', `Call epoch ${epoch} != host epoch ${this.#epoch}`);
    }

    const call: RecordedCall = { id, method, params, at: Date.now() };
    this.#calls.push(call);
    const waiters = this.#waiters.get(method);
    if (waiters) {
      this.#waiters.delete(method);
      for (const w of waiters) w(call);
    }

    if (this.#latencyMs > 0 || this.#jitterMs > 0) {
      await sleep(this.#latencyMs + this.#jitterMs * this.#rand());
    }

    try {
      const data = await this.#dispatch(method, params, { method, id, appId: this.#appId });
      return respond({ v: 1, id, type: 'result', ok: true, data: data ?? {} });
    } catch (err) {
      if (err instanceof WireFailure) {
        return failure(id, err.code, err.message, err.retryable, err.data);
      }
      if (err instanceof HoomiError) {
        return failure(id, err.code, err.message, err.retryable, err.data);
      }
      return failure(id, 'E_INTERNAL', err instanceof Error ? err.message : 'Mock host internal error');
    }
  }

  #violation(message: string): void {
    this.#violations.push(message);
    if (this.#strict) {
      // eslint-disable-next-line no-console
      console.error(`[hoomi-mock] protocol violation: ${message}`);
    }
  }

  #checkRateLimit(): void {
    if (!this.#rateLimit) return;
    const now = Date.now();
    const refilled = ((now - this.#lastRefill) / 1000) * this.#rateLimit.refillPerSec;
    if (refilled > 0) {
      this.#tokens = Math.min(this.#rateLimit.burst, this.#tokens + refilled);
      this.#lastRefill = now;
    }
    if (this.#tokens < 1) {
      const retryAfterMs = Math.ceil(((1 - this.#tokens) / this.#rateLimit.refillPerSec) * 1000);
      throw new WireFailure('E_RATE_LIMITED', 'Too many bridge calls', true, { retryAfterMs });
    }
    this.#tokens -= 1;
  }

  #checkScope(method: string, params?: unknown): void {
    const prefix = method.split('.')[0] ?? '';
    const required = [SCOPE_BY_PREFIX[prefix], EXTRA_SCOPE_BY_METHOD[method]];
    // Precise positioning is its own authority, whichever method asks for it.
    if (ACCURACY_METHODS.has(method) && (params as { accuracy?: unknown } | null | undefined)?.accuracy === 'high') {
      required.push('location.fine');
    }
    for (const scope of required) {
      if (scope && !this.#scopes.has(scope)) {
        throw new WireFailure('E_SCOPE_DENIED', `Method ${method} requires scope "${scope}"`, false, { scope });
      }
    }
  }

  #checkPermission(method: string): void {
    const prefix = method.split('.')[0] ?? '';
    const domain = PERMISSION_BY_PREFIX[prefix];
    if (!domain) return;
    const state = this.#permissions.get(domain) ?? 'prompt';
    if (state === 'prompt') {
      // The user "sees the system dialog" and accepts, like a first run.
      this.#permissions.set(domain, 'granted');
      return;
    }
    if (state === 'denied') {
      throw new WireFailure('E_PERMISSION_DENIED', `Permission "${domain}" denied`, false, { permission: domain });
    }
    if (state === 'denied_forever') {
      throw new WireFailure('E_PERMISSION_DENIED_FOREVER', `Permission "${domain}" permanently denied`, false, {
        permission: domain,
      });
    }
  }

  #checkInteractive(method: string): void {
    if (this.#cancelEverything && INTERACTIVE_METHODS.has(method)) {
      throw new WireFailure('E_USER_DENIED', `User cancelled ${method}`);
    }
  }

  async #dispatch(method: string, params: unknown, ctx: MockCallContext): Promise<unknown> {
    // Control-plane methods are exempt from scenario failure injection so a
    // flaky scenario cannot brick the handshake itself.
    switch (method) {
      case 'host.hello':
        return this.#handleHello();
      case 'host.getCapabilities':
        return { capabilities: Object.fromEntries(this.#capabilities.map((c) => [c, true])) };
      case 'bridge.subscribe':
        return this.#handleSubscribe(params);
      case 'bridge.unsubscribe':
        return this.#handleUnsubscribe(params);
      case 'lifecycle.backPressResult': {
        const p = (params ?? {}) as { pressId?: unknown; handled?: unknown };
        const waiter = typeof p.pressId === 'string' ? this.#backWaiters.get(p.pressId) : undefined;
        waiter?.(p.handled === true);
        return {};
      }
      default:
        break;
    }

    const forced = this.#failures.get(method);
    if (forced) throw new WireFailure(forced.code, forced.message, forced.code === 'E_RATE_LIMITED');

    this.#checkRateLimit();
    if (this.#offline && NETWORK_METHODS.has(method)) {
      throw new WireFailure('E_UNAVAILABLE', `Network is offline (mock): ${method}`, true);
    }
    if (this.#failureRate > 0 && this.#rand() < this.#failureRate) {
      throw new WireFailure('E_INTERNAL', `Injected random failure for ${method}`, true);
    }
    this.#checkScope(method, params);
    this.#checkPermission(method);
    this.#checkInteractive(method);

    const override = this.#handlers.get(method);
    if (override) return override(params, ctx);

    return this.#builtin(method, params);
  }

  #handleHello(): unknown {
    if (!this.#helloSeen) {
      this.#helloSeen = true;
      setTimeout(() => {
        this.#push({
          v: 1,
          type: 'event',
          event: 'lifecycle.load',
          data: {
            entry: 'mock',
            referrer: 'hoomi://home',
            scenario: this.#scenario,
            params: this.#launchParams,
          },
        });
        this.#push({ v: 1, type: 'event', event: 'lifecycle.show', data: {} });
      }, 0);
    }
    return {
      protocol: 1,
      host: { name: 'hoomi-mock', version: '0.1.0', platform: 'mock' },
      appId: this.#appId,
      scopes: [...this.#scopes],
      capabilities: Object.fromEntries(this.#capabilities.map((c) => [c, true])),
      limits: { ...this.#limits },
    };
  }

  #handleSubscribe(params: unknown): unknown {
    const p = (params ?? {}) as { method?: unknown; params?: unknown };
    const inner = typeof p.method === 'string' ? p.method : '';
    if (!isValidMethod(inner)) {
      throw new WireFailure('E_INVALID_PARAMS', `bridge.subscribe: invalid method ${JSON.stringify(p.method)}`);
    }
    if (this.#subs.size >= this.#limits.maxSubscriptions) {
      throw new WireFailure('E_RATE_LIMITED', `Subscription quota exceeded (max ${this.#limits.maxSubscriptions})`, true, {
        maxSubscriptions: this.#limits.maxSubscriptions,
      });
    }
    this.#checkScope(inner, p.params);
    this.#checkPermission(inner);

    const driver = this.#streamDrivers.get(inner) ?? this.#builtinStreamDriver(inner);
    if (!driver) {
      throw new WireFailure('E_UNSUPPORTED', `Method ${inner} is not subscribable`);
    }
    const subId = `s-${++this.#seq}`;
    const controller: MockStreamController = {
      data: (data) => {
        if (this.#subs.has(subId)) this.#push({ v: 1, type: 'event', event: 'stream.data', sub: subId, data });
      },
      error: (code, message) => {
        if (this.#subs.has(subId))
          this.#push({ v: 1, type: 'event', event: 'stream.error', sub: subId, error: { code, message: message ?? code } });
      },
      done: () => {
        const sub = this.#subs.get(subId);
        if (!sub) return;
        this.#subs.delete(subId);
        sub.cleanup?.();
        this.#push({ v: 1, type: 'event', event: 'stream.done', sub: subId });
      },
    };
    const record: ActiveSub = { subId, method: inner, cleanup: undefined };
    this.#subs.set(subId, record);
    const cleanup = driver(p.params, controller);
    record.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
    return { subId };
  }

  #handleUnsubscribe(params: unknown): unknown {
    const p = (params ?? {}) as { subId?: unknown };
    if (typeof p.subId !== 'string') {
      throw new WireFailure('E_INVALID_PARAMS', 'bridge.unsubscribe requires subId');
    }
    const sub = this.#subs.get(p.subId);
    if (sub) {
      this.#subs.delete(p.subId);
      sub.cleanup?.();
    }
    return {}; // idempotent, like the real host
  }

  #builtinStreamDriver(method: string): MockStreamDriver | null {
    if (method === 'location.watch') {
      return (params, stream) => {
        const p = (params ?? {}) as { minIntervalMs?: unknown };
        const interval = typeof p.minIntervalMs === 'number' && p.minIntervalMs > 0 ? p.minIntervalMs : 1_000;
        let lat = -6.2 + this.#rand() * 0.01;
        let lng = 106.816 + this.#rand() * 0.01;
        const timer = setInterval(() => {
          lat += (this.#rand() - 0.5) * 0.0005;
          lng += (this.#rand() - 0.5) * 0.0005;
          stream.data({
            latitude: lat,
            longitude: lng,
            accuracy: 8 + this.#rand() * 10,
            speed: this.#rand() * 2,
            timestamp: Date.now(),
          });
        }, interval);
        return () => clearInterval(timer);
      };
    }
    if (method === 'ble.notifications') {
      return (_params, stream) => {
        let n = 0;
        const timer = setInterval(() => {
          const bytes = new Uint8Array([n & 0xff, (n >> 8) & 0xff, Math.floor(this.#rand() * 256), 0x42]);
          n += 1;
          stream.data({ value: toBase64(bytes), timestamp: Date.now() });
        }, 800);
        return () => clearInterval(timer);
      };
    }
    return null;
  }

  #builtin(method: string, params: unknown): unknown {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      // lifecycle -----------------------------------------------------------
      case 'lifecycle.ready':
        return {};
      case 'lifecycle.close':
        setTimeout(() => {
          this.#push({ v: 1, type: 'event', event: 'lifecycle.hide', data: {} });
          this.#push({ v: 1, type: 'event', event: 'lifecycle.unload', data: {} });
        }, 0);
        return {};
      case 'lifecycle.reportError':
        return {};

      // ui --------------------------------------------------------------------
      case 'ui.toast':
      case 'ui.alert':
        this.#requireString(p, 'message', method);
        return {};
      case 'ui.confirm':
        this.#requireString(p, 'message', method);
        return { confirmed: !this.#cancelEverything };
      case 'ui.openExternal':
        this.#requireString(p, 'url', method);
        return {};
      case 'ui.setKeepScreenOn':
        if (typeof p['enabled'] !== 'boolean') {
          throw new WireFailure('E_INVALID_PARAMS', 'ui.setKeepScreenOn requires a boolean "enabled"');
        }
        this.#keepScreenOn = p['enabled'];
        return {};

      // storage ----------------------------------------------------------------
      case 'storage.get': {
        const key = this.#requireString(p, 'key', method);
        return { value: this.#storage.has(key) ? this.#storage.get(key) : null };
      }
      case 'storage.set': {
        const key = this.#requireString(p, 'key', method);
        if (!('value' in p)) throw new WireFailure('E_INVALID_PARAMS', 'storage.set requires "value"');
        this.#storage.set(key, p['value'] as JsonValue);
        return {};
      }
      case 'storage.remove': {
        this.#storage.delete(this.#requireString(p, 'key', method));
        return {};
      }
      case 'storage.keys':
        return { keys: [...this.#storage.keys()] };
      case 'storage.clear':
        this.#storage.clear();
        return {};

      // system -------------------------------------------------------------------
      case 'system.getInfo':
        // Flat, like the host: `protocol` and `appId` sit alongside the device
        // fields rather than under a `device` wrapper, so a consumer reads
        // `info.platform` and not `info.device.platform`.
        return {
          platform: 'android',
          osVersion: '14',
          hostVersion: '2.5.0-mock',
          model: 'Hoomi Simulator',
          locale: 'en-US',
          theme: 'light',
          safeAreaInsets: { top: 24, right: 0, bottom: 16, left: 0 },
          protocol: 1,
          appId: this.#appId,
        };
      case 'system.getNetworkStatus':
        return this.#offline ? { online: false, type: 'none' } : { online: true, type: 'wifi' };

      // user ----------------------------------------------------------------------
      case 'user.getProfile':
        return { ...this.#user };
      case 'user.getIdToken': {
        const expiresAt = Date.now() + 3_600_000;
        const body = toBase64(new TextEncoder().encode(JSON.stringify({ sub: this.#user.id, appId: this.#appId, exp: expiresAt })));
        return { token: `mock.${body}.sig`, expiresAt };
      }

      // location ---------------------------------------------------------------
      case 'location.getCurrent':
        return {
          latitude: -6.2 + this.#rand() * 0.01,
          longitude: 106.816 + this.#rand() * 0.01,
          accuracy: 8 + this.#rand() * 10,
          timestamp: Date.now(),
          isMocked: false,
        };
      case 'location.startTracking': {
        // Strict here, unlike getCurrent/watch: a typo would otherwise run a
        // whole trip at the wrong precision without anyone noticing.
        if ('accuracy' in p && !['coarse', 'balanced', 'high'].includes(p['accuracy'] as string)) {
          throw new WireFailure('E_INVALID_PARAMS', 'location.startTracking: accuracy must be coarse, balanced or high');
        }
        this.#optionalInt(p, 'minDistanceMeters', method, 0);
        // An ended session is handed back, never replaced: replacing it would
        // wipe fixes the page has not read.
        if (this.#tracking) return this.#describeTracking(this.#tracking, true);

        const startedAt = Date.now();
        const tracking: MockTracking = {
          trackingId: `trk-${++this.#seq}`,
          startedAt,
          expiresAt: startedAt + this.#limits.maxTrackingMs,
          state: 'active',
          log: new TrackLog(this.#limits.maxTrackedFixes),
          expiry: undefined,
          cooldown: undefined,
          nudgeOwed: false,
        };
        tracking.expiry = setTimeout(() => this.#endTracking('expired'), this.#limits.maxTrackingMs);
        for (let i = 0; i < TRACK_FIXTURE_FIXES; i++) tracking.log.record(this.#trackFix({ timestamp: startedAt + i }));
        this.#tracking = tracking;
        return this.#describeTracking(tracking, false);
      }
      case 'location.readTrack': {
        const tracking = this.#requireTracking(p, method);
        const afterSeq = this.#optionalInt(p, 'afterSeq', method, 0) ?? 0;
        const limit = this.#optionalInt(p, 'limit', method, 1, 500) ?? 200;
        return { ...tracking.log.read(afterSeq, limit), state: tracking.state };
      }
      case 'location.stopTracking':
        this.#requireTracking(p, method);
        this.#disposeTracking();
        return {};

      // camera --------------------------------------------------------------------
      case 'camera.capture':
        // 1×1 because that is genuinely what the embedded JPEG contains: an
        // app that reads width/height and an app that decodes `uri` must not
        // be told two different things.
        return this.#mediaAsset(MOCK_PHOTO_DATA_URI, 'image/jpeg', { width: 1, height: 1 });
      case 'camera.pickImage': {
        const count =
          typeof p['maxItems'] === 'number' && p['maxItems'] > 0
            ? Math.min(p['maxItems'], 20)
            : 1;
        // `assets`, matching the host: the elements are MediaAssets like every
        // other media result, so the list is not named after the picker.
        return {
          assets: Array.from({ length: count }, () =>
            this.#mediaAsset(MOCK_PHOTO_DATA_URI, 'image/jpeg', { width: 1, height: 1 }),
          ),
        };
      }
      case 'camera.scanCode':
        // The decoded payload is `text`, not `value`.
        return { text: `HOOMI-MOCK-${++this.#seq}`, format: 'qr' };

      // audio -----------------------------------------------------------------------
      case 'audio.startRecord': {
        const recordingId = `rec-${++this.#seq}`;
        this.#recordings.set(recordingId, { recordingId, startedAt: Date.now() });
        return { recordingId };
      }
      case 'audio.stopRecord': {
        const recordingId = typeof p['recordingId'] === 'string' ? p['recordingId'] : [...this.#recordings.keys()].pop();
        const rec = recordingId !== undefined ? this.#recordings.get(recordingId) : undefined;
        if (!rec) throw new WireFailure('E_INVALID_PARAMS', 'No active recording to stop');
        this.#recordings.delete(rec.recordingId);
        // The same MediaAsset the camera returns: a recording is media, and a
        // second result shape for audio is how the two SDKs drift apart.
        return this.#mediaAsset(MOCK_AUDIO_DATA_URI, 'audio/wav', {
          durationMs: Date.now() - rec.startedAt,
        });
      }
      case 'audio.cancelRecord': {
        const recordingId = typeof p['recordingId'] === 'string' ? p['recordingId'] : [...this.#recordings.keys()].pop();
        if (recordingId !== undefined) this.#recordings.delete(recordingId);
        return {};
      }

      // wallet -------------------------------------------------------------------
      case 'wallet.getBalance': {
        // Required and explicit — the mock will not invent a default currency
        // for a caller that forgot to say which wallet it means.
        const currency = this.#requireString(p, 'currency', method);
        return { amountMinor: this.#balance, currency };
      }
      case 'wallet.requestPayment': {
        const amountMinor = p['amountMinor'];
        // Integer minor units only. A float here is a defect on a money path,
        // not something to round, so it is refused rather than truncated.
        if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor < 1)
          throw new WireFailure(
            'E_INVALID_PARAMS',
            `wallet.requestPayment requires an integer "amountMinor" >= 1 (minor units), got ${JSON.stringify(amountMinor)}`,
          );
        const currency = this.#requireString(p, 'currency', method);
        // Who gets paid. Distinct from orderId, which is the caller's own
        // reference and stays optional.
        const payeeRef = this.#requireString(p, 'payeeRef', method);
        const orderId = typeof p['orderId'] === 'string' && p['orderId'].length > 0 ? p['orderId'] : undefined;
        if (amountMinor > this.#balance)
          throw new WireFailure('E_UNAVAILABLE', 'Insufficient mock wallet balance', false, {
            balance: this.#balance,
            requested: amountMinor,
          });
        this.#balance -= amountMinor;
        const paymentId = `pay-${++this.#seq}`;
        this.#payments.set(paymentId, {
          paymentId,
          status: 'succeeded',
          amountMinor,
          currency,
          orderId,
          payeeRef,
        });
        return this.#paymentView(paymentId);
      }
      case 'wallet.getPaymentStatus':
        // Same projection as requestPayment: the two results are one shape.
        return this.#paymentView(this.#requireString(p, 'paymentId', method));

      // jobs ----------------------------------------------------------------------
      case 'jobs.schedule': {
        const name = this.#requireString(p, 'name', method);
        const runAt =
          typeof p['runAt'] === 'number'
            ? p['runAt']
            : typeof p['delayMs'] === 'number'
              ? Date.now() + p['delayMs']
              : null;
        if (runAt === null) throw new WireFailure('E_INVALID_PARAMS', 'jobs.schedule requires "runAt" or "delayMs"');
        const jobId = `job-${++this.#seq}`;
        const job: { jobId: string; name: string; runAt: number; payload?: Record<string, JsonValue> } = { jobId, name, runAt };
        if (typeof p['payload'] === 'object' && p['payload'] !== null) job.payload = p['payload'] as Record<string, JsonValue>;
        this.#jobs.set(jobId, job);
        return { jobId };
      }
      case 'jobs.cancel': {
        const jobId = this.#requireString(p, 'jobId', method);
        if (!this.#jobs.delete(jobId)) throw new WireFailure('E_INVALID_PARAMS', `Unknown jobId: ${jobId}`);
        return {};
      }
      case 'jobs.list':
        return { jobs: [...this.#jobs.values()] };

      // pages ---------------------------------------------------------------------
      // The signed-in user's OWN storefronts. Not a directory: there is no way
      // in to a page this user does not own, by design.
      case 'pages.list':
        this.#requirePagesProvider(method);
        return { pages: [...this.#pages.values()].map(pageView) };
      case 'pages.get':
        this.#requirePagesProvider(method);
        return pageView(this.#requireOwnedPage(p, method));
      case 'pages.listProducts': {
        this.#requirePagesProvider(method);
        const page = this.#requireOwnedPage(p, method);
        return { products: (this.#products.get(page.id) ?? []).map(productView) };
      }

      // ble -----------------------------------------------------------------------
      case 'ble.requestDevice':
        return { deviceId: 'ble-mock-1', name: 'Hoomi Beacon', rssi: -52 };
      case 'ble.connect': {
        this.#bleConnected.add(this.#requireString(p, 'deviceId', method));
        return {};
      }
      case 'ble.disconnect': {
        this.#bleConnected.delete(this.#requireString(p, 'deviceId', method));
        return {};
      }
      case 'ble.read': {
        this.#requireBleConnection(p, method);
        const bytes = new Uint8Array(4).map(() => Math.floor(this.#rand() * 256));
        return { value: toBase64(bytes) };
      }
      case 'ble.write': {
        this.#requireBleConnection(p, method);
        this.#requireString(p, 'value', method);
        return {};
      }

      // iot ------------------------------------------------------------------------
      case 'iot.listDevices':
        return {
          devices: [
            { deviceId: 'iot-lamp-1', name: 'Living Room Lamp', kind: 'light', online: true },
            { deviceId: 'iot-therm-1', name: 'Thermostat', kind: 'thermostat', online: true },
            { deviceId: 'iot-plug-1', name: 'Coffee Machine Plug', kind: 'plug', online: false },
          ],
        };
      case 'iot.readTelemetry': {
        const deviceId = this.#requireString(p, 'deviceId', method);
        if (!['iot-lamp-1', 'iot-therm-1', 'iot-plug-1'].includes(deviceId))
          throw new WireFailure('E_INVALID_PARAMS', `Unknown deviceId: ${deviceId}`);
        return {
          deviceId,
          telemetry: {
            temperatureC: Math.round((22 + this.#rand() * 5) * 10) / 10,
            humidityPct: Math.round(55 + this.#rand() * 15),
            powerW: Math.round(this.#rand() * 60),
          },
          timestamp: Date.now(),
        };
      }
      case 'iot.sendCommand': {
        const deviceId = this.#requireString(p, 'deviceId', method);
        this.#requireString(p, 'command', method);
        if (!['iot-lamp-1', 'iot-therm-1', 'iot-plug-1'].includes(deviceId))
          throw new WireFailure('E_INVALID_PARAMS', `Unknown deviceId: ${deviceId}`);
        return { accepted: true, result: null };
      }

      default:
        throw new WireFailure('E_UNSUPPORTED', `Method ${method} is not supported by this host`);
    }
  }

  /**
   * The one media shape every capture method returns — `camera.capture`,
   * `camera.pickImage` and `audio.stopRecord` alike.
   *
   * The content goes in `uri`, because the host is the gateway to the hardware
   * and an app that asked for a photo gets the photo. `handle` is opaque and
   * session-scoped: never a filesystem path, since one would leak the app
   * sandbox layout and invite traversal. `byteLength` is derived from the URI
   * so the two can never disagree.
   *
   * No `previewDataUri`: it is only sent when `uri` is large, and none of
   * these stand-ins are.
   */
  #mediaAsset(
    dataUri: string,
    mimeType: string,
    extra: { width?: number; height?: number; durationMs?: number } = {},
  ): Record<string, unknown> {
    return {
      handle: `mock-media-${++this.#seq}`,
      uri: dataUri,
      mimeType,
      byteLength: dataUriByteLength(dataUri),
      ...(extra.width !== undefined ? { width: extra.width } : {}),
      ...(extra.height !== undefined ? { height: extra.height } : {}),
      ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
    };
  }

  /**
   * The wire-visible projection of a payment: exactly the v1 result shape.
   * `payeeRef` and any host-internal idempotency key are deliberately absent.
   */
  #paymentView(paymentId: string): Record<string, unknown> {
    const payment = this.#payments.get(paymentId);
    if (!payment) throw new WireFailure('E_INVALID_PARAMS', `Unknown paymentId: ${paymentId}`);
    return {
      paymentId: payment.paymentId,
      status: payment.status,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      ...(payment.orderId !== undefined ? { orderId: payment.orderId } : {}),
    };
  }

  /**
   * `E_UNSUPPORTED`, the way the real host answers a namespace with no
   * provider wired: permanent for this host build, so the SDK may cache it.
   * Drop `'pages'` from `capabilities` to model a host without the provider.
   */
  #requirePagesProvider(method: string): void {
    if (!this.#capabilities.includes('pages')) {
      throw new WireFailure('E_UNSUPPORTED', `Method ${method} is not supported by this host`);
    }
  }

  /**
   * A page the signed-in user owns, or `E_SCOPE_DENIED`.
   *
   * The answer is deliberately the same for a page owned by somebody else and
   * a page that does not exist at all: distinguishing them would turn
   * `pages.get` into an enumeration oracle over every Page in Hoomi, which is
   * exactly what this namespace is scoped to avoid. It is not
   * `E_INVALID_PARAMS` either — the id was well-formed, the answer is about
   * authorization, and re-prompting the user would not change it.
   */
  #requireOwnedPage(p: Record<string, unknown>, method: string): HoomiPage {
    const pageId = this.#requirePositiveInt(p, 'pageId', method);
    const page = this.#pages.get(pageId);
    if (!page) {
      throw new WireFailure('E_SCOPE_DENIED', `Page ${pageId} is not owned by the signed-in user`, false, { pageId });
    }
    return page;
  }

  #requirePositiveInt(p: Record<string, unknown>, key: string, method: string): number {
    const v = p[key];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) {
      throw new WireFailure(
        'E_INVALID_PARAMS',
        `${method} requires a positive integer "${key}" (got ${JSON.stringify(v)})`,
      );
    }
    return v;
  }

  #requireString(p: Record<string, unknown>, key: string, method: string): string {
    const v = p[key];
    if (typeof v !== 'string' || v.length === 0) {
      throw new WireFailure('E_INVALID_PARAMS', `${method} requires string "${key}"`);
    }
    return v;
  }

  /** An integer within [min, max], or undefined when absent. Anything else is the caller's bug. */
  #optionalInt(p: Record<string, unknown>, key: string, method: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
    const v = p[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      throw new WireFailure('E_INVALID_PARAMS', `${method}: "${key}" must be an integer between ${min} and ${max}`);
    }
    return v;
  }

  #requireBleConnection(p: Record<string, unknown>, method: string): void {
    const deviceId = this.#requireString(p, 'deviceId', method);
    if (!this.#bleConnected.has(deviceId)) {
      throw new WireFailure('E_UNAVAILABLE', `BLE device ${deviceId} is not connected`, true);
    }
  }
}
