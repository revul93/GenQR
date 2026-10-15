import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router';
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Paper,
  Slider,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import Download from '@mui/icons-material/Download';
import Email from '@mui/icons-material/Email';
import Print from '@mui/icons-material/Print';
import Save from '@mui/icons-material/Save';
import Upload from '@mui/icons-material/Upload';
import Block from '@mui/icons-material/Block';
import CheckCircle from '@mui/icons-material/CheckCircle';
import Warning from '@mui/icons-material/Warning';
import Bookmark from '@mui/icons-material/Bookmark';
import LinkIcon from '@mui/icons-material/Link';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { colourWarnings, DEFAULT_STYLE, fetchLogos, fetchPresets, linkState, logoUrl, svgDataUrl, uploadLogo, type ContentType, type Logo, type Preset, type QrCode, type QrShortLink, type QrStyle } from '../qr';
import { ExportDialog, PrintDialog } from '../components/ExportDialog';
import { CopyButton, LinkDialog, STATE_CHIP } from '../components/LinkDialog';
import { EmailDialog, useEmailEnabled } from '../components/EmailDialog';

interface Form {
  title: string;
  contentType: ContentType;
  content: string;
  style: QrStyle;
  logoId: number | null;
}

const EMPTY_FORM: Form = { title: '', contentType: 'url', content: '', style: DEFAULT_STYLE, logoId: null };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Paper sx={{ p: 2.5 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2 }}>
        {title}
      </Typography>
      <Stack spacing={2}>{children}</Stack>
    </Paper>
  );
}

function ColourField({ label, value, onChange, disabled }: { label: string; value: string; onChange(v: string): void; disabled?: boolean }) {
  return (
    <TextField
      type="color"
      label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      sx={{ width: 140, '& input': { height: 32, p: 0.5, cursor: 'pointer' } }}
    />
  );
}

