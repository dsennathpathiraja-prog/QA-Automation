import { Box, Stack, Typography } from '@mui/material';

export type ReportChartTallies = {
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  notAutomated: number;
};

const SEGMENTS: Array<{ key: keyof ReportChartTallies; label: string; color: string }> = [
  { key: 'passed', label: 'Passed', color: '#2e7d32' },
  { key: 'failed', label: 'Failed', color: '#c62828' },
  { key: 'blocked', label: 'Blocked', color: '#ed6c02' },
  { key: 'skipped', label: 'Skipped', color: '#607d8b' },
  { key: 'notAutomated', label: 'Not Automated', color: '#1565c0' },
];

function totalOf(t: ReportChartTallies): number {
  return t.passed + t.failed + t.blocked + t.skipped + t.notAutomated;
}

/** Horizontal stacked bar + donut for run outcome tallies (no chart library). */
export function ReportCharts({ tallies }: { tallies: ReportChartTallies }) {
  const total = totalOf(tallies);
  const active = SEGMENTS.filter((s) => tallies[s.key] > 0);
  const slices = active.length > 0 ? active : SEGMENTS;

  let angle = -90;
  const arcs = slices.map((s) => {
    const value = total > 0 ? tallies[s.key] : 0;
    const sweep = total > 0 ? (value / total) * 360 : 360 / slices.length;
    const start = angle;
    angle += sweep;
    return { ...s, value, start, sweep };
  });

  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={3}
      useFlexGap
      sx={{ mt: 2, alignItems: { sm: 'center' }, flexWrap: 'wrap' }}
      aria-label="Report outcome chart"
    >
      <Box sx={{ flex: '1 1 220px', minWidth: 0 }} aria-hidden={total === 0}>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>Outcome mix</Typography>
        <Box
          sx={{
            display: 'flex',
            height: 18,
            borderRadius: 1,
            overflow: 'hidden',
            bgcolor: 'action.hover',
            border: 1,
            borderColor: 'divider',
          }}
          role="img"
          aria-label={total === 0
            ? 'No case outcomes yet'
            : `Stacked bar: ${SEGMENTS.map((s) => `${tallies[s.key]} ${s.label}`).join(', ')}`}
        >
          {total === 0 ? (
            <Box sx={{ flex: 1, bgcolor: 'action.disabledBackground' }} />
          ) : (
            SEGMENTS.map((s) => (
              tallies[s.key] > 0 ? (
                <Box
                  key={s.key}
                  title={`${s.label}: ${tallies[s.key]}`}
                  sx={{
                    width: `${(tallies[s.key] / total) * 100}%`,
                    bgcolor: s.color,
                    minWidth: tallies[s.key] > 0 ? 4 : 0,
                  }}
                />
              ) : null
            ))
          )}
        </Box>
        <Stack direction="row" spacing={1.5} useFlexGap sx={{ mt: 1.5, flexWrap: 'wrap' }}>
          {SEGMENTS.map((s) => (
            <Stack key={s.key} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
              <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: s.color, flexShrink: 0 }} />
              <Typography variant="caption" color="text.secondary">
                {s.label} {tallies[s.key]}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </Box>

      <Box sx={{ flex: '0 0 auto', textAlign: 'center' }}>
        <svg
          width={132}
          height={132}
          viewBox="0 0 120 120"
          role="img"
          aria-label={total === 0
            ? 'Donut chart with no outcomes yet'
            : `Donut chart of ${total} cases`}
        >
          <circle cx="60" cy="60" r="40" fill="#f5f7fa" />
          {total === 0 ? (
            <circle cx="60" cy="60" r="48" fill="none" stroke="#cfd8dc" strokeWidth="16" />
          ) : (
            arcs.map((a) => (
              <path
                key={a.key}
                d={donutSlice(60, 60, 48, 32, a.start, a.sweep)}
                fill={a.color}
              >
                <title>{`${a.label}: ${a.value}`}</title>
              </path>
            ))
          )}
          <text x="60" y="56" textAnchor="middle" fontSize="18" fontWeight="700" fill="#263238">
            {total}
          </text>
          <text x="60" y="72" textAnchor="middle" fontSize="9" fill="#607d8b">
            cases
          </text>
        </svg>
      </Box>
    </Stack>
  );
}

/** Donut segment from `start` degrees, sweeping `sweep` degrees (SVG y-down). */
function donutSlice(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startDeg: number,
  sweepDeg: number,
): string {
  if (sweepDeg <= 0) return '';
  const sweep = Math.min(sweepDeg, 359.999);
  const start = polar(cx, cy, outerR, startDeg);
  const end = polar(cx, cy, outerR, startDeg + sweep);
  const startInner = polar(cx, cy, innerR, startDeg + sweep);
  const endInner = polar(cx, cy, innerR, startDeg);
  const large = sweep > 180 ? 1 : 0;
  return [
    `M ${start.x} ${start.y}`,
    `A ${outerR} ${outerR} 0 ${large} 1 ${end.x} ${end.y}`,
    `L ${startInner.x} ${startInner.y}`,
    `A ${innerR} ${innerR} 0 ${large} 0 ${endInner.x} ${endInner.y}`,
    'Z',
  ].join(' ');
}

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
