import { useEffect, useState } from 'react';
import { Alert, Box, Button, FormControlLabel, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import { api, errorMessage } from '../../api';

interface AnalyticsData {
  config: { retentionDays: number; geoip: boolean };
  geoip: { installed: boolean; path: string; updatedAt: number | null };
  archived?: number;
}

const RETENTION = [
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 395, label: '13 months (default)' },
  { days: 730, label: '2 years' },
  { days: 0, label: 'Keep forever' },
];

export function AnalyticsSettings() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [retentionDays, setRetentionDays] = useState(395);
  const [geoip, setGeoip] = useState(true);
  const [notice, setNotice] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);

  const apply = (d: AnalyticsData) => {
    setData(d);
    setRetentionDays(d.config.retentionDays);
    setGeoip(d.config.geoip);
  };
  useEffect(() => {
    api.get<AnalyticsData>('/admin/settings/analytics').then(apply).catch((err) => setNotice({ severity: 'error', text: errorMessage(err) }));
  }, []);
  if (!data) return notice ? <Alert severity="error">{notice.text}</Alert> : null;

  const save = async () => {
    setNotice(null);
    try {
      const d = await api.put<AnalyticsData>('/admin/settings/analytics', { retentionDays, geoip });
      apply(d);
      setNotice({ severity: 'success', text: `Saved.${d.archived ? ` ${d.archived} older clicks were archived into daily totals.` : ''}` });
    } catch (err) {
      setNotice({ severity: 'error', text: errorMessage(err) });
    }
  };

  return (
    <Stack spacing={3}>
      {notice && (
        <Alert severity={notice.severity} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}
      <Stack spacing={1.5}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          What is recorded
        </Typography>
        <Typography variant="body2" color="text.secondary">
          For every visit to a short link: the time, whether it came from a QR scan or the plain link, the referring website, the browser, operating system and device
          type, and (with a GeoIP database) the country. IP addresses are never stored — unique visitors are counted with a keyed one-way hash. Bots and link-preview
          services are recognised and left out of the statistics.
        </Typography>
      </Stack>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Retention
        </Typography>
        <TextField select label="Keep detailed clicks for" value={retentionDays} onChange={(e) => setRetentionDays(Number(e.target.value))} sx={{ maxWidth: 320 }}>
          {RETENTION.map((r) => (
            <MenuItem key={r.days} value={r.days}>
              {r.label}
            </MenuItem>
          ))}
        </TextField>
        <Typography variant="body2" color="text.secondary">
          Older clicks are reduced to daily totals per link (clicks, visitors, QR vs link). Totals and charts keep working; breakdowns by device, browser or country only
          cover the retention period.
        </Typography>
      </Stack>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Countries (GeoIP)
        </Typography>
        <FormControlLabel control={<Switch checked={geoip} onChange={(e) => setGeoip(e.target.checked)} />} label="Record the visitor's country" />
        {data.geoip.installed ? (
          <Alert severity="success">GeoIP database installed{data.geoip.updatedAt ? ` (updated ${new Date(data.geoip.updatedAt).toLocaleDateString()})` : ''}.</Alert>
        ) : (
          <Alert severity="info">
            No GeoIP database yet, so countries are not recorded. Download the free <b>GeoLite2 Country</b> database (.mmdb) from MaxMind (free account required) and
            copy it to <code>{data.geoip.path}</code>. It is picked up automatically, no restart needed. Lookups happen on this server; nothing is sent to MaxMind.
          </Alert>
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
