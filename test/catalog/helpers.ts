import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from '../../src/catalog/index.js';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/slopalytics/', import.meta.url));
const fixture = (name: string): string => readFileSync(`${FIXTURE_DIR}${name}`, 'utf8');

/** The real fixture files. index.html points at a different bundle name, so every /assets/*.js serves bundle.js. */
export const FIXTURE = {
  index: fixture('index.html'),
  bundle: fixture('bundle.js'),
  usage: fixture('t3-usage.json'),
};

export interface SiteOptions {
  index?: string;
  bundle?: string;
  usage?: string;
  /** 'error' makes the usage endpoint return HTTP 500. */
  usageStatus?: number;
  indexStatus?: number;
}

/** In-memory slopalytics.com serving the fixtures; records every requested URL. */
export function fakeSite(opts: SiteOptions = {}): { fetch: FetchLike; requests: string[] } {
  const requests: string[] = [];
  const fetch: FetchLike = async (url) => {
    requests.push(url);
    const { pathname } = new URL(url);
    if (pathname === '/') {
      return respond(opts.index ?? FIXTURE.index, opts.indexStatus);
    }
    if (pathname.startsWith('/assets/') && pathname.endsWith('.js')) {
      return respond(opts.bundle ?? FIXTURE.bundle);
    }
    if (pathname === '/data/t3-usage.json') {
      return respond(opts.usage ?? FIXTURE.usage, opts.usageStatus);
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, requests };
}

function respond(body: string, status = 200): Response {
  return new Response(body, { status });
}
