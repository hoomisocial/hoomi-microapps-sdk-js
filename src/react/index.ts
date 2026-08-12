/**
 * React bindings for hoomi.microapps.js. React is an optional peer
 * dependency: the main entry imports zero React; only this subpath does.
 *
 * All hooks are safe under React 18/19 StrictMode double-invoked effects:
 * async effects guard with a `cancelled` flag and close subscriptions that
 * resolve after cleanup, in-flight calls abort on unmount, and handlers are
 * kept in refs so re-renders never re-register bridge subscriptions.
 */

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DependencyList,
  type ReactElement,
  type ReactNode,
} from 'react';

import type { GeoPosition, LaunchPayload, LocationWatchParams, UserProfile } from '../api/types.js';
import type { BridgeStatus, Subscription } from '../core/client.js';
import { HoomiError, PermissionDeniedError, toHoomiError } from '../core/errors.js';
import { createHoomi, getHoomi, type Hoomi, type HoomiOptions } from '../hoomi.js';

export type { Hoomi, HoomiOptions } from '../hoomi.js';
export type { BridgeStatus } from '../core/client.js';

const HoomiContext = createContext<Hoomi | null>(null);

export interface HoomiProviderProps {
  /** Bring your own instance (tests: createTestHoomi().hoomi). */
  hoomi?: Hoomi;
  /** Options for a provider-created instance (ignored when `hoomi` given). */
  options?: HoomiOptions;
  children?: ReactNode;
}

/**
 * Provides a Hoomi instance to the hook tree. Without an explicit `hoomi`
 * prop it uses the lazy shared instance. The provider never disposes the
 * instance (StrictMode remounts would otherwise kill a live bridge);
 * whoever created the instance owns its lifetime.
 */
export function HoomiProvider(props: HoomiProviderProps): ReactElement {
  const { hoomi, options, children } = props;
  const [fallback] = useState(() => hoomi ?? (options ? createHoomi(options) : getHoomi()));
  const value = hoomi ?? fallback;
  return createElement(HoomiContext.Provider, { value }, children);
}

export function useHoomi(): Hoomi {
  const hoomi = useContext(HoomiContext);
  if (!hoomi) {
    throw new HoomiError('E_UNAVAILABLE', 'useHoomi() must be used inside <HoomiProvider>');
  }
  return hoomi;
}

export function useHoomiStatus(): BridgeStatus {
  const hoomi = useHoomi();
  const subscribe = useCallback((onChange: () => void) => hoomi.onStatusChange(onChange), [hoomi]);
  const get = useCallback(() => hoomi.status, [hoomi]);
  return useSyncExternalStore(subscribe, get, get);
}

/**
 * The lifecycle.load launch payload. Null until it arrives; thanks to
 * replay-on-subscribe this works no matter how late the component mounts.
 */
