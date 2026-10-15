import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardActions,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Pagination,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import Add from '@mui/icons-material/Add';
import Download from '@mui/icons-material/Download';
import Print from '@mui/icons-material/Print';
import Delete from '@mui/icons-material/Delete';
import QrCode2 from '@mui/icons-material/QrCode2';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { qrImageUrl, type QrCode } from '../qr';
import { ExportDialog, PrintDialog } from '../components/ExportDialog';

const PAGE_SIZE = 24;

export function QrListPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<QrCode[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [all, setAll] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<{ kind: 'export' | 'print' | 'delete'; qr: QrCode } | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
    if (search.trim()) params.set('q', search.trim());
    if (all) params.set('all', '1');
    try {
      const res = await api.get<{ items: QrCode[]; total: number }>(`/qr?${params}`);
      setItems(res.items);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [page, search, all]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const remove = async (qr: QrCode) => {
    setAction(null);
    try {
      await api.delete(`/qr/${qr.id}`);
      void load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const filtering = !!search.trim();

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' } }}>
        <Typography variant="h5">{all ? 'All QR codes' : 'My QR codes'}</Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          {user?.role === 'admin' && (
            <FormControlLabel
              control={
                <Switch
                  checked={all}
                  onChange={(e) => {
                    setAll(e.target.checked);
                    setPage(1);
                  }}
                />
              }
              label="All users"
            />
          )}
          <TextField
            size="small"
            placeholder="Search title or content"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          <Button variant="contained" startIcon={<Add />} component={RouterLink} to="/qr/new">
            New QR code
          </Button>
        </Stack>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}

      {loaded && !items.length && (
        <Paper sx={{ p: 6, textAlign: 'center' }}>
          <QrCode2 sx={{ fontSize: 64, color: 'text.disabled' }} />
          <Typography sx={{ mt: 1 }}>{filtering ? 'No QR codes match your search.' : 'You have not created any QR codes yet.'}</Typography>
          {!filtering && (
            <Button variant="contained" startIcon={<Add />} component={RouterLink} to="/qr/new" sx={{ mt: 2 }}>
              Create your first QR code
            </Button>
          )}
        </Paper>
      )}

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        {items.map((qr) => (
          <Card key={qr.id} variant="outlined">
            <CardActionArea component={RouterLink} to={`/qr/${qr.id}`}>
              <Box sx={{ p: 2, pb: 0 }}>
                <img src={qrImageUrl(qr, 300)} alt={qr.title} loading="lazy" style={{ width: '100%', aspectRatio: '1', display: 'block' }} />
              </Box>
              <CardContent sx={{ pb: 1 }}>
                <Typography variant="subtitle1" noWrap title={qr.title} sx={{ fontWeight: 600 }}>
                  {qr.title}
                </Typography>
                <Typography variant="body2" color="text.secondary" noWrap title={qr.content}>
                  {qr.shortLink ? `/short/${qr.shortLink.code} → ${qr.content.replace(/^https?:\/\//, '')}` : qr.content}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {new Date(qr.createdAt).toLocaleDateString()}
                  {all ? ` · ${qr.ownerDisplayName}` : ''}
                </Typography>
              </CardContent>
            </CardActionArea>
            <CardActions sx={{ pt: 0 }}>
              <Tooltip title="Download">
                <IconButton size="small" onClick={() => setAction({ kind: 'export', qr })}>
                  <Download fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Print">
                <IconButton size="small" onClick={() => setAction({ kind: 'print', qr })}>
                  <Print fontSize="small" />
                </IconButton>
              </Tooltip>
              <Box sx={{ flexGrow: 1 }} />
              <Tooltip title="Delete">
                <IconButton size="small" onClick={() => setAction({ kind: 'delete', qr })}>
                  <Delete fontSize="small" />
                </IconButton>
              </Tooltip>
            </CardActions>
          </Card>
        ))}
      </Box>

      {total > PAGE_SIZE && (
        <Stack sx={{ alignItems: 'center' }}>
          <Pagination count={Math.ceil(total / PAGE_SIZE)} page={page} onChange={(_e, p) => setPage(p)} />
        </Stack>
      )}

      {action && action.kind !== 'delete' && (
        <>
          <ExportDialog qrId={action.qr.id} open={action.kind === 'export'} onClose={() => setAction(null)} />
          <PrintDialog qrId={action.qr.id} open={action.kind === 'print'} onClose={() => setAction(null)} />
        </>
      )}
      <Dialog open={action?.kind === 'delete'} onClose={() => setAction(null)}>
        <DialogTitle>Delete “{action?.qr.title}”?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {action?.qr.shortLink
              ? 'It disappears from your list and its short link is switched off: printed copies will show a "link not available" page.'
              : 'It disappears from your list. Copies that were already printed still show their text.'}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAction(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => action && remove(action.qr)}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
