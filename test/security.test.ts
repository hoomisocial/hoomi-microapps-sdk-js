/**
 * Window-level integration: the SDK against installMockHost, exactly as a
 * micro-app would run it in a browser (jsdom here).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createHoomi, getHoomi, resetSharedHoomi, type Hoomi } from '../src/index.js';
import { installMockHost, type MockHostHandle } from '../src/mock/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TestWindow {
  __hoomiBootstrap?: { nonce?: string };
  __hoomiRx?: unknown;
  __hoomiRxQueue?: unknown;
  flutter_inappwebview?: unknown;
}

const w = () => window as unknown as TestWindow;

let host: MockHostHandle | null = null;
let hoomi: Hoomi | null = null;

afterEach(() => {
  hoomi?.dispose();
  hoomi = null;
  host?.uninstall();
  host = null;
  resetSharedHoomi();
});

describe('bootstrap capture and nonce hygiene', () => {
  it('deletes __hoomiBootstrap from window at init so the nonce is unreadable', async () => {
    host = installMockHost();
    const nonce = w().__hoomiBootstrap?.nonce;
    expect(typeof nonce).toBe('string');
    expect((nonce as string).length).toBeGreaterThan(8);

    hoomi = createHoomi(); // full detection path: window bridge + bootstrap
    // The very next synchronous statement already cannot see it:
    expect(w().__hoomiBootstrap).toBeUndefined();
    expect('__hoomiBootstrap' in window).toBe(false);

    await hoomi.ready();
    // The bridge still works (the nonce lives on in closure-private state).
    await hoomi.storage.set('k', 'v');
    expect(await hoomi.storage.get('k')).toBe('v');

    // The nonce is not reachable through the public object either.
    const surface = hoomi as unknown as Record<string, unknown>;
    expect(surface['nonce']).toBeUndefined();
    expect(JSON.stringify(Object.keys(surface))).not.toContain('nonce');
  });

  it('bootstrap values (appId, appVersion, locale, capabilities map) surface on the facade', async () => {
    host = installMockHost({ appId: 'app.acme.store', capabilities: ['wallet', 'location'] });
    hoomi = createHoomi();
    await hoomi.ready();
    expect(hoomi.appId).toBe('app.acme.store');
    expect(hoomi.appVersion).toBe('1.0.0');
    expect(hoomi.locale).toBe('en-US');
    expect(hoomi.hasCapability('wallet')).toBe(true);
    expect(hoomi.hasCapability('nfc')).toBe(false);
  });
});

describe('__hoomiRxQueue drain', () => {
  it('events buffered before the SDK loads are replayed, oldest first', async () => {
    host = installMockHost();
    // Host pushes before the SDK module has evaluated: the bootstrap shim
    // buffers into __hoomiRxQueue.
    host.emit('lifecycle.load', { params: { early: true } });
    expect((w().__hoomiRxQueue as string[]).length).toBe(1);

    hoomi = createHoomi();
    expect((w().__hoomiRxQueue as string[]).length).toBe(0); // drained at connect

    const seen: unknown[] = [];
    hoomi.onLoad((p) => seen.push(p));
    await hoomi.ready();
    await sleep(20);
    // First the buffered pre-init load, then the mock's own post-hello load.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect((seen[0] as { params?: { early?: boolean } }).params?.early).toBe(true);
  });
});

describe('shared instance and teardown', () => {
  it('getHoomi returns one shared instance; dispose + uninstall restore window', async () => {
    host = installMockHost();
    const first = getHoomi();
    hoomi = first;
    expect(getHoomi()).toBe(first);
    await first.ready();
    first.dispose();
    expect(getHoomi()).not.toBe(first); // disposed instance is forgotten
    getHoomi().dispose();
    resetSharedHoomi();
    host.uninstall();
    host = null;
    hoomi = null;
    expect(w().flutter_inappwebview).toBeUndefined();
    expect(w().__hoomiRx).toBeUndefined();
    expect(w().__hoomiRxQueue).toBeUndefined();
  });

  it('URL-driven scenario and latency are honoured', async () => {
    window.history.replaceState(null, '', '/?hoomi_scenario=no-scopes&hoomi_latency=0');
    try {
      host = installMockHost();
      expect(host.scenario).toBe('no-scopes');
      hoomi = createHoomi();
      await hoomi.ready();
      expect(hoomi.scopes).toEqual([]);
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });
});
