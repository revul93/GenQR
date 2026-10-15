import { useState } from 'react';
import { Alert, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { api, errorMessage, type User } from '../api';
import { useAuth } from '../auth';
import { AuthCard } from '../components/AuthCard';

/** `forced` renders the full-screen variant shown when an admin requires a password change. */
export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const { setUser, logout } = useAuth();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (newPassword !== confirm) return setError('New passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.post<{ user: User }>('/auth/change-password', { currentPassword, newPassword });
      setUser(user);
      setDone(true);
      setCurrent('');
      setNew('');
      setConfirm('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const fields = (
    <>
      <TextField label="Current password" type="password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} required fullWidth slotProps={{ htmlInput: { autoComplete: 'current-password' } }} />
      <TextField label="New password" type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} helperText="At least 10 characters, with letters and digits." required fullWidth slotProps={{ htmlInput: { autoComplete: 'new-password' } }} />
      <TextField label="Confirm new password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required fullWidth slotProps={{ htmlInput: { autoComplete: 'new-password' } }} />
    </>
  );

  if (forced) {
    return (
      <AuthCard title="Change your password" subtitle="An administrator requires you to set a new password before continuing." error={error} submitLabel="Change password" busy={busy} onSubmit={submit}>
        {fields}
        <Button onClick={() => logout()}>Sign out</Button>
      </AuthCard>
    );
  }

  return (
    <Paper
      component="form"
      sx={{ p: 3, maxWidth: 480 }}
      onSubmit={(e: React.FormEvent) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Stack spacing={2}>
        <Typography variant="h5">Change password</Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {done && <Alert severity="success">Password changed. Your other sessions were signed out.</Alert>}
        {fields}
        <Button type="submit" variant="contained" disabled={busy} sx={{ alignSelf: 'flex-start' }}>
          Change password
        </Button>
      </Stack>
    </Paper>
  );
}