export function useLaunchOptions(): LaunchPayload | null {
  const hoomi = useHoomi();
  const [payload, setPayload] = useState<LaunchPayload | null>(() => hoomi.launchPayload);
  useEffect(() => {
    let cancelled = false;
    const off = hoomi.onLoad((p) => {
      if (!cancelled) setPayload(p);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [hoomi]);
  return payload;
}

export interface HoomiCallState<T> {
  data: T | undefined;
  error: HoomiError | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Run a bridge call as an effect. Aborts the in-flight call on unmount and
 * on dependency change; never sets state after cleanup.
 */
export function useHoomiCall<T>(
  fn: (hoomi: Hoomi, opts: { signal: AbortSignal }) => Promise<T>,
  deps: DependencyList = [],
): HoomiCallState<T> {
  const hoomi = useHoomi();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ data: T | undefined; error: HoomiError | null; loading: boolean }>({
    data: undefined,
    error: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    fnRef.current(hoomi, { signal: controller.signal }).then(
      (data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      },
      (err: unknown) => {
        if (!cancelled) setState({ data: undefined, error: toHoomiError(err), loading: false });
      },
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoomi, tick, ...deps]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export interface UseUserResult {
  user: UserProfile | undefined;
  error: HoomiError | null;
  loading: boolean;
  reload: () => void;
}

export function useUser(): UseUserResult {
  const { data, error, loading, reload } = useHoomiCall((hoomi, opts) => hoomi.user.getProfile(opts), []);
  return { user: data, error, loading, reload };
}

export interface UseScopesResult {
  scopes: readonly string[];
  hasScope: (scope: string) => boolean;
}

export function useScopes(): UseScopesResult {
  const hoomi = useHoomi();
  const subscribe = useCallback(
    (onChange: () => void) => {
      const offScopes = hoomi.onScopesChanged(onChange);
      const offStatus = hoomi.onStatusChange(onChange); // hello may replace the scope list
      return () => {
        offScopes();
        offStatus();
      };
    },
    [hoomi],
  );
  const get = useCallback(() => hoomi.scopes, [hoomi]);
  const scopes = useSyncExternalStore(subscribe, get, get);
  const hasScope = useCallback((scope: string) => scopes.includes(scope), [scopes]);
  return { scopes, hasScope };
}

export function useCapability(capability: string): boolean {
  const hoomi = useHoomi();
  useHoomiStatus(); // re-evaluate once the handshake refreshes capabilities
  return hoomi.hasCapability(capability);
}

export type PermissionUiStatus = 'unknown' | 'granted' | 'denied' | 'denied-forever';

export interface UsePermissionResult {
  /** Drives "Retry" (denied) vs "Open Settings" (denied-forever) UI. */
  status: PermissionUiStatus;
  error: PermissionDeniedError | null;
  /**
   * Run a permission-gated bridge call and record its outcome. Rethrows the
   * original error so normal error handling still applies.
   */
  guard: <T>(op: () => Promise<T>) => Promise<T>;
  reset: () => void;
}

export function usePermission(): UsePermissionResult {
  const [status, setStatus] = useState<PermissionUiStatus>('unknown');
  const [error, setError] = useState<PermissionDeniedError | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const guard = useCallback(async <T,>(op: () => Promise<T>): Promise<T> => {
    try {
      const result = await op();
      if (mounted.current) {
        setStatus('granted');
        setError(null);
      }
      return result;
    } catch (err) {
      const mapped = toHoomiError(err);
      if (mapped instanceof PermissionDeniedError && mounted.current) {
        setStatus(mapped.permanent ? 'denied-forever' : 'denied');
        setError(mapped);
      }
      throw mapped;
    }
  }, []);

  const reset = useCallback(() => {
    setStatus('unknown');
    setError(null);
  }, []);

  return { status, error, guard, reset };
}

/**
 * Register a back-press handler. The handler lives in a ref, so re-renders
 * never re-register; returning true marks the press handled.
 */
export function useBackButton(handler: () => boolean | Promise<boolean>, enabled = true): void {
  const hoomi = useHoomi();
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!enabled) return undefined;
    return hoomi.onBackPress(() => ref.current());
  }, [hoomi, enabled]);
}

export interface LifecycleHandlers {
  onLoad?: (payload: LaunchPayload) => void;
  onShow?: () => void;
  onHide?: () => void;
  onError?: (message: string, data?: unknown) => void;
}

/** Subscribe to lifecycle events with stable registrations (handlers in refs). */
export function useLifecycle(handlers: LifecycleHandlers): void {
  const hoomi = useHoomi();
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    const offs = [
      hoomi.onLoad((payload) => ref.current.onLoad?.(payload)),
      hoomi.onShow(() => ref.current.onShow?.()),
      hoomi.onHide(() => ref.current.onHide?.()),
      hoomi.onError((message, data) => ref.current.onError?.(message, data)),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [hoomi]);
}

export interface UseLocationWatchOptions {
  enabled?: boolean;
}

export interface UseLocationWatchResult {
  position: GeoPosition | null;
  error: HoomiError | null;
  /** True while the host-side subscription is open. */
  active: boolean;
}

/**
 * Continuous GPS stream. StrictMode-safe: the effect guards with a
 * `cancelled` flag and closes a subscription that resolves after cleanup,
 * so double-invoked effects never leak a host-side watch.
 */
export function useLocationWatch(
  params?: LocationWatchParams,
  options: UseLocationWatchOptions = {},
): UseLocationWatchResult {
  const hoomi = useHoomi();
  const enabled = options.enabled ?? true;
  const [position, setPosition] = useState<GeoPosition | null>(null);
  const [error, setError] = useState<HoomiError | null>(null);
  const [active, setActive] = useState(false);
  // Key by value, not identity: an inline params object must not tear the
  // subscription down on every render.
  const paramsKey = useMemo(() => JSON.stringify(params ?? null), [params]);

  useEffect(() => {
    if (!enabled) {
      setActive(false);
      return undefined;
    }
    let cancelled = false;
    let sub: Subscription | null = null;
    const parsed = JSON.parse(paramsKey) as LocationWatchParams | null;
    hoomi.location
      .watch(parsed ?? undefined, {
        next: (pos) => {
          if (!cancelled) {
            setPosition(pos);
            setError(null);
          }
        },
        error: (err) => {
          if (!cancelled) setError(err);
        },
        complete: () => {
          if (!cancelled) setActive(false);
        },
      })
      .then((s) => {
        if (cancelled) {
          void s.close(); // resolved after cleanup: close instead of leaking
          return;
        }
        sub = s;
        setActive(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(toHoomiError(err));
          setActive(false);
        }
      });
    return () => {
      cancelled = true;
      setActive(false);
      if (sub) void sub.close();
    };
  }, [hoomi, enabled, paramsKey]);

  return { position, error, active };
}
