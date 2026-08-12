import { afterEach, describe, expect, it } from 'vitest';

import {
  BridgeClient,
  BridgeUnavailableError,
  HoomiError,
  TimeoutError,
  UserCancelledError,
  type CallFrame,
  type HoomiBootstrap,
  type Transport,
} from '../src/index.js';

const BOOTSTRAP: HoomiBootstrap = {
  nonce: 'test-nonce-123',
  epoch: 3,
  appId: 'app.test',
  capabilities: ['storage'],
  grantedScopes: ['profile'],
  protocol: 1,
};

const HELLO = {
  protocol: 1,
  host: { name: 'scripted', version: '1.0.0' },
  appId: 'app.test',
  scopes: ['profile', 'location'],
  capabilities: ['storage', 'location'],
  limits: { maxPayloadBytes: 4096, maxSubscriptions: 4, backPressGraceMs: 300 },
};

const ok = (id: string, data: unknown = {}) => JSON.stringify({ v: 1, id, type: 'result', ok: true, data });
const fail = (id: string, code: string, message = code) =>
  JSON.stringify({ v: 1, id, type: 'result', ok: false, error: { code, message } });
const event = (name: string, data?: unknown, extra?: Record<string, unknown>) =>
  JSON.stringify({ v: 1, type: 'event', event: name, ...(data !== undefined ? { data } : {}), ...(extra ?? {}) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Scripted transport. host.hello is answered automatically. Other calls use
 * `auto` when it returns a frame; otherwise the send() promise stays pending
 * until the test calls respond(id, raw) (or forever, for rx-push tests).
 */
class ScriptedTransport implements Transport {
  sent: CallFrame[] = [];
  auto: ((frame: CallFrame) => string | null) | null = null;
  private resolvers = new Map<string, { resolve: (raw: string) => void; reject: (err: unknown) => void }>();
  private rx: ((frame: string) => void) | null = null;
  failSends = false;

  send(raw: string): Promise<string> {
    if (this.failSends) return Promise.reject(new Error('bridge torn down'));
    const frame = JSON.parse(raw) as CallFrame;
    this.sent.push(frame);
    if (frame.method === 'host.hello') return Promise.resolve(ok(frame.id, HELLO));
    const scripted = this.auto?.(frame) ?? null;
    if (scripted !== null) return Promise.resolve(scripted);
    return new Promise<string>((resolve, reject) => {
      this.resolvers.set(frame.id, { resolve, reject });
    });
  }

  respond(id: string, raw: string): void {
    const r = this.resolvers.get(id);
    this.resolvers.delete(id);
    r?.resolve(raw);
  }

  connect(onFrame: (frame: string) => void): () => void {
    this.rx = onFrame;
    return () => {
      this.rx = null;
    };
  }

  push(frame: string): void {
    this.rx?.(frame);
  }

  /** Ids of frames sent for a method, in order. */
  ids(method: string): string[] {
    return this.sent.filter((f) => f.method === method).map((f) => f.id);
  }
}

let clients: BridgeClient[] = [];

function makeClient(options: { defaultTimeoutMs?: number; bootstrap?: HoomiBootstrap } = {}) {
  const transport = new ScriptedTransport();
  const client = new BridgeClient({
    transport,
    bootstrap: options.bootstrap ?? BOOTSTRAP,
    defaultTimeoutMs: options.defaultTimeoutMs ?? 1_000,
  });
  clients.push(client);
  return { transport, client };
}

afterEach(() => {
  for (const c of clients) c.dispose();
  clients = [];
});

describe('handshake', () => {
  it('performs host.hello once at init and adopts scopes/capabilities/limits', async () => {
    const { transport, client } = makeClient();
    const hello = await client.ready();
    expect(hello.host.name).toBe('scripted');
    expect(client.status).toBe('ready');
    expect(client.scopes).toEqual(['profile', 'location']);
    expect(client.capabilities).toEqual(['storage', 'location']);
    expect(client.limits.maxPayloadBytes).toBe(4096);
    expect(transport.ids('host.hello')).toHaveLength(1);
  });

  it('queues calls issued before the handshake completes', async () => {
    const { transport, client } = makeClient();
    const early = client.call('storage.get', { key: 'k' }); // issued immediately, before ready
    await client.ready();
    await sleep(0);
    const [id] = transport.ids('storage.get');
    expect(id).toBeDefined();
    transport.respond(id as string, ok(id as string, { value: 7 }));
    await expect(early).resolves.toEqual({ value: 7 });
  });

  it('every call frame carries the nonce and current epoch', async () => {
    const { transport, client } = makeClient();
    transport.auto = (f) => ok(f.id);
    await client.call('lifecycle.ready', {});
    for (const frame of transport.sent) {
      expect(frame.n).toBe('test-nonce-123');
      expect(frame.e).toBe(3);
      expect(frame.v).toBe(1);
      expect(frame.type).toBe('call');
      expect(frame.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });

  it('constructs unavailable without transport/bootstrap; calls reject BridgeUnavailableError', async () => {
    const client = new BridgeClient({ transport: null, bootstrap: null });
    clients.push(client);
    expect(client.status).toBe('unavailable');
    await expect(client.call('ui.toast', { message: 'x' })).rejects.toBeInstanceOf(BridgeUnavailableError);
    await expect(client.ready()).rejects.toBeInstanceOf(BridgeUnavailableError);
  });

  it('rejects invalid method names locally with E_INVALID_PARAMS', async () => {
    const { client } = makeClient();
    await client.ready();
    for (const bad of ['Storage.get', 'storage', 'a.b.c.d', 'storage..get', '1torage.get', 'storage.Get ']) {
      const err = await client.call(bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HoomiError);
      expect((err as HoomiError).code).toBe('E_INVALID_PARAMS');
    }
  });
});

describe('correlation', () => {
  it('routes by id, not send-promise identity: swapped responses land correctly', async () => {
    const { transport, client } = makeClient();
    await client.ready();
    const callA = client.call('storage.get', { key: 'a' });
    const callB = client.call('storage.get', { key: 'b' });
    await sleep(0);
    const [idA, idB] = transport.ids('storage.get') as [string, string];
    // A's send-promise resolves with B's result frame, and vice versa.
    transport.respond(idA, ok(idB, { value: 'B' }));
    transport.respond(idB, ok(idA, { value: 'A' }));
    await expect(callA).resolves.toEqual({ value: 'A' });
    await expect(callB).resolves.toEqual({ value: 'B' });
  });

  it('out-of-order responses pushed via __hoomiRx resolve the right calls', async () => {
    const { transport, client } = makeClient();
    await client.ready();
    const first = client.call('storage.get', { key: 'first' });
    const second = client.call('storage.get', { key: 'second' });
    await sleep(0);
    const [id1, id2] = transport.ids('storage.get') as [string, string];
    transport.push(ok(id2, { value: 2 })); // answer the second call first
    transport.push(ok(id1, { value: 1 }));
    await expect(second).resolves.toEqual({ value: 2 });
    await expect(first).resolves.toEqual({ value: 1 });
  });

  it('duplicate ids: first response wins, the duplicate is ignored without crashing', async () => {
    const { transport, client } = makeClient();
    await client.ready();
    const call = client.call('storage.get', { key: 'x' });
    await sleep(0);
    const [id] = transport.ids('storage.get') as [string];
    transport.push(ok(id, { value: 'first' }));
    transport.push(ok(id, { value: 'second' }));
    transport.push(fail(id, 'E_INTERNAL'));
    await expect(call).resolves.toEqual({ value: 'first' });
    // Bridge still healthy afterwards:
    const again = client.call('storage.get', { key: 'y' });
    await sleep(0);
    const ids = transport.ids('storage.get');
    const lastId = ids[ids.length - 1] as string;
    transport.push(ok(lastId, { value: 'ok' }));
    await expect(again).resolves.toEqual({ value: 'ok' });
  });

  it('a direct response with a foreign id fails the originating call fast (E_PROTOCOL)', async () => {
    const { transport, client } = makeClient();
    await client.ready();
    const call = client.call('storage.get', { key: 'x' });
    await sleep(0);
    const [id] = transport.ids('storage.get') as [string];
    transport.respond(id, ok('c-9999', { value: 'not yours' }));
    const err = await call.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HoomiError);
    expect((err as HoomiError).code).toBe('E_PROTOCOL');
  });

  it('a malformed direct response fails the originating call with E_PROTOCOL', async () => {
    const { transport, client } = makeClient();
    await client.ready();
    const call = client.call('storage.get', { key: 'x' });
    await sleep(0);
    const [id] = transport.ids('storage.get') as [string];
    transport.respond(id, '{garbage');
    const err = await call.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HoomiError);
    expect((err as HoomiError).code).toBe('E_PROTOCOL');
  });
});

describe('timeout, late responses, abort', () => {
  it('times out with TimeoutError and ignores the late response', async () => {
    const { transport, client } = makeClient();
    await client.ready();
    const call = client.call('camera.capture', {}, { timeoutMs: 30 });
    await sleep(0);
    const [id] = transport.ids('camera.capture') as [string];
    const err = await call.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).code).toBe('E_TIMEOUT');
    // Late response arrives after the timeout: must be dropped silently.
    transport.push(ok(id, { uri: 'late.jpg' }));
    await sleep(10);
    // And the client still works.
    transport.auto = (f) => ok(f.id, { fine: true });
    await expect(client.call('system.getInfo')).resolves.toEqual({ fine: true });
  });

  it('abort rejects with UserCancelledError (E_CANCELLED) and drops the eventual response', async () => {
    const { transport, client } = makeClient();
    await client.ready();
    const controller = new AbortController();
    const call = client.call('camera.capture', {}, { signal: controller.signal });
    await sleep(0);
    controller.abort();
    const err = await call.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserCancelledError);
    expect((err as UserCancelledError).code).toBe('E_CANCELLED');
    const [id] = transport.ids('camera.capture') as [string];
    transport.push(ok(id, {})); // must be ignored
    await sleep(10);
  });

  it('a pre-aborted signal rejects before anything is sent', async () => {
    const { transport, client } = makeClient();
    await client.ready();
    const controller = new AbortController();
    controller.abort();
    const before = transport.sent.length;
    const err = await client.call('camera.capture', {}, { signal: controller.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserCancelledError);
    expect(transport.sent.length).toBe(before);
  });

  it('transport send failure maps to BridgeUnavailableError', async () => {
    const { transport, client } = makeClient();
    await client.ready();
    transport.failSends = true;
    const err = await client.call('ui.toast', { message: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeUnavailableError);
    expect((err as BridgeUnavailableError).cause).toBeInstanceOf(Error);
  });
});

describe('epoch tracking', () => {
  it('rejects with E_STALE_EPOCH untouched when the host says so', async () => {
    const { transport, client } = makeClient();
    transport.auto = (f) => fail(f.id, 'E_STALE_EPOCH', 'stale');
    await client.ready();
    const err = await client.call('storage.get', { key: 'k' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HoomiError);
    expect((err as HoomiError).code).toBe('E_STALE_EPOCH');
  });

  it('adopts a higher epoch announced on an event frame', async () => {
    const { transport, client } = makeClient();
    transport.auto = (f) => ok(f.id);
    await client.ready();
    expect(client.epoch).toBe(3);
    transport.push(event('lifecycle.epochChanged', { epoch: 7 }, { e: 7 }));
    await sleep(0);
    expect(client.epoch).toBe(7);
    await client.call('lifecycle.ready', {});
    const last = transport.sent[transport.sent.length - 1] as CallFrame;
    expect(last.e).toBe(7);
    // A lower epoch on a later event must NOT downgrade.
    transport.push(event('whatever.event', {}, { e: 2 }));
    await sleep(0);
    expect(client.epoch).toBe(7);
  });
});

describe('payload cap', () => {
  it('rejects frames over the host limit locally with E_PAYLOAD_TOO_LARGE', async () => {
    const { transport, client } = makeClient();
    await client.ready(); // hello advertised maxPayloadBytes: 4096
    const before = transport.sent.length;
    const err = await client
      .call('storage.set', { key: 'big', value: 'x'.repeat(5000) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HoomiError);
    expect((err as HoomiError).code).toBe('E_PAYLOAD_TOO_LARGE');
    expect(transport.sent.length).toBe(before); // never left the page
  });
});

describe('events and subscriptions', () => {
  it('lifecycle.load replays to late subscribers', async () => {
    const { transport, client } = makeClient();
    await client.ready();
    transport.push(event('lifecycle.load', { params: { table: '12' } }));
    await sleep(0);
    // Subscribe AFTER the event already arrived — React mount timing.
    const seen: unknown[] = [];
    client.on('lifecycle.load', (data) => seen.push(data));
    await sleep(0);
    expect(seen).toEqual([{ params: { table: '12' } }]);
  });

  it('stream events route by sub id; early events are buffered until subscribe resolves', async () => {
    const { transport, client } = makeClient();
    await client.ready();
    const got: unknown[] = [];
    let done = false;
    const subPromise = client.subscribe('location.watch', {}, {
      next: (d) => got.push(d),
      complete: () => {
        done = true;
      },
    });
    await sleep(0);
    const [subCallId] = transport.ids('bridge.subscribe') as [string];
    // Host emits data BEFORE the subscribe result reaches the page (race).
    transport.push(event('stream.data', { latitude: 1 }, { sub: 's-77' }));
    transport.push(ok(subCallId, { subId: 's-77' }));
    const sub = await subPromise;
    expect(sub.subId).toBe('s-77');
    expect(got).toEqual([{ latitude: 1 }]); // buffered frame delivered
    transport.push(event('stream.data', { latitude: 2 }, { sub: 's-77' }));
    transport.push(event('stream.done', undefined, { sub: 's-77' }));
    await sleep(0);
    expect(got).toEqual([{ latitude: 1 }, { latitude: 2 }]);
    expect(done).toBe(true);
    expect(sub.closed).toBe(true);
  });

  it('stream.error is delivered as a HoomiError and is non-terminal', async () => {
    const { transport, client } = makeClient();
    transport.auto = (f) => (f.method === 'bridge.subscribe' ? ok(f.id, { subId: 's-1' }) : ok(f.id));
    await client.ready();
    const errors: HoomiError[] = [];
    const data: unknown[] = [];
    await client.subscribe('location.watch', {}, { next: (d) => data.push(d), error: (e) => errors.push(e) });
    transport.push(event('stream.error', undefined, { sub: 's-1', error: { code: 'E_UNAVAILABLE', message: 'gps glitch' } }));
    transport.push(event('stream.data', { latitude: 3 }, { sub: 's-1' }));
    await sleep(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(BridgeUnavailableError);
    expect(data).toEqual([{ latitude: 3 }]); // still alive after stream.error
  });

  it('close() sends bridge.unsubscribe exactly once and stops delivery', async () => {
    const { transport, client } = makeClient();
    transport.auto = (f) => (f.method === 'bridge.subscribe' ? ok(f.id, { subId: 's-5' }) : ok(f.id));
    await client.ready();
    const got: unknown[] = [];
    const sub = await client.subscribe('location.watch', {}, { next: (d) => got.push(d) });
    await Promise.all([sub.close(), sub.close()]);
    await sub.close();
    expect(transport.ids('bridge.unsubscribe')).toHaveLength(1);
    const unsub = transport.sent.find((f) => f.method === 'bridge.unsubscribe');
    expect(unsub?.params).toEqual({ subId: 's-5' });
    transport.push(event('stream.data', { latitude: 9 }, { sub: 's-5' }));
    await sleep(0);
    expect(got).toEqual([]);
  });

  it('an aborted signal closes a subscription that resolves after cleanup (no leak)', async () => {
    const { transport, client } = makeClient();
    await client.ready();
    const controller = new AbortController();
    const subPromise = client.subscribe('location.watch', {}, {}, { signal: controller.signal });
    await sleep(0);
    const [subCallId] = transport.ids('bridge.subscribe') as [string];
    controller.abort(); // cleanup happens while subscribe is still in flight
    transport.push(ok(subCallId, { subId: 's-9' }));
    const err = await subPromise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserCancelledError);
    await sleep(0);
    // The host-side subscription must have been closed, not leaked.
    expect(transport.ids('bridge.unsubscribe')).toHaveLength(1);
  });
});

describe('dispose', () => {
  it('rejects all pending calls with BridgeUnavailableError and goes quiet', async () => {
    const { transport, client } = makeClient();
    await client.ready();
    const p1 = client.call('storage.get', { key: 'a' });
    const p2 = client.call('storage.get', { key: 'b' });
    await sleep(0);
    client.dispose();
    await expect(p1).rejects.toBeInstanceOf(BridgeUnavailableError);
    await expect(p2).rejects.toBeInstanceOf(BridgeUnavailableError);
    expect(client.status).toBe('disposed');
    await expect(client.call('ui.toast', 'x')).rejects.toBeInstanceOf(BridgeUnavailableError);
    // rx is disconnected: pushing does nothing.
    transport.push(event('lifecycle.show'));
  });
});
