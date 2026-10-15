import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { api, errorMessage } from '../../api';

type Client = 'sqlite' | 'mysql' | 'pg' | 'mssql';

interface DriverState {
  client: Client;
  package: string;
  wanted: string;
  installed: string | null;
}

interface SwitchStatus {
  state: 'idle' | 'running' | 'failed' | 'restart-required' | 'restarting' | 'done' | 'reverted';
  from?: Client;
  to?: Client;
  step?: string;
  log: string[];
  error?: string;
  finishedAt?: string;
}

interface DbInfo {
  current: { client: Client; connection: Record<string, unknown> };
  drivers: DriverState[];
  status: SwitchStatus;
  canSelfRestart: boolean;
}

const ENGINES: { value: Client; label: string; port: number }[] = [
  { value: 'pg', label: 'PostgreSQL', port: 5432 },
  { value: 'mysql', label: 'MySQL / MariaDB', port: 3306 },
  { value: 'sqlite', label: 'SQLite (file on this server)', port: 0 },
];
const engineLabel = (c: Client) => ENGINES.find((e) => e.value === c)?.label ?? c;

function describe(info: DbInfo['current']): string {
  const c = info.connection;
  return info.client === 'sqlite' ? String(c.filename) : `${c.user}@${c.host}:${c.port}/${c.database}${c.ssl ? ' (TLS)' : ''}`;
}

