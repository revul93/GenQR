import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { api, errorMessage } from '../../api';
import { useAuth } from '../../auth';

interface EmailConfig {
  enabled: boolean;
  host: string;
  port: number;
  security: 'starttls' | 'tls' | 'none';
  username: string;
  fromAddress: string;
  fromName: string;
  rejectUnauthorized: boolean;
  hasPassword?: boolean;
}

interface LogEntry {
  id: number;
  kind: 'qr' | 'password_reset' | 'test';
  sentByName: string;
  recipients: string;
  subject: string;
  formats: string | null;
  status: 'sent' | 'failed';
  error: string | null;
  sentAt: number;
}

const PRESETS: { label: string; values: Partial<EmailConfig>; hint: string }[] = [
  {
    label: 'Gmail',
    values: { host: 'smtp.gmail.com', port: 587, security: 'starttls' },
    hint: 'Username is the full Gmail / Google Workspace address, the password is an app password (Google Account → Security → 2-Step Verification → App passwords). The sender address must be that account or one of its verified aliases.',
  },
  {
    label: 'Microsoft 365',
    values: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
    hint: 'SMTP AUTH must be enabled for the mailbox in the Microsoft 365 admin centre.',
  },
  { label: 'Internal relay', values: { port: 25, security: 'none', username: '' }, hint: 'For an internal relay that accepts mail from this server without a login.' },
];

const KIND_LABEL = { qr: 'QR code', password_reset: 'Password reset', test: 'Test' } as const;

