/**
 * OpenClaw Evo — Memory Store
 * JSON file-backed persistence layer keyed by string identifiers.
 * All I/O is async; auto-creates the memory directory on init.
 */

import { mkdir, readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const DEFAULT_MEMORY_DIR = '~/.hermes/evo-memory';

export class MemoryStore {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_MEMORY_DIR;
  }

  /** Expands ~ to the user's home directory. */
  private resolvePath(key: string): string {
    return join(this.dir.replace(/^~/, process.env.HOME ?? ''), `${key}.json`);
  }

  getMemoryDir(): string {
    return this.dir;
  }

  /** Ensure the memory directory exists. Call once at startup. */
  async init(): Promise<void> {
    const resolved = this.dir.replace(/^~/, process.env.HOME ?? '');
    if (!existsSync(resolved)) {
      await mkdir(resolved, { recursive: true });
    }
  }

  /**
   * Persist `data` to disk under `key`.
   * Uses a temp-file + atomic rename to avoid corruption from concurrent writers
   * (e.g. both the REPL daemon and a cron hub trying to checkpoint simultaneously).
   */
  async save(key: string, data: unknown): Promise<void> {
    await this.init();
    const filePath = this.resolvePath(key);
    const tmpPath = `${filePath}.tmp.${randomBytes(8).toString('hex')}`;
    const content = JSON.stringify(data, null, 2);
    await writeFile(tmpPath, content, { encoding: 'utf-8' });
    await rename(tmpPath, filePath);
  }

  /**
   * Load and deserialize the JSON stored at `key`.
   * Returns null if the key does not exist or the file is unreadable.
   */
  async load<T>(key: string): Promise<T | null> {
    const filePath = this.resolvePath(key);
    if (!existsSync(filePath)) return null;
    try {
      const content = await readFile(filePath, { encoding: 'utf-8' });
      return JSON.parse(content) as T;
    } catch {
      // Corrupt or unreadable file — treat as missing.
      return null;
    }
  }

  /** Return every key currently stored (filename without .json extension). */
  async list(): Promise<string[]> {
    await this.init();
    const resolved = this.dir.replace(/^~/, process.env.HOME ?? '');
    const entries = await readdir(resolved);
    return entries
      .filter((e) => e.endsWith('.json'))
      .map((e) => e.replace(/\.json$/, ''));
  }

  /** Remove the file for `key`. Silent no-op if key doesn't exist. */
  estimateSize(): number {
    let total = 0;
    try {
      const files = readdirSync(this.dir);
      for (const file of files) {
        const stat = statSync(join(this.dir, file));
        total += stat.size;
      }
    } catch { /* ignore */ }
    return total;
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    if (existsSync(filePath)) {
      await unlink(filePath);
    }
  }
}

/** Module-level singleton store. */
export const store = new MemoryStore();
