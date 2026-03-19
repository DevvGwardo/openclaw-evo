/**
 * HTTP API server for the OpenClaw Evo dashboard.
 *
 * Can be started standalone or embedded in the CLI via startServer(hub).
 *
 * Endpoints:
 *   GET /api/status              → hub.getStatus()
 *   GET /api/skills              → hub.getProposedSkills()
 *   GET /api/experiments         → hub.getActiveExperiments()
 *   GET /api/cycles              → hub.getCompletedCycles()
 *   GET /api/metrics             → dashboard metrics from OpenClaw gateway
 *   GET /api/health              → { ok: true }
 *   GET /api/approvals/pending   → pending skill approvals
 *   POST /api/approvals/:id/approve
 *   POST /api/approvals/:id/reject
 *   GET /api/webhooks
 *   POST /api/webhooks
 *   DELETE /api/webhooks/:id
 *
 * Static files: serves the built dashboard from dist/ for non-API routes.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvoHub } from './hub.js';
import { promoter } from './experiment/promoter.js';
import { DEFAULT_CONFIG } from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Dashboard builds to dashboard/dist/ via vite build
const DIST_DIR = path.resolve(__dirname, '..', 'dashboard', 'dist');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'openclaw-evo-webhook-secret';
const VALID_EVENTS = ['skill_promoted', 'skill_approved', 'experiment_completed', 'cycle_completed'] as const;
type WebhookEvent = typeof VALID_EVENTS[number];

interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  createdAt: string;
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

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  // Map / to /index.html
  let filePath = path.join(DIST_DIR, urlPath === '/' ? 'index.html' : urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(DIST_DIR)) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  // If file doesn't exist, serve index.html (SPA fallback)
  if (!fs.existsSync(filePath)) {
    filePath = path.join(DIST_DIR, 'index.html');
  }

  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=31536000',
    });
    res.end(content);
  } catch {
    sendError(res, 404, 'Not found');
  }
}

// ── Request router ────────────────────────────────────────────────────────

function createRouter(hub: EvoHub) {
  return function route(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    function readBody(): Promise<string> {
      return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk));
        req.on('end', () => resolve(body));
        req.on('error', reject);
      });
    }

    try {
      // ── API routes ──────────────────────────────────────────────────────

      if (url === '/api/health') {
        jsonResponse(res, 200, { ok: true, ts: new Date().toISOString() });
        return;
      }

      if (url === '/api/status') {
        jsonResponse(res, 200, hub.getStatus());
        return;
      }

      if (url === '/api/skills') {
        jsonResponse(res, 200, hub.getProposedSkills());
        return;
      }

      if (url === '/api/experiments') {
        jsonResponse(res, 200, hub.getActiveExperiments());
        return;
      }

      if (url === '/api/cycles') {
        jsonResponse(res, 200, hub.getCompletedCycles());
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
          .then(() => {
            void callWebhooks('skill_approved', { approvalId });
            jsonResponse(res, 200, { ok: true, approvalId });
          })
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

      // ── API 404 ─────────────────────────────────────────────────────────
      if (url.startsWith('/api/')) {
        sendError(res, 404, `Route not found: ${url}`);
        return;
      }

      // ── Static files (dashboard) ────────────────────────────────────────
      serveStatic(res, url);

    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
  };
}

// ── Exported start function ──────────────────────────────────────────────

export function startServer(hub: EvoHub, port?: number): http.Server {
  const p = port ?? DEFAULT_CONFIG.DASHBOARD_PORT;
  const server = http.createServer(createRouter(hub));

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[server] Port ${p} in use — dashboard API not started`);
    } else {
      console.error('[server] Server error:', err);
    }
  });

  server.listen(p, () => {
    const hasDist = fs.existsSync(path.join(DIST_DIR, 'index.html'));
    console.log(`[server] Dashboard API running on http://localhost:${p}`);
    if (hasDist) {
      console.log(`[server] Dashboard UI available at http://localhost:${p}`);
    } else {
      console.log(`[server] Dashboard UI not built — run \`npm run build\` first`);
    }
  });

  return server;
}

// ── Standalone mode ──────────────────────────────────────────────────────
// When run directly (not imported), start with a fresh hub
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url).includes(process.argv[1]);
if (isMainModule) {
  const hub = new EvoHub(DEFAULT_CONFIG);
  void hub.start();
  startServer(hub);
}
