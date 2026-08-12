/**
 * React adapter under React 19 StrictMode (double-invoked effects). The
 * critical assertions are resource ones: exactly one live host subscription
 * while mounted, zero after unmount — a naive effect leaks one per mount.
 */

import { StrictMode, useState } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HoomiProvider,
  useBackButton,
  useCapability,
  useHoomiCall,
  useHoomiStatus,
  useLaunchOptions,
  useLifecycle,
  useLocationWatch,
  usePermission,
  useScopes,
  useUser,
} from '../src/react/index.js';
import { createTestHoomi, type TestHoomi } from '../src/testing/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let active: TestHoomi[] = [];
const make = (...args: Parameters<typeof createTestHoomi>): TestHoomi => {
  const t = createTestHoomi(...args);
  active.push(t);
  return t;
};

afterEach(() => {
  cleanup();
  for (const t of active) t.cleanup();
  active = [];
});

function mount(t: TestHoomi, ui: React.ReactNode) {
  return render(
    <StrictMode>
      <HoomiProvider hoomi={t.hoomi}>{ui}</HoomiProvider>
    </StrictMode>,
  );
}

describe('useHoomiStatus / useCapability', () => {
  function Status() {
    const status = useHoomiStatus();
    const wallet = useCapability('wallet');
    return (
      <div>
        <span data-testid="status">{status}</span>
        <span data-testid="wallet">{wallet ? 'yes' : 'no'}</span>
      </div>
    );
  }

  it('transitions to ready and exposes capabilities', async () => {
    const t = make();
    mount(t, <Status />);
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('wallet').textContent).toBe('yes');
  });
});

describe('useLaunchOptions', () => {
  function Launch() {
    const launch = useLaunchOptions();
    return <span data-testid="launch">{launch ? JSON.stringify(launch.params) : 'none'}</span>;
  }

  it('receives the payload even when mounted after lifecycle.load (replay)', async () => {
    const t = make({ launchParams: { table: '9' } });
    await t.hoomi.ready();
    await sleep(20); // load has long been delivered
    mount(t, <Launch />);
    await waitFor(() => expect(screen.getByTestId('launch').textContent).toBe('{"table":"9"}'));
  });
});

describe('useUser', () => {
  function User() {
    const { user, loading, error } = useUser();
    if (loading) return <span data-testid="user">loading</span>;
    if (error) return <span data-testid="user">error:{error.code}</span>;
    return <span data-testid="user">{user?.displayName}</span>;
  }

  it('loads the profile', async () => {
    const t = make({ user: { displayName: 'Aftah P' } });
    mount(t, <User />);
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('Aftah P'));
  });

  it('surfaces scope errors as HoomiError codes', async () => {
    const t = make({ scenario: 'no-scopes' });
    mount(t, <User />);
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('error:E_SCOPE_DENIED'));
  });
});

describe('useScopes', () => {
  function Scopes() {
    const { scopes, hasScope } = useScopes();
    return (
      <span data-testid="scopes">
        {hasScope('wallet') ? 'wallet' : 'no-wallet'}:{scopes.length}
      </span>
    );
  }

  it('updates when the host revokes a scope', async () => {
    const t = make();
    mount(t, <Scopes />);
    await waitFor(() => expect(screen.getByTestId('scopes').textContent).toMatch(/^wallet:/));
    t.host.revoke('wallet');
    await waitFor(() => expect(screen.getByTestId('scopes').textContent).toMatch(/^no-wallet:/));
  });
});

describe('useLocationWatch (the StrictMode leak trap)', () => {
  function Watcher() {
    const { position, active: watching } = useLocationWatch({ minIntervalMs: 20 });
    return (
      <span data-testid="watch">
        {watching ? 'on' : 'off'}:{position ? position.latitude.toFixed(1) : 'none'}
      </span>
    );
  }

  it('holds exactly ONE host subscription while mounted, zero after unmount', async () => {
    const t = make();
    const view = mount(t, <Watcher />);
    await waitFor(() => expect(screen.getByTestId('watch').textContent).toMatch(/^on:/));
    await waitFor(() => expect(screen.getByTestId('watch').textContent).toMatch(/^on:-?\d/));
    // StrictMode ran the effect twice; a naive hook now holds 2 GPS watches.
    expect(t.host.activeSubscriptionCount).toBe(1);
    view.unmount();
    await waitFor(() => expect(t.host.activeSubscriptionCount).toBe(0));
  });

  it('enabled:false opens nothing', async () => {
    const t = make();
    function Disabled() {
      const { active: watching } = useLocationWatch({ minIntervalMs: 20 }, { enabled: false });
      return <span data-testid="watch">{watching ? 'on' : 'off'}</span>;
    }
    mount(t, <Disabled />);
    await t.hoomi.ready();
    await sleep(30);
    expect(screen.getByTestId('watch').textContent).toBe('off');
    expect(t.host.activeSubscriptionCount).toBe(0);
  });
});

