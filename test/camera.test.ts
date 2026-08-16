/**
 * Camera and audio payload contract (protocol v1).
 *
 * Every media-producing method — `camera.capture`, `camera.pickImage`,
 * `audio.stopRecord` — resolves to the same `MediaAsset`. That is pinned here
 * as well as in the shared corpus, because a per-method result type is exactly
 * how this SDK and the Dart host drifted apart once already.
 *
 * The behaviour worth pinning: the result carries the *content* (`uri`) plus an
 * opaque `handle` that is never a filesystem path — an app that asked for a
 * photo gets the photo, not a receipt it cannot redeem.
 *
 * There is no video method. A recording is almost never small enough to cross
 * the bridge, so micro-apps record in the page (`getUserMedia` +
 * `MediaRecorder`, or an `<input type="file" accept="video/*" capture>`) and
 * the bytes never become the host's problem.
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

describe('camera.capture', () => {
  it('resolves to the photo itself: content in uri, plus an opaque handle', async () => {
    const { hoomi } = make();
    const asset: MediaAsset = await hoomi.camera.capture();

    expect(typeof asset.uri).toBe('string');
    expect(asset.uri.length).toBeGreaterThan(0);
    expect(asset.mimeType).toBe('image/jpeg');
    expect(Number.isSafeInteger(asset.byteLength)).toBe(true);
    expect(typeof asset.handle).toBe('string');
  });

  it('the handle is opaque and is never a filesystem path', async () => {
    // A path would leak the app sandbox layout and invite traversal, which is
    // exactly why the host hands back a session-scoped reference instead.
    const { hoomi } = make();
    const { handle } = await hoomi.camera.capture();
    expect(handle).not.toMatch(/[/\\]/);
    expect(handle).not.toMatch(/^file:/i);
    expect(handle).not.toMatch(/\.(jpg|jpeg|png|tmp)$/i);
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

  it('the mock returns resolvable data: URIs, and byteLength matches them', async () => {
    // A `mock://` placeholder resolves to nothing: an <img src> pointed at one
    // fails silently, which is the class of bug the mock exists to surface on
    // a laptop rather than on device.
    const { hoomi } = make();
    const { recordingId } = await hoomi.audio.startRecord();
    const assets = [await hoomi.camera.capture(), await hoomi.audio.stopRecord({ recordingId })];
    for (const asset of assets) {
      expect(asset.uri.startsWith('data:'), asset.uri.slice(0, 32)).toBe(true);
      expect(dataUriBytes(asset.uri).length).toBe(asset.byteLength);
    }
    // And the bytes are the media they claim to be, not filler.
    const magic = (uri: string, from: number, to: number): number[] => [...dataUriBytes(uri).slice(from, to)];
    const ascii = (s: string): number[] => [...new TextEncoder().encode(s)];
    expect(magic(assets[0]!.uri, 0, 2)).toEqual([0xff, 0xd8]); // JPEG SOI
    expect(magic(assets[1]!.uri, 0, 4)).toEqual(ascii('RIFF')); // WAV container
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

describe('camera failure modes', () => {
  it('a dismissed camera is E_CANCELLED, and a UserCancelledError', async () => {
    const { hoomi, host } = make();
    host.fail('camera.capture', 'E_CANCELLED', 'User dismissed the camera');
    const err = await hoomi.camera.capture().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserCancelledError);
    expect((err as HoomiError).code).toBe('E_CANCELLED');
  });

  it('a host with no camera provider answers E_UNSUPPORTED, not E_NOT_IMPLEMENTED', async () => {
    // E_UNSUPPORTED is permanent for this host build, so the SDK may cache it
    // and hide the feature; E_NOT_IMPLEMENTED would mean version skew.
    const { hoomi, host } = make({ capabilities: ['lifecycle', 'ui', 'storage', 'system'] });
    expect(hoomi.hasCapability('camera')).toBe(false);
    host.fail('camera.capture', 'E_UNSUPPORTED', 'No camera provider wired');
    const err = await hoomi.camera.capture().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedError);
  });

  it('without the camera scope it is E_SCOPE_DENIED', async () => {
    const { hoomi } = make({ scopes: ['profile'] });
    const err = await hoomi.camera.capture().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeNotGrantedError);
    expect((err as HoomiError).code).toBe('E_SCOPE_DENIED');
  });

  it('a permanently denied camera permission keeps the "Open Settings" distinction', async () => {
    const { hoomi } = make({ scenario: 'deny-forever' });
    const err = await hoomi.camera.capture().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect((err as PermissionDeniedError).permanent).toBe(true);
  });

  it('the cancel-everything scenario covers it like any other interactive method', async () => {
    const { hoomi } = make({ scenario: 'cancel-everything' });
    const err = await hoomi.camera.capture().catch((e: unknown) => e);
    expect((err as HoomiError).code).toBe('E_USER_DENIED');
  });
});
