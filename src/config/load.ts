import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigSchema, type JevRoutingConfig } from './schema.js';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Replace ${VAR} and ${VAR:-default} in every string value. Unset vars without default become undefined. */
export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') {
    const whole = /^\$\{(\w+)(?::-(.*))?\}$/.exec(value);
    if (whole) {
      const v = env[whole[1]!];
      return v !== undefined && v !== '' ? v : whole[2];
    }
    return value.replace(/\$\{(\w+)(?::-(.*?))?\}/g, (_, k: string, d?: string) => env[k] || d || '');
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = interpolateEnv(v, env);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return value;
}

export function configSearchPaths(cwd = process.cwd()): string[] {
  return [
    process.env.JEV_CONFIG,
    join(cwd, 'jev.config.yaml'),
    join(cwd, 'jev.config.yml'),
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'jev-routing', 'config.yaml'),
  ].filter((p): p is string => !!p);
}

/** Load .env from cwd if present (does not override existing env vars). */
export function loadDotEnv(cwd = process.cwd()) {
  const file = join(cwd, '.env');
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      // ignore malformed .env
    }
  }
}

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): JevRoutingConfig {
  const res = ConfigSchema.safeParse(interpolateEnv(raw, env));
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid config:\n${issues}`);
  }
  const cfg = res.data;
  const known = new Set(Object.keys(cfg.providers));
  for (const id of [...cfg.routing.fallback, ...cfg.routing.only]) {
    if (!known.has(id)) throw new ConfigError(`routing references unknown provider "${id}"`);
  }
  return cfg;
}

export function loadConfig(path?: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { config: JevRoutingConfig; path: string } {
  const cwd = opts.cwd ?? process.cwd();
  loadDotEnv(cwd);
  const candidates = path ? [resolve(cwd, path)] : configSearchPaths(cwd);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new ConfigError(`No config found. Looked in:\n${candidates.map((c) => `  - ${c}`).join('\n')}`);
  const raw = parseYaml(readFileSync(found, 'utf8'));
  return { config: parseConfig(raw, opts.env ?? process.env), path: found };
}
