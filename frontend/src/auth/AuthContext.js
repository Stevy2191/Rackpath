import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import client, { setAuthToken, setUnauthorizedHandler } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);

  const logout = useCallback(() => {
    setAuthToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
  }, [logout]);

  const login = useCallback(async (username, password) => {
    const res = await client.post('/auth/login', { username, password });
    setAuthToken(res.data.token);
    setUser(res.data.user);
    return res.data.user;
  }, []);

  const refreshUser = useCallback(async () => {
    const res = await client.get('/auth/me');
    setUser(res.data);
    return res.data;
  }, []);

  const logoutRemote = useCallback(async () => {
    try {
      await client.post('/auth/logout');
    } finally {
      logout();
    }
  }, [logout]);

  return (
    <AuthContext.Provider value={{ user, login, logout: logoutRemote, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
