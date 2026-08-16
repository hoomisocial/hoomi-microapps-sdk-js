# hoomi.microapps.js

JavaScript SDK for **Hoomi micro-apps**: a typed bridge to the Hoomi superapp
host over the `flutter_inappwebview` WebView bridge, with React bindings, a
faithful mock host for laptop development, and test helpers.

- **Core** `hoomi.microapps.js` — zero dependencies, no React, ~6 KB min+gzip, SSR-safe (never touches `window` at import time)
- **React** `hoomi.microapps.js/react` — provider + hooks, StrictMode-correct
- **Mock** `hoomi.microapps.js/mock` — an in-browser fake host that enforces the *real* host's constraints
- **Testing** `hoomi.microapps.js/testing` — `createTestHoomi()`, no globals touched

```bash
npm install hoomi.microapps.js
# react is an optional peer dependency — only needed for /react
```

## Quickstart

```ts
import { getHoomi, HoomiError, PermissionDeniedError, UserCancelledError } from 'hoomi.microapps.js';

const hoomi = getHoomi();          // reads the host bootstrap, starts the handshake
await hoomi.ready();               // host.hello completed
await hoomi.lifecycle.ready();     // tell the host to reveal the page

hoomi.onLoad((payload) => console.log('launched with', payload.params));
hoomi.onShow(() => resumePolling());
hoomi.onHide(() => pausePolling());
hoomi.onError((msg) => console.warn('host error:', msg));
hoomi.onBackPress(() => closeMyModalIfOpen()); // return true = handled

const profile = await hoomi.user.getProfile();
await hoomi.storage.set('cart', { items: 3 });

try {
  const payment = await hoomi.wallet.requestPayment({
    amountMinor: 250_000,          // integer minor units, >= 1 — never a float
    currency: 'IDR',
    payeeRef: 'merchant:cafe-88',  // who gets paid (required)
    orderId: 'o-42',               // your own reference (optional)
  }, { timeoutMs: 15_000 });
  console.log(payment.status);     // 'pending' | 'succeeded' | 'failed'
} catch (err) {
  if (err instanceof UserCancelledError) { /* user backed out — fine */ }
  else if (err instanceof PermissionDeniedError) {
    // err.permanent === false → show "Retry"
    // err.permanent === true  → show "Open Settings"
  }
  else if (err instanceof HoomiError) report(err.code);
}
```

Every method accepts a trailing `{ signal?: AbortSignal; timeoutMs?: number }`:

```ts
const controller = new AbortController();
const pos = hoomi.location.getCurrent({ accuracy: 'fine' }, { signal: controller.signal });
```

Streams (`location.watch`, `ble.notifications`) return a `Subscription`:

```ts
const sub = await hoomi.location.watch({ minIntervalMs: 2000 }, (pos) => draw(pos));
await sub.close();
```

### Wallet payloads (protocol v1)

Money is **integer minor units**, and the field says so:

| method | params | result |
| --- | --- | --- |
| `wallet.getBalance` | `{ currency }` — required, no implicit default | `{ amountMinor, currency }` |
| `wallet.requestPayment` | `{ amountMinor, currency, payeeRef, orderId?, description? }` | `{ paymentId, status, amountMinor?, currency?, orderId? }` |
| `wallet.getPaymentStatus` | `{ paymentId }` | same as `requestPayment` |

`amountMinor` must be an integer ≥ 1; the SDK rejects a fractional value with
`E_INVALID_PARAMS` **before** it reaches the wire, because JSON has no integer
type and a truncated float on a payment path is a defect, not a rounding
question. `payeeRef` (who is paid) is required and is not the same thing as
`orderId` (your own reference). `status` is `'pending' | 'succeeded' |
'failed'`, typed open-ended so an unrecognised status from a newer host does
not throw. The host's idempotency key is derived from the session and is
deliberately never returned — `paymentId` is the only app-facing handle.

### Pages: the user's own storefronts (protocol v1)

A Hoomi user can create **Pages** — a store with a name, a category and a
product list. `hoomi.pages` is read-only access to *theirs*:

| method | params | result |
| --- | --- | --- |
| `pages.list` | `{}` | `{ pages: HoomiPage[] }` |
| `pages.get` | `{ pageId }` — positive integer | `HoomiPage` (the page itself, not wrapped) |
| `pages.listProducts` | `{ pageId }` | `{ products: HoomiProduct[] }` |

```ts
const { pages } = await hoomi.pages.list();
const { products } = await hoomi.pages.listProducts({ pageId: pages[0].id });
console.log(products[0].priceMinor, products[0].currency); // 28000 'HOOMI'
```

