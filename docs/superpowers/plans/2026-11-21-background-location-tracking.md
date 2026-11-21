# Background Location Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A micro-app can start a tracking session and receive every GPS fix in order, including fixes taken while Hoomi was backgrounded or the phone locked; plus a keep-screen-on call.

**Architecture:** The host records fixes into a bounded, numbered, in-memory log owned by the micro-app session. The page pulls pages of fixes with a cursor (`afterSeq`), which also acknowledges earlier fixes. A best-effort `location.trackAvailable` event keeps it live. The mobile app keeps the process alive during tracking with an Android location foreground service and iOS background location updates.

**Tech Stack:** TypeScript + vitest (SDK), Dart/Flutter + `flutter test` (adapter), Flutter + geolocator 14 (mobile).

**Spec:** `/Users/untagpranata/CascadeProjects/hoomi-microapps-sdk-js/docs/superpowers/specs/2026-11-21-background-location-tracking-design.md` — read it first; this plan does not repeat its reasoning.

Repos (absolute roots; every path below is relative to the repo named in the task heading):

- **ADAPTER** = `/Users/untagpranata/CascadeProjects/hoomi-flutter-microapp` (branch from `master`)
- **SDK** = `/Users/untagpranata/CascadeProjects/hoomi-microapps-sdk-js` (branch from `master`)
- **MOBILE** = `/Users/untagpranata/CascadeProjects/hoomi-mobile` (branch from `development`)

In each repo, work on a branch named `feat/background-location-tracking`. Never commit to `master`/`development`. Do not push.

## Global Constraints

- Wire names, exactly: methods `location.startTracking`, `location.readTrack`, `location.stopTracking`, `ui.setKeepScreenOn`; event `location.trackAvailable`; scopes `location.background`, `ui.keepScreenOn`.
- Params/results exactly as in the spec's "Wire protocol" section. `readTrack`: `afterSeq` integer ≥ 0 default 0; `limit` integer 1..500 default 200. `seq` starts at 1, +1 per fix.
- Limits: 10,000 buffered unread fixes (evict oldest, count in `droppedCount`); 8-hour session; `trackAvailable` coalesced to at most one per second.
- `state` is `"active" | "expired" | "failed"`; SDK type stays open-ended (`(string & {})`).
- Unknown/stopped `trackingId` → `E_INVALID_PARAMS`. No new error codes anywhere.
- `accuracy` is strict (`coarse|balanced|high`) for `startTracking` only; `getCurrent`/`watch` stay lenient so `'fine'` keeps behaving as today. `'fine'` is never translated to `'high'`.
- `'high'` requires scope `location.fine` on `getCurrent`, `watch` and `startTracking`.
- Tracking survives `bumpEpoch()` and `dropSubscriptions()`; it ends only on stop, expiry, failure, or session teardown.
- Vector files are byte-identical in ADAPTER and SDK `protocol/vectors/methods/`. Neither corpus shrinks.
- SDK: everything rejecting across the public API is a `HoomiError`; nothing touches `window` at import time; `npm run build && npm run size` must pass (12 KB core gate).
- The mock is never more lenient than the real host.
- Consent copy and notification copy in both `id` and `en`.

## Review Focus

1. **`observer.next` throws** inside `location.track` → later fixes still delivered, cursor still advances (SDK Task 6).
2. **Page reload mid-session** → a new `track()` gets `resumed: true` and re-receives every unacknowledged fix; none skipped (SDK Task 6, ADAPTER Task 3).
3. **`stop()` during an in-flight drain** → no `next` after `stop()` resolves, no unhandled rejection (SDK Task 6).
4. **Older host without the methods** → `track()` rejects with the host's `HoomiError`; it does not hang or retry forever (SDK Task 6).
5. **GPS off / permission revoked mid-session** → host flips to `state: "failed"`, log stays readable, wrapper drains then calls `observer.error` with retryable `E_UNAVAILABLE` (ADAPTER Task 3, SDK Task 6).

---

## Part 1 — ADAPTER (`hoomi-flutter-microapp`)

### Task 1: Shared vectors + runner array matching

**Files:**
- Create: 18 files in `protocol/vectors/methods/` (table below)
- Modify: `protocol/vectors/methods/README.md`, `test/protocol/method_conformance_test.dart`

- [ ] **Step 1: Write the vectors.** All have `"protocol": 1`. "start" below means setup call `location.startTracking {}` with `"bind": {"trackingId": "trackingId"}`.

