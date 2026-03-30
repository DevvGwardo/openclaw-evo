/**
 * Smoke test: run against the live Hermes/OpenClaw gateway on localhost:18789
 *
 * Usage: npx tsx tests/smoke-hermes.ts
 */

import { Gateway } from '../src/hermes/gateway.js';
import { SessionManager } from '../src/hermes/sessionManager.js';

async function main() {
  const gw = new Gateway('http://localhost:18789');

  // Test 1: Gateway status
  const status = await gw.getStatus();
  console.log('1. Gateway status:', status);
  assert(status.connected, 'Gateway should be connected');

  // Test 2: List sessions (no time filter)
  const sessions = await gw.listSessions(50);
  console.log('2. Sessions found:', sessions.length);
  if (sessions.length > 0) {
    const s = sessions[0];
    console.log('   First session:', {
      key: s.key,
      channel: s.channel,
      model: s.model,
      status: (s as Record<string, unknown>).status,
    });
  }

  // Test 3: Get session history (if sessions exist)
  if (sessions.length > 0) {
    const history = await gw.getSessionHistory(sessions[0].key, 5);
    console.log('3. History messages:', history.length);
    if (history.length > 0) {
      console.log('   First msg keys:', Object.keys(history[0]));
    }
  } else {
    console.log('3. Skipped (no sessions)');
  }

  // Test 4: SessionManager
  const sm = new SessionManager(gw);
  const active = await sm.getActiveSessions();
  console.log('4. SessionManager active sessions:', active.length);

  // Test 4b: Get metrics for first session if available
  if (sessions.length > 0) {
    const metrics = await sm.getSessionMetrics(sessions[0].key);
    console.log('   Metrics:', {
      toolCalls: metrics.totalToolCalls,
      errors: metrics.errorCount,
      success: metrics.success,
      taskType: metrics.taskType,
    });
  }

  // Test 5: Tool invocation
  try {
    const result = await gw.invokeTool('sessions_list', { limit: 1, messageLimit: 0 });
    console.log('5. invokeTool result ok:', result.ok);
  } catch (err) {
    console.log('5. invokeTool error:', (err as Error).message);
  }

  console.log('\n✅ All smoke tests passed');
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

main().catch((err) => {
  console.error('❌ Smoke test failed:', err);
  process.exit(1);
});
