import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { BrowserRouter } from 'react-router-dom';
import Navbar from './components/Navbar';
import DashboardPage from './pages/Dashboard';
import TopologyPage from './pages/Topology';
import VlansPage from './pages/Vlans';
import RacksPage from './pages/Racks';
import DevicesPage from './pages/Devices';
import MacrosPage from './pages/Macros';
import CamerasPage from './pages/Cameras';
import AccessDevicesPage from './pages/AccessDevices';
import IntegrationsPage from './pages/Integrations';
import ScanPage from './pages/Scan';
import LoginPage from './pages/Login';
import ChangePasswordPage from './pages/ChangePassword';
import ProjectSelectPage from './pages/ProjectSelect';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { ProjectProvider, useProject } from './project/ProjectContext';
import RequireAuth from './auth/RequireAuth';
import ErrorBoundary from './components/ErrorBoundary';
import LandingRedirect from './components/LandingRedirect';
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
          <Route
            path="/"
            element={
              <RequireAuth>
                <LandingRedirect />
              </RequireAuth>
            }
          />
          <Route
            path="/dashboard"
            element={
              <RequireAuth>
                <LandingRedirect />
              </RequireAuth>
            }
          />
          <Route
            path="/projects"
            element={
              <RequireAuth>
                <ProjectSelectPage />
              </RequireAuth>
            }
          />
          <Route
            path="/projects/:id"
            element={
              <RequireAuth>
                <DashboardPage />
              </RequireAuth>
            }
          />
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
            path="/devices/network"
            element={
              <RequireAuth>
                <DevicesPage />
              </RequireAuth>
            }
          />
          <Route
            path="/devices/cameras"
            element={
              <RequireAuth>
                <CamerasPage />
              </RequireAuth>
            }
          />
          <Route
            path="/devices/access"
            element={
              <RequireAuth>
                <AccessDevicesPage />
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
            path="/macros"
            element={
              <RequireAuth>
                <MacrosPage />
              </RequireAuth>
            }
          />
          <Route path="/cameras" element={<Navigate to="/devices/cameras" replace />} />
          <Route
            path="/integrations"
            element={
              <RequireAuth>
                <IntegrationsPage />
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