This is **not** a way to browse Hoomi. Pages the user merely follows, and
anyone else's pages, are out of scope — a well-formed `pageId` the signed-in
user does not own answers `E_SCOPE_DENIED`, and it answers exactly the same for
a page that does not exist, so `pages.get` cannot be used to enumerate the
catalogue. That boundary is why this is one modest consent row rather than a
directory capability.

`priceMinor` is **integer minor units**, the same rule as the wallet; the
catalogue stores prices as strings and the host parses them, so the SDK never
sees a string price. There is deliberately **no seller or user identifier on a
product**: these are the user's own products, so there is no counterparty to
name, and a stable id there would be something two micro-apps could join on.
A missing, non-integer or `< 1` `pageId` rejects with `E_INVALID_PARAMS`
before it reaches the wire; a host with no pages provider wired answers
`E_UNSUPPORTED`.

### Media: photos, codes and audio (protocol v1)

| method | params | result |
| --- | --- | --- |
| `camera.capture` | `{ facing?, quality? }` | `MediaAsset` |
| `camera.pickImage` | `{ count? }` | `{ assets: MediaAsset[] }` |
| `camera.scanCode` | `{ formats? }` | `{ text, format }` |
| `audio.startRecord` | `{ maxDurationMs?, format? }` | `{ recordingId }` |
| `audio.stopRecord` | `{ recordingId }` | `MediaAsset` |
| `audio.cancelRecord` | `{ recordingId }` | — |

**Every media-producing method returns the same `MediaAsset`.** A photo, a
picked image and a recording differ only in their bytes, so there is one shape
rather than three — a per-method result type is precisely how this SDK and the
Dart host drifted apart once already.

```ts
const photo = await hoomi.camera.capture();
img.src = photo.uri;               // the content, not a receipt

const { recordingId } = await hoomi.audio.startRecord();
const clip = await hoomi.audio.stopRecord({ recordingId });
audioEl.src = clip.uri;
```

A `MediaAsset` is `{ handle, uri, mimeType, byteLength, width?, height?,
durationMs?, previewDataUri? }`. **`uri` is the point**: the host is the
gateway to the hardware, so an app that asked for a photo gets the photo —
a `data:` URI while it is small enough to travel inline, or an `https:` URL
once the host has stored it. `handle` is an opaque, session-scoped reference
for host-side operations like uploading it later, and is deliberately **never
a filesystem path**: handing one to a micro-app would leak the app sandbox
layout and invite traversal. Do not parse it. `byteLength` is the size of the
media *before* base64 expansion.

`camera.scanCode` returns the decoded payload as **`text`** (with the
symbology in `format`), matching the host — not `value`.

### Video: record it in the page, not over the bridge

There is no `camera.recordVideo`, on purpose. A recording is almost never small
enough to travel as a `data:` URI, so a bridge method for it would mostly
return `E_PAYLOAD_TOO_LARGE`. Record in the page instead — the WebView already
does this well, and it is strictly better:

```ts
// getUserMedia + MediaRecorder: full control over the capture.
const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: true });
const recorder = new MediaRecorder(stream);
const chunks: Blob[] = [];
recorder.ondataavailable = (e) => chunks.push(e.data);
recorder.onstop = async () => {
  stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: recorder.mimeType });
  player.src = URL.createObjectURL(blob);            // preview locally
  await fetch('/api/uploads', { method: 'POST', body: blob });  // your backend, your upload
};
recorder.start();
setTimeout(() => recorder.stop(), 15_000);
```

```html
<!-- Or let the OS camera app do it: handled natively by the WebView. -->
<input type="file" accept="video/*" capture onchange="upload(this.files[0])" />
```

The host's WebView gates `getUserMedia` on the **same camera and microphone
scopes the bridge enforces**, so a micro-app still has to declare them in its
manifest and the user still has to grant them — this is not a way around
consent. What changes is that the recording stays a `Blob` in the page: it
never crosses the bridge, so there is no size ceiling and no
`E_PAYLOAD_TOO_LARGE` to handle. In exchange, **uploading it is your app's
job** — the host has no handle to it and cannot store it for you.

### Error model

Everything that rejects across the public API is a `HoomiError` — never a bare
`Error`, never a string. Narrow subclasses: `UserCancelledError`,
`PermissionDeniedError` (with `.permanent`), `ScopeNotGrantedError`,
`UnsupportedError`, `TimeoutError`, `RateLimitedError` (with `.retryAfterMs`),
`BridgeUnavailableError`. Unknown host codes are preserved on `err.code` with
`err.known === false` — forward-compatible, never a crash.

## React

