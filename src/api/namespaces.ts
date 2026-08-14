/**
 * Thin typed wrappers over client.call(). Every method takes an optional
 * trailing `{ signal?, timeoutMs? }`.
 */

import type { BridgeClient, CallOptions, Subscription, SubscriptionObserver } from '../core/client.js';
import { HoomiError } from '../core/errors.js';
import type {
  AlertParams,
  BleCharacteristicParams,
  BleDevice,
  BleDeviceParams,
  BleNotification,
  BleReadResult,
  BleRequestDeviceParams,
  BleWriteParams,
  CameraCaptureParams,
  CancelJobParams,
  CapturedImage,
  ConfirmParams,
  ConfirmResult,
  GeoPosition,
  GetBalanceParams,
  GetIdTokenParams,
  GetPageParams,
  GetPaymentStatusParams,
  HoomiPage,
  IdTokenResult,
  JsonValue,
  ListIotDevicesResult,
  ListJobsResult,
  ListPagesResult,
  ListProductsParams,
  ListProductsResult,
  LocationParams,
  LocationWatchParams,
  NetworkStatus,
  OpenExternalParams,
  PaymentResult,
  PickImageParams,
  PickImageResult,
  ReadTelemetryParams,
  RecordingResult,
  ReportErrorParams,
  RequestPaymentParams,
  ScanCodeParams,
  ScanCodeResult,
  ScheduleJobParams,
  ScheduleJobResult,
  SendCommandParams,
  SendCommandResult,
  StartRecordParams,
  StartRecordResult,
  StopRecordParams,
  SystemInfo,
  TelemetryResult,
  ToastParams,
  UserProfile,
  WalletBalance,
} from './types.js';

type Observer<T> = SubscriptionObserver<T> | ((data: T) => void);

function toObserver<T>(observer: Observer<T>): SubscriptionObserver<unknown> {
  const o: SubscriptionObserver<T> = typeof observer === 'function' ? { next: observer } : observer;
  return o as SubscriptionObserver<unknown>;
}

function invalidParams(message: string): HoomiError {
  return new HoomiError('E_INVALID_PARAMS', message);
}

function requireNonEmptyString(value: unknown, method: string, key: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidParams(`${method} requires a non-empty string "${key}"`);
  }
  return value;
}

/**
 * Money is validated on this side of the bridge, not only on the host's.
 *
 * `amountMinor` must be a safe integer >= 1: JSON has no integer type, so a
 * float reaches the host as a perfectly valid number and gets truncated on a
 * payment path. Catching it here means the defect surfaces in the micro-app's
 * own stack trace instead of as a mystery `E_INVALID_PARAMS` from the host —
 * and, more importantly, the bad frame is never written at all.
 */
function assertRequestPaymentParams(params: RequestPaymentParams | undefined): void {
  const p = params ?? ({} as RequestPaymentParams);
  const amountMinor: unknown = p.amountMinor;
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor < 1) {
    throw invalidParams(
      `wallet.requestPayment requires "amountMinor" to be an integer number of minor units >= 1 (got ${JSON.stringify(amountMinor)})`,
    );
  }
  requireNonEmptyString(p.currency, 'wallet.requestPayment', 'currency');
  // payeeRef is who gets paid; orderId is the caller's own reference and is
  // optional. They are not interchangeable, so a missing payeeRef is fatal
  // even when orderId is present.
  requireNonEmptyString(p.payeeRef, 'wallet.requestPayment', 'payeeRef');
}

/**
 * `pageId` is a positive integer, validated page-side for the same reason
 * `amountMinor` is: TypeScript cannot express "integer", so `1.5` type-checks
 * and JSON has no integer type to catch it on the wire. The host rejects it
 * with `E_INVALID_PARAMS` too — catching it here just means the defect
 * surfaces in the micro-app's own stack trace instead of as a round trip.
 */
