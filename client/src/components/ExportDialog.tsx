import { useEffect, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { exportUrl } from '../qr';

const FORMATS = [
  { value: 'png', label: 'PNG image', unit: 'px', sizes: [512, 1024, 2048, 4096], size: 1024 },
  { value: 'jpg', label: 'JPG image', unit: 'px', sizes: [512, 1024, 2048, 4096], size: 1024 },
  { value: 'svg', label: 'SVG vector (for designers and print shops)', unit: 'px', sizes: [512, 1024], size: 1024 },
  { value: 'pdf', label: 'PDF document', unit: 'cm', sizes: [2, 3, 5, 8, 10, 15, 20], size: 5 },
  { value: 'docx', label: 'Word document', unit: 'cm', sizes: [2, 3, 5, 8, 10, 15, 20], size: 5 },
] as const;

type Format = (typeof FORMATS)[number]['value'];

/** Picks a format and size, then downloads the saved QR code. */
export function ExportDialog({ qrId, open, onClose, initialFormat = 'png' }: { qrId: number; open: boolean; onClose(): void; initialFormat?: Format }) {
  const [format, setFormat] = useState<Format>(initialFormat);
  const spec = FORMATS.find((f) => f.value === format)!;
  const [size, setSize] = useState<number>(spec.size);

  useEffect(() => {
    if (open) setFormat(initialFormat);
  }, [open, initialFormat]);
  useEffect(() => setSize(FORMATS.find((f) => f.value === format)!.size), [format]);

  const download = () => {
    const a = document.createElement('a');
    a.href = exportUrl(qrId, format, size);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Download</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField select label="Format" value={format} onChange={(e) => setFormat(e.target.value as Format)}>
            {FORMATS.map((f) => (
              <MenuItem key={f.value} value={f.value}>
                {f.label}
              </MenuItem>
            ))}
          </TextField>
          <TextField select label={spec.unit === 'cm' ? 'Printed size' : 'Image size'} value={size} onChange={(e) => setSize(Number(e.target.value))}>
            {spec.sizes.map((s) => (
              <MenuItem key={s} value={s}>
                {spec.unit === 'cm' ? `${s} × ${s} cm` : `${s} × ${s} px`}
              </MenuItem>
            ))}
          </TextField>
          <Typography variant="caption" color="text.secondary">
            {spec.unit === 'cm'
              ? 'The page is exactly the size of the code, rendered at print resolution.'
              : 'For print, codes of at least 2 × 2 cm scan reliably; larger is better for distance scanning.'}
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={download}>
          Download
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function PrintDialog({ qrId, open, onClose }: { qrId: number; open: boolean; onClose(): void }) {
  const [cm, setCm] = useState(5);
  const [caption, setCaption] = useState('');
  const print = () => {
    const params = new URLSearchParams({ cm: String(cm) });
    if (caption.trim()) params.set('caption', caption.trim());
    window.open(`/qr/${qrId}/print?${params}`, '_blank', 'noopener');
    onClose();
  };
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Print</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField select label="Printed size" value={cm} onChange={(e) => setCm(Number(e.target.value))}>
            {[2, 3, 4, 5, 8, 10, 15].map((s) => (
              <MenuItem key={s} value={s}>
                {s} × {s} cm
              </MenuItem>
            ))}
          </TextField>
          <TextField label="Caption under the code (optional)" value={caption} onChange={(e) => setCaption(e.target.value)} slotProps={{ htmlInput: { maxLength: 120 } }} />
          <Typography variant="caption" color="text.secondary">
            Opens a print page in a new tab. Set the printer to 100% / &quot;actual size&quot; so the code keeps its size.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={print}>
          Open print page
        </Button>
      </DialogActions>
    </Dialog>
  );
}
