import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { BrowserRouter } from 'react-router-dom';
import Navbar from './components/Navbar';
import TopologyPage from './pages/Topology';
import VlansPage from './pages/Vlans';
import RacksPage from './pages/Racks';
import DevicesPage from './pages/Devices';
import ScanPage from './pages/Scan';
import LoginPage from './pages/Login';
import ChangePasswordPage from './pages/ChangePassword';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { ProjectProvider, useProject } from './project/ProjectContext';
import RequireAuth from './auth/RequireAuth';
import ErrorBoundary from './components/ErrorBoundary';
import { ThemeProvider } from './theme/ThemeContext';
import './App.css';

function AppShell() {
  const { user, loading } = useAuth();
  const { currentProjectId } = useProject();

  if (loading) {
    return <div className="page-status">Loading...</div>;
  }

  return (
    <div className="app">
      {user && <Navbar />}
      <main className="app-content">
        {/* Re-mount the routed pages when the project changes so every page
            re-fetches its data for the newly selected project. */}
        <Routes key={currentProjectId ?? 'none'}>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/change-password"
            element={
              <RequireAuth>
                <ChangePasswordPage />
              </RequireAuth>
            }
          />
          <Route path="/" element={<Navigate to="/scan" replace />} />
          <Route
            path="/topology"
            element={
              <RequireAuth>
                <TopologyPage />
              </RequireAuth>
            }
          />
          <Route
            path="/vlans"
            element={
              <RequireAuth>
                <VlansPage />
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
                <ErrorBoundary label="The Scan page ran into an unexpected error.">
                  <ScanPage />
                </ErrorBoundary>
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
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <ProjectProvider>
            <AppShell />
          </ProjectProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}
