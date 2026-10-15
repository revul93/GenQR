import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Divider,
  FormControlLabel,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Paper,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import CheckCircle from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import { api, errorMessage } from '../../api';

interface AdConfig {
  enabled: boolean;
  urls: string[];
  startTls: boolean;
  rejectUnauthorized: boolean;
  caCert: string;
  bindDn: string;
  baseDn: string;
  userFilter: string;
  searchFilter: string;
  usernameAttribute: string;
  displayNameAttribute: string;
  emailAttribute: string;
  timeoutSeconds: number;
  hasBindPassword?: boolean;
}

interface TestResult {
  ok: boolean;
  steps: { name: string; ok: boolean; detail: string }[];
}

function ActiveDirectorySettings() {
  const [cfg, setCfg] = useState<AdConfig | null>(null);
  const [urlsText, setUrlsText] = useState('');
  const [bindPassword, setBindPassword] = useState('');
  const [testUsername, setTestUsername] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [notice, setNotice] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = (c: AdConfig) => {
    setCfg(c);
    setUrlsText(c.urls.join('\n'));
  };

  useEffect(() => {
    api
      .get<{ config: AdConfig }>('/admin/settings/ad')
      .then(({ config }) => apply(config))
      .catch((err) => setNotice({ severity: 'error', text: errorMessage(err) }));
  }, []);

  if (!cfg) return notice ? <Alert severity="error">{notice.text}</Alert> : null;

  const set = <K extends keyof AdConfig>(key: K, value: AdConfig[K]) => setCfg({ ...cfg, [key]: value });
  const payload = () => {
    const { hasBindPassword: _h, ...rest } = cfg;
    return {
      ...rest,
      urls: urlsText.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean),
      bindPassword: bindPassword || undefined,
    };
  };

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    setNotice(null);
    try {
      setTest(await api.post<TestResult>('/admin/settings/ad/test', { ...payload(), testUsername: testUsername || undefined }));
    } catch (err) {
      setNotice({ severity: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const { config } = await api.put<{ config: AdConfig }>('/admin/settings/ad', payload());
      apply(config);
      setBindPassword('');
      setNotice({ severity: 'success', text: 'Active Directory settings saved.' });
    } catch (err) {
      setNotice({ severity: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof AdConfig, label: string, helperText?: string, extra: Record<string, unknown> = {}) => (
    <TextField label={label} helperText={helperText} value={cfg[key] as string} onChange={(e) => set(key, e.target.value as never)} fullWidth {...extra} />
  );

  return (
    <Stack spacing={3}>
      {notice && (
        <Alert severity={notice.severity} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}
      <FormControlLabel
        control={<Switch checked={cfg.enabled} onChange={(e) => set('enabled', e.target.checked)} />}
        label={cfg.enabled ? 'Active Directory sign-in is enabled' : 'Active Directory sign-in is disabled'}
      />

      <Section title="Connection">
        <TextField
          label="Domain controller URLs"
          helperText="One per line, tried in order. ldaps://dc1.company.local:636 (recommended) or ldap://dc1.company.local:389"
          value={urlsText}
          onChange={(e) => setUrlsText(e.target.value)}
          multiline
          minRows={2}
          fullWidth
        />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <FormControlLabel control={<Switch checked={cfg.startTls} onChange={(e) => set('startTls', e.target.checked)} />} label="Use StartTLS on ldap:// URLs" />
          <FormControlLabel control={<Switch checked={cfg.rejectUnauthorized} onChange={(e) => set('rejectUnauthorized', e.target.checked)} />} label="Verify server certificate" />
        </Stack>
        {!cfg.rejectUnauthorized && <Alert severity="warning">Certificate verification is off. Upload your CA certificate instead whenever possible.</Alert>}
        {field('caCert', 'CA certificate (PEM, optional)', 'Paste your internal root CA if the domain controller certificate is not publicly trusted.', {
          multiline: true,
          minRows: 3,
          slotProps: { htmlInput: { style: { fontFamily: 'monospace', fontSize: 12 } } },
        })}
        <TextField label="Timeout (seconds)" type="number" value={cfg.timeoutSeconds} onChange={(e) => set('timeoutSeconds', Number(e.target.value))} sx={{ maxWidth: 200 }} />
      </Section>

      <Section title="Service account">
        {field('bindDn', 'Bind DN', 'A read-only account used to look users up, e.g. CN=svc-genqr,OU=Service Accounts,DC=company,DC=local')}
        <TextField
          label="Bind password"
          type="password"
          value={bindPassword}
          onChange={(e) => setBindPassword(e.target.value)}
          helperText={cfg.hasBindPassword ? 'A password is saved. Leave empty to keep it.' : 'Stored encrypted.'}
          fullWidth
          slotProps={{ htmlInput: { autoComplete: 'new-password' } }}
        />
      </Section>

      <Section title="Users">
        {field('baseDn', 'Search base DN', 'e.g. DC=company,DC=local or OU=Staff,DC=company,DC=local')}
        {field('userFilter', 'Sign-in filter', '{{username}} is replaced with the login name.', { slotProps: { htmlInput: { style: { fontFamily: 'monospace', fontSize: 13 } } } })}
        {field('searchFilter', 'Import search filter', '{{query}} is replaced with the search text.', { slotProps: { htmlInput: { style: { fontFamily: 'monospace', fontSize: 13 } } } })}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          {field('usernameAttribute', 'Username attribute')}
          {field('displayNameAttribute', 'Display name attribute')}
          {field('emailAttribute', 'Email attribute')}
        </Stack>
      </Section>

      <Section title="Test">
        <Typography variant="body2" color="text.secondary">
          Tests the values on this page (saved or not): connects, binds as the service account and optionally looks up a user.
        </Typography>
        <Stack direction="row" spacing={1}>
          <TextField size="small" label="Username to look up (optional)" value={testUsername} onChange={(e) => setTestUsername(e.target.value)} />
          <Button variant="outlined" onClick={runTest} disabled={busy}>
            Test connection
          </Button>
        </Stack>
        {test && (
          <List dense>
            {test.steps.map((s) => (
              <ListItem key={s.name}>
                <ListItemIcon>{s.ok ? <CheckCircle color="success" /> : <ErrorIcon color="error" />}</ListItemIcon>
                <ListItemText primary={s.name} secondary={s.detail} />
              </ListItem>
            ))}
          </List>
        )}
      </Section>

      <Divider />
      <Box>
        <Button variant="contained" onClick={save} disabled={busy}>
          Save settings
        </Button>
      </Box>
    </Stack>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Stack spacing={2}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      {children}
    </Stack>
  );
}

export function SettingsPage() {
  const [tab, setTab] = useState('ad');
  return (
    <Stack spacing={2}>
      <Typography variant="h5">Settings</Typography>
      <Paper>
        <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ borderBottom: 1, borderColor: 'divider', px: 2 }}>
          <Tab value="ad" label="Active Directory" />
        </Tabs>
        <Box sx={{ p: 3, maxWidth: 900 }}>{tab === 'ad' && <ActiveDirectorySettings />}</Box>
      </Paper>
    </Stack>
  );
}
