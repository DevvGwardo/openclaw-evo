import React, { useState, useEffect, useCallback, useRef } from 'react';
import { evoClient } from './api/evoClient';
import type { DashboardData } from './types';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const C = {
  bg: '#0a0a0f',
  surface: '#111119',
  surface2: '#181824',
  border: '#252535',
  cyan: '#00e5c8',
  cyanDim: '#00a890',
  green: '#39d353',
  amber: '#f5a623',
  red: '#ff5f5f',
  text: '#e0e0e0',
  textMuted: '#6b7280',
  textDim: '#9ca3af',
};

const s = {
  root: { background: C.bg, color: C.text, minHeight: '100vh', fontFamily: 'system-ui, sans-serif' } as React.CSSProperties,
  header: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '16px 24px',
    borderBottom: `1px solid ${C.border}`, background: C.surface,
  } as React.CSSProperties,
  logo: { fontSize: 18, fontWeight: 700, letterSpacing: 0.5, color: C.cyan } as React.CSSProperties,
  badge: (color: string) => ({
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px',
    borderRadius: 12, fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
    background: `${color}22`, color, border: `1px solid ${color}55`,
    textTransform: 'uppercase',
  } as React.CSSProperties),
  main: { padding: '20px 24px', maxWidth: 1400, margin: '0 auto' } as React.CSSProperties,
  statBar: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20,
  } as React.CSSProperties,
  statCard: {
    background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
    padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 4,
  } as React.CSSProperties,
  statLabel: { fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 } as React.CSSProperties,
  statValue: { fontSize: 28, fontWeight: 700, color: C.text } as React.CSSProperties,
  section: {
    background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
    marginBottom: 16, overflow: 'hidden',
  } as React.CSSProperties,
  sectionHeader: {
    padding: '12px 18px', borderBottom: `1px solid ${C.border}`,
    fontSize: 13, fontWeight: 600, color: C.textDim, textTransform: 'uppercase', letterSpacing: 0.5,
    display: 'flex', alignItems: 'center', gap: 8,
  } as React.CSSProperties,
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 } as React.CSSProperties,
  table: { width: '100%', borderCollapse: 'collapse' } as React.CSSProperties,
  th: {
    padding: '8px 14px', textAlign: 'left', fontSize: 10, fontWeight: 600,
    color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5,
    borderBottom: `1px solid ${C.border}`, background: C.surface2,
  } as React.CSSProperties,
  td: { padding: '10px 14px', fontSize: 13, borderBottom: `1px solid ${C.border}`, verticalAlign: 'middle' } as React.CSSProperties,
  row: (hover?: boolean) => ({
    transition: 'background 0.15s',
    background: hover ? C.surface2 : 'transparent',
  } as React.CSSProperties),
  chip: (color: string) => ({
    display: 'inline-block', padding: '2px 8px', borderRadius: 6, fontSize: 10,
    fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4,
    background: `${color}22`, color, border: `1px solid ${color}44`,
  } as React.CSSProperties),
  btn: (variant: 'approve' | 'reject') => ({
    padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 700,
    cursor: 'pointer', border: 'none', letterSpacing: 0.3,
    background: variant === 'approve' ? `${C.green}22` : `${C.red}22`,
    color: variant === 'approve' ? C.green : C.red,
    border: `1px solid ${variant === 'approve' ? C.green : C.red}44`,
  } as React.CSSProperties),
  chartWrap: { padding: '16px 18px', position: 'relative' } as React.CSSProperties,
  emptyState: {
    padding: '24px', textAlign: 'center', color: C.textMuted, fontSize: 13,
  } as React.CSSProperties,
  refreshBtn: {
    marginLeft: 'auto', background: 'transparent', border: `1px solid ${C.border}`,
    color: C.textDim, borderRadius: 6, padding: '3px 10px', fontSize: 11,
    cursor: 'pointer', letterSpacing: 0.3,
  } as React.CSSProperties,
  uptime: { fontSize: 11, color: C.textMuted, marginLeft: 'auto' } as React.CSSProperties,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function fmtUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function phaseColor(phase: string): string {
  const map: Record<string, string> = {
    idle: C.textMuted, observing: C.cyan, analyzing: '#a78bfa',
    proposing: C.amber, deploying: '#60a5fa', testing: C.green, error: C.red,
  };
  return map[phase] ?? C.textMuted;
}

function severityColor(s: string): string {
  return { critical: C.red, high: '#f97316', medium: C.amber, low: C.cyan }[s] ?? C.textMuted;
}

