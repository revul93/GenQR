import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  InputAdornment,
  List,
  ListItem,
  ListItemText,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopy from '@mui/icons-material/ContentCopy';
import OpenInNew from '@mui/icons-material/OpenInNew';
import { api, errorMessage } from '../api';
import { linkState, type LinkHistoryEntry, type ShortLink } from '../qr';

// <input type="datetime-local"> works in local time without a zone.
const toLocalInput = (ms: number | null) => {
  if (ms == null) return '';
  const d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).getTime() : null);

export const STATE_CHIP = {
  active: { label: 'Active', color: 'success' },
  disabled: { label: 'Switched off', color: 'default' },
  expired: { label: 'Expired', color: 'warning' },
} as const;

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip title={copied ? 'Copied' : 'Copy'}>
      <IconButton
        size="small"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <ContentCopy fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

function describe(h: LinkHistoryEntry): string {
  switch (h.field) {
    case 'target':
      return `Destination changed to ${h.newValue}`;
    case 'active':
      return h.newValue === 'true' ? 'Switched on' : 'Switched off';
    case 'expires':
      return h.newValue ? `Expiry set to ${new Date(h.newValue).toLocaleString()}` : 'Expiry removed';
  }
}

/** View and change where a short link points, whether it is on, and when it expires. */
export function LinkDialog({ linkId, onClose, onChanged }: { linkId: number | null; onClose(): void; onChanged?(link: ShortLink): void }) {
  const [link, setLink] = useState<ShortLink | null>(null);
  const [history, setHistory] = useState<LinkHistoryEntry[]>([]);
  const [form, setForm] = useState({ targetUrl: '', isActive: true, expires: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = (l: ShortLink, h: LinkHistoryEntry[]) => {
    setLink(l);
    setHistory(h);
    setForm({ targetUrl: l.targetUrl, isActive: l.isActive, expires: toLocalInput(l.expiresAt) });
  };

  useEffect(() => {
    setLink(null);
    setError(null);
    if (linkId != null)
      api
        .get<{ link: ShortLink; history: LinkHistoryEntry[] }>(`/links/${linkId}`)
        .then((r) => apply(r.link, r.history))
        .catch((err) => setError(errorMessage(err)));
  }, [linkId]);

  if (linkId == null) return null;

  const save = async () => {
    if (!link) return;
    setBusy(true);
    setError(null);
    const patch: Record<string, unknown> = {};
    if (form.targetUrl.trim() !== link.targetUrl) patch.targetUrl = form.targetUrl.trim();
    if (form.isActive !== link.isActive) patch.isActive = form.isActive;
    const expiresAt = fromLocalInput(form.expires);
    if (expiresAt !== link.expiresAt) patch.expiresAt = expiresAt;
    try {
      if (Object.keys(patch).length) {
        const r = await api.patch<{ link: ShortLink; history: LinkHistoryEntry[] }>(`/links/${link.id}`, patch);
        apply(r.link, r.history);
        onChanged?.(r.link);
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const state = link ? linkState(link) : null;

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        Short link {state && <Chip size="small" sx={{ ml: 1 }} label={STATE_CHIP[state].label} color={STATE_CHIP[state].color} />}
      </DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {link && (
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label="Short URL"
              value={link.url}
              slotProps={{
                input: {
                  readOnly: true,
                  endAdornment: (
                    <InputAdornment position="end">
                      <CopyButton text={link.url} />
                      <Tooltip title="Open">
                        <IconButton size="small" href={link.url} target="_blank" rel="noopener">
                          <OpenInNew fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </InputAdornment>
                  ),
                },
              }}
            />
            <TextField
              label="Destination"
              value={form.targetUrl}
              onChange={(e) => setForm({ ...form, targetUrl: e.target.value })}
              helperText="Changing it takes effect immediately for everyone, including printed QR codes."
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'center' } }}>
              <FormControlLabel control={<Switch checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />} label={form.isActive ? 'Link is on' : 'Link is off'} />
              <TextField
                type="datetime-local"
                label="Expires (optional)"
                value={form.expires}
                onChange={(e) => setForm({ ...form, expires: e.target.value })}
                slotProps={{ inputLabel: { shrink: true } }}
                sx={{ minWidth: 240 }}
              />
              {form.expires && <Button onClick={() => setForm({ ...form, expires: '' })}>No expiry</Button>}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              People opening a switched-off or expired link see a &quot;link not available&quot; page.
              {link.qrTitle ? ` Used by the QR code “${link.qrTitle}”.` : ''} Owner: {link.ownerUsername}.
            </Typography>
            <Typography variant="subtitle2">History</Typography>
            {history.length ? (
              <List dense sx={{ maxHeight: 220, overflow: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}>
                {history.map((h) => (
                  <ListItem key={h.id}>
                    <ListItemText
                      primary={describe(h)}
                      secondary={`${new Date(h.changedAt).toLocaleString()} · ${h.changedByName}`}
                      slotProps={{ primary: { sx: { wordBreak: 'break-all' } } }}
                    />
                  </ListItem>
                ))}
              </List>
            ) : (
              <Typography variant="body2" color="text.secondary">
                No changes since the link was created on {new Date(link.createdAt).toLocaleString()}.
              </Typography>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={busy || !link}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
