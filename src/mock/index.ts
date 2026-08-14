/**
 * Mock host installer for browser development: wires the mock host into
 * `window` exactly the way the real Hoomi host would (bootstrap global +
 * flutter_inappwebview.callHandler), so the SDK cannot tell the difference.
 *
 * URL-driven scenarios: ?hoomi_scenario=deny-forever&hoomi_latency=1200
 * (also hoomi_seed, hoomi_failure, hoomi_offline=1, hoomi_panel=1).
 */

import { HoomiError } from '../core/errors.js';
import { MockHost, type MockHostHandle, type MockHostOptions } from './mockHost.js';
import { createMockPanel } from './panel.js';
import { isScenarioName } from './scenarios.js';

export {
  MockHost,
  mockError,
  type FrameLogEntry,
  type MockCallContext,
  type MockHostHandle,
  type MockHostOptions,
  type MockLimits,
  type MockMethodHandler,
  type MockPageSeed,
  type MockStreamController,
  type MockStreamDriver,
  type PermissionDomain,
  type PermissionState,
  type RecordedCall,
} from './mockHost.js';
export { SCENARIO_NAMES, isScenarioName, type ScenarioName } from './scenarios.js';

interface MockWindow {
  flutter_inappwebview?: unknown;
  __hoomiBootstrap?: unknown;
  __hoomiRx?: ((frame: string) => void) | undefined;
  __hoomiRxQueue?: string[] | undefined;
}

function optionsFromUrl(base: MockHostOptions): MockHostOptions {
  if (typeof location === 'undefined' || typeof location.search !== 'string') return base;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return base;
  }
  const merged: MockHostOptions = { ...base };
  const scenario = params.get('hoomi_scenario');
  if (scenario !== null && isScenarioName(scenario)) merged.scenario = scenario;
  const latency = Number(params.get('hoomi_latency'));
  if (params.get('hoomi_latency') !== null && Number.isFinite(latency) && latency >= 0) merged.latencyMs = latency;
  const seed = Number(params.get('hoomi_seed'));
  if (params.get('hoomi_seed') !== null && Number.isFinite(seed)) merged.seed = seed;
  const failure = Number(params.get('hoomi_failure'));
  if (params.get('hoomi_failure') !== null && Number.isFinite(failure)) merged.failureRate = Math.min(Math.max(failure, 0), 1);
  if (params.get('hoomi_offline') === '1') merged.offline = true;
  if (params.get('hoomi_panel') === '1') merged.panel = true;
  return merged;
}

/**
 * Install the mock host onto `window`. Call this BEFORE createHoomi()/
 * getHoomi() so the SDK finds the bootstrap global, exactly like on device.
 */
export function installMockHost(options: MockHostOptions = {}): MockHostHandle {
  if (typeof window === 'undefined') {
    throw new HoomiError(
      'E_UNAVAILABLE',
      'installMockHost needs a window. In Node tests use createTestHoomi() from "hoomi.microapps.js/testing" instead.',
    );
  }
  const w = window as unknown as MockWindow;
  const resolved = optionsFromUrl(options);
  const host = new MockHost(resolved);

  const hadBridge = 'flutter_inappwebview' in w;
  const previousBridge = w.flutter_inappwebview;
  const hadBootstrap = '__hoomiBootstrap' in w;
  const previousBootstrap = w.__hoomiBootstrap;
  const hadRx = '__hoomiRx' in w;
  const previousRx = w.__hoomiRx;
  const hadQueue = '__hoomiRxQueue' in w;
  const previousQueue = w.__hoomiRxQueue;

  w.flutter_inappwebview = {
    callHandler: (name: string, ...args: unknown[]): Promise<unknown> => {
      if (name !== 'hoomi') {
        return Promise.reject(new HoomiError('E_UNSUPPORTED', `Unknown handler: ${name}`));
      }
      return host.handleCall(String(args[0] ?? ''));
    },
  };

  // Mirror the real document-start bootstrap script exactly: a bounded
  // buffering __hoomiRx that fills __hoomiRxQueue until the SDK replaces it
  // and drains the queue.
  w.__hoomiRxQueue = w.__hoomiRxQueue ?? [];
  w.__hoomiRx = (frame: string) => {
    const queue = w.__hoomiRxQueue;
    if (Array.isArray(queue)) {
      queue.push(frame);
      if (queue.length > 64) queue.shift();
    }
  };
  w.__hoomiBootstrap = host.bootstrap();

  // Deliver host->JS pushes through whatever __hoomiRx is current at push
  // time — the buffering shim before SDK init, the SDK's handler after.
  host.addRxSink((frame) => {
    const rx = w.__hoomiRx;
    if (typeof rx === 'function') rx(frame);
  });

  const panel = resolved.panel ? createMockPanel(host) : null;

  host.addUninstallHook(() => {
    panel?.destroy();
    if (hadBridge) w.flutter_inappwebview = previousBridge;
    else delete w.flutter_inappwebview;
    if (hadBootstrap) w.__hoomiBootstrap = previousBootstrap;
    else delete w.__hoomiBootstrap;
    if (hadRx) w.__hoomiRx = previousRx;
    else delete w.__hoomiRx;
    if (hadQueue) w.__hoomiRxQueue = previousQueue;
    else delete w.__hoomiRxQueue;
  });

  return host;
}
