/**
 * Transport layer. All environment probing is lazy: nothing in this module
 * touches `window` at import time, so the SDK is safe to import under SSR
 * and dead-code-eliminates cleanly.
 */

import { BridgeUnavailableError } from './errors.js';

/** How call frames leave the page and event frames come back in. */
export interface Transport {
  /**
   * Send one call frame. Resolves with the host's response frame (a string).
   * Rejections are surfaced to the pending call as E_UNAVAILABLE.
   */
  send(frame: string): Promise<string>;
  /**
   * Install the host->JS receive path. Returns an uninstall function.
   * The default WebView transport wires `window.__hoomiRx`.
   */
  connect(onFrame: (frame: string) => void): () => void;
}

/**
 * Shape the host injects at document-start (main frame only). The real host
 * publishes capabilities as a boolean map ({"wallet":true,"ble":false});
 * an array of enabled names is also accepted for hand-built test bootstraps.
 */
export interface HoomiBootstrap {
  nonce: string;
  epoch: number;
  appId: string;
  appVersion?: string;
  protocol: number;
  capabilities: Record<string, boolean> | string[];
  grantedScopes: string[];
  locale?: string;
}

/** Normalize either capabilities shape to the list of enabled names. */
export function capabilityNames(capabilities: HoomiBootstrap['capabilities'] | unknown): string[] {
  if (Array.isArray(capabilities)) {
    return capabilities.filter((c): c is string => typeof c === 'string');
  }
  if (typeof capabilities === 'object' && capabilities !== null) {
    return Object.entries(capabilities as Record<string, unknown>)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name);
  }
  return [];
}

interface FlutterInAppWebView {
  callHandler(name: string, ...args: unknown[]): Promise<unknown>;
}

interface HoomiWindow {
  flutter_inappwebview?: FlutterInAppWebView;
  __hoomiBootstrap?: HoomiBootstrap;
  __hoomiRx?: (frame: string) => void;
  /** Bounded buffer the host's document-start script fills until the SDK loads. */
  __hoomiRxQueue?: unknown;
}

function hoomiWindow(): (Window & HoomiWindow) | undefined {
  return typeof window === 'undefined' ? undefined : (window as Window & HoomiWindow);
}

/** Transport over flutter_inappwebview's callHandler bridge. */
export class FlutterInAppWebViewTransport implements Transport {
  async send(frame: string): Promise<string> {
    const w = hoomiWindow();
    const bridge = w?.flutter_inappwebview;
    if (!bridge || typeof bridge.callHandler !== 'function') {
      throw new BridgeUnavailableError('flutter_inappwebview bridge is not present');
    }
    const response = await bridge.callHandler('hoomi', frame);
    if (typeof response !== 'string') {
      throw new BridgeUnavailableError('Host returned a non-string response frame');
    }
    return response;
  }

  connect(onFrame: (frame: string) => void): () => void {
    const w = hoomiWindow();
    if (!w) return () => {};
    const previous = w.__hoomiRx;
    w.__hoomiRx = onFrame;
    // The host's document-start script buffers events pushed before this
    // module evaluated into a bounded window.__hoomiRxQueue. Drain it now or
    // those frames are lost. The array itself stays (emptied): the host's
    // buffering __hoomiRx closure still references it if we ever disconnect.
    const queue = w.__hoomiRxQueue;
    if (Array.isArray(queue) && queue.length > 0) {
      for (const frame of queue.splice(0, queue.length)) {
        if (typeof frame === 'string') {
          try {
            onFrame(frame);
          } catch {
            /* a bad buffered frame must not break the drain */
          }
        }
      }
    }
    return () => {
      if (w.__hoomiRx === onFrame) {
        if (previous) w.__hoomiRx = previous;
        else delete w.__hoomiRx;
      }
    };
  }
}

/** Transport used outside the Hoomi host: every send rejects E_UNAVAILABLE. */
export class NullTransport implements Transport {
  send(): Promise<string> {
    return Promise.reject(new BridgeUnavailableError());
  }

  connect(): () => void {
    return () => {};
  }
}

/**
 * Lazy detection: returns a WebView transport when the flutter_inappwebview
 * bridge is present, otherwise null. Never called at import time.
 */
export function detectTransport(): Transport | null {
  const w = hoomiWindow();
  if (w?.flutter_inappwebview && typeof w.flutter_inappwebview.callHandler === 'function') {
    return new FlutterInAppWebViewTransport();
  }
  return null;
}

function isValidBootstrap(b: unknown): b is HoomiBootstrap {
  if (typeof b !== 'object' || b === null) return false;
  const r = b as Record<string, unknown>;
  const caps = r['capabilities'];
  return (
    typeof r['nonce'] === 'string' &&
    typeof r['epoch'] === 'number' &&
    typeof r['appId'] === 'string' &&
    (Array.isArray(caps) || (typeof caps === 'object' && caps !== null)) &&
    Array.isArray(r['grantedScopes']) &&
    typeof r['protocol'] === 'number'
  );
}

/**
 * Read `window.__hoomiBootstrap` once, copy it into a plain object owned by
 * the caller, and remove it from `window` so later page scripts cannot read
 * the nonce. Returns null when not running inside the Hoomi host.
 */
export function captureBootstrap(): HoomiBootstrap | null {
  const w = hoomiWindow();
  if (!w) return null;
  const raw = w.__hoomiBootstrap;
  if (raw !== undefined) {
    try {
      delete w.__hoomiBootstrap;
    } catch {
      /* non-configurable property: fall through to overwrite */
    }
    if (w.__hoomiBootstrap !== undefined) {
      w.__hoomiBootstrap = undefined as unknown as HoomiBootstrap;
    }
  }
  if (!isValidBootstrap(raw)) return null;
  const copy: HoomiBootstrap = {
    nonce: raw.nonce,
    epoch: raw.epoch,
    appId: raw.appId,
    protocol: raw.protocol,
    capabilities: Array.isArray(raw.capabilities) ? [...raw.capabilities] : { ...raw.capabilities },
    grantedScopes: [...raw.grantedScopes],
  };
  if (typeof raw.appVersion === 'string') copy.appVersion = raw.appVersion;
  if (typeof raw.locale === 'string') copy.locale = raw.locale;
  return copy;
}
