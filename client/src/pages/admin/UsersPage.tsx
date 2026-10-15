import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  IconButton,
  InputAdornment,
  ListItemIcon,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import PersonAdd from '@mui/icons-material/PersonAdd';
import GroupAdd from '@mui/icons-material/GroupAdd';
import MoreVert from '@mui/icons-material/MoreVert';
import Search from '@mui/icons-material/Search';
import Edit from '@mui/icons-material/Edit';
import Key from '@mui/icons-material/Key';
import LockOpen from '@mui/icons-material/LockOpen';
import Delete from '@mui/icons-material/Delete';
import { api, errorMessage, type User } from '../../api';
import { useAuth } from '../../auth';

type Role = User['role'];
interface ListUser extends User {
  locked: boolean;
}
interface AdUser {
  dn: string;
  username: string;
  displayName: string;
  email: string | null;
  disabled: boolean;
  imported: boolean;
}

const PASSWORD_HINT = 'At least 10 characters, with letters and digits.';

function RoleSelect({ value, onChange, label = 'Role' }: { value: Role; onChange(r: Role): void; label?: string }) {
  return (
    <TextField select label={label} value={value} onChange={(e) => onChange(e.target.value as Role)} fullWidth>
      <MenuItem value="user">User — creates and manages own QR codes</MenuItem>
      <MenuItem value="admin">Administrator — full access</MenuItem>
    </TextField>
  );
}