function ShapePicker<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange(v: T): void }) {
  return (
    <Stack spacing={0.5}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <ToggleButtonGroup exclusive size="small" value={value} onChange={(_e, v: T | null) => v && onChange(v)}>
        {options.map((o) => (
          <ToggleButton key={o.value} value={o.value} sx={{ px: 2 }}>
            {o.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Stack>
  );
}

export function QrDesignerPage() {
  const { id } = useParams();
  const qrId = id ? Number(id) : null;
  const navigate = useNavigate();
  const { user } = useAuth();

  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [saved, setSaved] = useState<Form | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [link, setLink] = useState<QrShortLink | null>(null);
  const [alias, setAlias] = useState('');
  const [loading, setLoading] = useState(true);
  const [logos, setLogos] = useState<Logo[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [preview, setPreview] = useState<{ svg: string; scannable: boolean; contentError: string | null } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<'export' | 'print' | 'preset' | 'link' | 'email' | null>(null);
  const emailEnabled = useEmailEnabled();
  const fileInput = useRef<HTMLInputElement>(null);
  const previewSeq = useRef(0);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const setStyle = (patch: Partial<QrStyle>) => setForm((f) => ({ ...f, style: { ...f.style, ...patch } }));

  // Initial load: logos, presets, and either the saved code or the default preset.
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [l, p] = await Promise.all([fetchLogos(), fetchPresets()]);
        setLogos(l);
        setPresets(p);
        if (qrId) {
          const { qr } = await api.get<{ qr: QrCode }>(`/qr/${qrId}`);
          const f: Form = { title: qr.title, contentType: qr.contentType, content: qr.content, style: { ...DEFAULT_STYLE, ...qr.style }, logoId: qr.logoId };
          setForm(f);
          setSaved(f);
          setOwner(qr.ownerUsername);
          setLink(qr.shortLink);
        } else {
          const def = p.find((x) => x.isDefault);
          setForm(def ? { ...EMPTY_FORM, style: { ...DEFAULT_STYLE, ...def.style }, logoId: def.logoId } : EMPTY_FORM);
          setSaved(null);
        }
      } catch (err) {
        setNotice({ severity: 'error', text: errorMessage(err) });
      } finally {
        setLoading(false);
      }
    })();
  }, [qrId]);

  // Live preview, debounced; stale responses are ignored.
  const previewKey = JSON.stringify([form.contentType, form.content, form.style, form.logoId]);
  useEffect(() => {
    if (loading) return;
    const content = form.content.trim();
    const seq = ++previewSeq.current;
    const t = setTimeout(async () => {
      try {
        const res = await api.post<{ svg: string; scannable: boolean; contentError: string | null }>('/qr/preview', { contentType: form.contentType, content, style: form.style, logoId: form.logoId, qrId: qrId ?? undefined });
        if (seq === previewSeq.current) {
          setPreview(res);
          setPreviewError(null);
        }
      } catch (err) {
        if (seq === previewSeq.current) setPreviewError(errorMessage(err));
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, loading]);

  const dirty = useMemo(() => !saved || JSON.stringify(saved) !== JSON.stringify(form), [saved, form]);
  const warnings = colourWarnings(form.style);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      if (qrId) {
        const { qr } = await api.put<{ qr: QrCode }>(`/qr/${qrId}`, form);
        setLink(qr.shortLink);
        setSaved(form);
        setNotice({ severity: 'success', text: 'Saved.' });
      } else {
        const { qr } = await api.post<{ qr: QrCode }>('/qr', { ...form, alias: form.contentType === 'url' && alias.trim() ? alias.trim() : undefined });
        navigate(`/qr/${qr.id}`, { replace: true });
      }
    } catch (err) {
      setNotice({ severity: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const onUpload = async (file: File | undefined) => {
    if (!file) return;
    try {
      const logo = await uploadLogo(file);
      setLogos((l) => [...l, logo]);
      set({ logoId: logo.id });
    } catch (err) {
      setNotice({ severity: 'error', text: errorMessage(err) });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const applyPreset = (presetId: number) => {
    const p = presets.find((x) => x.id === presetId);
    if (p) setForm((f) => ({ ...f, style: { ...DEFAULT_STYLE, ...p.style }, logoId: p.logoId }));
  };

  if (loading) {
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  const { style } = form;
  const hasLogo = form.logoId != null;

  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h5">{qrId ? form.title || 'QR code' : 'New QR code'}</Typography>
        {owner && owner !== user?.username && <Typography color="text.secondary">Owner: {owner}</Typography>}
      </Stack>
      {notice && (
        <Alert severity={notice.severity} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) 380px' }, alignItems: 'start' }}>
        <Stack spacing={2}>
          <Section title="Content">
            <TextField label="Title" value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Product brochure — Expo 2026" required />
            <ToggleButtonGroup exclusive size="small" value={form.contentType} disabled={!!qrId} onChange={(_e, v: ContentType | null) => v && set({ contentType: v })}>
              <ToggleButton value="url">Website link</ToggleButton>
              <ToggleButton value="text">Plain text</ToggleButton>
            </ToggleButtonGroup>
            <TextField
              label={form.contentType === 'url' ? 'Link (URL)' : 'Text'}
              value={form.content}
              onChange={(e) => set({ content: e.target.value })}
              placeholder={form.contentType === 'url' ? 'https://www.example.com/page' : 'Text people will see when they scan the code'}
              multiline={form.contentType === 'text'}
              minRows={form.contentType === 'text' ? 3 : undefined}
              error={!!preview?.contentError}
              helperText={
                preview?.contentError ??
                (form.contentType === 'url'
                  ? qrId
                    ? 'You can change this at any time; printed copies of this QR code follow the new link.'
                    : 'The QR code points to a short link, so you can change this destination later without reprinting.'
                  : qrId
                    ? 'Changing the text changes the QR code itself; copies already printed keep the old text.'
                    : `${form.content.length}/2000 characters. Shorter text makes a simpler, easier-to-scan code.`)
              }
              slotProps={{ htmlInput: { maxLength: 2000 } }}
            />
            {!qrId && form.contentType === 'url' && (
              <TextField
                label="Custom short name (optional)"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder="e.g. expo2026"
                helperText={`Short link: …/short/${alias.trim() || 'a7Kp3xQ'}. Leave empty for a random code. It cannot be changed later.`}
                slotProps={{ htmlInput: { maxLength: 40 } }}
              />
            )}
          </Section>

          {presets.length > 0 && (
            <Section title="Brand presets">
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                {presets.map((p) => (
                  <Button key={p.id} variant="outlined" size="small" startIcon={<Bookmark />} onClick={() => applyPreset(p.id)}>
                    {p.name}
                    {p.isDefault ? ' (default)' : ''}
                  </Button>
                ))}
              </Stack>
            </Section>
          )}

          <Section title="Colours">
            <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
              <ColourField label="Code colour" value={style.foreground} onChange={(v) => setStyle({ foreground: v })} />
              <ColourField label="Background" value={style.background} disabled={style.transparentBackground} onChange={(v) => setStyle({ background: v })} />
              <FormControlLabel control={<Checkbox checked={style.transparentBackground} onChange={(e) => setStyle({ transparentBackground: e.target.checked })} />} label="Transparent background" />
            </Stack>
            <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
              <TextField
                select
                label="Gradient"
                value={style.gradient?.type ?? 'none'}
                onChange={(e) => {
                  const v = e.target.value;
                  setStyle({ gradient: v === 'none' ? null : { type: v as 'linear' | 'radial', color: style.gradient?.color ?? '#0b5394', rotation: style.gradient?.rotation ?? 45 } });
                }}
                sx={{ width: 160 }}
              >
                <MenuItem value="none">None</MenuItem>
                <MenuItem value="linear">Linear</MenuItem>
                <MenuItem value="radial">Radial</MenuItem>
              </TextField>
              {style.gradient && (
                <>
                  <ColourField label="Gradient to" value={style.gradient.color} onChange={(v) => setStyle({ gradient: { ...style.gradient!, color: v } })} />
                  {style.gradient.type === 'linear' && (
                    <Box sx={{ width: 180 }}>
                      <Typography variant="caption" color="text.secondary">
                        Angle: {style.gradient.rotation}°
                      </Typography>
                      <Slider size="small" min={0} max={360} step={15} value={style.gradient.rotation} onChange={(_e, v) => setStyle({ gradient: { ...style.gradient!, rotation: v as number } })} />
                    </Box>
                  )}
                </>
              )}
            </Stack>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
              <FormControlLabel
                control={<Switch checked={style.eyeColor != null} onChange={(e) => setStyle({ eyeColor: e.target.checked ? style.foreground : null })} />}
                label="Different colour for the corners"
              />
              {style.eyeColor != null && <ColourField label="Corner colour" value={style.eyeColor} onChange={(v) => setStyle({ eyeColor: v })} />}
            </Stack>
          </Section>

          <Section title="Shapes">
            <ShapePicker
              label="Pattern"
              value={style.moduleShape}
              onChange={(v) => setStyle({ moduleShape: v })}
              options={[
                { value: 'square', label: 'Square' },
                { value: 'rounded', label: 'Rounded' },
                { value: 'dots', label: 'Dots' },
              ]}
            />
            <ShapePicker
              label="Corner frame"
              value={style.eyeFrameShape}
              onChange={(v) => setStyle({ eyeFrameShape: v })}
              options={[
                { value: 'square', label: 'Square' },
                { value: 'rounded', label: 'Rounded' },
                { value: 'circle', label: 'Circle' },
              ]}
            />
            <ShapePicker
              label="Corner centre"
              value={style.eyeBallShape}
              onChange={(v) => setStyle({ eyeBallShape: v })}
              options={[
                { value: 'square', label: 'Square' },
                { value: 'rounded', label: 'Rounded' },
                { value: 'circle', label: 'Circle' },
              ]}
            />
          </Section>

          <Section title="Logo">
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
              <LogoTile selected={!hasLogo} onClick={() => set({ logoId: null })} label="No logo">
                <Block color="disabled" />
              </LogoTile>
              {logos.map((l) => (
                <LogoTile key={l.id} selected={form.logoId === l.id} onClick={() => set({ logoId: l.id })} label={`${l.name}${l.isShared ? ' (company)' : ''}`}>
                  <img src={logoUrl(l.id)} alt={l.name} style={{ maxWidth: '100%', maxHeight: '100%' }} />
                </LogoTile>
              ))}
              <LogoTile selected={false} onClick={() => fileInput.current?.click()} label="Upload a logo">
                <Upload color="action" />
              </LogoTile>
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden onChange={(e) => onUpload(e.target.files?.[0])} />
            </Stack>
            {hasLogo && (
              <Stack direction="row" spacing={3} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Box sx={{ width: 220 }}>
                  <Typography variant="caption" color="text.secondary">
                    Logo size: {style.logoSizePercent}% of the code
                  </Typography>
                  <Slider size="small" min={10} max={30} value={style.logoSizePercent} onChange={(_e, v) => setStyle({ logoSizePercent: v as number })} />
                </Box>
                <FormControlLabel control={<Checkbox checked={style.logoBacking} onChange={(e) => setStyle({ logoBacking: e.target.checked })} />} label="Clear space around the logo" />
              </Stack>
            )}
            {hasLogo && (
              <Typography variant="caption" color="text.secondary">
                With a logo the code automatically uses the highest error correction (H), so it still scans with its centre covered.
              </Typography>
            )}
          </Section>

          <Section title="Advanced">
            <Stack direction="row" spacing={3} sx={{ flexWrap: 'wrap', gap: 2 }}>
              <TextField
                select
                label="Error correction"
                value={hasLogo ? 'H' : style.errorCorrection}
                disabled={hasLogo}
                onChange={(e) => setStyle({ errorCorrection: e.target.value as QrStyle['errorCorrection'] })}
                sx={{ width: 260 }}
                helperText="Higher survives damage better but makes a denser code."
              >
                <MenuItem value="L">Low (7%)</MenuItem>
                <MenuItem value="M">Medium (15%)</MenuItem>
                <MenuItem value="Q">Quartile (25%)</MenuItem>
                <MenuItem value="H">High (30%)</MenuItem>
              </TextField>
              <Box sx={{ width: 220 }}>
                <Typography variant="caption" color="text.secondary">
                  Margin: {style.margin} modules {style.margin < 2 ? '(may be hard to scan)' : ''}
                </Typography>
                <Slider size="small" min={0} max={10} value={style.margin} onChange={(_e, v) => setStyle({ margin: v as number })} />
              </Box>
            </Stack>
          </Section>
        </Stack>

        <Box sx={{ position: { md: 'sticky' }, top: { md: 88 } }}>
          <Paper sx={{ p: 2.5 }}>
            <Stack spacing={2}>
              <Box
                sx={{
                  aspectRatio: '1',
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: 1,
                  // checkerboard shows transparency
                  backgroundImage: style.transparentBackground ? 'repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%)' : undefined,
                  backgroundSize: '20px 20px',
                }}
              >
                {preview ? <img src={svgDataUrl(preview.svg)} alt="QR code preview" style={{ width: '100%', height: '100%' }} /> : <CircularProgress />}
              </Box>
              {previewError && <Alert severity="error">{previewError}</Alert>}
              {preview && !previewError && (
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  {preview.scannable ? <CheckCircle color="success" fontSize="small" /> : <Warning color="warning" fontSize="small" />}
                  <Typography variant="body2" color={preview.scannable ? 'success.main' : 'warning.main'}>
                    {preview.scannable ? 'Scan check passed' : 'Scan check failed — this design may not scan reliably'}
                  </Typography>
                </Stack>
              )}
              {link && (
                <Paper variant="outlined" sx={{ p: 1.5 }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <LinkIcon color="action" fontSize="small" />
                    <Typography variant="body2" sx={{ fontFamily: 'monospace', flexGrow: 1, wordBreak: 'break-all' }}>
                      {link.url}
                    </Typography>
                    <CopyButton text={link.url} />
                  </Stack>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 1 }}>
                    <Chip size="small" label={STATE_CHIP[linkState(link)].label} color={STATE_CHIP[linkState(link)].color} />
                    {link.expiresAt && linkState(link) === 'active' && (
                      <Typography variant="caption" color="text.secondary">
                        until {new Date(link.expiresAt).toLocaleString()}
                      </Typography>
                    )}
                    <Box sx={{ flexGrow: 1 }} />
                    <Button size="small" component={RouterLink} to={`/links/${link.id}`}>
                      Statistics
                    </Button>
                    <Button size="small" onClick={() => setDialog('link')}>
                      Manage link
                    </Button>
                  </Stack>
                </Paper>
              )}
              {warnings.map((w) => (
                <Alert key={w} severity="warning" sx={{ py: 0 }}>
                  {w}
                </Alert>
              ))}
              <Button variant="contained" size="large" startIcon={<Save />} onClick={save} disabled={busy || !dirty || !form.title.trim() || !form.content.trim()}>
                {qrId ? (dirty ? 'Save changes' : 'Saved') : 'Save QR code'}
              </Button>
              {qrId && (
                <Stack direction="row" spacing={1}>
                  <Tooltip title={dirty ? 'Save your changes first' : ''}>
                    <span style={{ flex: 1 }}>
                      <Button fullWidth variant="outlined" startIcon={<Download />} disabled={dirty} onClick={() => setDialog('export')}>
                        Download
                      </Button>
                    </span>
                  </Tooltip>
                  <Tooltip title={dirty ? 'Save your changes first' : ''}>
                    <span style={{ flex: 1 }}>
                      <Button fullWidth variant="outlined" startIcon={<Print />} disabled={dirty} onClick={() => setDialog('print')}>
                        Print
                      </Button>
                    </span>
                  </Tooltip>
                </Stack>
              )}
              {qrId && emailEnabled && (
                <Button variant="outlined" startIcon={<Email />} disabled={dirty} onClick={() => setDialog('email')}>
                  Email
                </Button>
              )}
              {user?.role === 'admin' && (
                <Button size="small" startIcon={<Bookmark />} onClick={() => setDialog('preset')}>
                  Save design as brand preset
                </Button>
              )}
              <Typography variant="caption" color="text.secondary">
                Always test-scan a printed sample with a phone before mass printing.
              </Typography>
            </Stack>
          </Paper>
        </Box>
      </Box>

      {qrId && <ExportDialog qrId={qrId} open={dialog === 'export'} onClose={() => setDialog(null)} />}
      {qrId && <PrintDialog qrId={qrId} open={dialog === 'print'} onClose={() => setDialog(null)} />}
      {qrId && <EmailDialog qr={{ id: qrId, title: form.title }} open={dialog === 'email'} onClose={() => setDialog(null)} onSent={(text) => setNotice({ severity: 'success', text })} />}
      <LinkDialog
        linkId={dialog === 'link' && link ? link.id : null}
        onClose={() => setDialog(null)}
        onChanged={(l) => {
          setLink({ id: l.id, code: l.code, url: l.url, isActive: l.isActive, expiresAt: l.expiresAt });
          // A destination edited in the dialog is also the code's content.
          setForm((f) => ({ ...f, content: l.targetUrl }));
          setSaved((sv) => (sv ? { ...sv, content: l.targetUrl } : sv));
        }}
      />
      <SavePresetDialog
        open={dialog === 'preset'}
        presets={presets}
        style={form.style}
        logoId={form.logoId}
        onClose={() => setDialog(null)}
        onSaved={(p) => {
          setPresets((list) => [...list.filter((x) => x.id !== p.id).map((x) => (p.isDefault ? { ...x, isDefault: false } : x)), p]);
          setDialog(null);
          setNotice({ severity: 'success', text: `Preset "${p.name}" saved.` });
        }}
      />
    </Stack>
  );
}

function LogoTile({ selected, onClick, label, children }: { selected: boolean; onClick(): void; label: string; children: ReactNode }) {
  return (
    <Tooltip title={label}>
      <ButtonBase
        onClick={onClick}
        aria-label={label}
        sx={{
          width: 64,
          height: 64,
          p: 1,
          borderRadius: 1,
          border: 2,
          borderColor: selected ? 'primary.main' : 'divider',
          bgcolor: 'background.paper',
        }}
      >
        {children}
      </ButtonBase>
    </Tooltip>
  );
}

function SavePresetDialog({
  open,
  presets,
  style,
  logoId,
  onClose,
  onSaved,
}: {
  open: boolean;
  presets: Preset[];
  style: QrStyle;
  logoId: number | null;
  onClose(): void;
  onSaved(p: Preset): void;
}) {
  const [name, setName] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName('');
      setIsDefault(false);
      setError(null);
    }
  }, [open]);
  const existing = presets.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());

  const submit = async () => {
    setError(null);
    try {
      const body = { name: name.trim(), style, logoId, isDefault };
      const { preset } = existing
        ? await api.put<{ preset: Preset }>(`/admin/settings/presets/${existing.id}`, body)
        : await api.post<{ preset: Preset }>('/admin/settings/presets', body);
      onSaved(preset);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Save as brand preset</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <Typography variant="body2" color="text.secondary">
            Presets let everyone apply this design (colours, shapes and logo) with one click.
          </Typography>
          <TextField label="Preset name" value={name} onChange={(e) => setName(e.target.value)} autoFocus helperText={existing ? `This replaces the existing preset "${existing.name}".` : ' '} />
          <FormControlLabel control={<Checkbox checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />} label="Use as the default for new QR codes" />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={!name.trim()}>
          {existing ? 'Replace preset' : 'Save preset'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
