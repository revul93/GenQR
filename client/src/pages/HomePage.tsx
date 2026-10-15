import { Paper, Stack, Typography } from '@mui/material';
import QrCode2 from '@mui/icons-material/QrCode2';
import { useAuth } from '../auth';

export function HomePage() {
  const { user } = useAuth();
  return (
    <Paper sx={{ p: 4 }}>
      <Stack spacing={2} sx={{ alignItems: 'center', textAlign: 'center' }}>
        <QrCode2 sx={{ fontSize: 72, color: 'primary.main' }} />
        <Typography variant="h5">Welcome, {user?.displayName}</Typography>
        <Typography color="text.secondary">The QR code designer arrives in Phase 3 of the plan.</Typography>
      </Stack>
    </Paper>
  );
}