| file | setup | method / params | expect |
| --- | --- | --- | --- |
| `location-starttracking-valid.json` | – | `location.startTracking` `{"accuracy":"balanced","minDistanceMeters":25}` | ok; result `{"resumed":false,"state":"active"}`; resultTypes `trackingId:string, startedAt:number, expiresAt:number, maxBufferedFixes:number` |
| `location-starttracking-invalid-accuracy.json` | – | `{"accuracy":"ultra"}` | `E_INVALID_PARAMS` |
| `location-starttracking-negative-mindistance.json` | – | `{"minDistanceMeters":-1}` | `E_INVALID_PARAMS` |
| `location-starttracking-twice-resumes.json` | start | `location.startTracking` `{}` | ok; result `{"resumed":true,"state":"active"}` |
| `location-readtrack-first-page.json` | start | `location.readTrack` `{"trackingId":"$trackingId","afterSeq":0,"limit":2}` | ok; result `{"fixes":[{"seq":1,"latitude":-6.2,"longitude":106.8,"isMocked":false},{"seq":2}],"lastSeq":3,"hasMore":true,"droppedCount":0,"state":"active"}` |
| `location-readtrack-second-page.json` | start | `{"trackingId":"$trackingId","afterSeq":2}` | ok; result `{"fixes":[{"seq":3}],"lastSeq":3,"hasMore":false}` |
| `location-readtrack-ack-discards.json` | start; then `location.readTrack {"trackingId":"$trackingId","afterSeq":2}` | `{"trackingId":"$trackingId","afterSeq":0}` | ok; result `{"fixes":[{"seq":3}]}` |
| `location-readtrack-unknown-id.json` | – | `{"trackingId":"trk-does-not-exist"}` | `E_INVALID_PARAMS` |
| `location-readtrack-limit-zero.json` | start | `{"trackingId":"$trackingId","limit":0}` | `E_INVALID_PARAMS` |
| `location-readtrack-limit-too-large.json` | start | `{"trackingId":"$trackingId","limit":501}` | `E_INVALID_PARAMS` |
| `location-readtrack-fractional-afterseq.json` | start | `{"trackingId":"$trackingId","afterSeq":1.5}` | `E_INVALID_PARAMS` |
| `location-stoptracking-valid.json` | start | `location.stopTracking` `{"trackingId":"$trackingId"}` | ok |
| `location-stoptracking-unknown-id.json` | – | `{"trackingId":"trk-does-not-exist"}` | `E_INVALID_PARAMS` |
| `location-readtrack-after-stop.json` | start; then `location.stopTracking {"trackingId":"$trackingId"}` | `location.readTrack` `{"trackingId":"$trackingId"}` | `E_INVALID_PARAMS` |
| `ui-setkeepscreenon-true.json` | – | `ui.setKeepScreenOn` `{"enabled":true}` | ok |
| `ui-setkeepscreenon-false.json` | – | `{"enabled":false}` | ok |
| `ui-setkeepscreenon-missing-enabled.json` | – | `{}` | `E_INVALID_PARAMS` |
| `ui-setkeepscreenon-enabled-as-string.json` | – | `{"enabled":"true"}` | `E_INVALID_PARAMS` |

- [ ] **Step 2: README.** Add to "Format": *arrays inside `expect.result` match by equal length, element-wise subset*. Add to "Fixtures a runner must provide": *the fake background location source has recorded exactly 3 fixes (latitude `-6.2`, longitude `106.8`, `isMocked: false`) by the time the call after `location.startTracking` is answered, and records no more on its own*.
- [ ] **Step 3:** In `method_conformance_test.dart`, make the subset matcher recurse into lists (equal length, element-wise subset) and raise the minimum-count assertion by 18.
- [ ] **Step 4:** Run `flutter test test/protocol/method_conformance_test.dart`. Expected: the 18 new vectors FAIL (methods unknown); all old ones pass.
- [ ] **Step 5:** Commit `test: vectors for location tracking and ui.setKeepScreenOn`.

### Task 2: `TrackLog` (pure data structure)

**Files:**
- Create: `lib/src/runtime/track_log.dart`, `test/runtime/track_log_test.dart`

**Interfaces — Produces:**

