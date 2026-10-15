import { Alert, Box, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Tooltip as MuiTooltip, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export interface Breakdown {
  name: string;
  count: number;
}

export interface Stats {
  range: { from: number; to: number; days: string[] };
  totals: { clicks: number; visitors: number; qr: number; direct: number; links: number; activeLinks: number };
  series: { day: string; clicks: number; visitors: number; qr: number; direct: number }[];
  devices: Breakdown[];
  browsers: Breakdown[];
  os: Breakdown[];
  referrers: Breakdown[];
  countries: Breakdown[];
  topLinks: { id: number; code: string; title: string | null; owner: string; clicks: number; visitors: number }[];
  topCreators: { username: string; displayName: string; clicks: number; links: number }[];
  includesArchived: boolean;
  bots: number;
}

// Validated categorical slots (dataviz reference palette, light mode): 1 = blue, 2 = orange.
const SERIES = { clicks: '#2a78d6', visitors: '#eb6834' };
const GRID = '#e6e6e3';
const AXIS_TEXT = '#52514e';

export const RANGES = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 365, label: 'Last 12 months' },
];

const fmt = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact' });
const countryNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(undefined, { type: 'region' }) : null;
const DEVICE_LABEL: Record<string, string> = { mobile: 'Phone', tablet: 'Tablet', desktop: 'Computer', other: 'Other' };

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Paper sx={{ p: 2.5, flex: 1, minWidth: 160 }}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography sx={{ fontSize: 34, fontWeight: 600, lineHeight: 1.2, mt: 0.5 }}>{value}</Typography>
      {hint && (
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      )}
    </Paper>
  );
}

/** Horizontal bar list: one series, so one hue; values in text ink beside the bar. */
function BarList({ title, items, labelOf = (n) => n }: { title: string; items: Breakdown[]; labelOf?: (name: string) => string }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  const total = items.reduce((s, i) => s + i.count, 0);
  return (
    <Paper sx={{ p: 2.5 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5 }}>
        {title}
      </Typography>
      {items.length ? (
        <Stack spacing={1.25}>
          {items.map((i) => (
            <MuiTooltip key={i.name} title={`${labelOf(i.name)}: ${fmt.format(i.count)} (${Math.round((i.count / total) * 100)}%)`} placement="top-start">
              <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 9rem) 1fr 3.5rem', alignItems: 'center', gap: 1.5, py: 0.25 }}>
                <Typography variant="body2" noWrap title={labelOf(i.name)}>
                  {labelOf(i.name)}
                </Typography>
                <Box sx={{ height: 14, bgcolor: GRID, borderRadius: '0 4px 4px 0' }}>
                  <Box sx={{ height: '100%', width: `${(i.count / max) * 100}%`, minWidth: 2, bgcolor: SERIES.clicks, borderRadius: '0 4px 4px 0' }} />
                </Box>
                <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {fmt.format(i.count)}
                </Typography>
              </Box>
            </MuiTooltip>
          ))}
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary">
          No data yet.
        </Typography>
      )}
    </Paper>
  );
}

const dayLabel = (day: string, long = false) =>
  new Date(`${day}T00:00:00`).toLocaleDateString(undefined, long ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });

function ClicksChart({ series }: { series: Stats['series'] }) {
  return (
    <Paper sx={{ p: 2.5 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        Clicks over time
      </Typography>
      <Box sx={{ height: 280, mt: 1 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="day" tickFormatter={(d) => dayLabel(d)} tick={{ fill: AXIS_TEXT, fontSize: 12 }} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={24} />
            <YAxis allowDecimals={false} tickFormatter={(v) => compact.format(v)} tick={{ fill: AXIS_TEXT, fontSize: 12 }} tickLine={false} axisLine={false} width={48} />
            <Tooltip
              labelFormatter={(d) => dayLabel(String(d), true)}
              formatter={(value, name) => [fmt.format(Number(value)), name]}
              cursor={{ stroke: AXIS_TEXT, strokeWidth: 1 }}
              contentStyle={{ borderRadius: 8, border: `1px solid ${GRID}`, fontSize: 13 }}
            />
            <Legend iconType="plainline" wrapperStyle={{ fontSize: 13, color: AXIS_TEXT }} />
            <Line type="monotone" dataKey="clicks" name="Clicks" stroke={SERIES.clicks} strokeWidth={2} dot={false} activeDot={{ r: 5, stroke: '#ffffff', strokeWidth: 2 }} strokeLinecap="round" />
            <Line type="monotone" dataKey="visitors" name="Unique visitors" stroke={SERIES.visitors} strokeWidth={2} dot={false} activeDot={{ r: 5, stroke: '#ffffff', strokeWidth: 2 }} strokeLinecap="round" />
          </LineChart>
        </ResponsiveContainer>
      </Box>
    </Paper>
  );
}

export function StatsView({ stats, showLinks = false, showCreators = false }: { stats: Stats; showLinks?: boolean; showCreators?: boolean }) {
  const { totals } = stats;
  const qrShare = totals.clicks ? Math.round((totals.qr / totals.clicks) * 100) : 0;

  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 2 }}>
        <Tile label="Clicks" value={fmt.format(totals.clicks)} />
        <Tile label="Unique visitors" value={fmt.format(totals.visitors)} />
        <Tile label="From QR scans" value={`${qrShare}%`} hint={`${fmt.format(totals.qr)} scans · ${fmt.format(totals.direct)} link clicks`} />
        {showLinks && <Tile label="Active links" value={fmt.format(totals.activeLinks)} hint={`of ${fmt.format(totals.links)}`} />}
      </Stack>

      {stats.includesArchived && (
        <Alert severity="info">Part of this period is older than the detailed-click retention period: it counts towards the totals and the chart but not the breakdowns below.</Alert>
      )}

      <ClicksChart series={stats.series} />

      {showLinks && (
        <Paper sx={{ p: 2.5 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
            Top links
          </Typography>
          {stats.topLinks.length ? (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>QR code</TableCell>
                  <TableCell>Short link</TableCell>
                  {showCreators && <TableCell>Owner</TableCell>}
                  <TableCell align="right">Clicks</TableCell>
                  <TableCell align="right">Visitors</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {stats.topLinks.map((l) => (
                  <TableRow key={l.id} hover>
                    <TableCell>
                      <RouterLink to={`/links/${l.id}`}>{l.title ?? '(no QR code)'}</RouterLink>
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>/short/{l.code}</TableCell>
                    {showCreators && <TableCell>{l.owner}</TableCell>}
                    <TableCell align="right">{fmt.format(l.clicks)}</TableCell>
                    <TableCell align="right">{fmt.format(l.visitors)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Typography variant="body2" color="text.secondary">
              No clicks in this period.
            </Typography>
          )}
        </Paper>
      )}

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
        <BarList title="Devices" items={stats.devices} labelOf={(n) => DEVICE_LABEL[n] ?? n} />
        <BarList title="Sources" items={stats.referrers} />
        <BarList title="Operating systems" items={stats.os} />
        <BarList title="Browsers" items={stats.browsers} />
        {stats.countries.length > 0 && <BarList title="Countries" items={stats.countries} labelOf={(c) => (c === 'Other' ? c : (countryNames?.of(c) ?? c))} />}
        {showCreators && (
          <BarList title="Top creators (clicks on their links)" items={stats.topCreators.map((c) => ({ name: `${c.displayName} (${c.links} link${c.links === 1 ? '' : 's'})`, count: c.clicks }))} />
        )}
      </Box>
      {stats.bots > 0 && (
        <Typography variant="caption" color="text.secondary">
          {fmt.format(stats.bots)} visit{stats.bots === 1 ? '' : 's'} by bots and link-preview services {stats.bots === 1 ? 'was' : 'were'} left out.
        </Typography>
      )}
    </Stack>
  );
}
