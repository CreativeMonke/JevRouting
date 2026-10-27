import { homedir } from 'node:os';
import { join } from 'node:path';
import { CatalogStore, loadSecondary, MergedCatalog } from './catalog/index.js';
import { loadConfig } from './config/load.js';
import type { JevRoutingConfig } from './config/schema.js';
import { createProviders } from './providers/index.js';
import type { Provider } from './providers/types.js';
import { OutcomeStore } from './router/outcomes.js';
import { Router } from './router/engine.js';
import { SessionStore } from './router/session.js';

export interface App {
  config: JevRoutingConfig;
  configPath: string;
  router: Router;
  providers: Map<string, Provider>;
  catalog?: MergedCatalog;
  catalogInfo?: { origin: string; ageHours?: number; warnings: string[]; secondaryModels?: number };
}

export function stateDir(cfg: JevRoutingConfig): string {
  return cfg.catalog.cacheDir ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'jev-routing');
}

export interface BuildOptions {
  configPath?: string;
  /** 'auto' refreshes the catalog when older than maxAgeHours. */
  catalogRefresh?: 'auto' | 'force' | 'never';
  /** Keep sessions/outcomes in memory only (tests, benchmarks). */
  ephemeral?: boolean;
  /** Adjust the parsed config before anything is built (benchmarks, tests). */
  mutateConfig?: (cfg: JevRoutingConfig) => void;
}

export async function buildApp(opts: BuildOptions = {}): Promise<App> {
  const { config, path } = loadConfig(opts.configPath);
  opts.mutateConfig?.(config);
  const providers = createProviders(config.providers);
  const dir = stateDir(config);

  let catalog: MergedCatalog | undefined;
  let catalogInfo: App['catalogInfo'];
  if (config.catalog.enabled) {
    const refresh = opts.catalogRefresh ?? 'auto';
    const store = new CatalogStore({ cacheDir: dir, baseUrl: config.catalog.slopalyticsUrl });
    const [loaded, secondary] = await Promise.all([
      store.load({ maxAgeHours: config.catalog.maxAgeHours, refresh: config.catalog.sources.slopalytics.enabled ? refresh : 'never' }),
      loadSecondary({ cacheDir: dir, sources: config.catalog.sources, maxAgeHours: config.catalog.maxAgeHours, refresh }),
    ]);
    catalog = new MergedCatalog(store, loaded.catalog, secondary.models);
    catalogInfo = {
      origin: loaded.origin,
      ageHours: loaded.ageHours,
      warnings: [...loaded.warnings, ...secondary.warnings],
      secondaryModels: Object.keys(secondary.models).length,
    };
  }

  const router = new Router({
    config,
    providers,
    catalog,
    sessions: new SessionStore(opts.ephemeral ? {} : { file: join(dir, 'sessions.json') }),
    outcomes: new OutcomeStore(opts.ephemeral ? undefined : join(dir, 'outcomes.json')),
  });
  return { config, configPath: path, router, providers, catalog, catalogInfo };
}
