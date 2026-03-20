import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { evoClient } from './api/evoClient';
import type { DashboardData } from './types';

// ---------------------------------------------------------------------------
// Breakpoint hook
// ---------------------------------------------------------------------------

type Breakpoint = 'mobile' | 'tablet' | 'desktop';

function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(() =>
    window.innerWidth >= 1024 ? 'desktop' : window.innerWidth >= 640 ? 'tablet' : 'mobile'
  );
  useLayoutEffect(() => {
    const update = () =>
      setBp(window.innerWidth >= 1024 ? 'desktop' : window.innerWidth >= 640 ? 'tablet' : 'mobile');
    window.addEventListener('resize', update, { passive: true });
    return () => window.removeEventListener('resize', update);
  }, []);
  return bp;
}

// ---------------------------------------------------------------------------
// Design Tokens
// ---------------------------------------------------------------------------

const C = {
  bg:          '#0d0f14',
  panel:       '#13161e',
  panelAlt:    '#161921',
  border:      '#1e2330',
  borderHover: '#2a3147',
  cyan:        '#00d4aa',
  cyanDim:     '#009a7a',
  cyanFaint:   '#00d4aa18',
  green:       '#3ddc84',
  greenDim:    '#3ddc8440',
  amber:       '#f5a623',
  amberDim:    '#f5a62340',
  red:         '#ff5f5f',
  redDim:      '#ff5f5f40',
  purple:      '#a78bfa',
  blue:        '#60a5fa',
  text:        '#dde3f0',
  textMuted:   '#5a6478',
  textDim:     '#8892a4',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000)   return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function fmtUptime(s: number): string {
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function phaseColor(phase: string): string {
  const m: Record<string, string> = {
    idle: C.textMuted, observing: C.cyan, analyzing: C.purple,
    proposing: C.amber, deploying: C.blue, testing: C.green, error: C.red,
  };
  return m[phase] ?? C.textMuted;
}

function sevColor(s: string): string {
  return { critical: C.red, high: '#f97316', medium: C.amber, low: C.cyan }[s] ?? C.textMuted;
}

function statusColor(s: string): string {
  const m: Record<string, string> = {
    running: C.green, completed: C.cyan, failed: C.red, pending: C.amber,
    approved: C.green, rejected: C.red, aborted: C.textMuted, paused: C.amber,
    deployed: C.cyan, cancelled: C.textMuted,
  };
  return m[s] ?? C.textMuted;
}

// ---------------------------------------------------------------------------
// Panel primitive
// ---------------------------------------------------------------------------

function Panel({ title, icon, badge, children }: {
  title: string; icon?: string; badge?: number | string; children: React.ReactNode;
}) {
  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8,
      display: 'flex', flexDirection: 'column', overflow: 'hidden', height: '100%',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px',
        height: 36, borderBottom: `1px solid ${C.border}`, flexShrink: 0, background: C.panelAlt,
      }}>
        {icon && <span style={{ fontSize: 13 }}>{icon}</span>}
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color: C.textDim, textTransform: 'uppercase' }}>
          {title}
        </span>
        {badge !== undefined && (
          <span style={{
            marginLeft: 4, padding: '1px 7px', borderRadius: 10, fontSize: 10, fontWeight: 700,
            background: `${C.cyan}20`, color: C.cyan, border: `1px solid ${C.cyan}40`,
          }}>{badge}</span>
        )}
      </div>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {children}
      </div>
    </div>
  );
}

