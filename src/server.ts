/**
 * Simple HTTP API server for the OpenClaw Evo dashboard.
 *
 * Runs on port 5174 (same port as the Vite dashboard dev server).
 * Provides JSON endpoints for hub and gateway status.
 *
 * Endpoints:
 *   GET /api/status       → hub.getStatus()
 *   GET /api/skills       → hub.getProposedSkills()
 *   GET /api/experiments  → hub.getActiveExperiments()
 *   GET /api/metrics      → dashboard metrics from OpenClaw gateway
 *   GET /api/health       → { ok: true }
 *
 * All responses are JSON. Unknown routes return 404.
 */

import http from 'node:http';
import { EvoHub } from './hub.js';
import { DEFAULT_CONFIG } from './constants.js';

const PORT = 5174;

// Lazily initialise hub so the server starts even if the gateway
// isn't reachable yet.
let hub: EvoHub | null = null;
function getHub(): EvoHub {
  if (!hub) {
    hub = new EvoHub(DEFAULT_CONFIG);
  }
  return hub;
}

// ── Dashboard metrics from the OpenClaw gateway ───────────────────────────

async function fetchGatewayMetrics(): Promise<unknown> {
  const gatewayUrl = DEFAULT_CONFIG.OPENCLAW_GATEWAY_URL ?? 'http://localhost:18789';
  try {
    const res = await fetch(`${gatewayUrl}/api/dashboard/metrics`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { error: `Gateway returned ${res.status}` };
    return await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Gateway unreachable: ${message}` };
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  jsonResponse(res, status, { error: message });
}

// ── Request router ────────────────────────────────────────────────────────

function route(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? '/';

  try {
    if (url === '/api/health') {
      jsonResponse(res, 200, { ok: true, ts: new Date().toISOString() });
      return;
    }

    if (url === '/api/status') {
      jsonResponse(res, 200, getHub().getStatus());
      return;
    }

    if (url === '/api/skills') {
      jsonResponse(res, 200, getHub().getProposedSkills());
      return;
    }

    if (url === '/api/experiments') {
      jsonResponse(res, 200, getHub().getActiveExperiments());
      return;
    }

    if (url === '/api/metrics') {
      fetchGatewayMetrics()
        .then((metrics) => jsonResponse(res, 200, metrics))
        .catch((err) => sendError(res, 500, String(err)));
      return;
    }

    sendError(res, 404, `Route not found: ${url}`);
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : String(err));
  }
}

// ── Server bootstrap ────────────────────────────────────────────────────────

const server = http.createServer(route);

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`OpenClaw Evo API server running on http://localhost:${PORT}`);
  console.log('  GET /api/health       → { ok, ts }');
  console.log('  GET /api/status      → hub status');
  console.log('  GET /api/skills      → proposed skills');
  console.log('  GET /api/experiments → active experiments');
  console.log('  GET /api/metrics     → gateway dashboard metrics');
});
