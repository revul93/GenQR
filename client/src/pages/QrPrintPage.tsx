import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Box, Typography } from '@mui/material';

/** Bare page sized in centimetres that opens the browser's print dialog. */
export function QrPrintPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const cm = Math.min(30, Math.max(1, Number(params.get('cm')) || 5));
  const caption = params.get('caption');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (loaded) setTimeout(() => window.print(), 200);
  }, [loaded]);

  return (
    <Box sx={{ p: '1cm', bgcolor: 'white', minHeight: '100vh', '@media print': { p: 0 } }}>
      <style>{'@page { margin: 1cm; } body { background: white !important; }'}</style>
      <Box sx={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: '0.2cm' }}>
        <img src={`/api/qr/${id}/image.svg?size=1024`} alt="QR code" style={{ width: `${cm}cm`, height: `${cm}cm` }} onLoad={() => setLoaded(true)} />
        {caption && (
          <Typography sx={{ maxWidth: `${Math.max(cm, 4)}cm`, textAlign: 'center', fontSize: cm < 4 ? 10 : 14 }}>{caption}</Typography>
        )}
      </Box>
    </Box>
  );
}
