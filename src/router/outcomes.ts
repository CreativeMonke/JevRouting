import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Learned reliability per provider+effort: a Beta posterior whose prior is the
 * catalog completion rate (weight `priorStrength` pseudo-observations), so real
 * outcomes gradually override benchmark/telemetry data.
 */
export class OutcomeStore {
  private stats = new Map<string, { ok: number; fail: number }>();
  /** providerId -> epoch ms until which it is unavailable (quota exhausted, needs sign-in, rate limited). */
  private cooldowns = new Map<string, { until: number; reason: string }>();

  constructor(
    private readonly file?: string,
    private readonly priorStrength = 10,
    private readonly now: () => number = Date.now,
  ) {
    if (file) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as {
          stats?: Record<string, { ok: number; fail: number }>;
          cooldowns?: Record<string, { until: number; reason: string }>;
        };
        for (const [k, v] of Object.entries(raw.stats ?? {})) this.stats.set(k, v);
        for (const [k, v] of Object.entries(raw.cooldowns ?? {})) if (v.until > this.now()) this.cooldowns.set(k, v);
      } catch {
        // start empty
      }
    }
  }

  private key(providerId: string, effort: string) {
    return `${providerId}@${effort}`;
  }

  record(providerId: string, effort: string, ok: boolean) {
    const k = this.key(providerId, effort);
    const s = this.stats.get(k) ?? { ok: 0, fail: 0 };
    if (ok) s.ok++;
    else s.fail++;
    this.stats.set(k, s);
    this.save();
  }

  observations(providerId: string, effort: string) {
    return this.stats.get(this.key(providerId, effort)) ?? { ok: 0, fail: 0 };
  }

  /** Posterior mean reliability given a prior rate in (0,1]. */
  reliability(providerId: string, effort: string, prior: number): number {
    const { ok, fail } = this.observations(providerId, effort);
    const a = prior * this.priorStrength + ok;
    const b = (1 - prior) * this.priorStrength + fail;
    return a / (a + b);
  }

  /** Take a provider out of rotation (all efforts) until `until`. */
  cooldown(providerId: string, ms: number, reason: string) {
    this.cooldowns.set(providerId, { until: this.now() + ms, reason });
    this.save();
  }

  /** Reason string while a provider is cooling down, else undefined. */
  coolingDown(providerId: string): string | undefined {
    const c = this.cooldowns.get(providerId);
    if (!c) return undefined;
    if (c.until <= this.now()) {
      this.cooldowns.delete(providerId);
      return undefined;
    }
    return `${c.reason} (retry in ${Math.ceil((c.until - this.now()) / 60_000)} min)`;
  }

  /** Best effort: a state-file write error must never fail a routed request. */
  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ stats: Object.fromEntries(this.stats), cooldowns: Object.fromEntries(this.cooldowns) }));
      renameSync(tmp, this.file);
    } catch {
      // Losing one outcome update is harmless; failing the completion is not.
    }
  }
}
