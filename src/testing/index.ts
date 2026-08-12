/**
 * Test helpers. `createTestHoomi()` wires a fresh SDK instance directly to a
 * fresh mock host through an in-memory transport — no globals are touched,
 * so tests can run in plain Node and in parallel.
 */

import { createHoomi, type Hoomi, type HoomiOptions } from '../hoomi.js';
import { MockHost, type MockHostHandle, type MockHostOptions } from '../mock/mockHost.js';

export interface TestHoomi {
  hoomi: Hoomi;
  host: MockHostHandle;
  /** Dispose the SDK and uninstall the mock host. */
  cleanup(): void;
}

export interface CreateTestHoomiOptions extends MockHostOptions {
  sdk?: Pick<HoomiOptions, 'defaultTimeoutMs' | 'handshakeTimeoutMs'>;
}

export function createTestHoomi(options: CreateTestHoomiOptions = {}): TestHoomi {
  const { sdk, ...hostOptions } = options;
  const host = new MockHost(hostOptions);
  const hoomiOptions: HoomiOptions = {
    transport: host.transport(),
    bootstrap: host.bootstrap(),
  };
  if (sdk?.defaultTimeoutMs !== undefined) hoomiOptions.defaultTimeoutMs = sdk.defaultTimeoutMs;
  if (sdk?.handshakeTimeoutMs !== undefined) hoomiOptions.handshakeTimeoutMs = sdk.handshakeTimeoutMs;
  const hoomi = createHoomi(hoomiOptions);
  return {
    hoomi,
    host,
    cleanup() {
      hoomi.dispose();
      host.uninstall();
    },
  };
}

export { MockHost, type MockHostHandle, type MockHostOptions } from '../mock/mockHost.js';
export { mockError } from '../mock/mockHost.js';
export type { Hoomi } from '../hoomi.js';
