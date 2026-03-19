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
import crypto from 'node:crypto';
import { EvoHub } from './hub.js';
import { promoter } from './experiment/promoter.js';
import { DEFAULT_CONFIG } from './constants.js';

const PORT = 5174;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'openclaw-evo-webhook-secret';
const VALID_EVENTS = ['skill_promoted', 'skill_approved', 'experiment_completed', 'cycle_completed'] as const;
type WebhookEvent = typeof VALID_EVENTS[number];

interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  createdAt: string;
}

// Lazily initialise hub so the server starts even if the gateway
// isn't reachable yet.
let hub: EvoHub | null = null;
function getHub(): EvoHub {
  if (!hub) {
    hub = new EvoHub(DEFAULT_CONFIG);
  }
  return hub;
}

// ── Webhook store ──────────────────────────────────────────────────────────
const webhooks = new Map<string, Webhook>();

function generateId(): string {
  return crypto.randomUUID();
}

function signPayload(payload: string): string {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
}

async function callWebhooks(event: WebhookEvent, data: unknown): Promise<void> {
  const timestamp = new Date().toISOString();
  const payload = JSON.stringify({ event, timestamp, data });
  const signature = signPayload(payload);

  const matches = [...webhooks.values()].filter((wh) => wh.events.includes(event));

  await Promise.allSettled(
    matches.map(async (wh) => {
      try {
        await fetch(wh.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature': signature,
            'X-Event': event,
            'X-Webhook-ID': wh.id,
          },
          body: payload,
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        console.error(`[webhooks] Failed to deliver ${event} to ${wh.url}:`, err);
      }
    }),
  );
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
  const method = req.method ?? 'GET';

  // Helper to read request body for POST/PUT
  function readBody(): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

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

    // GET /api/approvals/pending
    if (method === 'GET' && url === '/api/approvals/pending') {
      jsonResponse(res, 200, promoter.getPendingApprovals());
      return;
    }

    // POST /api/approvals/:id/approve
    if (method === 'POST' && url.match(/^\/api\/approvals\/([^/]+)\/approve$/)) {
      const approvalId = url.match(/^\/api\/approvals\/([^/]+)\/approve$/)![1];
      promoter.approveSkill(approvalId)
        .then(() => jsonResponse(res, 200, { ok: true, approvalId }))
        .catch((err) => sendError(res, 400, err instanceof Error ? err.message : String(err)));
      return;
    }

    // POST /api/approvals/:id/reject
    if (method === 'POST' && url.match(/^\/api\/approvals\/([^/]+)\/reject$/)) {
      const approvalId = url.match(/^\/api\/approvals\/([^/]+)\/reject$/)![1];
      try {
        promoter.rejectSkill(approvalId);
        jsonResponse(res, 200, { ok: true, approvalId });
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // GET /api/webhooks
    if (method === 'GET' && url === '/api/webhooks') {
      jsonResponse(res, 200, [...webhooks.values()]);
      return;
    }

    // POST /api/webhooks
    if (method === 'POST' && url === '/api/webhooks') {
      readBody().then((raw) => {
        let body: { url?: unknown; events?: unknown };
        try {
          body = JSON.parse(raw);
        } catch {
          sendError(res, 400, 'Invalid JSON body');
          return;
        }
        if (!body.url || typeof body.url !== 'string') {
          sendError(res, 400, 'url is required and must be a string');
          return;
        }
        if (!Array.isArray(body.events) || !body.events.every((e) => VALID_EVENTS.includes(e as WebhookEvent))) {
          sendError(res, 400, `events must be an array of: ${VALID_EVENTS.join(', ')}`);
          return;
        }
        const webhook: Webhook = {
          id: generateId(),
          url: body.url,
          events: body.events as WebhookEvent[],
          createdAt: new Date().toISOString(),
        };
        webhooks.set(webhook.id, webhook);
        jsonResponse(res, 201, webhook);
      });
      return;
    }

    // DELETE /api/webhooks/:id
    if (method === 'DELETE' && url.match(/^\/api\/webhooks\/([^/]+)$/)) {
      const id = url.match(/^\/api\/webhooks\/([^/]+)$/)![1];
      if (!webhooks.has(id)) {
        sendError(res, 404, `Webhook not found: ${id}`);
        return;
      }
      webhooks.delete(id);
      jsonResponse(res, 200, { ok: true, id });
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
  console.log('  GET  /api/health              → { ok, ts }');
  console.log('  GET  /api/status              → hub status');
  console.log('  GET  /api/skills              → proposed skills');
  console.log('  GET  /api/experiments         → active experiments');
  console.log('  GET  /api/metrics             → gateway dashboard metrics');
  console.log('  GET  /api/approvals/pending   → pending approvals');
  console.log('  POST /api/approvals/:id/approve → approve a skill');
  console.log('  POST /api/approvals/:id/reject  → reject a skill');
  console.log('  GET  /api/webhooks            → list registered webhooks');
  console.log('  POST /api/webhooks            → register webhook { url, events[] }');
  console.log('  DELETE /api/webhooks/:id       → remove a webhook');
});
