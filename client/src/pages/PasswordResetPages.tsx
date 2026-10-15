import { useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router';
import { Alert, Link, TextField, Typography } from '@mui/material';
import { api, errorMessage } from '../api';
import { AuthCard } from '../components/AuthCard';

export function ForgotPasswordPage() {
  const [login, setLogin] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/forgot', { login });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Forgot your password?"
      subtitle="For GenQR accounts only. Company (Active Directory) passwords are reset through IT."
      error={error}
      submitLabel="Email me a reset link"
      busy={busy || done}
      onSubmit={submit}
    >
      {done ? (
        <Alert severity="success">If that account exists and has an email address, a reset link is on its way. It works for one hour.</Alert>
      ) : (
        <TextField label="Username or email" value={login} onChange={(e) => setLogin(e.target.value)} autoFocus required fullWidth />
      )}
      <Typography variant="body2">
        <Link component={RouterLink} to="/">
          Back to sign in
        </Link>
      </Typography>
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : 'This reset link is incomplete. Copy the whole link from the email.');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (password !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/reset', { token, password });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Choose a new password" error={error} submitLabel="Set new password" busy={busy || done || !token} onSubmit={submit}>
      {done ? (
        <Alert severity="success">Your password was changed and you were signed out everywhere.</Alert>
      ) : (
        <>
          <TextField label="New password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} helperText="At least 10 characters, with letters and digits." autoFocus required fullWidth slotProps={{ htmlInput: { autoComplete: 'new-password' } }} />
          <TextField label="Confirm new password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required fullWidth slotProps={{ htmlInput: { autoComplete: 'new-password' } }} />
        </>
      )}
      <Typography variant="body2">
        <Link href="/">{done ? 'Sign in with your new password' : 'Back to sign in'}</Link>
      </Typography>
    </AuthCard>
  );
}
