import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import client, { setUnauthorizedHandler } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
  }, [logout]);

  const refreshUser = useCallback(async () => {
    const res = await client.get('/auth/me');
    setUser(res.data);
    return res.data;
  }, []);

  // The session cookie persists across page refreshes, so check for an
  // existing session on initial load.
  useEffect(() => {
    refreshUser()
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [refreshUser]);

  const login = useCallback(
    async (username, password) => {
      await client.post('/auth/login', { username, password });
      return refreshUser();
    },
    [refreshUser]
  );

  const logoutRemote = useCallback(async () => {
    try {
      await client.post('/auth/logout');
    } finally {
      logout();
    }
  }, [logout]);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout: logoutRemote, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
