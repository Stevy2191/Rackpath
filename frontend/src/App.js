import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { BrowserRouter } from 'react-router-dom';
import Navbar from './components/Navbar';
import TopologyPage from './pages/Topology';
import RacksPage from './pages/Racks';
import DevicesPage from './pages/Devices';
import ScanPage from './pages/Scan';
import LoginPage from './pages/Login';
import ChangePasswordPage from './pages/ChangePassword';
import { AuthProvider, useAuth } from './auth/AuthContext';
import RequireAuth from './auth/RequireAuth';
import './App.css';

function AppShell() {
  const { user } = useAuth();

  return (
    <div className="app">
      {user && <Navbar />}
      <main className="app-content">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/change-password"
            element={
              <RequireAuth>
                <ChangePasswordPage />
              </RequireAuth>
            }
          />
          <Route path="/" element={<Navigate to="/topology" replace />} />
          <Route
            path="/topology"
            element={
              <RequireAuth>
                <TopologyPage />
              </RequireAuth>
            }
          />
          <Route
            path="/racks"
            element={
              <RequireAuth>
                <RacksPage />
              </RequireAuth>
            }
          />
          <Route
            path="/devices"
            element={
              <RequireAuth>
                <DevicesPage />
              </RequireAuth>
            }
          />
          <Route
            path="/devices/:id"
            element={
              <RequireAuth>
                <DevicesPage />
              </RequireAuth>
            }
          />
          <Route
            path="/scan"
            element={
              <RequireAuth>
                <ScanPage />
              </RequireAuth>
            }
          />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </BrowserRouter>
  );
}
