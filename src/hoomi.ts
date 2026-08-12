/**
 * The Hoomi facade: what micro-app code actually uses.
 *
 * Environment detection is fully lazy — nothing here touches `window` until
 * `createHoomi()` / `getHoomi()` is called at runtime, so importing the SDK
 * is safe under SSR and in tests.
 */

import { createApiNamespaces, type ApiNamespaces } from './api/namespaces.js';
import type { LaunchPayload } from './api/types.js';
import {
  BridgeClient,
  type BridgeStatus,
  type CallOptions,
  type HelloResult,
  type Subscription,
  type SubscriptionObserver,
} from './core/client.js';
import type { EventFrame } from './core/codec.js';
import { toHoomiError } from './core/errors.js';
import { captureBootstrap, detectTransport, type HoomiBootstrap, type Transport } from './core/transport.js';

export type BackPressHandler = () => boolean | Promise<boolean>;

export interface HoomiOptions {
  /** Override the transport (used by the mock host and tests). */
  transport?: Transport;
  /** Override the bootstrap (used by tests; normally read from window). */
  bootstrap?: HoomiBootstrap;
  defaultTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}

export interface Hoomi extends ApiNamespaces {
  readonly appId: string;
  /** Micro-app version string from the host bootstrap ('' when unknown). */
  readonly appVersion: string;
  /** Host UI locale from the bootstrap ('' when unknown). */
  readonly locale: string;
  readonly status: BridgeStatus;
  readonly epoch: number;
  readonly scopes: readonly string[];
  readonly capabilities: readonly string[];
  /** Launch payload from lifecycle.load, or null if it has not arrived yet. */
  readonly launchPayload: LaunchPayload | null;

  /** True when running inside the Hoomi host with a live bridge. */
  isAvailable(): boolean;
  /** Resolves when the host.hello handshake completes. */
  ready(): Promise<HelloResult>;
  hasScope(scope: string): boolean;
  hasCapability(capability: string): boolean;

  /** Escape hatch for methods this SDK version has no wrapper for. */
  call<T = unknown>(method: string, params?: unknown, opts?: CallOptions): Promise<T>;
  subscribe(method: string, params: unknown, observer: SubscriptionObserver, opts?: CallOptions): Promise<Subscription>;
  /** Raw host event subscription (lifecycle.load replays to late subscribers). */
  on(event: string, handler: (data: unknown, frame: EventFrame) => void): () => void;
  onStatusChange(handler: (status: BridgeStatus) => void): () => void;

  onLoad(handler: (payload: LaunchPayload) => void): () => void;
  onShow(handler: () => void): () => void;
  onHide(handler: () => void): () => void;
  onError(handler: (message: string, data?: unknown) => void): () => void;
  onScopesChanged(handler: (scopes: readonly string[]) => void): () => void;
  /**
   * Register a hardware/host back-press handler. Handlers run newest-first;
   * the first to return (or resolve) true stops propagation and the SDK
   * acks "handled" to the host. Returns an unregister function.
   */
  onBackPress(handler: BackPressHandler): () => void;

  dispose(): void;
}

export function createHoomi(options: HoomiOptions = {}): Hoomi {
  const transport = options.transport ?? detectTransport();
  // Capture (and delete from window) even when a transport override is
  // passed: the nonce must never stay readable by later page scripts.
  const captured = captureBootstrap();
  const bootstrap = options.bootstrap ?? captured;

  const clientOptions: ConstructorParameters<typeof BridgeClient>[0] = { transport, bootstrap };
  if (options.defaultTimeoutMs !== undefined) clientOptions.defaultTimeoutMs = options.defaultTimeoutMs;
  if (options.handshakeTimeoutMs !== undefined) clientOptions.handshakeTimeoutMs = options.handshakeTimeoutMs;
  const client = new BridgeClient(clientOptions);

  const api = createApiNamespaces(client);

  let launchPayload: LaunchPayload | null = null;
  client.on('lifecycle.load', (data) => {
    launchPayload = (data ?? {}) as LaunchPayload;
  });

  // Back-press protocol: host pushes lifecycle.backPress {pressId}; the SDK
  // must ack with lifecycle.backPressResult {pressId, handled} before the
  // host's grace timeout, otherwise the host treats it as unhandled.
  const backHandlers: BackPressHandler[] = [];
  client.on('lifecycle.backPress', (data) => {
    const pressId = (data as { pressId?: unknown } | undefined)?.pressId;
    void (async () => {
      let handled = false;
      for (let i = backHandlers.length - 1; i >= 0; i--) {
        const handler = backHandlers[i];
        if (!handler) continue;
        try {
          if (await handler()) {
            handled = true;
            break;
          }
        } catch {
          // A throwing handler counts as "not handled"; keep going.
        }
      }
      try {
        await client.call('lifecycle.backPressResult', {
          pressId: typeof pressId === 'string' ? pressId : null,
          handled,
        });
      } catch {
        // Grace timeout on the host side already covers a lost ack.
      }
    })();
  });

  const hoomi: Hoomi = {
    ...api,

    get appId() {
      return client.appId;
    },
    get appVersion() {
      return client.appVersion;
    },
    get locale() {
      return client.locale;
    },
    get status() {
      return client.status;
    },
    get epoch() {
      return client.epoch;
    },
    get scopes() {
      return client.scopes;
    },
    get capabilities() {
      return client.capabilities;
    },
    get launchPayload() {
      return launchPayload;
    },

    isAvailable: () => client.status === 'ready' || client.status === 'connecting',
    ready: () => client.ready(),
    hasScope: (scope) => client.scopes.includes(scope),
    hasCapability: (capability) => client.capabilities.includes(capability),

    call: <T = unknown>(method: string, params?: unknown, opts?: CallOptions) =>
      client.call(method, params, opts).catch((err) => {
        throw toHoomiError(err);
      }) as Promise<T>,
    subscribe: (method, params, observer, opts) => client.subscribe(method, params, observer, opts),
    on: (event, handler) => client.on(event, handler),
    onStatusChange: (handler) => client.onStatusChange(handler),

    onLoad: (handler) => client.on('lifecycle.load', (data) => handler((data ?? {}) as LaunchPayload)),
    onShow: (handler) => client.on('lifecycle.show', () => handler()),
    onHide: (handler) => client.on('lifecycle.hide', () => handler()),
    onError: (handler) =>
      client.on('lifecycle.error', (data) => {
        const d = data as { message?: unknown } | undefined;
        handler(typeof d?.message === 'string' ? d.message : 'Unknown host error', data);
      }),
    onScopesChanged: (handler) => client.on('lifecycle.scopesChanged', () => handler(client.scopes)),
    onBackPress: (handler) => {
      backHandlers.push(handler);
      return () => {
        const i = backHandlers.lastIndexOf(handler);
        if (i >= 0) backHandlers.splice(i, 1);
      };
    },

    dispose: () => {
      if (shared === hoomi) shared = null;
      client.dispose();
    },
  };

  return hoomi;
}

let shared: Hoomi | null = null;

/**
 * Lazily-created shared instance. First call performs bootstrap capture and
 * starts the handshake; subsequent calls return the same instance.
 */
export function getHoomi(options?: HoomiOptions): Hoomi {
  if (!shared) shared = createHoomi(options);
  return shared;
}

/** Test-only: forget the shared instance without disposing it. */
export function resetSharedHoomi(): void {
  shared = null;
}