export function DatabaseSettings() {
  const [info, setInfo] = useState<DbInfo | null>(null);
  const [client, setClient] = useState<Client>('pg');
  const [form, setForm] = useState({ host: '', port: 5432, database: 'genqr', user: 'genqr', password: '', ssl: false, verifyCertificate: true, filename: 'data/genqr-new.db' });
  const [test, setTest] = useState<{ ok: boolean; version?: string; empty?: boolean; problem?: string; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await api.get<DbInfo>('/admin/database'));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const status = info?.status;
  const active = status?.state === 'running' || status?.state === 'restarting';

  // Follow a running switch, including across the restart (the server is briefly unreachable).
  useEffect(() => {
    if (!active) return;
    const t = setInterval(async () => {
      try {
        const s = await api.get<SwitchStatus>('/admin/database/status');
        setInfo((i) => (i ? { ...i, status: s } : i));
        if (s.state !== 'running' && s.state !== 'restarting') void load();
      } catch {
        /* restarting */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [active, load]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [status?.log.length]);

  const target = () =>
    client === 'sqlite'
      ? { client, filename: form.filename }
      : { client, host: form.host, port: Number(form.port), database: form.database, user: form.user, password: form.password, ssl: form.ssl, verifyCertificate: form.verifyCertificate };

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    setError(null);
    try {
      setTest(await api.post('/admin/database/test', target()));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const startSwitch = async () => {
    setConfirm(false);
    setError(null);
    try {
      const s = await api.post<SwitchStatus>('/admin/database/switch', target());
      setInfo((i) => (i ? { ...i, status: s } : i));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (!info) return error ? <Alert severity="error">{error}</Alert> : null;
  const set = (patch: Partial<typeof form>) => {
    setForm({ ...form, ...patch });
    setTest(null);
  };
  const driver = info.drivers.find((d) => d.client === client);
  const canSwitch = !!test?.ok && test.empty && !active;

  return (
    <Stack spacing={3}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Current database
        </Typography>
        <Typography variant="h6">{engineLabel(info.current.client)}</Typography>
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
          {describe(info.current)}
        </Typography>
      </Paper>

      {status && status.state !== 'idle' && (
        <Alert
          severity={status.state === 'failed' || status.state === 'reverted' ? 'error' : status.state === 'done' ? 'success' : status.state === 'restart-required' ? 'warning' : 'info'}
        >
          {status.state === 'running' && `Switching to ${engineLabel(status.to!)} — ${status.step ?? ''}…`}
          {status.state === 'restarting' && 'Restarting GenQR on the new database…'}
          {status.state === 'restart-required' && 'Data copied and configuration saved. Restart GenQR (genqrctl restart) to start using the new database.'}
          {status.state === 'done' && `Switch to ${engineLabel(status.to!)} completed${status.finishedAt ? ` on ${new Date(status.finishedAt).toLocaleString()}` : ''}.`}
          {status.state === 'failed' && `The switch failed and nothing was changed: ${status.error}`}
          {status.state === 'reverted' && `GenQR could not start on the new database and went back to the previous one: ${status.error}`}
        </Alert>
      )}
      {status && status.log.length > 0 && (
        <Box component="pre" ref={logRef} sx={{ m: 0, p: 1.5, maxHeight: 240, overflow: 'auto', bgcolor: 'grey.900', color: 'grey.100', borderRadius: 1, fontSize: 12 }}>
          {status.log.join('\n')}
        </Box>
      )}

      <Stack spacing={2}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Move GenQR to another database
        </Typography>
        <Typography variant="body2" color="text.secondary">
          All data is copied into a new, <b>empty</b> database, which then replaces the current one. The current database is left untouched, so you can switch back. The
          required driver is installed automatically.
        </Typography>
        <TextField
          select
          label="Database engine"
          value={client}
          onChange={(e) => {
            const c = e.target.value as Client;
            setClient(c);
            set({ port: ENGINES.find((x) => x.value === c)!.port || form.port });
          }}
          sx={{ maxWidth: 360 }}
        >
          {ENGINES.filter((e) => e.value !== info.current.client || e.value === 'sqlite').map((e) => (
            <MenuItem key={e.value} value={e.value}>
              {e.label}
            </MenuItem>
          ))}
        </TextField>
        {driver && driver.client !== 'sqlite' && (
          <Typography variant="caption" color="text.secondary">
            Driver {driver.package} {driver.wanted}: {driver.installed === driver.wanted ? 'installed' : 'will be installed when you test the connection'}
          </Typography>
        )}

        {client === 'sqlite' ? (
          <TextField label="Database file" value={form.filename} onChange={(e) => set({ filename: e.target.value })} helperText="Relative to the GenQR folder. Must be a new file." />
        ) : (
          <>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField label="Server" value={form.host} onChange={(e) => set({ host: e.target.value })} fullWidth placeholder="db.company.local" />
              <TextField label="Port" type="number" value={form.port} onChange={(e) => set({ port: Number(e.target.value) })} sx={{ width: { sm: 140 } }} />
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField label="Database name" value={form.database} onChange={(e) => set({ database: e.target.value })} fullWidth helperText="Create it empty beforehand." />
              <TextField label="User" value={form.user} onChange={(e) => set({ user: e.target.value })} fullWidth helperText="Needs rights to create tables in that database." />
              <TextField label="Password" type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} fullWidth slotProps={{ htmlInput: { autoComplete: 'new-password' } }} helperText="Stored encrypted." />
            </Stack>
            <Stack direction="row" spacing={2}>
              <FormControlLabel control={<Switch checked={form.ssl} onChange={(e) => set({ ssl: e.target.checked })} />} label="Encrypt the connection (TLS)" />
              {form.ssl && <FormControlLabel control={<Switch checked={form.verifyCertificate} onChange={(e) => set({ verifyCertificate: e.target.checked })} />} label="Verify server certificate" />}
            </Stack>
          </>
        )}

        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Button variant="outlined" onClick={runTest} disabled={busy || active}>
            {busy ? 'Testing…' : 'Test connection'}
          </Button>
          <Button variant="contained" color="warning" onClick={() => (setUnderstood(false), setConfirm(true))} disabled={!canSwitch}>
            Switch to this database
          </Button>
        </Stack>
        {error && <Alert severity="error">{error}</Alert>}
        {test && !test.ok && <Alert severity="error">{test.error}</Alert>}
        {test?.ok && (
          <Alert severity={test.empty ? 'success' : 'error'}>
            Connected: {test.version}
            {test.empty ? (
              <>
                {' '}
                <Chip size="small" label="Empty — ready" color="success" variant="outlined" />
              </>
            ) : (
              <> — {test.problem}</>
            )}
          </Alert>
        )}
      </Stack>

      <Dialog open={confirm} onClose={() => setConfirm(false)}>
        <DialogTitle>Switch to {engineLabel(client)}?</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <DialogContentText>
              GenQR copies all data into the new database, saves the new settings and restarts. Changes are blocked while data is copied (usually under a minute); short
              links keep redirecting. If GenQR cannot start on the new database it automatically returns to the current one.
            </DialogContentText>
            {!info.canSelfRestart && <Alert severity="warning">GenQR is not running as a service here, so you will need to restart it yourself afterwards.</Alert>}
            <FormControlLabel control={<Checkbox checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />} label="I have a backup and want to switch now" />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(false)}>Cancel</Button>
          <Button variant="contained" color="warning" disabled={!understood} onClick={startSwitch}>
            Switch now
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
