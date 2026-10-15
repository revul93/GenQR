import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { Box, CircularProgress } from '@mui/material';
import { useAuth } from './auth';
import { Layout } from './components/Layout';
import { SetupPage } from './pages/SetupPage';
import { LoginPage } from './pages/LoginPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { QrListPage } from './pages/QrListPage';
import { QrDesignerPage } from './pages/QrDesignerPage';
import { QrPrintPage } from './pages/QrPrintPage';
import { LinksPage } from './pages/LinksPage';
// Chart pages load on demand: the charting library is the largest dependency.
const LinkStatsPage = lazy(() => import('./pages/LinkStatsPage').then((m) => ({ default: m.LinkStatsPage })));
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
import { ForgotPasswordPage, ResetPasswordPage } from './pages/PasswordResetPages';
import { SystemPage } from './pages/admin/SystemPage';
import { AuditPage } from './pages/admin/AuditPage';
import { UsersPage } from './pages/admin/UsersPage';
import { SettingsPage } from './pages/admin/SettingsPage';

function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user?.role === 'admin' ? <>{children}</> : <Navigate to="/" replace />;
}

export function App() {
  const { loading, needsSetup, user } = useAuth();
  const { pathname } = useLocation();

  if (loading) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }
  if (needsSetup) return <SetupPage />;
  // Reset links work whether or not someone is signed in on this browser.
  if (pathname === '/reset-password') return <ResetPasswordPage />;
  if (!user) return pathname === '/forgot-password' ? <ForgotPasswordPage /> : <LoginPage />;
  if (user.mustChangePassword) return <ChangePasswordPage forced />;

  return (
    <Routes>
      <Route path="qr/:id/print" element={<QrPrintPage />} />
      <Route element={<Layout />}>
        <Route index element={<QrListPage />} />
        <Route path="qr/new" element={<QrDesignerPage key="new" />} />
        <Route path="qr/:id" element={<QrDesignerPage />} />
        <Route path="links" element={<LinksPage />} />
        <Route path="links/:id" element={<Suspense fallback={<CircularProgress />}><LinkStatsPage /></Suspense>} />
        <Route path="dashboard" element={<Suspense fallback={<CircularProgress />}><DashboardPage /></Suspense>} />
        <Route path="account/password" element={<ChangePasswordPage />} />
        <Route path="admin/users" element={<AdminOnly><UsersPage /></AdminOnly>} />
        <Route path="admin/settings" element={<AdminOnly><SettingsPage /></AdminOnly>} />
        <Route path="admin/system" element={<AdminOnly><SystemPage /></AdminOnly>} />
        <Route path="admin/audit" element={<AdminOnly><AuditPage /></AdminOnly>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
