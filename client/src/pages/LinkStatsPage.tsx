import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router';
import { Alert, Box, Button, Chip, CircularProgress, Link, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import Download from '@mui/icons-material/Download';
import { api, errorMessage } from '../api';
import { linkState, type ShortLink } from '../qr';
import { CopyButton, LinkDialog, STATE_CHIP } from '../components/LinkDialog';
import { RANGES, StatsView, type Stats } from '../components/StatsView';

export function LinkStatsPage() {
  const { id } = useParams();
  const linkId = Number(id);
  const [link, setLink] = useState<ShortLink | null>(null);
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
  const query = `days=${days}&tz=${new Date().getTimezoneOffset()}`;

  const loadLink = useCallback(() => {
    api
      .get<{ link: ShortLink }>(`/links/${linkId}`)
      .then((r) => setLink(r.link))
      .catch((err) => setError(errorMessage(err)));
  }, [linkId]);

  useEffect(loadLink, [loadLink]);
  useEffect(() => {
    setStats(null);
    api
      .get<Stats>(`/links/${linkId}/stats?${query}`)
      .then(setStats)
      .catch((err) => setError(errorMessage(err)));
  }, [linkId, query]);

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!link) return <CircularProgress />;
  const state = linkState(link);

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2.5 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ justifyContent: 'space-between' }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h5">{link.qrTitle ?? `Short link /short/${link.code}`}</Typography>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.5 }}>
              <Typography sx={{ fontFamily: 'monospace' }}>{link.url}</Typography>
              <CopyButton text={link.url} />
              <Chip size="small" label={STATE_CHIP[state].label} color={STATE_CHIP[state].color} />
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
              → {link.targetUrl}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', flexShrink: 0 }}>
            {link.qrCodeId && (
              <Button component={RouterLink} to={`/qr/${link.qrCodeId}`}>
                Open QR code
              </Button>
            )}
            <Button variant="outlined" onClick={() => setManage(true)}>
              Manage link
            </Button>
          </Stack>
        </Stack>
      </Paper>

      <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
        <TextField select size="small" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {RANGES.map((r) => (
            <MenuItem key={r.days} value={r.days}>
              {r.label}
            </MenuItem>
          ))}
        </TextField>
        <Button startIcon={<Download />} href={`/api/links/${linkId}/clicks.csv?${query}`}>
          CSV
        </Button>
      </Stack>
      {stats ? <StatsView stats={stats} /> : <CircularProgress sx={{ alignSelf: 'center', my: 6 }} />}
      <Typography variant="caption" color="text.secondary">
        <Link component={RouterLink} to="/links">
          ← All short links
        </Link>
      </Typography>
      <LinkDialog linkId={manage ? link.id : null} onClose={() => setManage(false)} onChanged={() => loadLink()} />
    </Stack>
  );
}
