/**
 * hoomi.microapps.js — SDK for Hoomi micro-apps.
 *
 * Import-time side-effect free: nothing here touches `window` until you call
 * `createHoomi()` / `getHoomi()`.
 */

export { createHoomi, getHoomi, resetSharedHoomi } from './hoomi.js';
export type { BackPressHandler, Hoomi, HoomiOptions } from './hoomi.js';

export {
  BridgeClient,
  SDK_VERSION,
  type BridgeClientOptions,
  type BridgeStatus,
  type CallOptions,
  type HelloResult,
  type HostLimits,
  type Subscription,
  type SubscriptionObserver,
} from './core/client.js';

export {
  FlutterInAppWebViewTransport,
  NullTransport,
  capabilityNames,
  captureBootstrap,
  detectTransport,
  type HoomiBootstrap,
  type Transport,
} from './core/transport.js';

export {
  PROTOCOL_VERSION,
  decodeCallFrame,
  decodeInboundFrame,
  encodeCallFrame,
  encodeFrame,
  utf8ByteLength,
  type CallDecodeResult,
  type CallFrame,
  type DecodedCall,
  type EventFrame,
  type InboundFrame,
  type ResultFrame,
} from './core/codec.js';

export { ID_PATTERN, METHOD_PATTERN, createIdGenerator, isValidId, isValidMethod } from './core/ids.js';

export {
  BridgeUnavailableError,
  ERROR_CODES,
  HoomiError,
  PermissionDeniedError,
  RateLimitedError,
  ScopeNotGrantedError,
  TimeoutError,
  UnsupportedError,
  UserCancelledError,
  errorFromWire,
  toHoomiError,
  type HoomiErrorCode,
  type HoomiErrorInit,
  type WireError,
} from './core/errors.js';

export type {
  ApiNamespaces,
  AudioApi,
  BleApi,
  CameraApi,
  IotApi,
  JobsApi,
  LifecycleApi,
  LocationApi,
  PagesApi,
  StorageApi,
  SystemApi,
  UiApi,
  UserApi,
  WalletApi,
} from './api/namespaces.js';

export type * from './api/types.js';
export type { TrackOptions, TrackingHandle } from './api/tracking.js';
