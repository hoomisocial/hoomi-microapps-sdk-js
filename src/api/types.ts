/** Typed shapes for the host API surface. */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

export interface LaunchPayload {
  /** Where the launch came from (deep link, home shelf, another app...). */
  entry?: string;
  /** Query params / launch params passed by the opener. */
  params?: Record<string, JsonValue>;
  referrer?: string;
  [key: string]: unknown;
}

export interface ReportErrorParams {
  message: string;
  stack?: string;
  fatal?: boolean;
  extra?: Record<string, JsonValue>;
}

// ---------------------------------------------------------------------------
// ui
// ---------------------------------------------------------------------------

export interface ToastParams {
  message: string;
  durationMs?: number;
}

export interface AlertParams {
  title?: string;
  message: string;
  okLabel?: string;
}

export interface ConfirmParams {
  title?: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
}

export interface ConfirmResult {
  confirmed: boolean;
}

export interface OpenExternalParams {
  url: string;
}

// ---------------------------------------------------------------------------
// system
// ---------------------------------------------------------------------------

/**
 * Flat, not nested under a `device` key: consumers read `platform` and
 * `locale` straight off the result, and a wrapper would make every one of them
 * reach through it for nothing.
 */
export interface SystemInfo {
  platform: string;
  /**
   * The wire protocol version the host is speaking, echoed here so an app can
   * check it without keeping the handshake result around.
   */
  protocol?: number;
  /** The micro-app's own id, as the host knows it. */
  appId?: string;
  osVersion?: string;
  hostVersion?: string;
  model?: string;
  locale?: string;
  theme?: 'light' | 'dark' | (string & {});
  safeAreaInsets?: { top: number; right: number; bottom: number; left: number };
  [key: string]: unknown;
}