```dart
class TrackPage {
  final List<Map<String, Object?>> fixes; // GeoPosition.toJson() + 'seq'
  final int lastSeq; final bool hasMore; final int droppedCount;
}
class TrackLog {
  TrackLog({required this.maxBufferedFixes});
  final int maxBufferedFixes;
  int get lastSeq;       // 0 before the first fix
  int get droppedCount;  // cumulative evictions of unread fixes
  int record(GeoPosition fix);                         // returns the new seq
  TrackPage read({required int afterSeq, required int limit}); // discards seq <= afterSeq first
  void clear();
}
```

- [ ] **Step 1: Failing tests** in `track_log_test.dart`:
  - `record` returns 1, 2, 3; `lastSeq == 3`.
  - `read(afterSeq: 0, limit: 2)` → seqs `[1, 2]`, `hasMore: true`; each fix map has `seq`, `latitude`, `timestamp`, `isMocked`.
  - after `read(afterSeq: 2, limit: 200)`, `read(afterSeq: 0, limit: 200)` → seqs `[3]` (ack discards).
  - `afterSeq` beyond `lastSeq` → empty fixes, `hasMore: false`, nothing thrown.
  - `maxBufferedFixes: 2`, record 3 → `read(afterSeq: 0)` seqs `[2, 3]`, `droppedCount == 1`; `lastSeq == 3`.
- [ ] **Step 2:** Run `flutter test test/runtime/track_log_test.dart` → FAIL (file missing).
- [ ] **Step 3:** Implement with a `ListQueue`.
- [ ] **Step 4:** Run again → PASS.
- [ ] **Step 5:** Commit `feat: TrackLog`.

### Task 3: Tracking session, provider, bindings, scopes

**Files:**
- Modify: `lib/src/capabilities/location.dart`, `lib/src/manifest/scope.dart`, `lib/src/protocol/method_names.dart`, `lib/src/runtime/runtime.dart`, `lib/src/runtime/session.dart`, `lib/src/runtime/method_table.dart`, `lib/testing.dart`, `lib/hoomi_microapp.dart` (exports), `test/protocol/method_conformance_test.dart` (wire the fake)
- Create: `lib/src/runtime/tracking.dart`, `test/runtime/tracking_test.dart`

**Interfaces — Consumes:** `TrackLog` (Task 2). **Produces:**

```dart
// capabilities/location.dart
abstract interface class HoomiBackgroundLocationProvider {
  /// Must keep emitting while the host app is backgrounded. Cancelling the
  /// subscription must stop GPS and remove any OS notification/indicator.
  Stream<GeoPosition> trackPosition(
    MicroAppContext ctx, {
    required String appName,
    LocationAccuracyHint accuracy = LocationAccuracyHint.balanced,
    int minDistanceMeters = 25,
  });
}
// scope.dart
locationBackground('location.background', 'location', ConsentRisk.high)
// runtime.dart
MicroAppRuntime({..., HoomiBackgroundLocationProvider? backgroundLocationProvider})
MicroAppPolicy({..., int maxTrackedFixes = 10000, Duration maxTrackingDuration = const Duration(hours: 8)})
// method_names.dart
MicroAppMethods.locationStartTracking / locationReadTrack / locationStopTracking
MicroAppEvents.locationTrackAvailable = 'location.trackAvailable'
// tracking.dart
enum TrackingState { active, expired, failed }   // wire: .name
class TrackingSession { String id; DateTime startedAt, expiresAt; TrackingState state; TrackLog log; Map<String,Object?> describe({required bool resumed}); }
// session.dart
TrackingSession? get tracking;
TrackingSession startTracking(Stream<GeoPosition> source); // creates, listens, arms expiry timer
TrackingSession requireTracking(String trackingId);        // throws invalidParams if absent/mismatched
Future<void> stopTracking(String trackingId);
// testing.dart
class FakeBackgroundLocationProvider implements HoomiBackgroundLocationProvider {
  FakeBackgroundLocationProvider({int initialFixes = 3, double latitude = -6.2, double longitude = 106.8});
  void emit(GeoPosition fix); void fail(Object error); bool get isListening;
}
```

