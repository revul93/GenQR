import { useState } from 'react';
import { Divider, TextField, Typography } from '@mui/material';
import { api, errorMessage, type User } from '../api';
import { useAuth } from '../auth';
import { AuthCard } from '../components/AuthCard';

export function SetupPage() {
  const { setUser } = useAuth();
  const [form, setForm] = useState({
    token: '',
    username: 'admin',
    displayName: 'Administrator',
    email: '',
    password: '',
    confirm: '',
    publicBaseUrl: window.location.origin,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const field = (name: keyof typeof form) => ({
    value: form[name],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [name]: e.target.value }),
    fullWidth: true,
    required: true,
  });

  const submit = async () => {
    if (form.password !== form.confirm) return setError('Passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      const { confirm: _c, ...body } = form;
      setUser((await api.post<{ user: User }>('/setup', body)).user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Welcome to GenQR"
      subtitle="Create the administrator account. This local account keeps working even when Active Directory is unavailable."
      error={error}
      submitLabel="Create administrator"
      busy={busy}
      onSubmit={submit}
      width={520}
    >
      <TextField
        label="Setup token"
        helperText="Shown in the server log, or run: genqrctl setup-token"
        autoFocus
        slotProps={{ htmlInput: { autoComplete: 'off', spellCheck: false } }}
        {...field('token')}
      />
      <Divider />
      <TextField label="Username" slotProps={{ htmlInput: { autoComplete: 'username' } }} {...field('username')} />
      <TextField label="Display name" {...field('displayName')} />
      <TextField label="Recovery email" type="email" helperText="Used for password-reset links once email is configured." {...field('email')} />
      <TextField label="Password" type="password" helperText="At least 10 characters, with letters and digits." slotProps={{ htmlInput: { autoComplete: 'new-password' } }} {...field('password')} />
      <TextField label="Confirm password" type="password" slotProps={{ htmlInput: { autoComplete: 'new-password' } }} {...field('confirm')} />
      <Divider />
      <TextField label="Public address of this app" type="url" {...field('publicBaseUrl')} />
      <Typography variant="caption" color="text.secondary">
        Short links will look like {form.publicBaseUrl.replace(/\/+$/, '')}/short/XXXXXXX. Printed QR codes contain this address, so pick the final
        hostname (e.g. https://genqr.jeddah-cables.com).
      </Typography>
    </AuthCard>
  );
}
