import { useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { Link, TextField, Typography } from '@mui/material';
import { useEmailEnabled } from '../components/EmailDialog';
import { api, errorMessage, type User } from '../api';
import { useAuth } from '../auth';
import { AuthCard } from '../components/AuthCard';

export function LoginPage() {
  const { setUser } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailEnabled = useEmailEnabled();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      setUser((await api.post<{ user: User }>('/auth/login', { username, password })).user);
    } catch (err) {
      setError(errorMessage(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in to GenQR" subtitle="Use your company (Active Directory) account or your GenQR account." error={error} submitLabel="Sign in" busy={busy} onSubmit={submit}>
      <TextField label="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required fullWidth slotProps={{ htmlInput: { autoComplete: 'username' } }} />
      <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required fullWidth slotProps={{ htmlInput: { autoComplete: 'current-password' } }} />
      {emailEnabled && (
        <Typography variant="body2">
          <Link component={RouterLink} to="/forgot-password">
            Forgot your password?
          </Link>
        </Typography>
      )}
    </AuthCard>
  );
}