```tsx
import { HoomiProvider, useUser, useLaunchOptions, useLocationWatch, useBackButton } from 'hoomi.microapps.js/react';

createRoot(el).render(
  <HoomiProvider>
    <App />
  </HoomiProvider>,
);

function App() {
  const launch = useLaunchOptions();          // replayed — safe to mount late
  const { user, loading, error, reload } = useUser();
  const { position, active } = useLocationWatch({ minIntervalMs: 1000 });
  useBackButton(() => dismissSheetIfOpen());  // handler kept in a ref
  // ...
}
```

Also: `useHoomi`, `useHoomiStatus`, `useScopes`, `usePermission` (drives
Retry vs Open Settings), `useCapability`, `useLifecycle`, `useHoomiCall`.
All hooks survive React 18/19 StrictMode double-invoked effects: subscriptions
that resolve after cleanup are closed, in-flight calls abort on unmount, and
handlers live in refs so re-renders never re-register bridge subscriptions.

## Developing without the superapp: the mock host

```ts
import { installMockHost } from 'hoomi.microapps.js/mock';

const host = installMockHost({
  appId: 'app.example.cafe',
  launchParams: { table: '12' },
  scenario: 'happy',
  panel: true,            // tiny DevTools overlay
});
```

Call it **before** `getHoomi()`. The mock enforces what the real host
enforces — nonce/epoch checks, the payload byte cap (pre-parse, like the
host), subscription quotas, scope and permission gates, the back-press grace
timeout — because a mock nicer than the real host produces code that works on
a laptop and fails on device.

Scenarios: `happy`, `deny-all`, `deny-forever`, `cancel-everything`,
`slow-3g`, `offline`, `rate-limited`, `no-scopes` — or via URL:

```
http://localhost:5173/?hoomi_scenario=deny-forever&hoomi_latency=1200
```

The returned handle: `on(method, handler)`, `onStream(method, driver)`,
`fail(method, code)`, `delay(ms)`, `setScopes/grant/revoke`,
`setPermission(domain, state)`, `setPages(seed)` (which storefront pages the
signed-in user owns), `setEpoch(n, announce?)`, `emit(event, data)`,
`pressBack()`, `waitFor(method)`, `frames` (wire log), `applyScenario(name)`,
`reset()`, `uninstall()`. Throw `mockError('E_UNAUTHENTICATED')` inside an
override to fail with a specific code.

## Testing your micro-app

```ts
import { createTestHoomi } from 'hoomi.microapps.js/testing';

const { hoomi, host, cleanup } = createTestHoomi({ scenario: 'deny-forever' });
await expect(hoomi.location.getCurrent()).rejects.toMatchObject({ code: 'E_PERMISSION_DENIED_FOREVER' });
cleanup();
```

No globals touched — safe in Node and in parallel test workers.

## Example app

`examples/react-vite/` is a complete micro-app (Vite 6 + React 19) showing
lifecycle, profile, storage, a live location watch, and a wallet payment
against the mock host:

```bash
cd examples/react-vite && npm install && npm run dev
```

## Protocol notes

- Wire protocol v1; the authoritative spec lives in the host repo
  (`hoomi-flutter-microapp/protocol/README.md`). Frames are single-line JSON;
  the encoder escapes U+2028/U+2029 itself (JSON.stringify does not).
- The host injects `window.__hoomiBootstrap` (nonce, epoch, appId, appVersion,
  capabilities map, grantedScopes, locale) at document-start. The SDK captures
  it into closure-private state and **deletes it from `window`** so later page
  scripts cannot read the nonce.
- Events pushed before the SDK evaluates are buffered by the host in a bounded
  `window.__hoomiRxQueue`; the SDK drains and replays it when it installs its
  own `__hoomiRx`.
- `lifecycle.load` is replay-on-subscribe: late subscribers (React mount
  timing) still get the launch payload.
- Every call carries the session nonce and current epoch; `E_STALE_EPOCH`
  means the page was navigated while a call was in flight.
- `protocol/vectors/` is the shared conformance corpus, run by both this repo
  (`test/protocol/`) and the Dart host. `codec/` covers the envelope;
  `methods/` covers per-method params and results (see
  `protocol/vectors/methods/README.md` for the vector format). **Adding or
  changing a protocol method means adding a vector** — the wallet payload
  drift between the two SDKs went unnoticed precisely because only the
  envelope was covered.

## Development

```bash
npm install
npm test          # vitest: 241 tests incl. fast-check property tests + 39 protocol method vectors
npm run build     # ESM+CJS multi-entry, IIFE global, .d.ts
npm run size      # size + tree-shaking gate (core ≤ 12 KB min+gzip)
```
