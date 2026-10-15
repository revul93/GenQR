import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
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

  if (loading) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <CircularProgress />
      </Box>
    );
  }
  if (needsSetup) return <SetupPage />;
  if (!user) return <LoginPage />;
  if (user.mustChangePassword) return <ChangePasswordPage forced />;

  return (
    <Routes>
      <Route path="qr/:id/print" element={<QrPrintPage />} />
      <Route element={<Layout />}>
        <Route index element={<QrListPage />} />
        <Route path="qr/new" element={<QrDesignerPage key="new" />} />
        <Route path="qr/:id" element={<QrDesignerPage />} />
        <Route path="links" element={<LinksPage />} />
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
