/**
 * formatDuration — Convert milliseconds to a human-readable duration string.
 * Examples: 154000 → "2m 34s", 3600000 → "1h 0m", 45000 → "45s"
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * formatPercent — Format a number 0–100 as a percentage string.
 * Example: 85.237 → "85.2%"
 */
export function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return '0.0%';
  return `${n.toFixed(1)}%`;
}

/**
 * formatDate — Format a Date for display.
 * If today: "15:04:32" (time only)
 * Otherwise: "Mar 19 12:34" (abbreviated month + day + time)
 */
export function formatDate(d: Date): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  const timeStr = `${hh}:${mm}:${ss}`;

  if (isToday) return timeStr;

  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const mon = months[d.getMonth()];
  const day = d.getDate().toString().padStart(2, '0');
  return `${mon} ${day} ${timeStr}`;
}

/**
 * calculateTrend — Detect direction of a numeric series.
 * Requires at least 2 data points.
 */
export function calculateTrend(values: number[]): 'up' | 'down' | 'stable' {
  if (!Array.isArray(values) || values.length < 2) return 'stable';
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return 'stable';

  // Simple linear regression slope
  const n = valid.length;
  const sumX = (n * (n - 1)) / 2;
  const sumY = valid.reduce((a, b) => a + b, 0);
  const sumXY = valid.reduce((acc, y, x) => acc + x * y, 0);
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 'stable';

  const slope = (n * sumXY - sumX * sumY) / denominator;

  // Threshold of ~0.01 per step to avoid noise
  const threshold = 0.01;
  if (slope > threshold) return 'up';
  if (slope < -threshold) return 'down';
  return 'stable';
}

/**
 * colorForScore — Return a CSS color string for a score 0–100.
 *   0–39  → red   ("#ef4444")
 *   40–69 → yellow("#eab308")
 *   70–100 → green ("#22c55e")
 */
export function colorForScore(score: number): string {
  if (!Number.isFinite(score)) return '#9ca3af';
  if (score >= 70) return '#22c55e';
  if (score >= 40) return '#eab308';
  return '#ef4444';
}