function requirePageId(value: unknown, method: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalidParams(`${method} requires "pageId" to be a positive integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

export interface LifecycleApi {
  /** Tell the host the micro-app has rendered and is ready to be shown. */
  ready(opts?: CallOptions): Promise<void>;
  /** Ask the host to close this micro-app. */
  close(opts?: CallOptions): Promise<void>;
  reportError(params: ReportErrorParams | string, opts?: CallOptions): Promise<void>;
}

export interface UiApi {
  toast(params: ToastParams | string, opts?: CallOptions): Promise<void>;
  alert(params: AlertParams | string, opts?: CallOptions): Promise<void>;
  /** Resolves true when the user confirmed. */
  confirm(params: ConfirmParams | string, opts?: CallOptions): Promise<boolean>;
  openExternal(params: OpenExternalParams | string, opts?: CallOptions): Promise<void>;
}

export interface StorageApi {
  /** Returns the stored JSON value, or null when the key is absent. */
  get<T extends JsonValue = JsonValue>(key: string, opts?: CallOptions): Promise<T | null>;
  set(key: string, value: JsonValue, opts?: CallOptions): Promise<void>;
  remove(key: string, opts?: CallOptions): Promise<void>;
  keys(opts?: CallOptions): Promise<string[]>;
  clear(opts?: CallOptions): Promise<void>;
}

export interface SystemApi {
  getInfo(opts?: CallOptions): Promise<SystemInfo>;
  getNetworkStatus(opts?: CallOptions): Promise<NetworkStatus>;
}

export interface UserApi {
  getProfile(opts?: CallOptions): Promise<UserProfile>;
  getIdToken(params?: GetIdTokenParams, opts?: CallOptions): Promise<IdTokenResult>;
}

export interface LocationApi {
  getCurrent(params?: LocationParams, opts?: CallOptions): Promise<GeoPosition>;
  /** Continuous position stream via bridge.subscribe. */
  watch(params: LocationWatchParams | undefined, observer: Observer<GeoPosition>, opts?: CallOptions): Promise<Subscription>;
}

export interface CameraApi {
  capture(params?: CameraCaptureParams, opts?: CallOptions): Promise<CapturedImage>;
  pickImage(params?: PickImageParams, opts?: CallOptions): Promise<PickImageResult>;
  scanCode(params?: ScanCodeParams, opts?: CallOptions): Promise<ScanCodeResult>;
}

export interface AudioApi {
  startRecord(params?: StartRecordParams, opts?: CallOptions): Promise<StartRecordResult>;
  stopRecord(params?: StopRecordParams, opts?: CallOptions): Promise<RecordingResult>;
  cancelRecord(params?: StopRecordParams, opts?: CallOptions): Promise<void>;
}

export interface WalletApi {
  /** `currency` is required: the host does not guess a default. */
  getBalance(params: GetBalanceParams, opts?: CallOptions): Promise<WalletBalance>;
  /**
   * `amountMinor` is integer minor units and `payeeRef` says who is paid.
   * Both are validated page-side and reject with `E_INVALID_PARAMS` before
   * anything is written to the bridge.
   */
  requestPayment(params: RequestPaymentParams, opts?: CallOptions): Promise<PaymentResult>;
  getPaymentStatus(params: GetPaymentStatusParams, opts?: CallOptions): Promise<PaymentResult>;
}

export interface JobsApi {
  schedule(params: ScheduleJobParams, opts?: CallOptions): Promise<ScheduleJobResult>;
  cancel(params: CancelJobParams, opts?: CallOptions): Promise<void>;
  list(opts?: CallOptions): Promise<ListJobsResult>;
}

/**
 * The signed-in user's own storefront Pages, read-only.
 *
 * Seller-tool territory: a micro-app can read the stores *this user* runs and
 * what they list on them. It cannot browse Hoomi — pages the user follows and
 * anyone else's pages are not reachable here, which is why this is one modest
 * consent row rather than a capability that could enumerate the catalogue.
 */
export interface PagesApi {
  /** Every page the signed-in user owns. */
  list(opts?: CallOptions): Promise<ListPagesResult>;
  /**
   * One owned page. `pageId` must be a positive integer (rejected page-side
   * with `E_INVALID_PARAMS` otherwise); a well-formed id the user does not own
   * answers `E_SCOPE_DENIED`, not "not found".
   */
  get(params: GetPageParams, opts?: CallOptions): Promise<HoomiPage>;
  /** Products listed on an owned page. Same `pageId` rules as `get`. */
  listProducts(params: ListProductsParams, opts?: CallOptions): Promise<ListProductsResult>;
}

export interface BleApi {
  requestDevice(params?: BleRequestDeviceParams, opts?: CallOptions): Promise<BleDevice>;
  connect(params: BleDeviceParams, opts?: CallOptions): Promise<void>;
  disconnect(params: BleDeviceParams, opts?: CallOptions): Promise<void>;
  read(params: BleCharacteristicParams, opts?: CallOptions): Promise<BleReadResult>;
  write(params: BleWriteParams, opts?: CallOptions): Promise<void>;
  /** Characteristic notification stream via bridge.subscribe. */
  notifications(params: BleCharacteristicParams, observer: Observer<BleNotification>, opts?: CallOptions): Promise<Subscription>;
}

export interface IotApi {
  listDevices(opts?: CallOptions): Promise<ListIotDevicesResult>;
  readTelemetry(params: ReadTelemetryParams, opts?: CallOptions): Promise<TelemetryResult>;
  sendCommand(params: SendCommandParams, opts?: CallOptions): Promise<SendCommandResult>;
}

export interface ApiNamespaces {
  lifecycle: LifecycleApi;
  ui: UiApi;
  storage: StorageApi;
  system: SystemApi;
  user: UserApi;
  location: LocationApi;
  camera: CameraApi;
  audio: AudioApi;
  wallet: WalletApi;
  jobs: JobsApi;
  pages: PagesApi;
  ble: BleApi;
  iot: IotApi;
}

export function createApiNamespaces(client: BridgeClient): ApiNamespaces {
  const call = <T>(method: string, params?: unknown, opts?: CallOptions): Promise<T> =>
    client.call(method, params, opts) as Promise<T>;
  const callVoid = (method: string, params?: unknown, opts?: CallOptions): Promise<void> =>
    client.call(method, params, opts).then(() => undefined);

  return {
    lifecycle: {
      ready: (opts) => callVoid('lifecycle.ready', {}, opts),
      close: (opts) => callVoid('lifecycle.close', {}, opts),
      reportError: (params, opts) =>
        callVoid('lifecycle.reportError', typeof params === 'string' ? { message: params } : params, opts),
    },
    ui: {
      toast: (params, opts) => callVoid('ui.toast', typeof params === 'string' ? { message: params } : params, opts),
      alert: (params, opts) => callVoid('ui.alert', typeof params === 'string' ? { message: params } : params, opts),
      confirm: async (params, opts) => {
        const r = await call<ConfirmResult>('ui.confirm', typeof params === 'string' ? { message: params } : params, opts);
        return r?.confirmed === true;
      },
      openExternal: (params, opts) =>
        callVoid('ui.openExternal', typeof params === 'string' ? { url: params } : params, opts),
    },
    storage: {
      get: async <T extends JsonValue = JsonValue>(key: string, opts?: CallOptions) => {
        const r = await call<{ value?: T | null }>('storage.get', { key }, opts);
        return r?.value ?? null;
      },
      set: (key, value, opts) => callVoid('storage.set', { key, value }, opts),
      remove: (key, opts) => callVoid('storage.remove', { key }, opts),
      keys: async (opts) => {
        const r = await call<{ keys?: string[] }>('storage.keys', {}, opts);
        return Array.isArray(r?.keys) ? r.keys : [];
      },
      clear: (opts) => callVoid('storage.clear', {}, opts),
    },
    system: {
      getInfo: (opts) => call<SystemInfo>('system.getInfo', {}, opts),
      getNetworkStatus: (opts) => call<NetworkStatus>('system.getNetworkStatus', {}, opts),
    },
    user: {
      getProfile: (opts) => call<UserProfile>('user.getProfile', {}, opts),
      getIdToken: (params, opts) => call<IdTokenResult>('user.getIdToken', params ?? {}, opts),
    },
    location: {
      getCurrent: (params, opts) => call<GeoPosition>('location.getCurrent', params ?? {}, opts),
      watch: (params, observer, opts) => client.subscribe('location.watch', params ?? {}, toObserver(observer), opts),
    },
    camera: {
      capture: (params, opts) => call<CapturedImage>('camera.capture', params ?? {}, opts),
      pickImage: (params, opts) => call<PickImageResult>('camera.pickImage', params ?? {}, opts),
      scanCode: (params, opts) => call<ScanCodeResult>('camera.scanCode', params ?? {}, opts),
    },
    audio: {
      startRecord: (params, opts) => call<StartRecordResult>('audio.startRecord', params ?? {}, opts),
      stopRecord: (params, opts) => call<RecordingResult>('audio.stopRecord', params ?? {}, opts),
      cancelRecord: (params, opts) => callVoid('audio.cancelRecord', params ?? {}, opts),
    },
    wallet: {
      // async so a validation failure rejects the returned promise rather
      // than throwing synchronously out of the call expression.
      getBalance: async (params, opts) => {
        const currency = requireNonEmptyString(params?.currency, 'wallet.getBalance', 'currency');
        return call<WalletBalance>('wallet.getBalance', { currency }, opts);
      },
      requestPayment: async (params, opts) => {
        assertRequestPaymentParams(params);
        return call<PaymentResult>('wallet.requestPayment', params, opts);
      },
      getPaymentStatus: async (params, opts) => {
        const paymentId = requireNonEmptyString(params?.paymentId, 'wallet.getPaymentStatus', 'paymentId');
        return call<PaymentResult>('wallet.getPaymentStatus', { paymentId }, opts);
      },
    },
    jobs: {
      schedule: (params, opts) => call<ScheduleJobResult>('jobs.schedule', params, opts),
      cancel: (params, opts) => callVoid('jobs.cancel', params, opts),
      list: (opts) => call<ListJobsResult>('jobs.list', {}, opts),
    },
    pages: {
      list: (opts) => call<ListPagesResult>('pages.list', {}, opts),
      // async so a validation failure rejects the returned promise rather
      // than throwing synchronously out of the call expression.
      get: async (params, opts) => {
        const pageId = requirePageId(params?.pageId, 'pages.get');
        return call<HoomiPage>('pages.get', { pageId }, opts);
      },
      listProducts: async (params, opts) => {
        const pageId = requirePageId(params?.pageId, 'pages.listProducts');
        return call<ListProductsResult>('pages.listProducts', { pageId }, opts);
      },
    },
    ble: {
      requestDevice: (params, opts) => call<BleDevice>('ble.requestDevice', params ?? {}, opts),
      connect: (params, opts) => callVoid('ble.connect', params, opts),
      disconnect: (params, opts) => callVoid('ble.disconnect', params, opts),
      read: (params, opts) => call<BleReadResult>('ble.read', params, opts),
      write: (params, opts) => callVoid('ble.write', params, opts),
      notifications: (params, observer, opts) =>
        client.subscribe('ble.notifications', params, toObserver(observer), opts),
    },
    iot: {
      listDevices: (opts) => call<ListIotDevicesResult>('iot.listDevices', {}, opts),
      readTelemetry: (params, opts) => call<TelemetryResult>('iot.readTelemetry', params, opts),
      sendCommand: (params, opts) => call<SendCommandResult>('iot.sendCommand', params, opts),
    },
  };
}
