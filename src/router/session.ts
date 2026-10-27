import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Per-session record of where each provider's prompt cache was last warmed. */
export interface SessionRecord {
  lastProviderId?: string;
  /** providerId -> { lastUsedAt (ms), contextTokens } */
  caches: Record<string, { lastUsedAt: number; contextTokens: number }>;
  turns: number;
  consecutiveFailures: number;
}

export interface SessionStoreOptions {
  /** Persist to this JSON file; omit for in-memory only. */
  file?: string;
  now?: () => number;
  /** Drop sessions idle longer than this (default 24h). */
  maxIdleMs?: number;
}

export class SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private readonly now: () => number;
  private readonly maxIdleMs: number;

  constructor(private readonly opts: SessionStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxIdleMs = opts.maxIdleMs ?? 24 * 3600_000;
    if (opts.file) this.load(opts.file);
  }

  get(id: string): SessionRecord {
    let s = this.sessions.get(id);
    if (!s) {
      s = { caches: {}, turns: 0, consecutiveFailures: 0 };
      this.sessions.set(id, s);
    }
    return s;
  }

  /** Is providerId's cache for this session still within ttlSec? */
  isWarm(id: string | undefined, providerId: string, ttlSec: number): boolean {
    if (!id || ttlSec <= 0) return false;
    const c = this.sessions.get(id)?.caches[providerId];
    return !!c && this.now() - c.lastUsedAt < ttlSec * 1000;
  }

  record(id: string, providerId: string, contextTokens: number, ok: boolean) {
    const s = this.get(id);
    s.turns++;
    if (ok) {
      s.lastProviderId = providerId;
      s.caches[providerId] = { lastUsedAt: this.now(), contextTokens };
      s.consecutiveFailures = 0;
    } else {
      s.consecutiveFailures++;
    }
    this.save();
  }

  private load(file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, SessionRecord>;
      const cutoff = this.now() - this.maxIdleMs;
      for (const [k, v] of Object.entries(raw)) {
        const last = Math.max(0, ...Object.values(v.caches ?? {}).map((c) => c.lastUsedAt));
        if (last >= cutoff) this.sessions.set(k, v);
      }
    } catch {
      // Missing or corrupt file: start empty.
    }
  }

  /** Best effort: a state-file write error must never fail a routed request. */
  private save() {
    const file = this.opts.file;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.sessions)));
      renameSync(tmp, file);
    } catch {
      // Losing one session update is harmless; failing the completion is not.
    }
  }
}
