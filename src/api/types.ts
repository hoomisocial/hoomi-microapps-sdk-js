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

export interface SystemInfo {
  platform: string;
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
// camera
// ---------------------------------------------------------------------------

export interface CameraCaptureParams {
  facing?: 'front' | 'back';
  quality?: number;
}

export interface CapturedImage {
  uri: string;
  width?: number;
  height?: number;
  mimeType?: string;
  [key: string]: unknown;
}

export interface PickImageParams {
  count?: number;
}

export interface PickImageResult {
  images: CapturedImage[];
}

export interface ScanCodeParams {
  formats?: string[];
}

export interface ScanCodeResult {
  value: string;
  format?: string;
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
  recordingId?: string;
}

export interface RecordingResult {
  uri: string;
  durationMs?: number;
  mimeType?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// wallet
// ---------------------------------------------------------------------------

export interface WalletBalance {
  currency: string;
  /** Minor units (cents). */
  amount: number;
  [key: string]: unknown;
}

export interface RequestPaymentParams {
  /** Minor units (cents). */
  amount: number;
  currency: string;
  orderId: string;
  description?: string;
  metadata?: Record<string, JsonValue>;
}

export type PaymentStatus = 'pending' | 'authorized' | 'completed' | 'failed' | 'refunded' | (string & {});

export interface PaymentResult {
  paymentId: string;
  status: PaymentStatus;
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
