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
    amount: 250_000, currency: 'IDR', orderId: 'o-42',
  }, { timeoutMs: 15_000 });
  console.log(payment.status);
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
`setPermission(domain, state)`, `setEpoch(n, announce?)`, `emit(event, data)`,
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
- `protocol/vectors/codec/` is the shared conformance corpus, run by both this
  repo (`test/protocol/conformance.test.ts`) and the Dart host. **Adding a
  protocol method means adding a vector.**

## Development

```bash
npm install
npm test          # vitest: 149 tests incl. fast-check property tests
npm run build     # ESM+CJS multi-entry, IIFE global, .d.ts
npm run size      # size + tree-shaking gate (core ≤ 12 KB min+gzip)
```