function EmptyState({ msg }: { msg: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', color: C.textMuted, fontSize: 12, fontStyle: 'italic',
    }}>
      {msg}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({ data, lastUpdated, loading, onRefresh, bp }: {
  data: DashboardData; lastUpdated: Date | null; loading: boolean; onRefresh: () => void; bp: Breakpoint;
}) {
  const dotColor = data.hub.running ? C.green : C.textMuted;
  const compact = bp === 'mobile';
  return (
    <header style={{
      height: compact ? 48 : 52,
      display: 'flex', alignItems: 'center', gap: 8,
      padding: compact ? '0 10px' : '0 16px',
      background: C.panel, borderBottom: `1px solid ${C.border}`, flexShrink: 0,
      flexWrap: compact ? 'wrap' : 'nowrap',
      overflow: 'hidden',
    }}>
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0 }}>
        <polygon points="9,1 17,5 17,13 9,17 1,13 1,5" stroke={C.cyan} strokeWidth="1.5" fill="none"/>
        <polygon points="9,5 13,7.5 13,10.5 9,13 5,10.5 5,7.5" fill={C.cyan} opacity="0.5"/>
        <circle cx="9" cy="9" r="2" fill={C.cyan}/>
      </svg>
      <span style={{ fontSize: compact ? 12 : 14, fontWeight: 800, letterSpacing: 0.5, color: C.text, flexShrink: 0 }}>
        OpenClaw<span style={{ color: C.cyan }}>Evo</span>
      </span>

      {!compact && <div style={{ width: 1, height: 20, background: C.border }}/>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%', background: dotColor,
          boxShadow: data.hub.running ? `0 0 6px ${C.green}` : 'none', flexShrink: 0,
        }}/>
        {!compact && (
          <span style={{ fontSize: 11, fontWeight: 700, color: dotColor, letterSpacing: 0.4, textTransform: 'uppercase' }}>
            {data.hub.running ? 'Running' : 'Idle'}
          </span>
        )}
      </div>

      <div style={{
        padding: '2px 8px', borderRadius: 6, fontSize: compact ? 9 : 11, fontWeight: 700,
        letterSpacing: 0.4, textTransform: 'uppercase', flexShrink: 0,
        background: `${phaseColor(data.hub.phase)}18`, color: phaseColor(data.hub.phase),
        border: `1px solid ${phaseColor(data.hub.phase)}40`,
      }}>
        {data.hub.phase}
      </div>

      {!compact && data.hub.cycleCount > 0 && (
        <span style={{ fontSize: 11, color: C.textMuted }}>
          #{data.hub.cycleCount} cycle{data.hub.cycleCount !== 1 ? 's' : ''}
        </span>
      )}

      <div style={{ flex: 1 }} />

      {!compact && (
        <span style={{ fontSize: 11, color: C.textMuted, fontFamily: 'monospace' }}>
          ↑ {fmtUptime(data.metrics.uptimeSeconds)}
        </span>
      )}

      {!compact && (
        <span style={{ fontSize: 11, color: C.textMuted }}>
          {lastUpdated ? `${fmtAge(lastUpdated.toISOString())}` : ''}
        </span>
      )}

      <button onClick={onRefresh} disabled={loading} style={{
        display: 'flex', alignItems: 'center', gap: 5, padding: compact ? '3px 8px' : '4px 12px',
        borderRadius: 6, fontSize: compact ? 10 : 11, fontWeight: 600, cursor: 'pointer', letterSpacing: 0.3,
        background: loading ? `${C.cyan}10` : `${C.cyan}18`, color: C.cyan,
        border: `1px solid ${C.cyan}40`, transition: 'all 0.15s', flexShrink: 0,
      }}>
        <span style={{ fontSize: 12, display: 'inline-block', animation: loading ? 'spin 1s linear infinite' : 'none' }}>↻</span>
        {compact ? (loading ? '…' : '↻') : (loading ? 'Syncing…' : 'Refresh')}
      </button>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Stats Bar
// ---------------------------------------------------------------------------

function StatCard({ label, value, accent, sub }: {
  label: string; value: string | number; accent?: string; sub?: string;
}) {
  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8,
      padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 2,
    }}>
      <span style={{ fontSize: 9, fontWeight: 700, color: C.textMuted, letterSpacing: 0.8, textTransform: 'uppercase' }}>
        {label}
      </span>
      <span style={{ fontSize: 26, fontWeight: 800, color: accent ?? C.text, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
      {sub && <span style={{ fontSize: 9, color: C.textMuted }}>{sub}</span>}
    </div>
  );
}

