// @vitest-environment node
/**
 * SSR safety: importing the SDK must never touch `window`, and creating an
 * instance outside the host degrades to 'unavailable' instead of crashing.
 */

import { describe, expect, it } from 'vitest';

import { BridgeUnavailableError, createHoomi, detectTransport } from '../src/index.js';

describe('SSR / non-browser environments', () => {
  it('there is no window here (precondition)', () => {
    expect(typeof window).toBe('undefined');
  });

  it('detectTransport is lazy and returns null without a window', () => {
    expect(detectTransport()).toBeNull();
  });

  it('createHoomi degrades to unavailable; calls reject with BridgeUnavailableError', async () => {
    const hoomi = createHoomi();
    expect(hoomi.status).toBe('unavailable');
    expect(hoomi.isAvailable()).toBe(false);
    await expect(hoomi.ui.toast('hi')).rejects.toBeInstanceOf(BridgeUnavailableError);
    await expect(hoomi.ready()).rejects.toBeInstanceOf(BridgeUnavailableError);
    const err = await hoomi.wallet.getBalance({ currency: 'IDR' }).catch((e: unknown) => e);
    expect((err as BridgeUnavailableError).code).toBe('E_UNAVAILABLE');
    hoomi.dispose();
  });
});
