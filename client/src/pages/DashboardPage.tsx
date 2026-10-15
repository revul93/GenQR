import { useEffect, useState } from 'react';
import { Alert, Button, CircularProgress, FormControlLabel, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import Download from '@mui/icons-material/Download';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { RANGES, StatsView, type Stats } from '../components/StatsView';

const tz = () => new Date().getTimezoneOffset();

export function DashboardPage() {
  const { user } = useAuth();
  const [days, setDays] = useState(30);
  const [all, setAll] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = `days=${days}&tz=${tz()}${all ? '&all=1' : ''}`;

  useEffect(() => {
    setStats(null);
    api
      .get<Stats>(`/stats?${query}`)
      .then((s) => {
        setStats(s);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)));
  }, [query]);

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' } }}>
        <Typography variant="h5">{all ? 'Dashboard — all users' : 'Dashboard'}</Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {user?.role === 'admin' && <FormControlLabel control={<Switch checked={all} onChange={(e) => setAll(e.target.checked)} />} label="All users" />}
          <TextField select size="small" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {RANGES.map((r) => (
              <MenuItem key={r.days} value={r.days}>
                {r.label}
              </MenuItem>
            ))}
          </TextField>
          <Button startIcon={<Download />} href={`/api/stats/clicks.csv?${query}`}>
            CSV
          </Button>
        </Stack>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      {stats ? <StatsView stats={stats} showLinks showCreators={all} /> : !error && <CircularProgress sx={{ alignSelf: 'center', my: 6 }} />}
    </Stack>
  );
}
