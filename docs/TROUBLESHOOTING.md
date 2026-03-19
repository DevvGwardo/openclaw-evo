# Troubleshooting Guide

Common issues encountered when running the OpenClaw Evolution system, with causes and fixes.

---

## Hub Won't Start

**Symptom:** The hub fails to start or is unreachable.

**Cause:** The OpenClaw Gateway is not running, or is not listening on the expected port.

**Fix:**
1. Verify the Gateway is running:
   ```bash
   openclaw gateway status
   ```
2. If it's not running, start it:
   ```bash
   openclaw gateway start
   ```
3. Confirm it is listening on port **18789**:
   ```bash
   lsof -i :18789
   ```
4. Check that `OPENCLAW_GATEWAY_URL` (default `http://localhost:18789`) is set in your environment and matches the actual gateway address. For remote setups, ensure the URL is reachable from the machine running the evolver.

---

## Tests Failing

**Symptom:** `npm test` or the test suite exits with non-zero status.

**Cause:** Usually an unsupported or mismatched Node.js version.

**Fix:**
1. Check your Node.js version (minimum required: **v20.0.0**):
   ```bash
   node --version
   ```
2. If below v20, install a newer version using nvm:
   ```bash
   nvm install 20
   nvm use 20
   ```
3. Re-run the test suite:
   ```bash
   npm test
   ```
4. If tests still fail after confirming the version, check for failing lint rules with `npm run lint` or inspect the test output for the specific assertion that failed.

---

## Skills Not Deploying

**Symptom:** A skill template builds successfully but never appears in `~/.openclaw/skills/`.

**Cause:** The skills directory is not writable, or the deploy step ran with insufficient permissions.

**Fix:**
1. Verify the directory exists and is writable:
   ```bash
   ls -la ~/.openclaw/skills/
   ```
2. Fix permissions if needed:
   ```bash
   chmod -R 755 ~/.openclaw/skills/
   ```
3. Re-run the deploy step manually:
   ```bash
   ./scripts/deploy-skills.sh
   ```
4. If running in CI, ensure the deploy job has write access to the skills path on the target system.

---

## Memory Errors / Evolution Crashes

**Symptom:** The evolver throws an out-of-memory error, or the process is killed unexpectedly. Logs show `EvoRunner` failing to initialize.

**Cause:** Insufficient disk space or memory allocated to the Node.js process.

**Fix:**
1. Check available disk space:
   ```bash
   df -h .
   ```
2. To reset all evolution state and cached memory:
   ```bash
   rm -rf ~/.openclaw/evo-memory/
   ```
   > This deletes all saved evolution history. Use with caution in production.
3. Increase the Node.js heap limit if needed (for large skill evaluations):
   ```bash
   NODE_OPTIONS="--max-old-space-size=4096" node src/evoloop.js
   ```
4. Restart the hub after clearing memory.

---

## GitHub Actions — Missing Secrets

**Symptom:** CI workflow fails immediately with an error like `OPENCLAW_GATEWAY_URL is not set`.

**Cause:** Required secrets are not configured in the GitHub repository's **Settings → Secrets and variables → Actions**.

**Required secrets:**

| Secret Name | Description |
|---|---|
| `OPENCLAW_GATEWAY_URL` | Full URL of the OpenClaw Gateway (e.g. `https://your-gateway.example.com`) |
| `OPENCLAW_GATEWAY_TOKEN` | Bearer token for authenticating with the Gateway API |

**Fix:**
1. Go to your repository on GitHub → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
2. Add `OPENCLAW_GATEWAY_URL` with your gateway URL.
3. Add `OPENCLAW_GATEWAY_TOKEN` with a valid bearer token from the gateway.
4. Re-run the failed workflow from the **Actions** tab.

> For local runs, set these in your `.env` file at the repo root (never commit it):
> ```bash
> OPENCLAW_GATEWAY_URL=http://localhost:18789
> OPENCLAW_GATEWAY_TOKEN=your-token-here
> ```

---

## Still Stuck?

- Run the evolver with verbose logging: `DEBUG=* node src/evoloop.js`
- Check full logs in `logs/evoloop.log`
- Open an issue at https://github.com/your-org/openclaw-evo/issues with the relevant log section
