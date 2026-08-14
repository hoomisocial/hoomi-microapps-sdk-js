# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`hoomi.microapps.js` — zero-dependency TypeScript SDK for Hoomi micro-apps: a typed bridge to the Hoomi superapp host over the `flutter_inappwebview` WebView bridge (wire protocol v1, single-line JSON frames). Ships four entry points: core (`.`), `/react`, `/mock`, `/testing`.

## Commands

```bash
npm test                          # vitest run (all tests, jsdom env)
npx vitest run test/client.test.ts        # single test file
npx vitest run -t "pattern"               # tests matching a name pattern
npm run test:watch                # vitest watch mode
npm run typecheck                 # tsc --noEmit
npm run build                     # typecheck + ESM/CJS multi-entry + IIFE global + .d.ts
npm run size                      # size & tree-shaking gate (requires a fresh build)
```

`npm run size` bundles `dist/` with esbuild and fails if the full core exceeds 12 KB min+gzip, if an errors-only import exceeds 2.5 KB, or if tree-shaking has no effect. Run `npm run build` first.

## Architecture

Layered, bottom-up (each layer only imports from the ones below):

- `src/core/codec.ts` — frame encode/decode. Frames must stay single-line: the encoder escapes U+2028/U+2029 itself (JSON.stringify does not), mirroring the Dart host.
- `src/core/ids.ts` — id/method validation patterns and id generator.
- `src/core/errors.ts` — the error model. **Everything that rejects across the public API is a `HoomiError`** (never a bare Error/string); unknown host codes are preserved on `err.code` with `err.known === false` rather than crashing.
- `src/core/transport.ts` — `Transport` interface, `FlutterInAppWebViewTransport`, `captureBootstrap()`. The host injects `window.__hoomiBootstrap` (nonce, epoch, appId, capabilities, scopes); the SDK captures it into closure-private state and **deletes it from `window`** so later page scripts can't read the nonce. Pre-SDK events buffered by the host in `window.__hoomiRxQueue` are drained when the SDK installs `__hoomiRx`.
- `src/core/client.ts` — `BridgeClient`: host.hello handshake, pending-call correlation, subscriptions, abort/timeout, epoch tracking. Every call carries nonce + epoch.
- `src/api/` — typed namespace wrappers (`user`, `storage`, `wallet`, `pages`, `location`, `ble`, …) over `client.call`/`client.subscribe`. Every method takes a trailing `{ signal?, timeoutMs? }`.
- `src/hoomi.ts` — the `Hoomi` facade (`createHoomi`/`getHoomi` shared singleton), lifecycle event sugar (`onLoad`/`onShow`/…), and the back-press protocol (host pushes `lifecycle.backPress {pressId}`; SDK runs handlers newest-first and must ack `lifecycle.backPressResult` before the host's grace timeout).
- `src/mock/` — `installMockHost()`: in-browser fake host that deliberately enforces the real host's constraints (nonce/epoch checks, pre-parse payload byte cap, subscription quotas, scope/permission gates). Don't make the mock more lenient than the real host. Scenarios (`happy`, `deny-forever`, `slow-3g`, …) in `src/mock/scenarios.ts`, also settable via `?hoomi_scenario=` URL params.
- `src/testing/` — `createTestHoomi()`: wires a fresh SDK to a fresh `MockHost` via an in-memory transport, no globals touched (Node-safe, parallel-safe).
- `src/react/` — `HoomiProvider` + hooks. All hooks must survive React 18/19 StrictMode double-invoked effects: subscriptions resolving after cleanup get closed, in-flight calls abort on unmount, handlers live in refs.
- `src/global.ts` — entry for the IIFE `window.Hoomi` build (separate `vite.iife.config.ts` because Vite rejects multi-entry lib builds that include 'iife').

## Hard invariants

- **SSR/import-time safety**: nothing may touch `window` at import time — all environment probing is lazy, inside `createHoomi()`/`getHoomi()`. `sideEffects: false` depends on this.
- **Build target is es2022 on purpose**: it keeps native `#private` class fields. Downleveling to WeakMaps defeats consumer tree-shaking and blows the size gate (see comment in `vite.config.ts`).
- **Protocol conformance corpus**: `protocol/vectors/` is shared with the Dart host repo (`hoomi-flutter-microapp`) and run by both runners. Two layers: `codec/` (envelope encode/decode, `test/protocol/conformance.test.ts`) and `methods/` (per-method params/results executed against the mock host, `test/protocol/methods.test.ts`; format documented in `protocol/vectors/methods/README.md`). **Adding or changing a protocol method means adding a vector** — envelope-only coverage is how the wallet payloads silently drifted apart from the Dart host. Neither corpus may shrink (both tests enforce a minimum count). The authoritative wire spec lives in the host repo at `protocol/README.md`.
- **Money is integer minor units.** `wallet.requestPayment` takes `amountMinor` (integer ≥ 1) plus a required `payeeRef`; the SDK rejects a non-integer amount *before* it reaches the wire. `PaymentStatus` is `'pending' | 'succeeded' | 'failed'` and stays open-ended (`(string & {})`) so an unknown status from a newer host never throws. The host's idempotency key is host-internal and is never returned to the page.
- **`pages` is the user's own storefronts, not a directory.** `pages.list` / `pages.get` / `pages.listProducts` read Pages the *signed-in user owns*; pages they merely follow and anyone else's pages are unreachable. A well-formed `pageId` outside that set answers `E_SCOPE_DENIED`, and it must answer the same for a page that does not exist — otherwise `pages.get` is an enumeration oracle over every Page in Hoomi. `pageId` is a positive integer, validated page-side. `priceMinor` is integer minor units (wallet rule; the catalogue's string prices are parsed by the host). A product payload carries **no seller/user identifier** and must not grow one: these are the user's own products, so there is no counterparty to name, and a stable id there is something two micro-apps could join on.
- Because `pages` is read-only, its vectors cannot build their own state with `setup`; they pin a fixture instead (owned page id `1` with one product, id `999999` unowned). See the "Fixtures a runner must provide" section of `protocol/vectors/methods/README.md` — the Dart runner has to seed the same.
- Tests include fast-check property tests (`test/codec.test.ts` etc.); React tests use `@testing-library/react` under jsdom.