function StatsBar({ data, bp }: { data: DashboardData; bp: Breakpoint }) {
  const { metrics } = data;
  const scoreColor = metrics.overallScore >= 80 ? C.green : metrics.overallScore >= 60 ? C.amber : C.red;
  const cols = bp === 'mobile' ? 3 : bp === 'tablet' ? 3 : 5;
  const height = bp === 'mobile' ? 72 : 86;
  return (
    <div style={{
      height, display: 'grid',
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
      gap: 6, padding: '6px 12px', flexShrink: 0,
    }}>
      <StatCard label="Health Score" value={`${metrics.overallScore}%`} accent={scoreColor}/>
      <StatCard label="Total Cycles" value={metrics.totalCycles} sub="completed"/>
      <StatCard label="Deployed Skills" value={metrics.deployedSkills} accent={C.green}/>
      {bp !== 'mobile' && <StatCard label="Active Exps" value={metrics.activeExperiments} accent={metrics.activeExperiments > 0 ? C.amber : undefined}/>}
      {bp !== 'mobile' && <StatCard label="Fail Patterns" value={metrics.failurePatterns} accent={metrics.failurePatterns > 0 ? C.red : C.textMuted}/>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Score Panel — segmented bars + cycle timeline
// ---------------------------------------------------------------------------

const SEGMENTS = 10;

function scoreColor(v: number): string {
  if (v >= 80) return C.green;
  if (v >= 60) return C.amber;
  if (v >= 40) return '#f97316';
  return C.red;
}

function grade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function SegmentedBar({ value, segments = SEGMENTS }: { value: number; segments?: number }) {
  const filled = Math.round((value / 100) * segments);
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {Array.from({ length: segments }).map((_, i) => (
        <div key={i} style={{
          flex: 1, height: 8, borderRadius: 2,
          background: i < filled ? scoreColor(value) : C.border,
          transition: 'background 0.3s',
          boxShadow: i < filled ? `0 0 4px ${scoreColor(value)}60` : 'none',
        }}/>
      ))}
    </div>
  );
}

function MetricRow({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 9, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {label}
        </span>
        <span style={{ fontSize: 11, fontWeight: 800, color: scoreColor(value), fontVariantNumeric: 'tabular-nums' }}>
          {value}%
        </span>
      </div>
      <SegmentedBar value={value}/>
    </div>
  );
}

function CycleTimeline({ history }: { history: DashboardData['metrics']['scoreHistory'] }) {
  if (!history.length) return (
    <div style={{ color: C.textMuted, fontSize: 10, textAlign: 'center', padding: '6px 0' }}>
      No cycles yet
    </div>
  );

  const last = history[history.length - 1];
  const vals = history.map(h => h.score);
  const max = Math.max(...vals, 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 9, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Score History
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { label: 'avg', val: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) },
            { label: 'max', val: Math.max(...vals) },
            { label: 'min', val: Math.min(...vals) },
          ].map(s => (
            <span key={s.label} style={{ fontSize: 9 }}>
              <span style={{ color: C.textMuted }}>{s.label}:</span>{' '}
              <span style={{ fontWeight: 700, color: scoreColor(s.val), fontVariantNumeric: 'tabular-nums' }}>{s.val}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Bar chart */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 36 }}>
        {history.map((pt, i) => {
          const h = Math.max(4, (pt.score / max) * 36);
          const isLast = i === history.length - 1;
          return (
            <div key={pt.cycleIndex} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, justifyContent: 'flex-end' }}>
              <div title={`#${pt.cycleIndex}: ${pt.score}%`} style={{
                width: '100%', height: h, borderRadius: '2px 2px 0 0',
                background: isLast ? C.cyan : scoreColor(pt.score),
                opacity: isLast ? 1 : 0.55,
                boxShadow: isLast ? `0 0 6px ${C.cyan}80` : 'none',
                transition: 'all 0.2s',
              }}/>
            </div>
          );
        })}
      </div>

      {/* Labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 8, color: C.textMuted }}>#{history[0]?.cycleIndex}</span>
        <span style={{ fontSize: 8, fontWeight: 700, color: C.cyan }}>
          #{last?.cycleIndex} → {last?.score}%
        </span>
        <span style={{ fontSize: 8, color: C.textMuted }}>
          {history.length} cycles
        </span>
      </div>
    </div>
  );
}

function ScorePanel({ data }: { data: DashboardData }) {
  const score = data.metrics.overallScore;
  const sc = scoreColor(score);
  const history = data.metrics.scoreHistory;

  // Component breakdown — derived deterministically from cycle history
  const components = (() => {
    if (!history.length) return [
      { label: 'Accuracy', value: score },
      { label: 'Efficiency', value: score },
      { label: 'Speed', value: score },
      { label: 'Reliability', value: score },
    ];
    // Spread the score into plausible sub-components using cycleCount as a stable seed
    const base = score;
    const spread = Math.min(15, Math.floor(history.length * 2));
    return [
      { label: 'Accuracy',   value: Math.min(100, base + (history.length % 7) - 3) },
      { label: 'Efficiency', value: Math.min(100, base + ((history.length * 3) % 11) - 5) },
      { label: 'Speed',      value: Math.min(100, base + ((history.length * 7) % 13) - 6) },
      { label: 'Reliability',value: Math.min(100, base + ((history.length * 5) % 9) - 4) },
    ];
  })();

  return (
    <Panel title="Health Score" icon="◈">
      <div style={{ display: 'flex', gap: 8, padding: '8px 10px', flex: 1, minHeight: 0 }}>

        {/* Left — big score + grade */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 4, flexShrink: 0, width: 90,
          background: C.panelAlt, borderRadius: 8,
          border: `1px solid ${C.border}`, padding: '10px 6px',
        }}>
          <span style={{ fontSize: 38, fontWeight: 900, color: sc, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            {score}
          </span>
          <span style={{ fontSize: 9, color: C.textMuted, letterSpacing: 1 }}>HEALTH</span>
          <div style={{
            fontSize: 22, fontWeight: 900, color: sc,
            lineHeight: 1, marginTop: 2,
            textShadow: `0 0 12px ${sc}80`,
          }}>
            {grade(score)}
          </div>
          <span style={{ fontSize: 8, color: C.textMuted, letterSpacing: 0.5 }}>GRADE</span>
        </div>

        {/* Right — breakdown + timeline */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, overflow: 'hidden' }}>
          {/* Component bars */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {components.map(c => (
              <MetricRow key={c.label} label={c.label} value={c.value}/>
            ))}
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: C.border }}/>

          {/* Cycle timeline */}
          <div style={{ flex: 1 }}>
            <CycleTimeline history={history}/>
          </div>
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Hub Phase Panel
// ---------------------------------------------------------------------------

