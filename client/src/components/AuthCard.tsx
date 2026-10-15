import type { FormEvent, ReactNode } from 'react';
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import QrCode2 from '@mui/icons-material/QrCode2';

interface Props {
  title: string;
  subtitle?: ReactNode;
  error?: string | null;
  submitLabel: string;
  busy?: boolean;
  onSubmit(): void;
  children: ReactNode;
  width?: number;
}

/** Centered card used by the setup, sign-in and forced password-change screens. */
export function AuthCard({ title, subtitle, error, submitLabel, busy, onSubmit, children, width = 420 }: Props) {
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', bgcolor: 'grey.100', p: 2 }}>
      <Paper component="form" onSubmit={handleSubmit} elevation={3} sx={{ p: 4, width: '100%', maxWidth: width }}>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color: 'primary.main' }}>
            <QrCode2 fontSize="large" />
            <Typography variant="h5" component="h1">
              {title}
            </Typography>
          </Stack>
          {subtitle && (
            <Typography variant="body2" color="text.secondary">
              {subtitle}
            </Typography>
          )}
          {error && <Alert severity="error">{error}</Alert>}
          {children}
          <Button type="submit" variant="contained" size="large" disabled={busy}>
            {submitLabel}
          </Button>
        </Stack>
      </Paper>
    </Box>
  );
}