function AddLocalDialog({ open, onClose, onDone }: { open: boolean; onClose(): void; onDone(msg: string): void }) {
  const empty = { username: '', displayName: '', email: '', role: 'user' as Role, password: '', mustChangePassword: true };
  const [form, setForm] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setForm(empty);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.post<{ user: User }>('/admin/users/local', form);
      onDone(`Local user "${user.username}" created.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Add local user</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Local users sign in with a password stored in GenQR. To give access to company staff, prefer importing them from Active Directory.
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField label="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required autoFocus />
          <TextField label="Display name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required />
          <TextField label="Email (optional)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <RoleSelect value={form.role} onChange={(role) => setForm({ ...form, role })} />
          <TextField label="Initial password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} helperText={PASSWORD_HINT} required slotProps={{ htmlInput: { autoComplete: 'new-password' } }} />
          <FormControlLabel control={<Checkbox checked={form.mustChangePassword} onChange={(e) => setForm({ ...form, mustChangePassword: e.target.checked })} />} label="Require a password change at first sign-in" />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={busy}>
          Create user
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ImportDialog({ open, onClose, onDone }: { open: boolean; onClose(): void; onDone(msg: string): void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AdUser[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [role, setRole] = useState<Role>('user');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults(null);
      setSelected(new Set());
      setRole('user');
      setError(null);
    }
  }, [open]);

  const search = async () => {
    setBusy(true);
    setError(null);
    try {
      setResults((await api.get<{ users: AdUser[] }>(`/admin/users/ad-search?q=${encodeURIComponent(query)}`)).users);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (username: string) => {
    const next = new Set(selected);
    if (next.has(username)) next.delete(username);
    else next.add(username);
    setSelected(next);
  };

  const importSelected = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ imported: string[]; skipped: { username: string; reason: string }[] }>('/admin/users/import', {
        users: [...selected].map((username) => ({ username, role })),
      });
      const skipped = res.skipped.map((s) => `${s.username}: ${s.reason}`).join(' ');
      onDone(`Imported ${res.imported.length} user(s).${skipped ? ` Skipped — ${skipped}` : ''}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Import users from Active Directory</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <Stack
            direction="row"
            spacing={1}
            component="form"
            onSubmit={(e: React.FormEvent) => {
              e.preventDefault();
              void search();
            }}
          >
            <TextField
              label="Search by name, username or email"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              fullWidth
              autoFocus
              slotProps={{ input: { startAdornment: <InputAdornment position="start"><Search /></InputAdornment> } }}
            />
            <Button type="submit" variant="outlined" disabled={busy || query.trim().length < 2}>
              Search
            </Button>
          </Stack>
          {results && (
            <TableContainer sx={{ maxHeight: 360 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" />
                    <TableCell>Username</TableCell>
                    <TableCell>Name</TableCell>
                    <TableCell>Email</TableCell>
                    <TableCell>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {results.map((u) => {
                    const blocked = u.imported || u.disabled;
                    return (
                      <TableRow key={u.dn} hover={!blocked} onClick={() => !blocked && toggle(u.username)} sx={{ cursor: blocked ? 'default' : 'pointer' }}>
                        <TableCell padding="checkbox">
                          <Checkbox checked={selected.has(u.username)} disabled={blocked} />
                        </TableCell>
                        <TableCell>{u.username}</TableCell>
                        <TableCell>{u.displayName}</TableCell>
                        <TableCell>{u.email}</TableCell>
                        <TableCell>
                          {u.imported && <Chip size="small" label="Already in GenQR" />}
                          {u.disabled && <Chip size="small" color="warning" label="Disabled in AD" />}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!results.length && (
                    <TableRow>
                      <TableCell colSpan={5} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                        No matching users.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          <RoleSelect label="Role for imported users" value={role} onChange={setRole} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={importSelected} disabled={busy || !selected.size}>
          Import {selected.size || ''} user{selected.size === 1 ? '' : 's'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function EditDialog({ user, onClose, onDone }: { user: ListUser | null; onClose(): void; onDone(msg: string): void }) {
  const [form, setForm] = useState({ displayName: '', email: '', role: 'user' as Role, isActive: true });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (user) {
      setForm({ displayName: user.displayName, email: user.email ?? '', role: user.role, isActive: user.isActive });
      setError(null);
    }
  }, [user]);
  if (!user) return null;
  const local = user.source === 'local';

  const submit = async () => {
    setError(null);
    const patch: Record<string, unknown> = {};
    if (form.role !== user.role) patch.role = form.role;
    if (form.isActive !== user.isActive) patch.isActive = form.isActive;
    if (local && form.displayName !== user.displayName) patch.displayName = form.displayName;
    if (local && form.email !== (user.email ?? '')) patch.email = form.email;
    if (!Object.keys(patch).length) return onClose();
    try {
      await api.patch(`/admin/users/${user.id}`, patch);
      onDone(`Saved changes to "${user.username}".`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Edit {user.username}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          {!local && <Alert severity="info">Name and email come from Active Directory and are refreshed each time this user signs in.</Alert>}
          <TextField label="Display name" value={form.displayName} disabled={!local} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          <TextField label="Email" value={form.email} disabled={!local} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <RoleSelect value={form.role} onChange={(role) => setForm({ ...form, role })} />
          <FormControlLabel control={<Switch checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />} label={form.isActive ? 'Account enabled' : 'Account disabled — cannot sign in'} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose, onDone }: { user: ListUser | null; onClose(): void; onDone(msg: string): void }) {
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPassword('');
    setMustChange(true);
    setError(null);
  }, [user]);
  if (!user) return null;

  const submit = async () => {
    setError(null);
    try {
      await api.post(`/admin/users/${user.id}/reset-password`, { password, mustChangePassword: mustChange });
      onDone(`Password for "${user.username}" was reset. Their sessions were signed out.`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Reset password for {user.username}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField label="New password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} helperText={PASSWORD_HINT} autoFocus slotProps={{ htmlInput: { autoComplete: 'new-password' } }} />
          <FormControlLabel control={<Checkbox checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />} label="Require a change at next sign-in" />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={!password}>
          Reset password
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<ListUser[]>([]);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);
  const [dialog, setDialog] = useState<'local' | 'import' | null>(null);
  const [editing, setEditing] = useState<ListUser | null>(null);
  const [resetting, setResetting] = useState<ListUser | null>(null);
  const [deleting, setDeleting] = useState<ListUser | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; user: ListUser } | null>(null);

  const load = useCallback(async () => {
    try {
      const q = search.trim() ? `?q=${encodeURIComponent(search.trim())}` : '';
      setUsers((await api.get<{ users: ListUser[] }>(`/admin/users${q}`)).users);
    } catch (err) {
      setNotice({ severity: 'error', text: errorMessage(err) });
    }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const done = (text: string) => {
    setDialog(null);
    setEditing(null);
    setResetting(null);
    setDeleting(null);
    setNotice({ severity: 'success', text });
    void load();
  };

  const act = async (fn: () => Promise<unknown>, text: string) => {
    setMenu(null);
    try {
      await fn();
      done(text);
    } catch (err) {
      setNotice({ severity: 'error', text: errorMessage(err) });
    }
  };

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}>
        <Typography variant="h5">Users</Typography>
        <Stack direction="row" spacing={1}>
          <TextField size="small" placeholder="Search users" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Button variant="outlined" startIcon={<PersonAdd />} onClick={() => setDialog('local')}>
            Add local
          </Button>
          <Button variant="contained" startIcon={<GroupAdd />} onClick={() => setDialog('import')}>
            Import from AD
          </Button>
        </Stack>
      </Stack>
      {notice && (
        <Alert severity={notice.severity} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}
      <Paper>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Username</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Email</TableCell>
                <TableCell>Source</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Last sign-in</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id} hover>
                  <TableCell sx={{ fontWeight: 500 }}>
                    {u.username}
                    {u.id === me?.id && <Chip size="small" label="you" sx={{ ml: 1 }} />}
                  </TableCell>
                  <TableCell>{u.displayName}</TableCell>
                  <TableCell>{u.email}</TableCell>
                  <TableCell>
                    <Chip size="small" variant="outlined" label={u.source === 'ad' ? 'Active Directory' : 'Local'} />
                  </TableCell>
                  <TableCell>
                    <Chip size="small" color={u.role === 'admin' ? 'primary' : 'default'} label={u.role === 'admin' ? 'Admin' : 'User'} />
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5}>
                      {!u.isActive && <Chip size="small" color="error" label="Disabled" />}
                      {u.locked && <Chip size="small" color="warning" label="Locked" />}
                      {u.mustChangePassword && <Chip size="small" label="Must change password" />}
                      {u.isActive && !u.locked && !u.mustChangePassword && <Chip size="small" color="success" variant="outlined" label="Active" />}
                    </Stack>
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never'}</TableCell>
                  <TableCell align="right">
                    <Tooltip title="Actions">
                      <IconButton size="small" onClick={(e) => setMenu({ anchor: e.currentTarget, user: u })}>
                        <MoreVert fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
              {!users.length && (
                <TableRow>
                  <TableCell colSpan={8} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    No users found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Menu anchorEl={menu?.anchor} open={!!menu} onClose={() => setMenu(null)}>
        <MenuItem
          onClick={() => {
            setEditing(menu!.user);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <Edit fontSize="small" />
          </ListItemIcon>
          Edit
        </MenuItem>
        {menu?.user.source === 'local' && (
          <MenuItem
            onClick={() => {
              setResetting(menu.user);
              setMenu(null);
            }}
          >
            <ListItemIcon>
              <Key fontSize="small" />
            </ListItemIcon>
            Reset password
          </MenuItem>
        )}
        {menu?.user.locked && (
          <MenuItem onClick={() => act(() => api.post(`/admin/users/${menu.user.id}/unlock`), `"${menu.user.username}" unlocked.`)}>
            <ListItemIcon>
              <LockOpen fontSize="small" />
            </ListItemIcon>
            Unlock
          </MenuItem>
        )}
        <MenuItem
          disabled={menu?.user.id === me?.id}
          onClick={() => {
            setDeleting(menu!.user);
            setMenu(null);
          }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon>
            <Delete fontSize="small" color="error" />
          </ListItemIcon>
          Delete
        </MenuItem>
      </Menu>

      <AddLocalDialog open={dialog === 'local'} onClose={() => setDialog(null)} onDone={done} />
      <ImportDialog open={dialog === 'import'} onClose={() => setDialog(null)} onDone={done} />
      <EditDialog user={editing} onClose={() => setEditing(null)} onDone={done} />
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} onDone={done} />
      <DeleteUserDialog
        user={deleting}
        users={users}
        onClose={() => setDeleting(null)}
        onDelete={(target, reassignTo) =>
          act(
            () => api.delete(`/admin/users/${target.id}${reassignTo ? `?reassignTo=${reassignTo}` : ''}`),
            `"${target.username}" deleted.${reassignTo ? ` Their QR codes now belong to ${users.find((u) => u.id === reassignTo)?.username}.` : ''}`,
          )
        }
      />
    </Stack>
  );
}

function DeleteUserDialog({
  user,
  users,
  onClose,
  onDelete,
}: {
  user: ListUser | null;
  users: ListUser[];
  onClose(): void;
  onDelete(user: ListUser, reassignTo: number | null): void;
}) {
  const [owned, setOwned] = useState<number | null>(null);
  const [heir, setHeir] = useState<number | ''>('');
  useEffect(() => {
    setOwned(null);
    setHeir('');
    if (user) api.get<{ count: number }>(`/admin/users/${user.id}/owned`).then((r) => setOwned(r.count)).catch(() => setOwned(0));
  }, [user]);
  if (!user) return null;
  const candidates = users.filter((u) => u.id !== user.id && u.isActive);

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Delete {user.username}?</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <DialogContentText>
            The user is removed from GenQR and signed out. {user.source === 'ad' ? 'Their Active Directory account is not affected; you can import them again later.' : ''} To keep the account but
            block sign-in, disable it instead.
          </DialogContentText>
          {!!owned && (
            <>
              <Alert severity="info">{user.username} owns QR codes or logos. They keep working and move to the user you choose.</Alert>
              <TextField select label="Transfer QR codes to" value={heir} onChange={(e) => setHeir(Number(e.target.value))}>
                {candidates.map((u) => (
                  <MenuItem key={u.id} value={u.id}>
                    {u.displayName} ({u.username})
                  </MenuItem>
                ))}
              </TextField>
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button color="error" variant="contained" disabled={owned === null || (!!owned && heir === '')} onClick={() => onDelete(user, heir === '' ? null : heir)}>
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  );
}
