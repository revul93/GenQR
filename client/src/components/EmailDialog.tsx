import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormGroup,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { api, errorMessage } from '../api';

const FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPG' },
  { value: 'svg', label: 'SVG' },
  { value: 'pdf', label: 'PDF' },
  { value: 'docx', label: 'Word' },
] as const;

const splitAddresses = (s: string) => s.split(/[\s,;]+/).map((a) => a.trim()).filter(Boolean);

/** Whether admins have switched email on; fetched once per mount. */
export function useEmailEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    api
      .get<{ emailEnabled: boolean }>('/auth/options')
      .then((r) => setEnabled(r.emailEnabled))
      .catch(() => setEnabled(false));
  }, []);
  return enabled;
}

export function EmailDialog({ qr, open, onClose, onSent }: { qr: { id: number; title: string }; open: boolean; onClose(): void; onSent?(msg: string): void }) {
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [formats, setFormats] = useState<string[]>(['png', 'pdf']);
  const [imageSize, setImageSize] = useState(1024);
  const [printSizeCm, setPrintSizeCm] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setTo('');
      setCc('');
      setSubject(`QR code: ${qr.title}`);
      setMessage('');
      setError(null);
    }
  }, [open, qr.title]);

  const toggle = (f: string) => setFormats((list) => (list.includes(f) ? list.filter((x) => x !== f) : [...list, f]));
  const needsImageSize = formats.some((f) => f === 'png' || f === 'jpg');
  const needsPrintSize = formats.some((f) => f === 'pdf' || f === 'docx');

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const recipients = splitAddresses(to);
      await api.post(`/qr/${qr.id}/email`, { to: recipients, cc: splitAddresses(cc), subject, message, formats, imageSize, printSizeCm });
      onSent?.(`Email sent to ${recipients.join(', ')}.`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Email QR code</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField label="To" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@company.com, other@company.com" autoFocus helperText="Up to 10 addresses, separated by commas." />
          <TextField label="Cc (optional)" value={cc} onChange={(e) => setCc(e.target.value)} />
          <TextField label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <TextField label="Message (optional)" value={message} onChange={(e) => setMessage(e.target.value)} multiline minRows={3} />
          <Stack spacing={0.5}>
            <Typography variant="body2" color="text.secondary">
              Attach as
            </Typography>
            <FormGroup row>
              {FORMATS.map((f) => (
                <FormControlLabel key={f.value} control={<Checkbox checked={formats.includes(f.value)} onChange={() => toggle(f.value)} />} label={f.label} />
              ))}
            </FormGroup>
          </Stack>
          <Stack direction="row" spacing={2}>
            {needsImageSize && (
              <TextField select size="small" label="Image size" value={imageSize} onChange={(e) => setImageSize(Number(e.target.value))} sx={{ minWidth: 160 }}>
                {[512, 1024, 2048].map((s) => (
                  <MenuItem key={s} value={s}>
                    {s} px
                  </MenuItem>
                ))}
              </TextField>
            )}
            {needsPrintSize && (
              <TextField select size="small" label="Printed size" value={printSizeCm} onChange={(e) => setPrintSizeCm(Number(e.target.value))} sx={{ minWidth: 160 }}>
                {[3, 5, 8, 10].map((s) => (
                  <MenuItem key={s} value={s}>
                    {s} × {s} cm
                  </MenuItem>
                ))}
              </TextField>
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Replies go to your own email address. The message also shows the code and, for website codes, its short link.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={send} disabled={busy || !splitAddresses(to).length || !formats.length || !subject.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
