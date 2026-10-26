import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CatalogSchema } from './schema.js';
import type { Catalog } from './types.js';

export interface CatalogPaths {
  catalog: string;
  lock: string;
}

/** `$XDG_CACHE_HOME/jev-routing`, or `~/.cache/jev-routing`. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'jev-routing');
}

export function catalogPaths(cacheDir: string): CatalogPaths {
  return { catalog: join(cacheDir, 'catalog.json'), lock: join(cacheDir, 'catalog.lock') };
}

/** Returns undefined when the file does not exist; throws when it exists but is not a valid catalog. */
export async function readCatalogFile(path: string): Promise<Catalog | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return undefined;
    throw err;
  }
  return CatalogSchema.parse(JSON.parse(text));
}

/** Writes to a sibling temp file, then renames over the target, so readers never see a partial file. */
export async function writeCatalogAtomic(path: string, catalog: Catalog): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(catalog, null, 2)}\n`);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Thrown when another process holds a fresh refresh lock. */
export class CatalogLockedError extends Error {
  constructor(lockPath: string) {
    super(`catalog refresh already in progress (lock: ${lockPath})`);
    this.name = 'CatalogLockedError';
  }
}

/**
 * Runs `task` while holding an exclusive lock file. A lock whose mtime is older than `staleMs`
 * is assumed to belong to a crashed process and is taken over.
 */
export async function withLock<T>(lockPath: string, staleMs: number, task: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  await acquireLock(lockPath, staleMs);
  try {
    return await task();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function acquireLock(lockPath: string, staleMs: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: 'wx' });
      return;
    } catch (err) {
      if (!isErrnoCode(err, 'EEXIST')) throw err;
    }
    const age = await lockAgeMs(lockPath);
    if (age === undefined) continue; // released between our attempts
    if (age < staleMs) throw new CatalogLockedError(lockPath);
    await rm(lockPath, { force: true });
  }
  throw new CatalogLockedError(lockPath);
}

async function lockAgeMs(lockPath: string): Promise<number | undefined> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs;
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return undefined;
    throw err;
  }
}

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code;
}
