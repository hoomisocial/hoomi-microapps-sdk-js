/**
 * Camera and audio payload contract (protocol v1), with `camera.recordVideo`
 * as the interesting case.
 *
 * Every media-producing method — `camera.capture`, `camera.pickImage`,
 * `camera.recordVideo`, `audio.stopRecord` — resolves to the same
 * `MediaAsset`. That is pinned here as well as in the shared corpus, because
 * a per-method result type is exactly how this SDK and the Dart host drifted
 * apart once already.
 *
 * Two behaviours are surprising enough to be worth pinning:
 *
 * - the result carries the *content* (`uri`) and an opaque `handle` that is
 *   never a filesystem path — an app that asked for a video gets the video,
 *   not a receipt it cannot redeem;
 * - `E_PAYLOAD_TOO_LARGE` is the expected answer for most real recordings, so
 *   it must reach the caller as a rejection rather than being swallowed into
 *   an empty-ish result.
 *
 * The oversized path has no vector in protocol/vectors/methods/: the vector
 * format can only make calls, and there is no protocol method a micro-app may
 * call that puts a host into "cannot store this" state. It is covered here
 * instead, via the mock's `videoTooLarge` knob.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  HoomiError,
  PermissionDeniedError,
  ScopeNotGrantedError,
  UnsupportedError,
  UserCancelledError,
  type MediaAsset,
} from '../src/index.js';
import { createTestHoomi, type TestHoomi } from '../src/testing/index.js';

let active: TestHoomi[] = [];
const make = (...args: Parameters<typeof createTestHoomi>): TestHoomi => {
  const t = createTestHoomi(...args);
  active.push(t);
  return t;
};

afterEach(() => {
  for (const t of active) t.cleanup();
  active = [];
});

const cameraCalls = (host: TestHoomi['host']) => host.calls.filter((c) => c.method.startsWith('camera.'));

describe('camera.recordVideo', () => {
  it('resolves to the recording itself: content in uri, plus an opaque handle', async () => {
    const { hoomi } = make();
    const asset: MediaAsset = await hoomi.camera.recordVideo();

    expect(typeof asset.uri).toBe('string');
    expect(asset.uri.length).toBeGreaterThan(0);
    expect(asset.mimeType).toBe('video/mp4');
    expect(Number.isSafeInteger(asset.byteLength)).toBe(true);
    expect(typeof asset.handle).toBe('string');
  });

  it('the handle is opaque and is never a filesystem path', async () => {
    // A path would leak the app sandbox layout and invite traversal, which is
    // exactly why the host hands back a session-scoped reference instead.
    const { hoomi } = make();
    const { handle } = await hoomi.camera.recordVideo();
    expect(handle).not.toMatch(/[/\\]/);
    expect(handle).not.toMatch(/^file:/i);
    expect(handle).not.toMatch(/\.(mp4|mov|tmp)$/i);
  });

  it('sends only the params it was given', async () => {
    const { hoomi, host } = make();
    await hoomi.camera.recordVideo();
    expect(host.calls.find((c) => c.method === 'camera.recordVideo')?.params).toEqual({});

    await hoomi.camera.recordVideo({ facing: 'front', maxDurationMs: 5_000 });
    expect(host.calls.filter((c) => c.method === 'camera.recordVideo')[1]?.params).toEqual({
      facing: 'front',
      maxDurationMs: 5_000,
    });
  });

  it('never records for longer than the caller asked for', async () => {
    const { hoomi } = make();
    const asset = await hoomi.camera.recordVideo({ maxDurationMs: 500 });
    expect(asset.durationMs).toBeLessThanOrEqual(500);
  });

  it('rejects a malformed maxDurationMs BEFORE it reaches the wire', async () => {
    const { hoomi, host } = make();
    await hoomi.ready();

    // TypeScript cannot express "positive integer", so 1500.5 type-checks.
    const bad: unknown[] = [0, -1, -1_000, 1_500.5, Number.NaN, Number.POSITIVE_INFINITY, '5000', null, 2 ** 53];
    for (const maxDurationMs of bad) {
      const err = await hoomi.camera.recordVideo({ maxDurationMs } as never).catch((e: unknown) => e);
      expect((err as HoomiError).code, `maxDurationMs=${String(maxDurationMs)}`).toBe('E_INVALID_PARAMS');
      expect((err as HoomiError).message).toContain('maxDurationMs');
    }
    expect(cameraCalls(host)).toEqual([]);
    expect(host.frames.filter((f) => f.frame.includes('camera.recordVideo'))).toEqual([]);
  });

  it('undefined maxDurationMs is "no limit", not a validation failure', async () => {
    const { hoomi, host } = make();
    // `as never`: exactOptionalPropertyTypes forbids writing this in TS, but
    // JS callers spread it out of state all the time, and an absent key must
    // not become the string "undefined" on the wire.
    await hoomi.camera.recordVideo({ facing: 'back', maxDurationMs: undefined } as never);
    expect(host.calls.find((c) => c.method === 'camera.recordVideo')?.params).toEqual({ facing: 'back' });
  });

  it('the host refuses a duration outside its own window, after the page-side check passes', async () => {
    // 50ms is a positive integer, so the page-side guard lets it through; the
    // host's accepted window (100ms..10min) is the host's to enforce.
    const { hoomi, host } = make();
    const err = await hoomi.camera.recordVideo({ maxDurationMs: 50 }).catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_INVALID_PARAMS');
    expect(cameraCalls(host).map((c) => c.method)).toEqual(['camera.recordVideo']);
  });
});

describe('camera.recordVideo oversized recordings', () => {
  it('surfaces E_PAYLOAD_TOO_LARGE as a rejection instead of swallowing it', async () => {
    // The common case for video: too big to travel inline, and the host has
    // nowhere to store it. An app must be able to see that and degrade.
    const { hoomi } = make({ videoTooLarge: true });
    const outcome = await hoomi.camera
      .recordVideo({ maxDurationMs: 600_000 })
      .then((asset) => ({ resolved: true as const, asset }))
      .catch((err: unknown) => ({ resolved: false as const, err }));

    expect(outcome.resolved, 'an oversized recording must not resolve').toBe(false);
    if (outcome.resolved) return;
    expect(outcome.err).toBeInstanceOf(HoomiError);
    expect((outcome.err as HoomiError).code).toBe('E_PAYLOAD_TOO_LARGE');
    // Retrying the same call unchanged cannot help — a shorter recording can.
    expect((outcome.err as HoomiError).retryable).toBe(false);
  });

  it('is a toggle, so an app can be exercised on both paths', async () => {
    const { hoomi, host } = make();
    expect((await hoomi.camera.recordVideo()).mimeType).toBe('video/mp4');

    host.setVideoTooLarge(true);
    const err = await hoomi.camera.recordVideo().catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_PAYLOAD_TOO_LARGE');

    host.setVideoTooLarge(false);
    expect(typeof (await hoomi.camera.recordVideo()).uri).toBe('string');
  });

  it('leaves the other camera methods alone: a photo still fits inline', async () => {
    const { hoomi } = make({ videoTooLarge: true });
    await expect(hoomi.camera.capture()).resolves.toMatchObject({
      uri: expect.any(String),
      handle: expect.any(String),
      byteLength: expect.any(Number),
    });
  });
});

/** Decodes a `data:` URI's payload back to bytes, so byteLength can be checked. */
function dataUriBytes(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  expect(uri.slice(0, comma)).toMatch(/^data:[^;]+;base64$/);
  const binary = atob(uri.slice(comma + 1));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

describe('every media method returns one MediaAsset shape', () => {
  const isMediaAsset = (asset: MediaAsset): void => {
    expect(typeof asset.handle).toBe('string');
    expect(asset.handle.length).toBeGreaterThan(0);
    expect(typeof asset.uri).toBe('string');
    expect(typeof asset.mimeType).toBe('string');
    expect(Number.isSafeInteger(asset.byteLength)).toBe(true);
    // A handle is opaque and session-scoped. A filesystem path would leak the
    // app sandbox layout and invite traversal.
    expect(asset.handle).not.toMatch(/[/\\]/);
  };

  it('camera.capture', async () => {
    const { hoomi } = make();
    isMediaAsset(await hoomi.camera.capture());
  });

  it('camera.pickImage — the list is `assets`, matching the host', async () => {
    const { hoomi } = make();
    const { assets } = await hoomi.camera.pickImage({ maxItems: 3 });
    expect(assets).toHaveLength(3);
    for (const asset of assets) isMediaAsset(asset);
    // Distinct handles: two picked photos are two assets, not one aliased.
    expect(new Set(assets.map((a) => a.handle)).size).toBe(3);
  });

  it('audio.stopRecord', async () => {
    const { hoomi } = make();
    const { recordingId } = await hoomi.audio.startRecord();
    const asset = await hoomi.audio.stopRecord({ recordingId });
    isMediaAsset(asset);
    expect(typeof asset.durationMs).toBe('number');
  });

  it('camera.recordVideo', async () => {
    const { hoomi } = make();
    isMediaAsset(await hoomi.camera.recordVideo());
  });

  it('the mock returns resolvable data: URIs, and byteLength matches them', async () => {
    // A `mock://` placeholder resolves to nothing: an <img src> pointed at one
    // fails silently, which is the class of bug the mock exists to surface on
    // a laptop rather than on device.
    const { hoomi } = make();
    const { recordingId } = await hoomi.audio.startRecord();
    const assets = [
      await hoomi.camera.capture(),
      await hoomi.camera.recordVideo(),
      await hoomi.audio.stopRecord({ recordingId }),
    ];
    for (const asset of assets) {
      expect(asset.uri.startsWith('data:'), asset.uri.slice(0, 32)).toBe(true);
      expect(dataUriBytes(asset.uri).length).toBe(asset.byteLength);
    }
    // And the bytes are the media they claim to be, not filler.
    const magic = (uri: string, from: number, to: number): number[] => [...dataUriBytes(uri).slice(from, to)];
    const ascii = (s: string): number[] => [...new TextEncoder().encode(s)];
    expect(magic(assets[0]!.uri, 0, 2)).toEqual([0xff, 0xd8]); // JPEG SOI
    expect(magic(assets[1]!.uri, 4, 8)).toEqual(ascii('ftyp')); // MP4 box type
    expect(magic(assets[2]!.uri, 0, 4)).toEqual(ascii('RIFF')); // WAV container
  });
});

describe('camera.scanCode', () => {
  it('the decoded payload is `text`, with the symbology in `format`', async () => {
    // `value` is what this SDK used to call it; the host has always said
    // `text`, and the two names is the drift this corpus exists to catch.
    const { hoomi } = make();
    const result = await hoomi.camera.scanCode();
    expect(typeof result.text).toBe('string');
    expect(result.text.length).toBeGreaterThan(0);
    expect(typeof result.format).toBe('string');
    expect(result).not.toHaveProperty('value');
  });
});

describe('camera.recordVideo failure modes', () => {
  it('a dismissed camera is E_CANCELLED, and a UserCancelledError', async () => {
    const { hoomi, host } = make();
    host.fail('camera.recordVideo', 'E_CANCELLED', 'User dismissed the camera');
    const err = await hoomi.camera.recordVideo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserCancelledError);
    expect((err as HoomiError).code).toBe('E_CANCELLED');
  });

  it('a host with no camera provider answers E_UNSUPPORTED, not E_NOT_IMPLEMENTED', async () => {
    // E_UNSUPPORTED is permanent for this host build, so the SDK may cache it
    // and hide the feature; E_NOT_IMPLEMENTED would mean version skew.
    const { hoomi, host } = make({ capabilities: ['lifecycle', 'ui', 'storage', 'system'] });
    expect(hoomi.hasCapability('camera')).toBe(false);
    host.fail('camera.recordVideo', 'E_UNSUPPORTED', 'No camera provider wired');
    const err = await hoomi.camera.recordVideo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedError);
  });

  it('without the camera scope it is E_SCOPE_DENIED', async () => {
    const { hoomi } = make({ scopes: ['profile'] });
    const err = await hoomi.camera.recordVideo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeNotGrantedError);
    expect((err as HoomiError).code).toBe('E_SCOPE_DENIED');
  });

  it('a permanently denied camera permission keeps the "Open Settings" distinction', async () => {
    const { hoomi } = make({ scenario: 'deny-forever' });
    const err = await hoomi.camera.recordVideo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect((err as PermissionDeniedError).permanent).toBe(true);
  });

  it('the cancel-everything scenario covers it like any other interactive method', async () => {
    const { hoomi } = make({ scenario: 'cancel-everything' });
    const err = await hoomi.camera.recordVideo().catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_USER_DENIED');
  });
});
