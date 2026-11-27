import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/app.css';
import { AuthProvider, useAuth } from './auth';
import { applyTheme, currentTheme } from './theme';
import { ToastProvider, Spinner } from './ui';
import { Shell } from './layout/Shell';
import { Login, SecondFactor } from './pages/Login';
import { AccountPage, ForcedPasswordChange, ForcedTwoFactor } from './pages/Account';
import { InvitePage } from './pages/Invite';
import { ProjectsPage } from './pages/Projects';
import { ProjectHome } from './pages/ProjectHome';
import { projectRoutes } from './routes';
import { UsersPage } from './pages/admin/Users';
import { ActivityPage } from './pages/Activity';

applyTheme(currentTheme());

function Gate({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  switch (state.kind) {
    case 'loading':
      return (
        <div className="auth-page">
          <Spinner />
        </div>
      );
    case 'signed_out':
      return <Login />;
    case 'mfa':
      return <SecondFactor />;
    case 'change_password':
      return <ForcedPasswordChange />;
    case 'setup_2fa':
      return <ForcedTwoFactor />;
    case 'ready':
      return <>{children}</>;
  }
}

function App() {
  return (
    <Routes>
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route
        path="*"
        element={
          <Gate>
            <Routes>
              <Route element={<Shell />}>
                <Route index element={<Navigate to="/projects" replace />} />
                <Route path="projects" element={<ProjectsPage />} />
                <Route path="account" element={<AccountPage />} />
                <Route path="admin/users" element={<UsersPage />} />
                <Route path="activity" element={<ActivityPage />} />
                <Route path="p/:projectId">
                  <Route index element={<ProjectHome />} />
                  {projectRoutes}
                </Route>
                <Route path="*" element={<div className="empty"><strong>Page not found</strong></div>} />
              </Route>
            </Routes>
          </Gate>
        }
      />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
