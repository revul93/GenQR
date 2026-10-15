import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import {
  Alert,
  Chip,
  FormControlLabel,
  Link,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { linkState, type ShortLink } from '../qr';
import { CopyButton, LinkDialog, STATE_CHIP } from '../components/LinkDialog';

export function LinksPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<ShortLink[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [search, setSearch] = useState('');
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: String(rowsPerPage), offset: String(page * rowsPerPage) });
    if (search.trim()) params.set('q', search.trim());
    if (all) params.set('all', '1');
    try {
      const res = await api.get<{ items: ShortLink[]; total: number }>(`/links?${params}`);
      setItems(res.items);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [page, rowsPerPage, search, all]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' } }}>
        <Typography variant="h5">Short links</Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {user?.role === 'admin' && <FormControlLabel control={<Switch checked={all} onChange={(e) => (setAll(e.target.checked), setPage(0))} />} label="All users" />}
          <TextField size="small" placeholder="Search code, destination or title" value={search} onChange={(e) => (setSearch(e.target.value), setPage(0))} sx={{ minWidth: 280 }} />
        </Stack>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Every QR code for a website gets a short link. Change a link&apos;s destination here and printed codes follow it.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <Paper>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Short link</TableCell>
                <TableCell>Destination</TableCell>
                <TableCell>QR code</TableCell>
                {all && <TableCell>Owner</TableCell>}
                <TableCell>Status</TableCell>
                <TableCell>Updated</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((l) => {
                const state = linkState(l);
                return (
                  <TableRow key={l.id} hover onClick={() => setOpen(l.id)} sx={{ cursor: 'pointer' }}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                      <Link href={l.url} target="_blank" rel="noopener" underline="hover" sx={{ fontFamily: 'monospace' }}>
                        /short/{l.code}
                      </Link>
                      <CopyButton text={l.url} />
                    </TableCell>
                    <TableCell sx={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.targetUrl}>
                      {l.targetUrl}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {l.qrCodeId ? (
                        <Link component={RouterLink} to={`/qr/${l.qrCodeId}`} underline="hover">
                          {l.qrTitle}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    {all && <TableCell>{l.ownerUsername}</TableCell>}
                    <TableCell>
                      <Chip size="small" label={STATE_CHIP[state].label} color={STATE_CHIP[state].color} />
                      {state === 'active' && l.expiresAt && (
                        <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                          until {new Date(l.expiresAt).toLocaleDateString()}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(l.updatedAt).toLocaleString()}</TableCell>
                  </TableRow>
                );
              })}
              {!items.length && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    No short links yet. Create a QR code for a website to get one.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          component="div"
          count={total}
          page={page}
          onPageChange={(_e, p) => setPage(p)}
          rowsPerPage={rowsPerPage}
          rowsPerPageOptions={[25, 50, 100, 200]}
          onRowsPerPageChange={(e) => (setRowsPerPage(Number(e.target.value)), setPage(0))}
        />
      </Paper>
      <LinkDialog linkId={open} onClose={() => setOpen(null)} onChanged={() => void load()} />
    </Stack>
  );
}