function EmailLog() {
  const [items, setItems] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const load = useCallback(async () => {
    const res = await api.get<{ items: LogEntry[]; total: number }>(`/admin/settings/email/log?limit=25&offset=${page * 25}`);
    setItems(res.items);
    setTotal(res.total);
  }, [page]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Stack spacing={1}>
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Sent email
        </Typography>
        <Button size="small" onClick={load}>
          Refresh
        </Button>
      </Stack>
      <Paper variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Time</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>By</TableCell>
              <TableCell>To</TableCell>
              <TableCell>Subject</TableCell>
              <TableCell>Result</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((e) => (
              <TableRow key={e.id}>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(e.sentAt).toLocaleString()}</TableCell>
                <TableCell>
                  {KIND_LABEL[e.kind] ?? e.kind}
                  {e.formats ? ` (${e.formats.toUpperCase()})` : ''}
                </TableCell>
                <TableCell>{e.sentByName}</TableCell>
                <TableCell sx={{ maxWidth: 220, wordBreak: 'break-word' }}>{e.recipients}</TableCell>
                <TableCell>{e.subject}</TableCell>
                <TableCell>
                  {e.status === 'sent' ? (
                    <Chip size="small" color="success" variant="outlined" label="Sent" />
                  ) : (
                    <Tooltip title={e.error ?? ''}>
                      <Chip size="small" color="error" label="Failed" />
                    </Tooltip>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!items.length && (
              <TableRow>
                <TableCell colSpan={6} align="center" sx={{ color: 'text.secondary', py: 3 }}>
                  No email sent yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <TablePagination component="div" count={total} page={page} onPageChange={(_e, p) => setPage(p)} rowsPerPage={25} rowsPerPageOptions={[25]} />
      </Paper>
    </Stack>
  );
}

export function EmailSettings() {
  const { user } = useAuth();
  const [cfg, setCfg] = useState<EmailConfig | null>(null);
  const [password, setPassword] = useState('');
  const [testTo, setTestTo] = useState(user?.email ?? '');
  const [hint, setHint] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [logKey, setLogKey] = useState(0);

  useEffect(() => {
    api
      .get<{ config: EmailConfig }>('/admin/settings/email')
      .then((r) => setCfg(r.config))
      .catch((err) => setNotice({ severity: 'error', text: errorMessage(err) }));
  }, []);

  if (!cfg) return notice ? <Alert severity="error">{notice.text}</Alert> : null;
  const set = (patch: Partial<EmailConfig>) => setCfg({ ...cfg, ...patch });
  const payload = () => {
    const { hasPassword: _h, ...rest } = cfg;
    return { ...rest, password: password || undefined };
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setNotice({ severity: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
      setLogKey((k) => k + 1);
    }
  };

  const save = () =>
    run(async () => {
      const { config } = await api.put<{ config: EmailConfig }>('/admin/settings/email', payload());
      setCfg(config);
      setPassword('');
      setNotice({ severity: 'success', text: config.enabled ? 'Email settings saved. Sending is ON.' : 'Email settings saved. Sending is OFF.' });
    });

  const test = () =>
    run(async () => {
      await api.post('/admin/settings/email/test', { ...payload(), testRecipient: testTo });
      setNotice({ severity: 'success', text: `Test email sent to ${testTo}. Check the inbox (and spam folder).` });
    });

  return (
    <Stack spacing={3}>
      {notice && (
        <Alert severity={notice.severity} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}
      <FormControlLabel
        control={<Switch checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} />}
        label={cfg.enabled ? 'Sending email is ON — users can email QR codes and reset forgotten passwords' : 'Sending email is OFF — email buttons are hidden'}
      />

      <Stack spacing={2}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          SMTP server
        </Typography>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              size="small"
              variant="outlined"
              onClick={() => {
                set(p.values);
                setHint(p.hint);
              }}
            >
              {p.label}
            </Button>
          ))}
        </Stack>
        {hint && (
          <Alert severity="info" onClose={() => setHint(null)}>
            {hint}
          </Alert>
        )}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField label="Host" value={cfg.host} onChange={(e) => set({ host: e.target.value })} fullWidth />
          <TextField label="Port" type="number" value={cfg.port} onChange={(e) => set({ port: Number(e.target.value) })} sx={{ width: { sm: 140 } }} />
          <TextField select label="Security" value={cfg.security} onChange={(e) => set({ security: e.target.value as EmailConfig['security'] })} sx={{ minWidth: 220 }}>
            <MenuItem value="starttls">STARTTLS (usually 587)</MenuItem>
            <MenuItem value="tls">SSL/TLS (usually 465)</MenuItem>
            <MenuItem value="none">None (internal relay)</MenuItem>
          </TextField>
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField label="Username (empty = no login)" value={cfg.username} onChange={(e) => set({ username: e.target.value })} fullWidth slotProps={{ htmlInput: { autoComplete: 'off' } }} />
          <TextField
            label="Password / app password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            helperText={cfg.hasPassword ? 'Saved. Leave empty to keep it.' : 'Stored encrypted.'}
            fullWidth
            slotProps={{ htmlInput: { autoComplete: 'new-password' } }}
          />
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField label="Sender address" value={cfg.fromAddress} onChange={(e) => set({ fromAddress: e.target.value })} fullWidth />
          <TextField label="Sender name" value={cfg.fromName} onChange={(e) => set({ fromName: e.target.value })} fullWidth />
        </Stack>
        {cfg.security !== 'none' && (
          <FormControlLabel control={<Switch checked={cfg.rejectUnauthorized} onChange={(e) => set({ rejectUnauthorized: e.target.checked })} />} label="Verify the server's certificate" />
        )}
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' } }}>
        <TextField size="small" label="Send a test to" value={testTo} onChange={(e) => setTestTo(e.target.value)} sx={{ minWidth: 280 }} />
        <Button variant="outlined" onClick={test} disabled={busy || !testTo}>
          Send test email
        </Button>
        <Typography variant="caption" color="text.secondary">
          Uses the values on this page, saved or not.
        </Typography>
      </Stack>
      <Box>
        <Button variant="contained" onClick={save} disabled={busy}>
          Save settings
        </Button>
      </Box>
      <Divider />
      <EmailLog key={logKey} />
    </Stack>
  );
}
