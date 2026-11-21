# Background location tracking for micro-apps — design

Date: 2026-11-21
Status: approved 2026-11-21

Spans three repos:

- `hoomi-microapps-sdk-js` (this repo) — JS SDK, mock host, protocol vectors
- `hoomi-flutter-microapp` — the Dart bridge/adapter package, authoritative wire spec
- `hoomi-mobile` — the host app (geolocator, OS permissions, platform config)

## Intent

A micro-app (a web app running in Hoomi's WebView) consumes GPS fixes from the
host and processes them itself. Today that works only while the micro-app is on
screen: `location.watch` streams fixes, but once the user switches apps or
locks the phone the fixes stop reaching the page.

The web app needs **every fix** from the whole time it is open, including the
stretches where Hoomi is in the background or the phone is locked (a driver or
courier mid-trip).

## Goals

- A micro-app can start a tracking session; the host keeps GPS running while
  Hoomi is backgrounded or the phone is locked.
- No fix is lost because the page was asleep, missed an event, or reloaded.
  Fixes arrive in order.
- The user can always see that tracking is on (Android notification, iOS
  location indicator) and it never outlives the micro-app.
- Loss that *does* happen (buffer overflow, session expiry) is reported to the
  page, never silent.

## Non-goals

- Tracking after the micro-app is closed or Hoomi is killed. Decided: tracking
  ends when the micro-app closes. The existing rule "a micro-app must not keep
  GPS alive after it is closed" stays intact.
- The host sending fixes to a backend. The page is the only consumer.
- Surviving the OS killing the Hoomi process. The log is in memory; if the
  process dies the micro-app session is gone too.
- A React hook in v1 (see "Left to the builder").
- Geofencing, activity recognition, or any "Always" location permission.

## Anti-goals

- Making the mock host more lenient than the real host.
- A second position shape. Tracked fixes are the existing `GeoPosition` plus a
  `seq`.
- Silent caps. Any limit that drops data must be visible to the page.

## Constraints found in the code

- WebView JavaScript is throttled or suspended in the background
  (`hoomi-flutter-microapp/lib/src/capabilities/jobs.dart` documents this for
  iOS). The page cannot be relied on to receive pushes while backgrounded.
- Stream subscriptions are cancelled on teardown and on page reload
  (`session.dart`: `dropSubscriptions`, `_cancelAllSubscriptions`).
- Frames are capped at 262,144 bytes pre-parse, so a backlog must be paged.
- `geolocator` 14.x, already a dependency of `hoomi-mobile`, supports both
  platform mechanisms: `AndroidSettings.foregroundNotificationConfig`
  (foreground service + notification) and
  `AppleSettings.allowBackgroundLocationUpdates`. No new dependency.
- iOS `Info.plist` already declares the `location` background mode. Android
  declares only fine/coarse location: no foreground-service permissions.
- Every protocol method needs a vector in `protocol/vectors/methods/` in both
  repos (CLAUDE.md hard invariant); neither corpus may shrink.
- Everything rejecting across the SDK's public API must be a `HoomiError`.
- Existing drift: the SDK's `LocationParams` sends `accuracy: 'coarse' | 'fine'`
  and `minDistanceM`; the host reads `'coarse' | 'low' | 'high'` (else
  balanced) and `minDistanceMeters`. So `'fine'` and the distance filter are
  silently ignored today.

## Approaches

**A. `background: true` flag on `location.watch`.** Host keeps GPS alive and
keeps pushing stream events. Smallest change, but pushes into a suspended
WebView can be dropped and the host never learns what the page received. Cannot
guarantee every fix. Rejected.

**B. Host-side track log, page pulls with a cursor. (Chosen.)** The host
records fixes natively into a bounded, numbered log. The page reads batches
after a sequence number; advancing the cursor acknowledges what came before.
Loss-free across sleep and reload, pageable under the frame cap, no
retransmit machinery.

**C. Host pushes numbered batches, page acks each.** Same guarantee as B, but
needs retransmit timers and still pushes into a page that may be suspended.
More protocol for no gain. Rejected.

Picked B (approved in conversation), because the requirement is every fix and B
is the simplest design that can promise it.

## Design

### Wire protocol (v1, additive)

Three new methods and one new event. Names follow the host's existing params
(`accuracy`, `minDistanceMeters`).

**`location.startTracking`**

```jsonc
// params
{ "accuracy": "balanced",        // "coarse" | "balanced" | "high"; default "balanced"
  "minDistanceMeters": 25 }      // integer >= 0; default 25
// result
{ "trackingId": "trk-…",         // opaque, host-chosen
  "startedAt": 1795000000000,    // epoch ms
  "expiresAt": 1795028800000,    // epoch ms; host stops tracking here
  "maxBufferedFixes": 10000,
  "state": "active",
  "resumed": false }             // true when an existing session was returned
```

- At most one tracking session per micro-app session. Calling it while one is
  active returns that session with `resumed: true` and does not change its
  settings. This is how a reloaded page picks its session back up.
- The result also carries `state` (`"active" | "expired" | "failed"`). If the
  previous session has ended on its own (expired or failed) and has not been
  stopped, `startTracking` returns *that* session with `resumed: true` and its
  ended `state`; it never wipes an unread log implicitly. The page drains it,
  calls `stopTracking`, then starts again. The SDK wrapper does this itself.
  (My call; avoids inventing a new error code.)
- `state: "failed"` means the location source died mid-session (GPS switched
  off, OS permission revoked). GPS and keep-alive stop, the log stays readable.
  The SDK wrapper drains, then reports a retryable `E_UNAVAILABLE` to the
  observer's `error`.
- For this new method `accuracy` is strict: anything other than the three
  values is `E_INVALID_PARAMS` (unlike `getCurrent`/`watch`, which stay
  lenient so `'fine'` keeps working).
- Invalid `accuracy` or `minDistanceMeters` → `E_INVALID_PARAMS`.

**`location.readTrack`**

```jsonc
// params
{ "trackingId": "trk-…",
  "afterSeq": 0,                 // integer >= 0; "give me fixes with seq > this"
  "limit": 200 }                 // integer 1..500; default 200
// result
{ "fixes": [ { "seq": 1, "latitude": …, "longitude": …, "accuracy": …,
               "timestamp": …, "isMocked": false /* + optional GeoPosition fields */ } ],
  "lastSeq": 1,                  // highest seq recorded so far
  "hasMore": false,
  "droppedCount": 0,             // fixes evicted before being read (cumulative)
  "state": "active" }            // "active" | "expired" | "failed"
```

- `seq` starts at 1 and increases by 1 per recorded fix.
- **Ack by cursor:** the host discards every fix with `seq <= afterSeq`.
  Reading with `afterSeq: 0` returns everything not yet acknowledged, which is
  what a freshly reloaded page does. Delivery is at-least-once.
- `limit` 500 keeps a page well under the frame cap (~200 bytes per fix).
- Unknown or stopped `trackingId` → `E_INVALID_PARAMS` (same convention as
  `audio.stopRecord` with an id it never issued).

**`location.stopTracking`**

```jsonc
// params
{ "trackingId": "trk-…" }
// result
{}
```

Stops GPS, removes the notification, wipes the log. Unknown id →
`E_INVALID_PARAMS`.

**Event `location.trackAvailable`**

```jsonc
{ "trackingId": "trk-…", "lastSeq": 42 }
```

A hint that new fixes exist. Best-effort, coalesced (no more than about one per
second), carries no positions. Correctness never depends on it arriving.

### Limits (host policy, with defaults)

- `maxBufferedFixes`: 10,000 unread fixes. When full, the oldest unread fix is
  evicted and `droppedCount` increments.
- Max session length: 8 hours. On expiry the host stops GPS and removes the
  notification; the log stays readable until the micro-app closes, with
  `state: "expired"`.
- Rate: `readTrack` needs a generous limit (a drain after a long background
  stretch is many calls in a row).

These numbers are my proposal, not something decided in conversation. For the
ride-hailing case: with `minDistanceMeters: 10`, 10,000 unread fixes is about
100 km driven without the page waking once; an 8-hour cap means a driver on a
longer shift restarts tracking (one consent sheet).

### Scope and consent

- New scope `location.background` (wire), risk `high`, rolling up to the
  existing `location` catalog key.
- `startTracking` requires `location.coarse` + `location.background`, and
  `location.fine` when `accuracy` is `"high"` (same rule as `getCurrent`).
  `readTrack`/`stopTracking` require `location.background`.
- Consent tier for `startTracking`: **per invocation** — each start shows a
  sheet saying the app will keep receiving location while Hoomi is in the
  background, until the micro-app is closed. A `resumed: true` return shows no
  sheet. My call: background tracking is the kind of authority that should not
  be granted once and forgotten.
- OS permission: the ordinary "while in use" permission is enough on both
  platforms, because tracking always starts while the micro-app is visible
  (Android foreground service of type `location`; iOS when-in-use plus
  background mode). No "Always" permission, no `ACCESS_BACKGROUND_LOCATION`.

### `hoomi-flutter-microapp` (adapter)

- New optional provider, separate from `HoomiLocationProvider` so existing
  implementers do not break:

  ```dart
  abstract interface class HoomiBackgroundLocationProvider {
    /// Fixes that keep flowing while the host app is backgrounded.
    /// Cancelling the subscription must stop GPS and remove any OS indicator.
    Stream<GeoPosition> trackPosition(
      MicroAppContext ctx, {
      LocationAccuracyHint accuracy,
      int minDistanceMeters,
    });
  }
  ```

  When the runtime has none, the three methods answer the same "unsupported"
  error other unwired capabilities do.
- The **track log lives in the package, owned by the session** (not in the
  provider): numbering, eviction, ack-by-cursor, expiry timer, coalesced
  `location.trackAvailable` events. The provider only supplies a stream.
- Lifetime: survives page reload and in-app navigation, i.e. both
  `dropSubscriptions()` and `bumpEpoch()` leave the log alone and the
  `trackingId` stays valid across an epoch bump. It ends on `stopTracking`,
  expiry, or session teardown. Teardown cancels the provider stream and clears
  the log. (My call: the session, not the document, is what the user consented
  to.)
- `location.watch` with `accuracy: "high"` starts requiring `location.fine`,
  matching `getCurrent`. Today the watch binding checks only `location.coarse`,
  so precise fixes are reachable without the high-risk scope. The mock mirrors
  it. (My call. Typed SDK users could never send `'high'` to watch before, so
  the exposure to existing apps is small.)
- Consent plumbing: the dispatcher currently confirms unconditionally for any
  per-invocation binding, and `SensitiveAction` has no tracking member. The
  builder needs a path where a `resumed: true` return shows no sheet (a
  dispatcher change, or confirming from inside the binding) plus a new
  `SensitiveAction`.
- Audit entries use `redactedForAudit()`-style rounding and record start/stop,
  not every fix.
- Method bindings, scope enum, method names, consent strings (id/en),
  `protocol/README.md`, vectors, fake provider in `testing.dart`, Dart vector
  runner.

### Keep-alive (requested by the user)

The user asked for the app to be kept alive while the micro-app is open, where
Android or iOS need it for tracking to work. Both do, and the mechanisms are
tied to an **active tracking session**, since that is the only OS-sanctioned
reason available to stay alive:

- **Android:** the location foreground service (with its ongoing notification)
  keeps the Hoomi process alive and exempt from Doze for location, plus a wake
  lock so the CPU keeps delivering fixes with the screen off.
- **iOS:** background location updates keep the app running in the background;
  `pauseLocationUpdatesAutomatically` is off so iOS does not decide the driver
  has stopped and suspend the app.
- Keep-alive starts with `startTracking` and ends with `stopTracking`, expiry
  or closing the micro-app. A micro-app that is open but not tracking gets no
  keep-alive: neither OS offers a legitimate way to hold an app alive in the
  background for no declared reason, and iOS would reject it.
- **Known risk, verify on devices:** some Android vendors (Xiaomi, Oppo, Vivo,
  some Samsung modes) kill apps despite a foreground service. If device testing
  shows fixes stopping, the follow-up is a host-side prompt guiding the user to
  exempt Hoomi from battery optimisation. That is not built in v1 because Play
  restricts the exemption permission and it should be justified by evidence.

### Screen-on (requested by the user)

A driver app wants the display to stay awake while it is in front. Independent
of tracking; the details below are my calls.

- New method **`ui.setKeepScreenOn`**, params `{ "enabled": true }` (boolean,
  required; anything else → `E_INVALID_PARAMS`), result `{}`. Idempotent.
- Baseline plumbing like `ui.toast`: new baseline scope `ui.keepScreenOn`, no
  consent sheet. It costs battery but exposes no data, and it cannot outlive
  the micro-app.
- The host applies it only while the micro-app is the visible screen and
  releases it on session teardown, so a closed or backgrounded micro-app never
  holds the screen awake. The page's request is remembered across reloads
  within the session.
- Adapter: optional hook on the host side (a small provider or a `HoomiUiHost`
  addition that does not break existing implementers); unwired → the usual
  unsupported error.
- Mobile: implemented with a screen wake lock; `hoomi-mobile` has no wakelock
  package today, so this adds one (`wakelock_plus`) or a few lines of platform
  code, builder's choice.
- SDK: `hoomi.ui.setKeepScreenOn(enabled, opts?)`; mock records the state and
  exposes it to tests; vectors for `true`, `false`, missing `enabled`, and
  non-boolean `enabled`.

### `hoomi-mobile` (host app)

- `HoomiLocationAdapter` also implements `HoomiBackgroundLocationProvider`
  using `Geolocator.getPositionStream` with platform settings:
  - Android: `AndroidSettings` with `foregroundNotificationConfig`
    (ongoing notification: "<micro-app name> is using your location", id/en,
    tap returns to Hoomi), wake lock on.
  - iOS: `AppleSettings` with `allowBackgroundLocationUpdates: true`,
    `showBackgroundLocationIndicator: true`,
    `pauseLocationUpdatesAutomatically: false`.
- Wire it into `microapp_runtime.dart`.
- `AndroidManifest.xml`: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`,
  `POST_NOTIFICATIONS` (if not already present), and whatever service
  declaration geolocator's foreground service needs.
- `Info.plist`: the usage strings currently say location "is only read while
  you are using the app". That becomes untrue; reword to cover a mini app the
  user left open tracking in the background.
- Uses the existing `MicroAppPermissions.requireLocation()` denial codes.

### `hoomi-microapps-sdk-js` (this repo)

- Types in `src/api/types.ts`: `StartTrackingParams`, `TrackingSession`,
  `ReadTrackParams`, `ReadTrackResult`, `TrackedFix` (= `GeoPosition` +
  `seq`).
- `LocationApi` gains the three raw methods (each with trailing
  `{ signal?, timeoutMs? }`) and a convenience wrapper:

  ```ts
  const tracking = await hoomi.location.track(
    { accuracy: 'high', minDistanceMeters: 10 },
    {
      next: (fix) => { /* every fix, in order */ },
      error: (err) => { /* HoomiError */ },
    },
    { onDropped: (count) => { /* host evicted `count` unread fixes */ } },
  );
  // later
  await tracking.stop();
  ```

  The wrapper hides the cursor. It drains (`readTrack` in a loop until
  `hasMore` is false) on start, on each `location.trackAvailable`, and on
  `lifecycle.show`; one drain at a time. It delivers each `seq` once per page
  lifetime, and acknowledges by passing the last delivered `seq` as the next
  `afterSeq`. When `state` becomes `"expired"` and the log is drained, it
  completes the observer.
- Validation before the wire, like `wallet`/`pages`: non-integer or negative
  `minDistanceMeters`, `limit`, `afterSeq` reject with a `HoomiError`.
- **Drift fix:** `LocationParams.accuracy` becomes
  `'coarse' | 'balanced' | 'high'` and `LocationWatchParams` gains
  `minDistanceMeters`. `minDistanceM` stays as a deprecated alias the SDK
  translates to `minDistanceMeters` before sending.
- **`'fine'` (decided by the user):**
  `'fine'` stays accepted, deprecated, and is sent unchanged, so it keeps
  behaving as it does today (the host treats it as balanced). It is *not*
  translated to `'high'`: `getCurrent` requires the `location.fine` scope for
  `'high'`, so translating would turn a working call into `E_SCOPE_DENIED` for
  any existing app without that scope. Apps that want precise fixes move to
  `'high'` deliberately.
- **`'high'` is the precise mode and must work end to end** for
  `getCurrent`, `watch` and `startTracking`. The first consumer is a
  ride-hailing micro-app, which needs high-precision GPS; its manifest must
  hold `location.fine` as well as `location.background`.
- `GeoPosition` gains `isMocked?: boolean`, which the host already sends and
  the SDK type omits. The mock returns it too.
- Mock host: implements the same log with the same limits, scope gate
  (`location.background`), permission gate, one-session rule, ack-by-cursor,
  eviction and expiry. Test controls to push fixes and advance expiry.
  `createTestHoomi()` exposes them.
- **Vector fixture** (documented in the vectors README, like the `pages`
  one): a runner's fake location source has recorded exactly **3 fixes** by
  the time `location.startTracking` returns, and records no more on its own.
  Without it no vector would ever see a non-empty `fixes`, and the fix shape,
  ack-by-cursor and `hasMore` would be unpinned across the two repos. Extra
  vectors this enables: read `afterSeq: 0, limit: 2` returns seq 1–2 with
  `hasMore: true`; read `afterSeq: 2` returns seq 3 with `hasMore: false`;
  after that, `afterSeq: 0` returns only seq 3 (1–2 were acknowledged). If the
  vector format cannot assert array contents today, extend it and document the
  extension.
- Vectors (added identically to both repos' `protocol/vectors/methods/`):
  start valid; start with invalid accuracy; start twice returns
  `resumed: true`; read after start (types of `lastSeq`, `hasMore`,
  `droppedCount`, `state`); read with unknown id; read with `limit` 0 and 501;
  read with fractional `afterSeq`; stop valid; read after stop; stop unknown id.
- Docs: README section, CLAUDE.md invariant paragraph for tracking (log is
  host-side and session-scoped; ends on micro-app close; no backend delivery;
  mock enforces the same caps).
- Must stay inside the size gate (12 KB core).

## Testing

- SDK: unit tests for the wrapper (ordering, dedupe after a simulated reload,
  drain on `lifecycle.show` without any nudge event, `onDropped`, expiry
  completion, abort/stop mid-drain), mock-host tests, vectors.
- Adapter: log unit tests (numbering, ack, eviction, expiry, coalescing),
  teardown stops the provider stream, reload does not, vector runner.
- Mobile: manual device checks on Android and iOS — lock the phone for several
  minutes mid-session, return, confirm the full trail arrives in order; confirm
  the notification/indicator disappears on stop and on closing the micro-app.

## Rollout order

1. Adapter (`hoomi-flutter-microapp`): protocol, log, bindings, vectors.
2. SDK (this repo): types, wrapper, mock, vectors. Can proceed in parallel
   against the mock.
3. Mobile (`hoomi-mobile`): provider, platform config, device testing.

An older host that lacks the methods answers its normal unknown-method error,
which the SDK surfaces as a `HoomiError`; apps can feature-detect on that.

## Left to the builder

- Exact error code for "provider not wired" and "unknown method", following
  what the dispatcher already does.
- Whether the handshake advertises a capability flag for tracking, and its
  name.
- How the mock expresses the new scope given its coarser scope names.
- Whether the micro-app's manifest/registry pipeline passes the new
  `location.background` scope through unchanged, or the backend needs a seed.
  If the backend needs a change, stop and raise it: that is a fourth repo.
- Notification channel, icon and exact copy; consent sheet copy (id/en).
- A `useLocationTracking` React hook is deferred: with per-invocation consent,
  StrictMode's double-invoked effects would prompt twice in development unless
  it is designed around `resumed`. Worth its own small design after v1.
