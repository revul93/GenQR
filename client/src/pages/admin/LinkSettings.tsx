import { useEffect, useState } from 'react';
import { Alert, Box, Button, Divider, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { api, errorMessage } from '../../api';

interface LinkSettingsData {
  publicBaseUrl: string;
  policy: { mode: 'off' | 'allowlist' | 'blocklist'; domains: string[] };
}

export function LinkSettings() {
  const [saved, setSaved] = useState<LinkSettingsData | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [mode, setMode] = useState<LinkSettingsData['policy']['mode']>('off');
  const [domains, setDomains] = useState('');
  const [notice, setNotice] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);

  const apply = (d: LinkSettingsData) => {
    setSaved(d);
    setBaseUrl(d.publicBaseUrl);
    setMode(d.policy.mode);
    setDomains(d.policy.domains.join('\n'));
  };

  useEffect(() => {
    api.get<LinkSettingsData>('/admin/settings/links').then(apply).catch((err) => setNotice({ severity: 'error', text: errorMessage(err) }));
  }, []);

  if (!saved) return notice ? <Alert severity="error">{notice.text}</Alert> : null;

  const save = async () => {
    setNotice(null);
    try {
      const body = {
        publicBaseUrl: baseUrl.trim(),
        policy: { mode, domains: domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean) },
      };
      apply(await api.put<LinkSettingsData>('/admin/settings/links', body));
      setNotice({ severity: 'success', text: 'Short-link settings saved.' });
    } catch (err) {
      setNotice({ severity: 'error', text: errorMessage(err) });
    }
  };

  const baseChanged = baseUrl.trim().replace(/\/+$/, '') !== saved.publicBaseUrl;

  return (
    <Stack spacing={3}>
      {notice && (
        <Alert severity={notice.severity} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}
      <Stack spacing={2}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Public address
        </Typography>
        <TextField
          label="Public address of GenQR"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          helperText={`Short links look like ${baseUrl.replace(/\/+$/, '') || 'https://genqr.example.com'}/short/a7Kp3xQ`}
        />
        {baseChanged && (
          <Alert severity="warning">
            Only new QR codes use the new address. Codes created earlier — including printed ones — keep the old address, so keep that hostname pointing at
            this server too.
          </Alert>
        )}
      </Stack>
      <Divider />
      <Stack spacing={2}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Allowed destinations
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Stops short links being used to send people to unwanted sites. Rules apply to subdomains too (jeddah-cables.com also covers shop.jeddah-cables.com) and
          are checked whenever a destination is set or changed.
        </Typography>
        <TextField select label="Rule" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} sx={{ maxWidth: 360 }}>
          <MenuItem value="off">Any website</MenuItem>
          <MenuItem value="allowlist">Only the domains listed below</MenuItem>
          <MenuItem value="blocklist">Any website except the domains below</MenuItem>
        </TextField>
        {mode !== 'off' && (
          <TextField label="Domains, one per line" value={domains} onChange={(e) => setDomains(e.target.value)} multiline minRows={4} placeholder={'jeddah-cables.com\nenergya.com'} />
        )}
      </Stack>
      <Box>
        <Button variant="contained" onClick={save}>
          Save settings
        </Button>
      </Box>
    </Stack>
  );
}
