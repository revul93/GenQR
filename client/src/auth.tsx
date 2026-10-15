import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type User } from './api';

interface AuthState {
  loading: boolean;
  needsSetup: boolean;
  user: User | null;
  setUser(user: User | null): void;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { needsSetup } = await api.get<{ needsSetup: boolean }>('/setup/status');
        setNeedsSetup(needsSetup);
        if (!needsSetup) setUser((await api.get<{ user: User }>('/auth/me')).user);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 401)) console.error(err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleSetUser = useCallback((u: User | null) => {
    setUser(u);
    if (u) setNeedsSetup(false);
  }, []);

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ loading, needsSetup, user, setUser: handleSetUser, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
