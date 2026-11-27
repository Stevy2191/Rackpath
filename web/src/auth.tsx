import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, onGate } from './api';
import type { Me } from './types';

// Where the session stands. The server is the authority: the app asks /me
// on start and reacts to "gate" errors from any request.
export type AuthState =
  | { kind: 'loading' }
  | { kind: 'signed_out' }
  | { kind: 'mfa'; username: string }
  | { kind: 'change_password'; me: Me }
  | { kind: 'setup_2fa'; me: Me }
  | { kind: 'ready'; me: Me };

interface AuthApi {
  state: AuthState;
  me: Me | null;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  submitMfa: (code: string, recovery: boolean) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthApi | null>(null);

function classify(me: Me): AuthState {
  if (me.mfa_pending) return { kind: 'mfa', username: me.user.username };
  if (me.user.must_change_password) return { kind: 'change_password', me };
  if (me.account_requires_2fa && !me.user.totp_enabled) return { kind: 'setup_2fa', me };
  return { kind: 'ready', me };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<Me>('/api/auth/me');
      setState(classify(me));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setState({ kind: 'signed_out' });
      } else {
        throw e;
      }
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => setState({ kind: 'signed_out' }));
    return onGate((e) => {
      if (e.status === 401) setState({ kind: 'signed_out' });
      else refresh().catch(() => undefined);
    });
  }, [refresh]);

  const login = useCallback(
    async (username: string, password: string) => {
      await api.post('/api/auth/login', { username, password });
      await refresh();
    },
    [refresh],
  );

  const submitMfa = useCallback(
    async (code: string, recovery: boolean) => {
      await api.post('/api/auth/mfa', recovery ? { recovery_code: code } : { code });
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setState({ kind: 'signed_out' });
    }
  }, []);

  const value = useMemo<AuthApi>(
    () => ({
      state,
      me: state.kind === 'ready' || state.kind === 'change_password' || state.kind === 'setup_2fa' ? state.me : null,
      refresh,
      login,
      submitMfa,
      logout,
    }),
    [state, refresh, login, submitMfa, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

/** What the signed-in user may do in a project, from their grants. Deeper
 * grants (a room, a rack) are reported per item by the server (`can_edit`). */
export function projectRights(me: Me | null, projectId: number): { write: boolean; manage: boolean } {
  let write = false;
  let manage = false;
  for (const g of me?.grants ?? []) {
    const covers = g.scope_type === 'account' || (g.scope_type === 'project' && g.project_id === projectId);
    if (!covers) continue;
    if (g.role === 'admin') manage = write = true;
    if (g.role === 'editor') write = true;
  }
  if (me?.user.is_owner) manage = write = true;
  return { write, manage };
}