- [ ] **Step 1: Failing tests** in `tracking_test.dart` (use `fake_async` for timers; build a session the way `test/runtime/session_test.dart` does):
  - fixes emitted by the fake appear in `tracking.log` in order.
  - `bumpEpoch()` and `dropSubscriptions()` leave `tracking` non-null and the fake still `isListening`.
  - `dispose()` → fake no longer listening, `tracking == null`.
  - `stopTracking(id)` → not listening, `tracking == null`; `requireTracking(id)` then throws `E_INVALID_PARAMS`.
  - after `policy.maxTrackingDuration` elapses → `state == expired`, not listening, log still readable.
  - `fake.fail(...)` → `state == failed`, not listening, log still readable.
  - emitting 5 fixes within one second produces exactly one `location.trackAvailable` event whose `lastSeq` is 5 (capture via `session.emitFrame`).
  - dispatcher-level (pattern from `test/runtime/dispatcher_test.dart`): `location.startTracking` without `location.background` → `E_SCOPE_DENIED`; with `accuracy: 'high'` and no `location.fine` → `E_SCOPE_DENIED`; with no provider wired → same code other unwired providers return; `location.watch` with `accuracy: 'high'` and no `location.fine` → `E_SCOPE_DENIED`.
- [ ] **Step 2:** Run `flutter test test/runtime/tracking_test.dart` → FAIL.
- [ ] **Step 3: Implement.**
  - Bindings: `startTracking` scope `locationCoarse`, additionally `require(locationBackground)` and, for high, `require(locationFine)` inside `invoke` (the pattern `locationGetCurrent` already uses). `readTrack`/`stopTracking` scope `locationBackground`, tier `install`. `readTrack` rate `RateLimit(perMinute: 120, burst: 30)`.
  - `startTracking` when `session.tracking != null` (any state) returns `describe(resumed: true)` without touching the provider.
  - `appName` comes from the session manifest's display name (fall back to `appId` if the manifest has none).
  - `readTrack` result = page fields + `'state': tracking.state.name`.
  - Add the `'high'` → `locationFine` check to the `locationWatch` stream binding.
  - Audit: start/stop only, via the existing `summarizeParams`; never fix coordinates.
  - Wire `FakeBackgroundLocationProvider()` into the conformance runner's runtime.
- [ ] **Step 4:** Run `flutter test` → all pass except the 4 `ui-setkeepscreenon-*` vectors.
- [ ] **Step 5:** Commit `feat: location tracking session and bindings`.

### Task 4: Per-start consent sheet

**Files:**
- Modify: `lib/src/security/consent.dart`, `lib/src/runtime/method_binding.dart`, `lib/src/runtime/dispatcher.dart`, `lib/src/runtime/method_table.dart`, `lib/src/ui/consent_strings.dart`, `lib/src/ui/consent_sheet.dart` (if it switches on `SensitiveAction`), `lib/testing.dart` (if the fake consent delegate needs the new case)
- Test: `test/runtime/dispatcher_test.dart`

**Interfaces — Produces:** `SensitiveAction.trackLocation`; `MethodBinding({..., bool Function(MethodCall call)? skipConfirmation})`.

- [ ] **Step 1: Failing tests:** fresh `location.startTracking` invokes the consent delegate once with `SensitiveAction.trackLocation`; decline → `E_USER_DENIED` and provider never listened; second `startTracking` while a session exists → delegate **not** invoked, `resumed: true`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Dispatcher: skip `_confirm` when `binding.skipConfirmation?.call(methodCall) == true`. `startTracking` becomes `ConsentTier.perInvocation` with `skipConfirmation: (c) => c.session.tracking != null`. Copy:
  - en title `Share location in the background`; body `{app} will keep receiving your location while Hoomi is in the background, until you close it.`
  - id title `Bagikan lokasi di latar belakang`; body `{app} akan terus menerima lokasi Anda saat Hoomi berjalan di latar belakang, sampai Anda menutupnya.`
