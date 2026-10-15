import { useEffect, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { Alert, Box, Button, Chip, IconButton, Paper, Stack, Table, TableBody, TableCell, TableRow, Tooltip, Typography } from '@mui/material';
import Delete from '@mui/icons-material/Delete';
import Star from '@mui/icons-material/Star';
import StarBorder from '@mui/icons-material/StarBorder';
import Upload from '@mui/icons-material/Upload';
import { api, errorMessage } from '../../api';
import { fetchLogos, fetchPresets, logoUrl, uploadLogo, type Logo, type Preset } from '../../qr';

/** Company logo library and brand presets. */
export function BrandingSettings() {
  const [logos, setLogos] = useState<Logo[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [notice, setNotice] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const [l, p] = await Promise.all([fetchLogos(), fetchPresets()]);
      setLogos(l.filter((x) => x.isShared));
      setPresets(p);
    } catch (err) {
      setNotice({ severity: 'error', text: errorMessage(err) });
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const run = async (fn: () => Promise<unknown>, text: string) => {
    try {
      await fn();
      setNotice({ severity: 'success', text });
      await load();
    } catch (err) {
      setNotice({ severity: 'error', text: errorMessage(err) });
    }
  };

  const onUpload = (file: File | undefined) => {
    if (!file) return;
    void run(() => uploadLogo(file, true), `Logo "${file.name}" added to the company library.`).finally(() => {
      if (fileInput.current) fileInput.current.value = '';
    });
  };

  const setDefault = (p: Preset) =>
    run(() => api.put(`/admin/settings/presets/${p.id}`, { name: p.name, style: p.style, logoId: p.logoId, isDefault: !p.isDefault }), p.isDefault ? `"${p.name}" is no longer the default.` : `"${p.name}" is now the default for new QR codes.`);

  return (
    <Stack spacing={4}>
      {notice && (
        <Alert severity={notice.severity} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      <Stack spacing={2}>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Company logos
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Available to everyone in the QR designer. Square logos with a transparent or plain background work best.
            </Typography>
          </Box>
          <Button variant="outlined" startIcon={<Upload />} onClick={() => fileInput.current?.click()}>
            Add logo
          </Button>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden onChange={(e) => onUpload(e.target.files?.[0])} />
        </Stack>
        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 2 }}>
          {logos.map((l) => (
            <Paper key={l.id} variant="outlined" sx={{ p: 1, width: 140, textAlign: 'center' }}>
              <Box sx={{ height: 96, display: 'grid', placeItems: 'center', backgroundImage: 'repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%)', backgroundSize: '16px 16px' }}>
                <img src={logoUrl(l.id)} alt={l.name} style={{ maxWidth: 88, maxHeight: 88 }} />
              </Box>
              <Stack direction="row" sx={{ alignItems: 'center', mt: 0.5 }}>
                <Typography variant="body2" noWrap title={l.name} sx={{ flexGrow: 1, textAlign: 'left' }}>
                  {l.name}
                </Typography>
                <Tooltip title="Delete">
                  <IconButton size="small" onClick={() => run(() => api.delete(`/qr/logos/${l.id}`), `Logo "${l.name}" deleted.`)}>
                    <Delete fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            </Paper>
          ))}
          {!logos.length && <Typography color="text.secondary">No company logos yet.</Typography>}
        </Stack>
      </Stack>

      <Stack spacing={2}>
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            Brand presets
          </Typography>
          <Typography variant="body2" color="text.secondary">
            To create or change a preset, design a code in the{' '}
            <RouterLink to="/qr/new">QR designer</RouterLink> and use &quot;Save design as brand preset&quot;. The default preset is applied to every new QR code.
          </Typography>
        </Box>
        <Paper variant="outlined">
          <Table size="small">
            <TableBody>
              {presets.map((p) => (
                <TableRow key={p.id}>
                  <TableCell sx={{ width: 40 }}>
                    <Box sx={{ width: 24, height: 24, borderRadius: 0.5, border: 1, borderColor: 'divider', background: p.style.gradient ? `linear-gradient(135deg, ${p.style.foreground}, ${p.style.gradient.color})` : p.style.foreground }} />
                  </TableCell>
                  <TableCell>
                    {p.name} {p.isDefault && <Chip size="small" color="primary" label="Default" sx={{ ml: 1 }} />}
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>
                    {p.style.moduleShape} pattern · {p.style.eyeFrameShape} corners{p.logoId ? ' · with logo' : ''}
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title={p.isDefault ? 'Remove as default' : 'Make default'}>
                      <IconButton size="small" onClick={() => setDefault(p)}>
                        {p.isDefault ? <Star fontSize="small" color="primary" /> : <StarBorder fontSize="small" />}
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <IconButton size="small" onClick={() => run(() => api.delete(`/admin/settings/presets/${p.id}`), `Preset "${p.name}" deleted.`)}>
                        <Delete fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
              {!presets.length && (
                <TableRow>
                  <TableCell colSpan={4} sx={{ color: 'text.secondary', py: 3, textAlign: 'center' }}>
                    No presets yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Paper>
      </Stack>
    </Stack>
  );
}