function statusColor(s: string): string {
  return { running: C.green, completed: C.cyan, failed: C.red, pending: C.amber,
    approved: C.green, rejected: C.red, aborted: C.textMuted, paused: C.amber,
    deployed: C.cyan, cancelled: C.textMuted }[s] ?? C.textMuted;
}

// ---------------------------------------------------------------------------
// Score Chart (SVG)
// ---------------------------------------------------------------------------

interface ScoreChartProps {
  history: { timestamp: string; score: number }[];
  overallScore: number;
}

function ScoreChart({ history, overallScore }: ScoreChartProps) {
  const W = 700, H = 120, PAD = 24;
  const data = history.length ? history : [{ timestamp: '', score: overallScore }];
  const max = 100;
  const xs = data.map((_, i) => PAD + (i / Math.max(data.length - 1, 1)) * (W - PAD * 2));
  const ys = data.map((d) => H - PAD - ((d.score / max) * (H - PAD * 2)));
  const pts = xs.map((x, i) => `${x},${ys[i]}`).join(' ');
  const area = [PAD, H - PAD, ...xs.map((x, i) => `${x},${ys[i]}`), W - PAD, H - PAD].join(' ');

  return (
    <div style={s.chartWrap}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 32, fontWeight: 800, color: C.cyan }}>{overallScore}%</span>
        <span style={{ fontSize: 12, color: C.textMuted }}>overall health score</span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.cyan} stopOpacity={0.25} />
            <stop offset="100%" stopColor={C.cyan} stopOpacity={0} />
          </linearGradient>
        </defs>
        {/* Grid lines */}
        {[25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line
              x1={PAD} y1={H - PAD - (v / max) * (H - PAD * 2)}
              x2={W - PAD} y2={H - PAD - (v / max) * (H - PAD * 2)}
              stroke={C.border} strokeWidth={1} strokeDasharray="4 4"
            />
            <text
              x={PAD - 4} y={H - PAD - (v / max) * (H - PAD * 2) + 4}
              textAnchor="end" fontSize={9} fill={C.textMuted}
            >{v}</text>
          </g>
        ))}
        {/* Area fill */}
        <polygon points={area} fill="url(#areaGrad)" />
        {/* Line */}
        <polyline
          points={pts}
          fill="none" stroke={C.cyan} strokeWidth={2}
          strokeLinejoin="round" strokeLinecap="round"
        />
        {/* Dots */}
        {xs.map((x, i) => (
          <circle key={i} cx={x} cy={ys[i]} r={3} fill={C.bg} stroke={C.cyan} strokeWidth={2} />
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        <span style={{ fontSize: 10, color: C.textMuted }}>
          {history.length > 0 ? 'Cycle 1' : 'No data yet'}
        </span>
        <span style={{ fontSize: 10, color: C.textMuted }}>
          {history.length > 1 ? `Cycle ${history.length}` : ''}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats Bar
// ---------------------------------------------------------------------------

interface StatsBarProps {
  data: DashboardData | null;
}

function StatsBar({ data }: StatsBarProps) {
  const d = data?.metrics;
  const stats = [
    { label: 'Total Cycles', value: d?.totalCycles ?? 0 },
    { label: 'Deployed Skills', value: d?.deployedSkills ?? 0, accent: C.green },
    { label: 'Active Experiments', value: d?.activeExperiments ?? 0, accent: C.amber },
    { label: 'Failure Patterns', value: d?.failurePatterns ?? 0, accent: C.red },
  ];
  return (
    <div style={s.statBar}>
      {stats.map((st) => (
        <div key={st.label} style={s.statCard}>
          <span style={s.statLabel}>{st.label}</span>
          <span style={{ ...s.statValue, color: st.accent ?? s.statValue.color }}>
            {st.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Failure Patterns Table
// ---------------------------------------------------------------------------

interface FailuresTableProps {
  patterns: DashboardData['failurePatterns'];
}

function FailuresTable({ patterns }: FailuresTableProps) {
  if (!patterns.length) return <div style={s.emptyState}>No failure patterns detected.</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={s.table}>
        <thead>
          <tr>
            {['Tool', 'Error', 'Message', 'Freq', 'Severity', 'Last Seen'].map((h) => (
              <th key={h} style={s.th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {patterns.map((fp) => (
            <tr key={fp.id} style={s.row()}>
              <td style={{ ...s.td, color: C.cyan, fontWeight: 600, fontFamily: 'monospace' }}>{fp.toolName}</td>
              <td style={{ ...s.td, fontFamily: 'monospace', color: C.textDim }}>{fp.errorType}</td>
              <td style={{ ...s.td, color: C.textMuted, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {fp.message}
              </td>
              <td style={{ ...s.td, textAlign: 'center', fontWeight: 700 }}>{fp.frequency}</td>
              <td style={s.td}>
                <span style={s.chip(severityColor(fp.severity))}>{fp.severity}</span>
              </td>
              <td style={{ ...s.td, color: C.textMuted, whiteSpace: 'nowrap' }}>{fmtAge(fp.lastSeen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evolution Cycle Log
// ---------------------------------------------------------------------------

interface CycleLogProps {
  cycles: DashboardData['cycles'];
}

function CycleLog({ cycles }: CycleLogProps) {
  if (!cycles.length) return <div style={s.emptyState}>No cycles recorded yet.</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={s.table}>
        <thead>
          <tr>
            {['Cycle', 'Phase', 'Status', 'Score', 'Started', 'Age'].map((h) => (
              <th key={h} style={s.th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cycles.map((c) => (
            <tr key={c.id} style={s.row()}>
              <td style={{ ...s.td, fontWeight: 700, color: C.text }}>#{c.cycleIndex}</td>
              <td style={s.td}>
                <span style={s.chip(phaseColor(c.phase))}>{c.phase}</span>
              </td>
              <td style={s.td}>
                <span style={s.chip(statusColor(c.status))}>{c.status}</span>
              </td>
              <td style={{ ...s.td, fontWeight: 700, color: c.score !== null ? C.cyan : C.textMuted }}>
                {c.score !== null ? `${Math.round(c.score * 100)}%` : '—'}
              </td>
              <td style={{ ...s.td, color: C.textMuted, fontFamily: 'monospace', fontSize: 12 }}>
                {new Date(c.startedAt).toLocaleTimeString()}
              </td>
              <td style={{ ...s.td, color: C.textMuted }}>{fmtAge(c.startedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Proposed Skills
// ---------------------------------------------------------------------------

interface ProposedSkillsProps {
  skills: DashboardData['proposedSkills'];
  onRefresh: () => void;
}

function ProposedSkills({ skills, onRefresh }: ProposedSkillsProps) {
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  const handle = async (id: string, action: 'approve' | 'reject') => {
    setLoading((l) => ({ ...l, [id]: true }));
    try {
      if (action === 'approve') await evoClient.approveSkill(id);
      else await evoClient.rejectSkill(id);
      onRefresh();
    } finally {
      setLoading((l) => ({ ...l, [id]: false }));
    }
  };

  if (!skills.length) return <div style={s.emptyState}>No proposed skills.</div>;

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={s.table}>
        <thead>
          <tr>
            {['Skill', 'Confidence', 'Target Failure', 'Status', 'Actions'].map((h) => (
              <th key={h} style={s.th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {skills.map((sk) => (
            <tr key={sk.id} style={s.row()}>
              <td style={s.td}>
                <div style={{ fontWeight: 700, color: C.cyan }}>{sk.name}</div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2, maxWidth: 220 }}>
                  {sk.description}
                </div>
              </td>
              <td style={{ ...s.td, fontWeight: 800, color: sk.confidence >= 80 ? C.green : sk.confidence >= 60 ? C.amber : C.textMuted }}>
                {sk.confidence}%
              </td>
              <td style={{ ...s.td, color: C.textDim, fontSize: 12 }}>{sk.targetFailure}</td>
              <td style={s.td}>
                <span style={s.chip(statusColor(sk.status))}>{sk.status}</span>
              </td>
              <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                {sk.status === 'pending' && (
                  <>
                    <button
                      style={s.btn('approve')}
                      onClick={() => handle(sk.id, 'approve')}
                      disabled={loading[sk.id]}
                    >
                      {loading[sk.id] ? '…' : '✓ Approve'}
                    </button>
                    {' '}
                    <button
                      style={s.btn('reject')}
                      onClick={() => handle(sk.id, 'reject')}
                      disabled={loading[sk.id]}
                    >
                      ✗ Reject
                    </button>
                  </>
                )}
                {sk.status !== 'pending' && (
                  <span style={{ color: C.textMuted, fontSize: 12 }}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active Experiments
// ---------------------------------------------------------------------------

interface ExperimentsProps {
  experiments: DashboardData['experiments'];
}

function Experiments({ experiments }: ExperimentsProps) {
  if (!experiments.length) return <div style={s.emptyState}>No active experiments.</div>;

  return (
    <div style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {experiments.map((exp) => (
        <div
          key={exp.id}
          style={{
            background: C.surface2, border: `1px solid ${C.border}`,
            borderRadius: 8, padding: '12px 14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontWeight: 700, color: C.text }}>{exp.name}</span>
            <span style={s.chip(C.cyan)}>{exp.type}</span>
            <span style={{ ...s.chip(statusColor(exp.status)), marginLeft: 'auto' }}>{exp.status}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
            {[
              { label: 'Control', value: `${exp.metrics.control}%` },
              { label: 'Variant', value: `${exp.metrics.variant}%` },
              { label: 'Lift', value: `${exp.metrics.improvement > 0 ? '+' : ''}${exp.metrics.improvement}%`, color: exp.metrics.improvement > 0 ? C.green : C.red },
              { label: 'N', value: String(exp.metrics.sampleSize) },
              { label: 'Sig', value: exp.metrics.significance.toFixed(2), color: exp.metrics.significance >= 0.95 ? C.green : C.amber },
            ].map((m) => (
              <div key={m.label} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 }}>{m.label}</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: m.color ?? C.text }}>{m.value}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: C.textMuted }}>
            Started {fmtAge(exp.startedAt)}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const EMPTY: DashboardData = {
  hub: { running: false, phase: 'idle', cycleCount: 0, lastCycleAt: null, uptimeSeconds: 0 },
  metrics: { totalCycles: 0, deployedSkills: 0, activeExperiments: 0, failurePatterns: 0, overallScore: 0, scoreHistory: [], uptimeSeconds: 0 },
  failurePatterns: [],
  cycles: [],
  proposedSkills: [],
  experiments: [],
};

export default function App() {
  const [data, setData] = useState<DashboardData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const clientRef = useRef(evoClient.polling);

  const handleData = useCallback((d: DashboardData) => {
    setData(d);
    setLastUpdated(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    const client = clientRef.current;
    client.start();
    const unsub = client.subscribe(handleData);
    return () => { unsub(); client.stop(); };
  }, [handleData]);

  const handleRefresh = async () => {
    setLoading(true);
    try {
      const d = await evoClient.polling.refresh();
      handleData(d);
    } catch {
      setLoading(false);
    }
  };

  const phaseColor_ = phaseColor(data.hub.phase);

  return (
    <div style={s.root}>
      {/* Header */}
      <header style={{ ...s.header, alignItems: 'center' } as React.CSSProperties}>
        <span style={s.logo}>◈ OpenClaw Evo</span>
        <span style={s.badge(data.hub.running ? C.green : C.red)}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', display: 'inline-block' } as React.CSSProperties} />
          {data.hub.running ? 'running' : 'idle'}
        </span>
        <span style={{ ...s.chip(phaseColor_), marginLeft: 4 } as React.CSSProperties}>{data.hub.phase}</span>
        <span style={s.uptime as React.CSSProperties}>
          {fmtUptime(data.metrics.uptimeSeconds)} uptime
          {lastUpdated ? ` · updated ${fmtAge(lastUpdated.toISOString())}` : ''}
        </span>
        <button style={{ ...s.refreshBtn, marginLeft: 'auto' } as React.CSSProperties} onClick={handleRefresh} disabled={loading}>
          {loading ? '⟳' : '↻'} Refresh
        </button>
      </header>

      <main style={s.main}>
        {/* Stats */}
        <StatsBar data={data} />

        {/* Score Chart */}
        <div style={s.section}>
          <div style={s.sectionHeader}>📈 Performance Score Over Time</div>
          <ScoreChart
            history={data.metrics.scoreHistory}
            overallScore={data.metrics.overallScore}
          />
        </div>

        {/* Two-col grid */}
        <div style={s.grid2}>
          {/* Failure Patterns */}
          <div style={s.section}>
            <div style={s.sectionHeader}>⚠ Failure Patterns ({data.failurePatterns.length})</div>
            <FailuresTable patterns={data.failurePatterns} />
          </div>

          {/* Experiments */}
          <div style={s.section}>
            <div style={s.sectionHeader}>🧪 Active Experiments ({data.experiments.filter((e) => e.status === 'running').length})</div>
            <Experiments experiments={data.experiments} />
          </div>
        </div>

        {/* Proposed Skills */}
        <div style={s.section}>
          <div style={s.sectionHeader}>💡 Proposed Skills ({data.proposedSkills.length} pending)</div>
          <ProposedSkills skills={data.proposedSkills} onRefresh={handleRefresh} />
        </div>

        {/* Cycle Log */}
        <div style={s.section}>
          <div style={s.sectionHeader}>🔄 Evolution Cycle Log</div>
          <CycleLog cycles={data.cycles} />
        </div>
      </main>
    </div>
  );
}
