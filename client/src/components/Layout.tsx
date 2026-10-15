import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { AppBar, Box, Button, Container, Divider, IconButton, ListItemIcon, Menu, MenuItem, Toolbar, Typography } from '@mui/material';
import AccountCircle from '@mui/icons-material/AccountCircle';
import Logout from '@mui/icons-material/Logout';
import Password from '@mui/icons-material/Password';
import QrCode2 from '@mui/icons-material/QrCode2';
import { useAuth } from '../auth';

const navButtonSx = { color: 'inherit', '&.active': { bgcolor: 'rgba(255,255,255,0.15)' } };

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'grey.50' }}>
      <AppBar position="sticky" elevation={1}>
        <Toolbar sx={{ gap: 1 }}>
          <QrCode2 />
          <Typography variant="h6" sx={{ mr: 2 }}>
            GenQR
          </Typography>
          <Button component={NavLink} to="/" end sx={navButtonSx}>
            QR codes
          </Button>
          {user?.role === 'admin' && (
            <>
              <Button component={NavLink} to="/admin/users" sx={navButtonSx}>
                Users
              </Button>
              <Button component={NavLink} to="/admin/settings" sx={navButtonSx}>
                Settings
              </Button>
              <Button component={NavLink} to="/admin/audit" sx={navButtonSx}>
                Audit log
              </Button>
              <Button component={NavLink} to="/admin/system" sx={navButtonSx}>
                System
              </Button>
            </>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Typography variant="body2" sx={{ display: { xs: 'none', sm: 'block' } }}>
            {user?.displayName}
          </Typography>
          <IconButton color="inherit" onClick={(e) => setMenuAnchor(e.currentTarget)} aria-label="Account menu">
            <AccountCircle />
          </IconButton>
          <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
            <MenuItem disabled>
              {user?.username} · {user?.role}
            </MenuItem>
            <Divider />
            {user?.source === 'local' && (
              <MenuItem
                onClick={() => {
                  setMenuAnchor(null);
                  navigate('/account/password');
                }}
              >
                <ListItemIcon>
                  <Password fontSize="small" />
                </ListItemIcon>
                Change password
              </MenuItem>
            )}
            <MenuItem onClick={() => logout()}>
              <ListItemIcon>
                <Logout fontSize="small" />
              </ListItemIcon>
              Sign out
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ py: 3 }}>
        <Outlet />
      </Container>
    </Box>
  );
}
