import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Learned reliability per provider+effort: a Beta posterior whose prior is the
 * catalog completion rate (weight `priorStrength` pseudo-observations), so real
 * outcomes gradually override benchmark/telemetry data.
 */
export class OutcomeStore {
  private stats = new Map<string, { ok: number; fail: number }>();

  constructor(
    private readonly file?: string,
    private readonly priorStrength = 10,
  ) {
    if (file) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { ok: number; fail: number }>;
        for (const [k, v] of Object.entries(raw)) this.stats.set(k, v);
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

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.stats)));
    renameSync(tmp, this.file);
  }
}
