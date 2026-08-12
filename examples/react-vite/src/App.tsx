import { useState } from 'react';
import {
  HoomiError,
  PermissionDeniedError,
  RateLimitedError,
  UserCancelledError,
  type PaymentResult,
} from 'hoomi.microapps.js';
import {
  useBackButton,
  useHoomi,
  useHoomiCall,
  useHoomiStatus,
  useLaunchOptions,
  useLifecycle,
  useLocationWatch,
  usePermission,
  useUser,
} from 'hoomi.microapps.js/react';

export function App() {
  const status = useHoomiStatus();
  const launch = useLaunchOptions();
  const [log, setLog] = useState<string[]>([]);
  const note = (line: string) => setLog((l) => [...l.slice(-5), line]);

  useLifecycle({
    onShow: () => note('lifecycle: show'),
    onHide: () => note('lifecycle: hide'),
    onError: (msg) => note(`lifecycle error: ${msg}`),
  });
  useBackButton(() => {
    note('back press handled in-app');
    return true;
  });

  return (
    <main>
      <h1>☕ Hoomi Cafe (example micro-app)</h1>
      <section>
        <h2>Bridge</h2>
        <div>
          status: <code>{status}</code> · table: <code>{String(launch?.params?.['table'] ?? '…')}</code> · promo:{' '}
          <code>{String(launch?.params?.['promo'] ?? '…')}</code>
        </div>
      </section>
      <Profile />
      <Notes />
      <Location />
      <Payment />
      <section>
        <h2>Lifecycle log</h2>
        {log.length === 0 ? <div>quiet so far…</div> : log.map((l, i) => <div key={i}>{l}</div>)}
      </section>
    </main>
  );
}

function Profile() {
  const { user, loading, error, reload } = useUser();
  return (
    <section>
      <h2>Profile (user.getProfile)</h2>
      {loading && <div>loading…</div>}
      {error && (
        <div className="err">
          {error.code}: {error.message} <button onClick={reload}>retry</button>
        </div>
      )}
      {user && (
        <div>
          {user.displayName} <code>{user.id}</code>
        </div>
      )}
    </section>
  );
}

function Notes() {
  const hoomi = useHoomi();
  const { data, reload } = useHoomiCall(
    (h, opts) => h.storage.get<string[]>('notes', opts).then((v) => v ?? []),
    [],
  );
  const [text, setText] = useState('');
  const notes = data ?? [];
  const add = async () => {
    if (!text.trim()) return;
    await hoomi.storage.set('notes', [...notes, text.trim()]);
    setText('');
    reload();
  };
  return (
    <section>
      <h2>Order notes (storage)</h2>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="extra oat milk…" />
      <button className="primary" onClick={() => void add()}>
        save
      </button>
      <ul>
        {notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    </section>
  );
}

function Location() {
  const [enabled, setEnabled] = useState(false);
  const perm = usePermission();
  const { position, error, active } = useLocationWatch({ minIntervalMs: 1000 }, { enabled });
  return (
    <section>
      <h2>Courier tracking (location.watch)</h2>
      <button className="primary" onClick={() => setEnabled((v) => !v)}>
        {enabled ? 'stop' : 'start'} watching
      </button>
      {active && position && (
        <div className="ok">
          {position.latitude.toFixed(5)}, {position.longitude.toFixed(5)} (±{Math.round(position.accuracy ?? 0)}m)
        </div>
      )}
      {error instanceof PermissionDeniedError ? (
        <div className="err">
          location permission denied — {error.permanent ? <button>Open Settings</button> : <button onClick={() => setEnabled(true)}>Retry</button>}
        </div>
      ) : (
        error && <div className="err">{error.code}</div>
      )}
      <div>
        one-shot: <OneShot guard={perm.guard} status={perm.status} />
      </div>
    </section>
  );
}

function OneShot({
  guard,
  status,
}: {
  guard: <T>(op: () => Promise<T>) => Promise<T>;
  status: string;
}) {
  const hoomi = useHoomi();
  const [result, setResult] = useState('');
  return (
    <>
      <button
        onClick={() => {
          void guard(() => hoomi.location.getCurrent({ accuracy: 'fine' }))
            .then((p) => setResult(`${p.latitude.toFixed(4)}, ${p.longitude.toFixed(4)}`))
            .catch((e: unknown) => setResult(e instanceof HoomiError ? e.code : 'failed'));
        }}
      >
        locate once
      </button>{' '}
      <code>{result || status}</code>
    </>
  );
}

function Payment() {
  const hoomi = useHoomi();
  const [state, setState] = useState<string>('');
  const [last, setLast] = useState<PaymentResult | null>(null);

  const pay = async () => {
    setState('paying…');
    try {
      const payment = await hoomi.wallet.requestPayment(
        {
          amount: 48_000,
          currency: 'IDR',
          orderId: `order-${Date.now()}`,
          description: '2× flat white, 1× croissant',
        },
        { timeoutMs: 15_000 },
      );
      setLast(payment);
      const balance = await hoomi.wallet.getBalance();
      setState(`✅ ${payment.status} (${payment.paymentId}) — balance ${balance.amount.toLocaleString()} ${balance.currency}`);
      await hoomi.ui.toast('Payment complete. Terima kasih!');
    } catch (err) {
      if (err instanceof UserCancelledError) setState('payment cancelled by user');
      else if (err instanceof RateLimitedError) setState(`rate limited — retry in ${err.retryAfterMs ?? '?'}ms`);
      else if (err instanceof HoomiError) setState(`payment failed: ${err.code}`);
      else setState('payment failed');
    }
  };

  return (
    <section>
      <h2>Pay (wallet.requestPayment)</h2>
      <button className="primary" onClick={() => void pay()}>
        pay Rp 48.000
      </button>
      {last && (
        <button
          onClick={() => {
            void hoomi.wallet
              .getPaymentStatus({ paymentId: last.paymentId })
              .then((s) => setState(`status check: ${s.status}`))
              .catch((e: unknown) => setState(e instanceof HoomiError ? e.code : 'failed'));
          }}
        >
          re-check status
        </button>
      )}
      <div>{state}</div>
    </section>
  );
}
