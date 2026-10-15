import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Typography,
} from '@mui/material';
import SystemUpdateAlt from '@mui/icons-material/SystemUpdateAlt';
import Refresh from '@mui/icons-material/Refresh';
import { api, errorMessage } from '../../api';

interface UpdateStatus {
  state: 'idle' | 'requested' | 'running' | 'success' | 'failed' | 'up-to-date';
  message?: string;
  requestedBy?: string;
  fromCommit?: string;
  toCommit?: string;
  at?: string;
}

interface SystemInfo {
  version: string;
  commit: string | null;
  branch: string | null;
  commitDate: string | null;
  commitSubject: string | null;
  database: string;
  node: string;
  platform: string;
  uptimeSeconds: number;
  update: UpdateStatus;
}

interface UpdateCheck {
  remoteCommit: string | null;
  updateAvailable: boolean;
  error?: string;
}

const short = (sha?: string | null) => sha?.slice(0, 7) ?? '—';
const ACTIVE_STATES = new Set(['requested', 'running']);
// If nothing picks up the request in this time, the updater service is probably not installed.
const PICKUP_WARNING_MS = 60_000;

function formatUptime(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export function SystemPage() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [log, setLog] = useState('');
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const loadInfo = useCallback(async () => {
    try {
      const data = await api.get<SystemInfo>('/admin/system');
      setInfo(data);
      setUpdate(data.update);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  const active = !!update && ACTIVE_STATES.has(update.state);

  // While an update runs, follow its log. The server restarts mid-way, so errors are expected and ignored.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(async () => {
      try {
        const data = await api.get<{ update: UpdateStatus; log: string }>('/admin/system/update-log');
        setUpdate(data.update);
        setLog(data.log);
        if (!ACTIVE_STATES.has(data.update.state)) {
          if (data.update.state === 'success') window.location.reload();
          else void loadInfo();
        }
      } catch {
        /* server restarting */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [active, loadInfo]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const checkUpdates = async () => {
    setChecking(true);
    setError(null);
    try {
      setCheck(await api.post<UpdateCheck>('/admin/system/check-updates'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  const startUpdate = async () => {
    setConfirmOpen(false);
    setError(null);
    try {
      setLog('');
      setUpdate((await api.post<{ update: UpdateStatus }>('/admin/system/update')).update);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const viewLog = async () => {
    const data = await api.get<{ update: UpdateStatus; log: string }>('/admin/system/update-log');
    setLog(data.log || '(the update log is empty)');
  };

  const stuck = update?.state === 'requested' && !!update.at && Date.now() - Date.parse(update.at) > PICKUP_WARNING_MS;

  if (!info) return error ? <Alert severity="error">{error}</Alert> : null;

  return (
    <Stack spacing={3}>
      <Typography variant="h5">System</Typography>
      {error && <Alert severity="error">{error}</Alert>}

      <Paper sx={{ p: 2 }}>
        <Table size="small">
          <TableBody>
            {[
              ['Version', info.version],
              ['Commit', info.commit ? `${short(info.commit)} — ${info.commitSubject ?? ''}` : 'not a git checkout'],
              ['Commit date', info.commitDate ? new Date(info.commitDate).toLocaleString() : '—'],
              ['Branch', info.branch ?? '—'],
              ['Database', info.database],
              ['Node.js', `${info.node} (${info.platform})`],
              ['Uptime', formatUptime(info.uptimeSeconds)],
            ].map(([k, v]) => (
              <TableRow key={k}>
                <TableCell sx={{ width: 160, fontWeight: 500 }}>{k}</TableCell>
                <TableCell>{v}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Typography variant="h6">Updates</Typography>
          <Typography variant="body2" color="text.secondary">
            Updates pull the latest code from GitHub, back up the database, apply migrations and restart the service. They can also be run on the server
            with <code>genqrctl update</code>.
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Button startIcon={<Refresh />} onClick={checkUpdates} disabled={checking || active}>
              Check for updates
            </Button>
            <Button variant="contained" startIcon={<SystemUpdateAlt />} onClick={() => setConfirmOpen(true)} disabled={active}>
              Update now
            </Button>
            <Button onClick={viewLog} disabled={active}>
              View last update log
            </Button>
            {check && !check.error && (
              <Chip
                color={check.updateAvailable ? 'warning' : 'success'}
                label={check.updateAvailable ? `Update available: ${short(check.remoteCommit)}` : 'Up to date'}
              />
            )}
          </Stack>
          {check?.error && <Alert severity="warning">{check.error}</Alert>}
          {update && update.state !== 'idle' && (
            <Alert severity={update.state === 'failed' ? 'error' : active ? 'info' : 'success'}>
              Last update: <strong>{update.state}</strong>
              {update.message ? ` — ${update.message}` : ''}
              {update.requestedBy ? ` (requested by ${update.requestedBy}` : ''}
              {update.at ? `${update.requestedBy ? ', ' : ' ('}${new Date(update.at).toLocaleString()})` : update.requestedBy ? ')' : ''}
            </Alert>
          )}
          {stuck && (
            <Alert severity="warning">
              The update request has not been picked up. Check that the updater is installed: <code>systemctl status genqr-update.path</code>
            </Alert>
          )}
          {log && (
            <Box
              component="pre"
              ref={logRef}
              sx={{ m: 0, p: 1.5, maxHeight: 360, overflow: 'auto', bgcolor: 'grey.900', color: 'grey.100', borderRadius: 1, fontSize: 12 }}
            >
              {log}
            </Box>
          )}
        </Stack>
      </Paper>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>Update GenQR now?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The service restarts during the update, so users may see a short interruption. A database backup is taken first, and the update rolls back
            automatically if the new version fails to start.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={startUpdate}>
            Update now
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