describe('useBackButton', () => {
  function Back({ armed }: { armed: boolean }) {
    const [count, setCount] = useState(0);
    useBackButton(() => {
      setCount((c) => c + 1);
      return true;
    }, armed);
    return <span data-testid="count">{count}</span>;
  }

  it('handles the press while mounted, exactly once despite StrictMode', async () => {
    const t = make();
    const view = mount(t, <Back armed />);
    await t.hoomi.ready();
    await expect(t.host.pressBack()).resolves.toEqual({ handled: true, timedOut: false });
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'));
    view.unmount();
    await expect(t.host.pressBack()).resolves.toEqual({ handled: false, timedOut: false });
  });

  it('enabled=false does not register', async () => {
    const t = make();
    mount(t, <Back armed={false} />);
    await t.hoomi.ready();
    await expect(t.host.pressBack()).resolves.toEqual({ handled: false, timedOut: false });
    expect(screen.getByTestId('count').textContent).toBe('0');
  });
});

describe('useLifecycle', () => {
  function Lifecycled() {
    const [events, setEvents] = useState<string[]>([]);
    useLifecycle({
      onLoad: () => setEvents((e) => [...e, 'load']),
      onShow: () => setEvents((e) => [...e, 'show']),
      onError: (msg) => setEvents((e) => [...e, `error:${msg}`]),
    });
    return <span data-testid="events">{events.join(',')}</span>;
  }

  it('delivers load (via replay), show, and error exactly once each', async () => {
    const t = make();
    mount(t, <Lifecycled />);
    await waitFor(() => expect(screen.getByTestId('events').textContent).toContain('show'));
    t.host.emit('lifecycle.error', { message: 'oh no' });
    await waitFor(() => expect(screen.getByTestId('events').textContent).toContain('error:oh no'));
    const events = (screen.getByTestId('events').textContent ?? '').split(',');
    expect(events.filter((e) => e === 'load')).toHaveLength(1);
    expect(events.filter((e) => e === 'show')).toHaveLength(1);
  });
});

describe('usePermission', () => {
  function Gate() {
    const perm = usePermission();
    return (
      <div>
        <span data-testid="perm">{perm.status}</span>
        <GateButton guard={perm.guard} />
      </div>
    );
  }
  function GateButton({ guard }: { guard: <T>(op: () => Promise<T>) => Promise<T> }) {
    const [, setTick] = useState(0);
    return (
      <button
        data-testid="go"
        onClick={() => {
          void guard(() => ctxHoomi!.location.getCurrent()).catch(() => setTick((v) => v + 1));
        }}
      >
        go
      </button>
    );
  }

  // The button needs the hoomi instance; simplest is a module-level slot.
  let ctxHoomi: TestHoomi['hoomi'] | null = null;

  it('records denied-forever so the UI can offer Open Settings', async () => {
    const t = make({ scenario: 'deny-forever' });
    ctxHoomi = t.hoomi;
    mount(t, <Gate />);
    await t.hoomi.ready();
    screen.getByTestId('go').click();
    await waitFor(() => expect(screen.getByTestId('perm').textContent).toBe('denied-forever'));
  });

  it('records granted on success', async () => {
    const t = make();
    ctxHoomi = t.hoomi;
    mount(t, <Gate />);
    await t.hoomi.ready();
    screen.getByTestId('go').click();
    await waitFor(() => expect(screen.getByTestId('perm').textContent).toBe('granted'));
  });
});

describe('useHoomiCall', () => {
  it('reload re-runs the call', async () => {
    const t = make();
    let calls = 0;
    t.host.on('system.getInfo', () => {
      calls += 1;
      return { platform: 'android', call: calls };
    });
    function Info() {
      const { data, loading, reload } = useHoomiCall((h, opts) => h.system.getInfo(opts), []);
      return (
        <div>
          <span data-testid="info">{loading ? 'loading' : JSON.stringify((data as { call?: number })?.call)}</span>
          <button data-testid="reload" onClick={reload}>
            reload
          </button>
        </div>
      );
    }
    mount(t, <Info />);
    await waitFor(() => expect(screen.getByTestId('info').textContent).not.toBe('loading'));
    const first = Number(screen.getByTestId('info').textContent);
    screen.getByTestId('reload').click();
    await waitFor(() => expect(Number(screen.getByTestId('info').textContent)).toBeGreaterThan(first));
  });
});