- [ ] **Step 4:** `flutter test` → same state as Task 3 Step 4 (conformance runner's consent fake must auto-approve).
- [ ] **Step 5:** Commit `feat: per-start consent for background tracking`.

### Task 5: `ui.setKeepScreenOn`

**Files:**
- Create: `lib/src/capabilities/screen.dart`, `test/runtime/keep_screen_on_test.dart`
- Modify: `scope.dart`, `method_names.dart`, `runtime.dart`, `session.dart`, `method_table.dart`, `lib/src/ui/player.dart`, `lib/testing.dart`, `lib/hoomi_microapp.dart`, conformance runner wiring

**Interfaces — Produces:**

```dart
abstract interface class HoomiScreenProvider { Future<void> setKeepScreenOn(bool enabled); }
MicroAppRuntime({..., HoomiScreenProvider? screenProvider})
MicroAppScope.uiKeepScreenOn('ui.keepScreenOn', null, ConsentRisk.low)
MicroAppMethods.uiSetKeepScreenOn = 'ui.setKeepScreenOn'
// session.dart
bool keepScreenOnRequested;                 // survives bumpEpoch
// testing.dart
class FakeScreenProvider implements HoomiScreenProvider { bool enabled; List<bool> calls; }
```

- [ ] **Step 1: Failing tests:** call with `true` → `fake.calls == [true]`; `{}` and `{"enabled":"true"}` → `E_INVALID_PARAMS`; session `dispose()` after `true` → last call is `false`; player lifecycle `paused` after `true` → `false`, `resumed` → `true` again (extend `test/ui/player_test.dart`); no provider → the usual unwired error.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Binding tier `none`, returns `{'ok': true}` like `ui.toast`. Confirm how baseline scopes are granted (see how `uiToast` reaches `session.scopes`) and make `ui.keepScreenOn` granted the same way. `params.requireBool` — add it to `lib/src/protocol/params.dart` if missing, with a test in `test/protocol/params_test.dart`.
- [ ] **Step 4:** `flutter test` → everything passes, including all 18 new vectors. `flutter analyze` clean.
- [ ] **Step 5:** Commit `feat: ui.setKeepScreenOn`.

### Task 6: Adapter docs

**Files:** Modify `protocol/README.md`, `README.md`.

- [ ] **Step 1:** Document the four methods, the event, both scopes, limits, lifetime rules and the `'fine'`/`'high'` note in `protocol/README.md`; add a host-integration section (the two new providers) to `README.md`.
- [ ] **Step 2:** Commit `docs: location tracking and keep-screen-on`.

---

## Part 2 — SDK (`hoomi-microapps-sdk-js`)

### Task 7: Vectors + mock track log

**Files:**
- Create: the same 18 vector files (copy from ADAPTER, byte-identical), `src/mock/trackLog.ts`, `test/tracking-mock.test.ts`
- Modify: `protocol/vectors/methods/README.md` (same two additions as ADAPTER Task 1), `test/protocol/methods.test.ts`, `src/mock/mockHost.ts`, `src/mock/index.ts`, `src/testing/index.ts` (only if `host` is not already exposed with the new members)

**Interfaces — Produces:**

```ts
// src/mock/trackLog.ts — same semantics as the Dart TrackLog
export class TrackLog {
  constructor(maxBufferedFixes: number);
  readonly lastSeq: number; readonly droppedCount: number;
  record(fix: GeoPosition): number;
  read(afterSeq: number, limit: number): { fixes: TrackedFix[]; lastSeq: number; hasMore: boolean; droppedCount: number };
}
// MockHost additions
pushTrackFix(fix?: Partial<GeoPosition>): number; // records + emits coalesced location.trackAvailable; returns seq; throws if not tracking
expireTracking(): void;                            // state -> 'expired'
failTracking(): void;                              // state -> 'failed'
readonly keepScreenOn: boolean;
// MockLimits additions
maxTrackedFixes: number;       // default 10_000
maxTrackingMs: number;         // default 28_800_000
```

- [ ] **Step 1:** In `methods.test.ts` raise the minimum count from 36 to 54 and add `location.readTrack`, `location.startTracking`, `location.stopTracking`, `ui.setKeepScreenOn` to the sorted method list. (`toMatchObject` already matches arrays by length + element subset.)
- [ ] **Step 2: Failing tests** in `tracking-mock.test.ts` (via `createTestHoomi()` and `hoomi.call`):
  - start records 3 fixture fixes (`latitude: -6.2`, `longitude: 106.8`, `isMocked: false`).
  - `pushTrackFix()` → next read includes seq 4; a `location.trackAvailable` event with `lastSeq: 4` is emitted.
  - `limits: { maxTrackedFixes: 2 }` → `droppedCount` 1 after start, fixes `[2, 3]`.
  - `expireTracking()` → read `state: 'expired'`; `startTracking` returns `resumed: true, state: 'expired'`.
  - `failTracking()` → `state: 'failed'`.
  - `host.revoke('location.background')` → `startTracking` rejects `E_SCOPE_DENIED`.
  - `accuracy: 'high'` without scope `location.fine` → `E_SCOPE_DENIED` for `startTracking`, `getCurrent` and a `location.watch` subscribe.
  - permission `denied_forever` on `location` → `startTracking` rejects `E_PERMISSION_DENIED_FOREVER`.
  - `setEpoch(n, true)` (page reload) keeps the session: read with the same `trackingId` still works.
  - `ui.setKeepScreenOn {enabled:true}` → `host.keepScreenOn === true`; `host.reset()` → `false`.
- [ ] **Step 3:** Run `npx vitest run test/tracking-mock.test.ts test/protocol/methods.test.ts` → FAIL.
- [ ] **Step 4:** Implement. Add `'location.fine'` and `'location.background'` to `DEFAULT_SCOPES`; add a per-method extra-scope check alongside `SCOPE_BY_PREFIX`. `location.getCurrent` in the mock gains `isMocked: false`. Validation mirrors the host exactly (strict accuracy for start only; integer checks; limit 1..500).
- [ ] **Step 5:** Run `npm test` → PASS.
- [ ] **Step 6:** Commit `feat(mock): location tracking log and keep-screen-on`.

### Task 8: Types, raw methods, param drift fix

**Files:**
- Modify: `src/api/types.ts`, `src/api/namespaces.ts`, `src/index.ts` (type exports)
- Test: `test/location.test.ts` (create)

**Interfaces — Produces:**

```ts
export type LocationAccuracy = 'coarse' | 'balanced' | 'high';
export interface LocationParams { accuracy?: LocationAccuracy | /** @deprecated use 'high' */ 'fine'; maximumAgeMs?: number }
export interface LocationWatchParams extends LocationParams {
  minIntervalMs?: number; minDistanceMeters?: number; /** @deprecated */ minDistanceM?: number;
}
export interface GeoPosition { /* existing */ isMocked?: boolean }
export interface StartTrackingParams { accuracy?: LocationAccuracy; minDistanceMeters?: number }
export type TrackingState = 'active' | 'expired' | 'failed' | (string & {});
export interface TrackingSession { trackingId: string; startedAt: number; expiresAt: number; maxBufferedFixes: number; state: TrackingState; resumed: boolean }
export interface TrackedFix extends GeoPosition { seq: number }
export interface ReadTrackParams { trackingId: string; afterSeq?: number; limit?: number }
export interface ReadTrackResult { fixes: TrackedFix[]; lastSeq: number; hasMore: boolean; droppedCount: number; state: TrackingState }
// LocationApi
startTracking(params?: StartTrackingParams, opts?: CallOptions): Promise<TrackingSession>;
readTrack(params: ReadTrackParams, opts?: CallOptions): Promise<ReadTrackResult>;
stopTracking(trackingId: string, opts?: CallOptions): Promise<void>;
// UiApi
setKeepScreenOn(enabled: boolean, opts?: CallOptions): Promise<void>;
```

- [ ] **Step 1: Failing tests** (`createTestHoomi()`; inspect `t.host.calls` for what reached the wire):
  - `location.watch({ minDistanceM: 10 }, …)` sends `minDistanceMeters: 10` and no `minDistanceM`.
  - `location.getCurrent({ accuracy: 'fine' })` sends `accuracy: 'fine'` unchanged.
  - `startTracking({ minDistanceMeters: 1.5 })`, `readTrack({ trackingId, limit: 0 })`, `readTrack({ trackingId, afterSeq: -1 })`, `readTrack({ trackingId: '' })`, `ui.setKeepScreenOn('yes' as never)` each reject with `HoomiError` code `E_INVALID_PARAMS` and `t.host.calls` has no such call.
  - happy path: start → read returns 3 fixes → stop resolves `undefined`.
- [ ] **Step 2:** Run `npx vitest run test/location.test.ts` → FAIL.
- [ ] **Step 3:** Implement, reusing the existing page-side validation helper at `src/api/namespaces.ts:69` and the `async` wrapper pattern used by `wallet`/`pages`.
- [ ] **Step 4:** `npm test && npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: location tracking and ui.setKeepScreenOn API`.

### Task 9: `location.track` wrapper

**Files:**
- Create: `src/api/tracking.ts`, `test/tracking.test.ts`
- Modify: `src/api/namespaces.ts`, `src/api/types.ts`, `src/index.ts`

**Interfaces — Consumes:** raw methods from Task 8; `client.on(event, handler)` (`src/core/client.ts:244`). **Produces:**

```ts
export interface TrackOptions extends CallOptions { onDropped?: (count: number) => void }
export interface TrackingHandle { readonly trackingId: string; stop(): Promise<void> }
// LocationApi
track(params: StartTrackingParams | undefined, observer: Observer<TrackedFix>, opts?: TrackOptions): Promise<TrackingHandle>;
```

Behaviour (the algorithm the tests alone do not pin):

1. `startTracking(params)`. If the returned `state !== 'active'`: drain it into the observer, `stopTracking`, then `startTracking` again once.
2. Drain = loop `readTrack({ trackingId, afterSeq: lastDelivered, limit: 200 })`; deliver fixes with `seq > lastDelivered` in order; set `lastDelivered`; repeat while `hasMore`. Only one drain runs at a time; a trigger arriving mid-drain sets a flag that causes exactly one follow-up drain.
3. Triggers: once after start; every `location.trackAvailable` whose `trackingId` matches; every `lifecycle.show`.
4. `onDropped(n)` fires with the increase whenever `droppedCount` grows.
5. When a drain finishes with `state === 'expired'` → `observer.complete?.()`; with `'failed'` → `observer.error?.(new HoomiError('E_UNAVAILABLE', …))`. Either way, call `stopTracking` and detach listeners.
6. A throwing `observer.next` is caught; delivery and the cursor continue.
7. A failed `readTrack` leaves the cursor untouched; the next trigger retries. If it fails with `E_INVALID_PARAMS` (session gone) → `observer.error` and detach.
8. `stop()` is idempotent: detach listeners, mark stopped (no `next` afterwards, even from an in-flight drain), `stopTracking`. `opts.signal` aborting does the same.

- [ ] **Step 1: Failing tests** in `tracking.test.ts`:
  - delivers the 3 fixture fixes in order, then seq 4 after `host.pushTrackFix()`.
  - **no nudge:** suppress the event (push 5 fixes with a `host.on`-free path, or stub `client.on` for `location.trackAvailable`), then `host.emit('lifecycle.show')` → all delivered.
  - 450 pushed fixes → delivered once each, in order, across multiple `readTrack` calls with `limit: 200`.
  - **Review Focus 1:** `next` throws on seq 2 → seq 3 still delivered.
  - **Review Focus 2:** call `track()` a second time on the same host without stopping (simulated reload) → handle has the same `trackingId`; fixes not yet acknowledged are delivered to the new observer; none skipped.
  - **Review Focus 3:** `stop()` while `readTrack` is delayed (`host.delay`) → no `next` after `stop()` resolves; no unhandled rejection.
  - **Review Focus 4:** `host.fail('location.startTracking', 'E_NOT_IMPLEMENTED')` → `track()` rejects with that `HoomiError`; no listeners left attached.
  - **Review Focus 5:** `host.failTracking()` then a trigger → remaining fixes delivered, then `error` called with code `E_UNAVAILABLE`.
  - `host.expireTracking()` then a trigger → remaining fixes delivered, then `complete` called, and `stopTracking` reached the host.
  - `limits: { maxTrackedFixes: 2 }` → `onDropped(1)`.
  - starting when the existing session is already expired → old fixes delivered, then a fresh `trackingId`.
  - `signal` abort → behaves like `stop()`.
- [ ] **Step 2:** Run `npx vitest run test/tracking.test.ts` → FAIL.
- [ ] **Step 3:** Implement `createLocationTracker(client, raw)` in `src/api/tracking.ts`; wire `location.track` in `namespaces.ts`.
- [ ] **Step 4:** `npm test && npm run build && npm run size` → all pass (size gate included).
- [ ] **Step 5:** Commit `feat: location.track wrapper`.

### Task 10: SDK docs

**Files:** Modify `README.md`, `CLAUDE.md`.

- [ ] **Step 1:** README: a "Background location tracking" section (the `location.track` example from the spec, required scopes `location.background` + `location.fine` for `'high'`, limits, what ends tracking, at-least-once note after reload) and `ui.setKeepScreenOn`. Note `'fine'` is deprecated and `'high'` is the precise mode.
- [ ] **Step 2:** CLAUDE.md "Hard invariants": one paragraph — the track log is host-side, in-memory and session-scoped; tracking never outlives the micro-app and the host never delivers fixes anywhere but the page; `TrackedFix` is `GeoPosition` + `seq`, no second position shape; the mock enforces the same caps and scope gates; the vectors pin a 3-fix fixture.
- [ ] **Step 3:** Commit `docs: background location tracking`.

---

## Part 3 — MOBILE (`hoomi-mobile`)

### Task 11: Wire providers and platform config

**Files:**
- Modify: `pubspec.yaml`, `lib/services/microapp/hoomi_location_adapter.dart`, `lib/services/microapp/microapp_runtime.dart`, `android/app/src/main/AndroidManifest.xml`, `ios/Runner/Info.plist`
- Create: `lib/services/microapp/hoomi_screen_adapter.dart`

**Interfaces — Consumes:** `HoomiBackgroundLocationProvider`, `HoomiScreenProvider`, runtime params `backgroundLocationProvider`, `screenProvider` (ADAPTER Tasks 3, 5).

- [ ] **Step 1:** `pubspec.yaml`: point `hoomi_microapp` at the local path `../hoomi-flutter-microapp` (the commented-out block at lines 69–74 shows the form) and add `wakelock_plus`. Run `flutter pub get`. Leave a `TODO(release)` comment to switch back to a git ref once the adapter branch is merged — and say so in the final report.
- [ ] **Step 2:** `HoomiLocationAdapter implements HoomiLocationProvider, HoomiBackgroundLocationProvider`. `trackPosition` calls `MicroAppPermissions.requireLocation()` then `Geolocator.getPositionStream` with:
  - Android: `AndroidSettings(accuracy, distanceFilter, foregroundNotificationConfig: ForegroundNotificationConfig(notificationTitle: <title>, notificationText: <text>, enableWakeLock: true, setOngoing: true))`
  - iOS: `AppleSettings(accuracy, distanceFilter, allowBackgroundLocationUpdates: true, showBackgroundLocationIndicator: true, pauseLocationUpdatesAutomatically: false)`
  - Copy — en: title `Hoomi`, text `{appName} is using your location`; id: text `{appName} sedang menggunakan lokasi Anda`. Locale from `ctx.locale`.
  - Reuse `_accuracyFor` and `_toGeoPosition`.
- [ ] **Step 3:** `HoomiScreenAdapter implements HoomiScreenProvider` → `WakelockPlus.toggle(enable: enabled)`.
- [ ] **Step 4:** Pass both into `MicroAppRuntime(...)` in `microapp_runtime.dart`; in the existing `onSessionEnd`, also `WakelockPlus.disable()` as a belt-and-braces release.
- [ ] **Step 5:** `AndroidManifest.xml`: add `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, and `POST_NOTIFICATIONS` if absent. Check the merged manifest (`geolocator_android`'s own manifest) for the foreground service declaration with `foregroundServiceType="location"`; add it only if the plugin does not already declare it.
- [ ] **Step 6:** `Info.plist`: reword the three location usage strings (lines 54–59) so they no longer say location "is only read while you are using the app". Text: `Hoomi uses your location to show posts, people and communities near you, and to let a mini app you open find nearby places. A mini app you start a trip or delivery in can keep receiving your location while Hoomi is in the background, until you close it.`
- [ ] **Step 7:** Check `lib/services/microapp/hoomi_micro_app_registry.dart`: does a manifest scope string `location.background` from the backend reach `MicroAppScope.parseAll` unchanged? If the backend maps or whitelists scopes so it cannot be granted, **stop and report** — that needs a change in the Hoomi API repo, which is out of this plan.
- [ ] **Step 8:** `flutter analyze` → no new issues. `flutter build apk --debug` → succeeds.
- [ ] **Step 9:** Commit `feat(microapp): background location tracking and keep-screen-on`.

### Task 12: Device verification (manual — needs the user's devices)

Not automatable from here. Produce the checklist in the final report rather than claiming it done:

- Android + iOS: start tracking in a test micro-app with `accuracy: 'high'`, `minDistanceMeters: 10`; consent sheet appears; notification (Android) / location indicator (iOS) appears.
- Lock the phone and move for 5+ minutes; unlock → the full trail arrives in order, no gaps in `seq`.
- Switch to another app for 5+ minutes → same.
- Reload the micro-app mid-session → no second consent sheet; no fixes skipped.
- Stop tracking, and separately close the micro-app → notification/indicator disappears within a few seconds.
- Turn GPS off mid-session → app receives the `E_UNAVAILABLE` error.
- Xiaomi/Oppo/Vivo device if available: 15 minutes locked; note whether fixes stop (spec's known risk).
- `ui.setKeepScreenOn(true)` → screen stays on past the system timeout; leaving the micro-app releases it.