export interface NetworkStatus {
  online: boolean;
  type?: 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown' | (string & {});
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// user
// ---------------------------------------------------------------------------

export interface UserProfile {
  id: string;
  displayName?: string;
  avatarUrl?: string;
  email?: string;
  phone?: string;
  [key: string]: unknown;
}

export interface GetIdTokenParams {
  audience?: string;
  forceRefresh?: boolean;
}

export interface IdTokenResult {
  token: string;
  expiresAt?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// location
// ---------------------------------------------------------------------------

export interface LocationParams {
  accuracy?: 'coarse' | 'fine';
  maximumAgeMs?: number;
}

export interface LocationWatchParams extends LocationParams {
  minIntervalMs?: number;
  minDistanceM?: number;
}

export interface GeoPosition {
  latitude: number;
  longitude: number;
  accuracy?: number;
  altitude?: number;
  heading?: number;
  speed?: number;
  timestamp?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// media
//
// Every method that produces media — `camera.capture`, `camera.pickImage`,
// `camera.recordVideo`, `audio.stopRecord` — resolves to the same `MediaAsset`.
// One shape, because "a photo" and "a recording" differ only in their bytes,
// and a per-method result type is how the two SDKs drift apart.
// ---------------------------------------------------------------------------

/**
 * A captured, picked or recorded asset — the host's single media shape.
 *
 * Carries the content itself and deliberately **no filesystem path**: the host
 * is the gateway to the hardware, so an app that asked for a photo gets the
 * photo, in `uri`. `handle` is an opaque, session-scoped reference for
 * host-side operations like uploading it later — never a path, because handing
 * one to a micro-app would leak the app sandbox layout and invite traversal.
 */
export interface MediaAsset {
  /** Opaque, session-scoped host reference. Not a path; do not parse it. */
  handle: string;
  /**
   * The content, as something the page can render or upload directly: a
   * `data:` URI when it is small enough to travel inline, or an `https:` URL
   * once the host has stored it. This is the point of the capability — a
   * result carrying only a handle would be a receipt the app cannot redeem.
   */
  uri: string;
  /** e.g. `'image/jpeg'`, `'video/mp4'`, `'audio/wav'`. */
  mimeType: string;
  /** Size of the underlying media in bytes, *before* any base64 expansion. */
  byteLength: number;
  width?: number;
  height?: number;
  durationMs?: number;
  /** A downscaled thumbnail, sent only when `uri` is large. */
  previewDataUri?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// camera
// ---------------------------------------------------------------------------

export interface CameraCaptureParams {
  facing?: 'front' | 'back';
  /** JPEG quality, 1..100. */
  quality?: number;
  /** Downscale bounds the host applies before returning the image. */
  maxWidth?: number;
  maxHeight?: number;
}

export interface PickImageParams {
  /**
   * Upper bound on how many images to return, not an exact count — the user
   * may pick fewer. Named to match the host, which clamps it to 1..20; a
   * mismatched name here meant a request for five silently returned one.
   */
  maxItems?: number;
}

/**
 * The wrapper key is `assets`, not `images`: the elements are `MediaAsset`s,
 * the same ones every other media method returns, and naming the list after
 * the picker rather than its contents is how a second shape gets invented.
 */
export interface PickImageResult {
  assets: MediaAsset[];
}

export interface ScanCodeParams {
  formats?: string[];
}

export interface ScanCodeResult {
  /** The decoded payload. Named `text` on the wire, never `value`. */
  text: string;
  /** e.g. `'qr'`, `'ean13'`. */
  format: string;
}

export interface RecordVideoParams {
  /** Which camera to open. Defaults to `'back'`. */
  facing?: 'front' | 'back';
  /**
   * Stop the recording after this many milliseconds. Positive integer; the
   * SDK rejects anything else with `E_INVALID_PARAMS` before a frame is
   * written. Hosts additionally clamp it to a sane window (v1: 100 ms to
   * 10 minutes) and answer `E_INVALID_PARAMS` outside it.
   */
  maxDurationMs?: number;
}

// ---------------------------------------------------------------------------
// audio
// ---------------------------------------------------------------------------

export interface StartRecordParams {
  maxDurationMs?: number;
  format?: 'aac' | 'wav' | 'opus' | (string & {});
}

export interface StartRecordResult {
  recordingId: string;
}

export interface StopRecordParams {
  /**
   * Required. The host will not guess which recording to stop, so omitting it
   * is `E_INVALID_PARAMS` on a device even though a lenient mock might accept
   * it.
   */
  recordingId: string;
}

// ---------------------------------------------------------------------------
// wallet
// ---------------------------------------------------------------------------

export interface GetBalanceParams {
  /**
   * Currency to report the balance in. Required and explicit: a wallet can
   * hold more than one, and an implicit "default currency" is a guess the
   * host is not entitled to make on the micro-app's behalf.
   */
  currency: string;
}

export interface WalletBalance {
  /**
   * Integer minor units (sen for IDR, cents for USD). The field is named
   * `amountMinor`, never `amount`, because an ambiguous name is exactly what
   * lets a float onto a money path.
   */
  amountMinor: number;
  currency: string;
  [key: string]: unknown;
}

export interface RequestPaymentParams {
  /**
   * Integer minor units, >= 1. NEVER a float — JSON has no integer type, so
   * `2500.5` decodes as a double and truncating it on a payment path is a
   * defect, not a rounding question. The SDK rejects a non-integer before it
   * reaches the wire.
   */
  amountMinor: number;
  currency: string;
  /**
   * Who gets paid. Required, and a different concept from `orderId`: this
   * identifies the payee, not the caller's own bookkeeping reference.
   */
  payeeRef: string;
  /** The micro-app's own order reference, echoed back on the result. */
  orderId?: string;
  description?: string;
}

/**
 * Open-ended on purpose: a host that grows a status this SDK version has not
 * heard of must not make consuming code throw. v1 hosts emit only the three
 * named members.
 */
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | (string & {});

/**
 * The app-facing handle for a payment is `paymentId`. The host's idempotency
 * key is derived from the session and is deliberately not returned here — it
 * is host-internal and a micro-app must never be able to replay it.
 */
export interface PaymentResult {
  paymentId: string;
  status: PaymentStatus;
  amountMinor?: number;
  currency?: string;
  orderId?: string;
  [key: string]: unknown;
}

export interface GetPaymentStatusParams {
  paymentId: string;
}

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

export interface ScheduleJobParams {
  name: string;
  /** Epoch millis. Provide either runAt or delayMs. */
  runAt?: number;
  delayMs?: number;
  payload?: Record<string, JsonValue>;
}

export interface ScheduleJobResult {
  jobId: string;
}

export interface CancelJobParams {
  jobId: string;
}

export interface JobInfo {
  jobId: string;
  name: string;
  runAt: number;
  payload?: Record<string, JsonValue>;
  [key: string]: unknown;
}

export interface ListJobsResult {
  jobs: JobInfo[];
}

// ---------------------------------------------------------------------------
// pages
//
// Read-only access to the **signed-in user's own** storefront Pages and the
// Products listed on them: seller tools, a cross-posting helper, a catalogue
// viewer. It is the viewing user's own commercial data.
//
// It is deliberately *not* a way to browse Hoomi. Pages the user merely
// follows and pages belonging to anyone else are out of scope. That boundary
// is what keeps this one modest consent row instead of a capability that could
// enumerate the catalogue or harvest a follow graph.
// ---------------------------------------------------------------------------

/** One of the signed-in user's storefront pages. */
export interface HoomiPage {
  id: number;
  /** The store name. */
  name: string;
  description?: string;
  category?: string;
  logoUrl?: string;
  bannerUrl?: string;
  followers: number;
  [key: string]: unknown;
}

export interface ListPagesResult {
  pages: HoomiPage[];
}

export interface GetPageParams {
  /**
   * Positive integer. Must be a page the signed-in user owns: any other id
   * answers `E_SCOPE_DENIED`, whether or not that page exists — the host will
   * not let this method become an enumeration oracle over every Page in Hoomi.
   */
  pageId: number;
}

/** A product listed on one of the signed-in user's pages. */
export interface HoomiProduct {
  id: number;
  /** The page this product is listed on. */
  pageId: number;
  name: string;
  /**
   * Integer minor units, the same rule the wallet enforces. The catalogue
   * stores prices as strings; the host parses them and fails loudly on a price
   * it cannot read, so the SDK never sees a string price.
   *
   * Note there is deliberately **no seller/user identifier** anywhere on a
   * product. These are the signed-in user's own products, so there is no
   * counterparty to name, and a stable id here would be something two
   * micro-apps could join on. Do not add one.
   */
  priceMinor: number;
  /** Currency code for `priceMinor`, e.g. `'HOOMI'`. */
  currency: string;
  description?: string;
  stock: number;
  imageUrls: string[];
  [key: string]: unknown;
}

export interface ListProductsParams {
  /** Positive integer; same ownership rule as `pages.get`. */
  pageId: number;
}

export interface ListProductsResult {
  products: HoomiProduct[];
}

// ---------------------------------------------------------------------------
// ble
// ---------------------------------------------------------------------------

export interface BleRequestDeviceParams {
  filters?: Array<{ name?: string; namePrefix?: string; services?: string[] }>;
  acceptAll?: boolean;
}

export interface BleDevice {
  deviceId: string;
  name?: string;
  rssi?: number;
  [key: string]: unknown;
}

export interface BleDeviceParams {
  deviceId: string;
}

export interface BleCharacteristicParams extends BleDeviceParams {
  service: string;
  characteristic: string;
}

export interface BleReadResult {
  /** Base64-encoded bytes. */
  value: string;
}

export interface BleWriteParams extends BleCharacteristicParams {
  /** Base64-encoded bytes. */
  value: string;
  withResponse?: boolean;
}

export interface BleNotification {
  /** Base64-encoded bytes. */
  value: string;
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// iot
// ---------------------------------------------------------------------------

export interface IotDevice {
  deviceId: string;
  name?: string;
  kind?: string;
  online?: boolean;
  [key: string]: unknown;
}

export interface ListIotDevicesResult {
  devices: IotDevice[];
}

export interface ReadTelemetryParams {
  deviceId: string;
  metrics?: string[];
}

export interface TelemetryResult {
  deviceId: string;
  telemetry: Record<string, JsonValue>;
  timestamp?: number;
}

export interface SendCommandParams {
  deviceId: string;
  command: string;
  args?: Record<string, JsonValue>;
}

export interface SendCommandResult {
  accepted: boolean;
  result?: JsonValue;
}