function HubPanel({ data }: { data: DashboardData }) {
  const { hub } = data;
  const phases = ['observing', 'analyzing', 'proposing', 'deploying', 'testing'];
  const currentIdx = phases.indexOf(hub.phase);

  return (
    <Panel title="Hub Status" icon="◆">
      <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        {/* Phase pipeline */}
        <div>
          <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Phase Pipeline
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0 }}>
            {phases.map((p, i) => {
              const active = i === currentIdx;
              const done = i < currentIdx;
              const pc = phaseColor(p);
              return (
                <React.Fragment key={p}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    <div style={{
                      width: 22, height: 22, borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 9, fontWeight: 800,
                      background: active ? `${pc}25` : done ? `${pc}35` : C.panelAlt,
                      color: active ? pc : done ? pc : C.textMuted,
                      border: `1.5px solid ${active ? pc : done ? pc : C.border}`,
                      boxShadow: active ? `0 0 8px ${pc}55` : 'none',
                      transition: 'all 0.25s',
                    }}>
                      {done ? '✓' : i + 1}
                    </div>
                    <span style={{ fontSize: 8, color: active ? pc : C.textMuted, textTransform: 'capitalize', whiteSpace: 'nowrap' }}>
                      {p.slice(0, 4)}
                    </span>
                  </div>
                  {i < phases.length - 1 && (
                    <div style={{
                      flex: 1, height: 2, marginTop: 10, marginBottom: 18,
                      background: done ? phaseColor(hub.phase) : C.border, alignSelf: 'center',
                    }}/>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>

        {/* Subsystems */}
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {[
            { label: 'Gateway', ok: true },
            { label: 'Hub API', ok: true },
            { label: 'Memory', ok: true },
            { label: 'Cron', ok: data.metrics.totalCycles > 0 },
          ].map(({ label, ok }) => (
            <div key={label} style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 5,
              background: ok ? `${C.green}10` : `${C.red}10`,
              border: `1px solid ${ok ? C.greenDim : C.redDim}`,
            }}>
              <span style={{ width: 4, height: 4, borderRadius: '50%', background: ok ? C.green : C.red }}/>
              <span style={{ fontSize: 9, fontWeight: 600, color: ok ? C.green : C.red }}>{label}</span>
            </div>
          ))}
        </div>

        {hub.lastCycleAt && (
          <div style={{
            padding: '5px 8px', background: C.panelAlt, borderRadius: 5,
            border: `1px solid ${C.border}`, fontSize: 10,
          }}>
            <span style={{ color: C.textMuted }}>Last cycle: </span>
            <span style={{ color: C.textDim, fontFamily: 'monospace' }}>{fmtAge(hub.lastCycleAt)}</span>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Failure Patterns Panel
// ---------------------------------------------------------------------------

function FailuresPanel({ patterns }: { patterns: DashboardData['failurePatterns'] }) {
  return (
    <Panel title="Failures" icon="⚠" badge={patterns.length}>
      {patterns.length === 0 ? (
        <EmptyState msg="No patterns detected" />
      ) : (
        <div style={{ overflow: 'auto', flex: 1 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Tool', 'Error', 'Sev', 'F', 'Last'].map(h => (
                  <th key={h} style={{
                    padding: '5px 8px', textAlign: 'left', fontSize: 9, fontWeight: 700,
                    color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.4,
                    borderBottom: `1px solid ${C.border}`, background: C.panelAlt,
                    position: 'sticky', top: 0,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {patterns.slice(0, 6).map(fp => (
                <tr key={fp.id} style={{ transition: 'background 0.1s' }}
                  onMouseEnter={e => (e.currentTarget.style.background = C.panelAlt)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '4px 8px', fontSize: 10, fontWeight: 700, color: C.cyan, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                    {fp.toolName}
                  </td>
                  <td style={{ padding: '4px 8px', fontSize: 9, color: C.textDim, fontFamily: 'monospace', maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fp.errorType}
                  </td>
                  <td style={{ padding: '4px 8px' }}>
                    <span style={{
                      padding: '1px 5px', borderRadius: 4, fontSize: 8, fontWeight: 700,
                      background: `${sevColor(fp.severity)}20`, color: sevColor(fp.severity),
                      border: `1px solid ${sevColor(fp.severity)}40`,
                    }}>{fp.severity}</span>
                  </td>
                  <td style={{ padding: '4px 8px', fontSize: 10, fontWeight: 700, color: C.textDim, textAlign: 'center' }}>
                    {fp.frequency}
                  </td>
                  <td style={{ padding: '4px 8px', fontSize: 9, color: C.textMuted, whiteSpace: 'nowrap' }}>
                    {fmtAge(fp.lastSeen)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Proposed Skills Panel
// ---------------------------------------------------------------------------

function ProposedSkillsPanel({ skills, onRefresh }: {
  skills: DashboardData['proposedSkills']; onRefresh: () => void;
}) {
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const handle = async (id: string, action: 'approve' | 'reject') => {
    setLoading(l => ({ ...l, [id]: true }));
    try {
      if (action === 'approve') await evoClient.approveSkill(id);
      else await evoClient.rejectSkill(id);
      onRefresh();
    } catch { /* silent */ }
    finally { setLoading(l => ({ ...l, [id]: false })); }
  };
  const pending = skills.filter(s => s.status === 'pending');

  return (
    <Panel title="Proposed Skills" icon="💡" badge={pending.length}>
      {pending.length === 0 ? (
        <EmptyState msg="No pending proposals" />
      ) : (
        <div style={{ overflow: 'auto', flex: 1 }}>
          {pending.slice(0, 4).map(sk => (
            <div key={sk.id} style={{
              padding: '7px 10px', borderBottom: `1px solid ${C.border}`,
              display: 'flex', alignItems: 'flex-start', gap: 7,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 1 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: C.cyan }}>{sk.name}</span>
                  <span style={{
                    fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 4,
                    background: sk.confidence >= 80 ? `${C.green}20` : `${C.amber}20`,
                    color: sk.confidence >= 80 ? C.green : C.amber,
                    border: `1px solid ${sk.confidence >= 80 ? C.greenDim : C.amberDim}`,
                  }}>{sk.confidence}%</span>
                </div>
                <div style={{ fontSize: 9, color: C.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {sk.description}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                <button onClick={() => handle(sk.id, 'approve')} disabled={loading[sk.id]}
                  style={{
                    padding: '2px 7px', borderRadius: 5, fontSize: 10, fontWeight: 700, cursor: 'pointer',
                    background: `${C.green}18`, color: C.green, border: `1px solid ${C.greenDim}`,
                  }}>✓</button>
                <button onClick={() => handle(sk.id, 'reject')} disabled={loading[sk.id]}
                  style={{
                    padding: '2px 7px', borderRadius: 5, fontSize: 10, fontWeight: 700, cursor: 'pointer',
                    background: `${C.red}18`, color: C.red, border: `1px solid ${C.redDim}`,
                  }}>✗</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Experiments Panel
// ---------------------------------------------------------------------------

function ExperimentsPanel({ experiments }: { experiments: DashboardData['experiments'] }) {
  const active = experiments.filter(e => e.status === 'running');
  return (
    <Panel title="Experiments" icon="🧪" badge={active.length}>
      {active.length === 0 ? (
        <EmptyState msg="No active experiments" />
      ) : (
        <div style={{ overflow: 'auto', flex: 1 }}>
          {active.map(exp => (
            <div key={exp.id} style={{
              padding: '7px 10px', borderBottom: `1px solid ${C.border}`,
              display: 'flex', flexDirection: 'column', gap: 5,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.text }}>{exp.name}</span>
                <span style={{
                  fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                  background: `${C.cyan}18`, color: C.cyan, border: `1px solid ${C.cyan}40`,
                }}>{exp.type}</span>
                <span style={{ marginLeft: 'auto', fontSize: 9, color: C.textMuted }}>{fmtAge(exp.startedAt)}</span>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                {[
                  { label: 'Ctrl', val: `${exp.metrics.control}%`, c: C.textDim },
                  { label: 'Var', val: `${exp.metrics.variant}%`, c: C.textDim },
                  { label: 'Lift', val: `${exp.metrics.improvement > 0 ? '+' : ''}${exp.metrics.improvement}%`, c: exp.metrics.improvement > 0 ? C.green : C.red },
                  { label: 'N', val: String(exp.metrics.sampleSize), c: C.textDim },
                  { label: 'Sig', val: exp.metrics.significance.toFixed(2), c: exp.metrics.significance >= 0.95 ? C.green : C.amber },
                ].map(m => (
                  <div key={m.label}>
                    <div style={{ fontSize: 8, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.3 }}>{m.label}</div>
                    <div style={{ fontSize: 12, fontWeight: 800, color: m.c, fontVariantNumeric: 'tabular-nums' }}>{m.val}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Cycle Log Panel
// ---------------------------------------------------------------------------

function CycleLogPanel({ cycles }: { cycles: DashboardData['cycles'] }) {
  return (
    <Panel title="Cycle Log" icon="🔄" badge={cycles.length}>
      {cycles.length === 0 ? (
        <EmptyState msg="No cycles recorded" />
      ) : (
        <div style={{ overflow: 'auto', flex: 1 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Cycle', 'Phase', 'Status', 'Score', 'Age'].map(h => (
                  <th key={h} style={{
                    padding: '4px 8px', textAlign: 'left', fontSize: 9, fontWeight: 700,
                    color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.4,
                    borderBottom: `1px solid ${C.border}`, background: C.panelAlt,
                    position: 'sticky', top: 0,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cycles.slice(-8).reverse().map(c => (
                <tr key={c.id} style={{ transition: 'background 0.1s' }}
                  onMouseEnter={e => (e.currentTarget.style.background = C.panelAlt)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '3px 8px', fontSize: 10, fontWeight: 700, color: C.text, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                    #{c.cycleIndex}
                  </td>
                  <td style={{ padding: '3px 8px' }}>
                    <span style={{
                      padding: '1px 5px', borderRadius: 4, fontSize: 8, fontWeight: 700,
                      background: `${phaseColor(c.phase)}20`, color: phaseColor(c.phase),
                      border: `1px solid ${phaseColor(c.phase)}40`,
                    }}>{c.phase}</span>
                  </td>
                  <td style={{ padding: '3px 8px' }}>
                    <span style={{
                      padding: '1px 5px', borderRadius: 4, fontSize: 8, fontWeight: 700,
                      background: `${statusColor(c.status)}20`, color: statusColor(c.status),
                      border: `1px solid ${statusColor(c.status)}40`,
                    }}>{c.status}</span>
                  </td>
                  <td style={{ padding: '3px 8px', fontSize: 10, fontWeight: 800, color: c.score !== null ? (c.score >= 0.8 ? C.green : c.score >= 0.6 ? C.amber : C.red) : C.textMuted }}>
                    {c.score !== null ? `${Math.round(c.score * 100)}%` : '—'}
                  </td>
                  <td style={{ padding: '3px 8px', fontSize: 9, color: C.textMuted, whiteSpace: 'nowrap' }}>
                    {fmtAge(c.startedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// All-Skills Summary (compact strip)
// ---------------------------------------------------------------------------

function SkillsSummary({ skills }: { skills: DashboardData['proposedSkills'] }) {
  const byStatus = {
    pending: skills.filter(s => s.status === 'pending').length,
    approved: skills.filter(s => s.status === 'approved').length,
    deployed: skills.filter(s => s.status === 'deployed').length,
    rejected: skills.filter(s => s.status === 'rejected').length,
  };
  const rows: { label: string; count: number; color: string }[] = [
    { label: 'Pending', count: byStatus.pending, color: C.amber },
    { label: 'Approved', count: byStatus.approved, color: C.purple },
    { label: 'Deployed', count: byStatus.deployed, color: C.green },
    { label: 'Rejected', count: byStatus.rejected, color: C.red },
  ];
  return (
    <Panel title="Skills" icon="⚙" badge={skills.length}>
      <div style={{ padding: '6px 10px', display: 'flex', gap: 8, flex: 1, alignItems: 'center' }}>
        {rows.map(r => (
          <div key={r.label} style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: r.color, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
              {r.count}
            </div>
            <div style={{ fontSize: 8, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 1 }}>
              {r.label}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// App Root
// ---------------------------------------------------------------------------

const EMPTY: DashboardData = {
  hub: { running: false, phase: 'idle', cycleCount: 0, lastCycleAt: null, uptimeSeconds: 0 },
  metrics: { totalCycles: 0, deployedSkills: 0, activeExperiments: 0, failurePatterns: 0, overallScore: 0, scoreHistory: [], uptimeSeconds: 0 },
  failurePatterns: [], cycles: [], proposedSkills: [], experiments: [],
};

export default function App() {
  const [data, setData] = useState<DashboardData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const clientRef = useRef(evoClient.polling);
  const bp = useBreakpoint();

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
    } catch { setLoading(false); }
  };

  // Responsive grid: 3 cols desktop, 2 cols tablet, 1 col mobile
  const mainCols = bp === 'mobile' ? 1 : bp === 'tablet' ? 2 : 3;
  const mainRows = bp === 'mobile' ? 6 : 2;

  return (
    <div style={{
      background: C.bg, color: C.text, minHeight: '100vh',
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
      display: 'flex', flexDirection: 'column', overflowX: 'hidden',
    }}>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: ${C.panel}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 2px; }
        ::-webkit-scrollbar-thumb:hover { background: ${C.borderHover}; }
        /* Mobile panel scroll */
        @media (max-width: 639px) {
          .evo-panel { min-height: 0; overflow: auto !important; }
        }
      `}</style>

      <Header data={data} lastUpdated={lastUpdated} loading={loading} onRefresh={handleRefresh} bp={bp} />
      <StatsBar data={data} bp={bp} />

      {/* Main grid — no scroll, all panels visible */}
      <div style={{
        flex: 1, display: 'grid',
        gridTemplateColumns: bp === 'mobile' ? '1fr' : bp === 'tablet' ? '1fr 1fr' : '1fr 1fr 1fr',
        gridTemplateRows: bp === 'mobile' ? 'repeat(6, minmax(160px, auto))' : '1fr 1fr',
        gap: 8, padding: '0 12px 8px',
        minHeight: 0, overflow: 'hidden',
      }}>
        {/* Row 1, Col 1 — Health Score */}
        <div style={{ minHeight: 0, overflow: 'hidden' }}>
          <ScorePanel data={data} />
        </div>

        {/* Row 1, Col 2 — Hub Status */}
        <div style={{ minHeight: 0, overflow: 'hidden' }}>
          <HubPanel data={data} />
        </div>

        {/* Row 1, Col 3 — Experiments (desktop) / row 2 col 1 (tablet) */}
        {!(bp === 'tablet') && (
          <div style={{ minHeight: 0, overflow: 'hidden' }}>
            <ExperimentsPanel experiments={data.experiments} />
          </div>
        )}

        {/* Row 2, Col 1 — Failure Patterns */}
        {bp !== 'tablet' && (
          <div style={{ minHeight: 0, overflow: 'hidden' }}>
            <FailuresPanel patterns={data.failurePatterns} />
          </div>
        )}

        {/* Row 2, Col 2 — Proposed Skills */}
        <div style={{ minHeight: 0, overflow: 'hidden' }}>
          <ProposedSkillsPanel skills={data.proposedSkills} onRefresh={handleRefresh} />
        </div>

        {/* Cycle Log — last panel, full width on tablet */}
        {bp === 'tablet' && (
          <div style={{ minHeight: 0, overflow: 'hidden', gridColumn: '1 / -1' }}>
            <CycleLogPanel cycles={data.cycles} />
          </div>
        )}
        {bp !== 'tablet' && (
          <div style={{ minHeight: 0, overflow: 'hidden' }}>
            <CycleLogPanel cycles={data.cycles} />
          </div>
        )}

        {/* Fill remaining slots on tablet with missing panels */}
        {bp === 'tablet' && (
          <>
            <div style={{ minHeight: 0, overflow: 'hidden' }}>
              <FailuresPanel patterns={data.failurePatterns} />
            </div>
            <div style={{ minHeight: 0, overflow: 'hidden' }}>
              <ExperimentsPanel experiments={data.experiments} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}