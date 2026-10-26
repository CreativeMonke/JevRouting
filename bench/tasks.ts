// Benchmark suite: realistic coding-assistant requests spanning trivial -> hard,
// each with an automatic correctness check so cost savings are measured at
// equal quality. Checks are deliberately lenient on formatting.

import { runInNewContext } from 'node:vm';

export interface BenchTask {
  id: string;
  /** Rough difficulty we expect (for reporting only — the router doesn't see this). */
  expected: 'trivial' | 'simple' | 'moderate' | 'hard';
  prompt: string;
  check: (answer: string) => boolean;
}

/** Pull the first fenced code block (or the whole answer). */
export function codeOf(answer: string): string {
  const m = /```(?:[a-zA-Z]+)?\n([\s\S]*?)```/.exec(answer);
  return (m ? m[1]! : answer).trim();
}

/** Evaluate JS defining `name`, then run assertions against it in a sandbox (1s budget). */
function jsCheck(name: string, cases: Array<[unknown[], unknown]>) {
  return (answer: string) => {
    const code = codeOf(answer).replace(/^export\s+(default\s+)?/gm, '');
    try {
      const ctx: Record<string, unknown> = {};
      runInNewContext(`${code}\n;globalThis.__fn = typeof ${name} !== 'undefined' ? ${name} : undefined;`, ctx, { timeout: 1000 });
      const fn = ctx.__fn as ((...a: unknown[]) => unknown) | undefined;
      if (typeof fn !== 'function') return false;
      return cases.every(([args, want]) => JSON.stringify(fn(...args)) === JSON.stringify(want));
    } catch {
      return false;
    }
  };
}

const has = (...needles: RegExp[]) => (a: string) => needles.every((n) => n.test(a));

export const TASKS: BenchTask[] = [
  {
    id: 'greet',
    expected: 'trivial',
    prompt: 'Reply with exactly the word: pong',
    check: (a) => /\bpong\b/i.test(a) && a.trim().length < 40,
  },
  {
    id: 'commit-msg',
    expected: 'trivial',
    prompt: 'Write a one-line conventional commit message for: renamed getUser to fetchUser in src/api.ts. Output only the message.',
    check: (a) => /^(refactor|chore|fix|feat)(\(.+\))?!?:\s*\S/im.test(a.trim()) && /fetchUser/.test(a),
  },
  {
    id: 'explain-closure',
    expected: 'simple',
    prompt: 'In two sentences, explain what a JavaScript closure is.',
    check: has(/function/i, /(scope|variable|environment)/i),
  },
  {
    id: 'regex-email',
    expected: 'simple',
    prompt: 'Write a JavaScript function isHexColor(s) that returns true for strings like "#fff" or "#a1b2c3" (case-insensitive) and false otherwise. Code only, in a ```js block.',
    check: jsCheck('isHexColor', [[['#fff'], true], [['#A1B2C3'], true], [['#abcd'], false], [['fff'], false], [['#ggg'], false]]),
  },
  {
    id: 'fizzbuzz-variant',
    expected: 'simple',
    prompt: 'Write a JavaScript function fizz(n) returning an array of strings for 1..n where multiples of 3 are "Fizz", of 5 "Buzz", of both "FizzBuzz", else the number as a string. Code only, ```js block.',
    check: jsCheck('fizz', [[[5], ['1', '2', 'Fizz', '4', 'Buzz']], [[15], ['1', '2', 'Fizz', '4', 'Buzz', 'Fizz', '7', '8', 'Fizz', 'Buzz', '11', 'Fizz', '13', '14', 'FizzBuzz']]]),
  },
  {
    id: 'debounce',
    expected: 'moderate',
    prompt: 'Write a JavaScript function chunk(arr, size) that splits an array into chunks of the given size (last chunk may be smaller); throw a RangeError if size < 1. Code only, ```js block.',
    check: (a) =>
      jsCheck('chunk', [[[[1, 2, 3, 4, 5], 2], [[1, 2], [3, 4], [5]]], [[[], 3], []], [[[1, 2, 3], 3], [[1, 2, 3]]]])(a) && /RangeError/.test(a),
  },
  {
    id: 'lru',
    expected: 'moderate',
    prompt:
      'Write a JavaScript function lruSim(capacity, ops) that simulates an LRU cache. ops is an array of ["get", key] or ["put", key, value]. Return an array with the result of each get (the value, or -1 if missing). Code only, ```js block.',
    check: jsCheck('lruSim', [
      [[2, [['put', 1, 1], ['put', 2, 2], ['get', 1], ['put', 3, 3], ['get', 2], ['put', 4, 4], ['get', 1], ['get', 3], ['get', 4]]], [1, -1, -1, 3, 4]],
    ]),
  },
  {
    id: 'interval-merge',
    expected: 'moderate',
    prompt: 'Write a JavaScript function merge(intervals) that merges overlapping [start,end] intervals (touching counts as overlapping) and returns them sorted. Code only, ```js block.',
    check: jsCheck('merge', [[[[[1, 3], [2, 6], [8, 10], [15, 18]]], [[1, 6], [8, 10], [15, 18]]], [[[[1, 4], [4, 5]]], [[1, 5]]], [[[[5, 6], [1, 2]]], [[1, 2], [5, 6]]]]),
  },
  {
    id: 'bug-find',
    expected: 'moderate',
    prompt:
      'This function should return the median of a numeric array but is wrong for some inputs. Return the corrected JavaScript function named median in a ```js block.\n```js\nfunction median(xs){ const s = xs.sort(); const m = Math.floor(s.length/2); return s.length % 2 ? s[m] : (s[m-1]+s[m])/2 }\n```',
    check: jsCheck('median', [[[[10, 2, 3]], 3], [[[1, 10, 2, 9]], 5.5], [[[5]], 5], [[[-1, -10, 3]], -1]]),
  },
  {
    id: 'topo-sort',
    expected: 'hard',
    prompt:
      'Write a JavaScript function buildOrder(deps) where deps is an object mapping a package name to an array of packages it depends on. Return an array of all package names (including ones that only appear as dependencies) in an order where every package comes after its dependencies; among valid choices pick the lexicographically smallest next package each step. Throw an Error containing "cycle" if there is a cycle. Code only, ```js block.',
    check: (a) => {
      const ok = jsCheck('buildOrder', [
        [[{ app: ['lib', 'util'], lib: ['util'], util: [] }], ['util', 'lib', 'app']],
        [[{ b: ['a'], c: ['a'], d: ['b', 'c'] }], ['a', 'b', 'c', 'd']],
      ])(a);
      return ok && /cycle/i.test(a);
    },
  },
  {
    id: 'parse-duration',
    expected: 'hard',
    prompt:
      'Write a JavaScript function parseDuration(s) that parses strings like "1h30m", "45s", "2d4h", "1h 15m 10s", "90m" into total seconds (units d,h,m,s; spaces allowed; units may appear at most once and must be in descending order d>h>m>s). Return null for invalid input such as "", "10", "1m1h", "1x", "1h1h". Code only, ```js block.',
    check: jsCheck('parseDuration', [
      [['1h30m'], 5400], [['45s'], 45], [['2d4h'], 187200], [['1h 15m 10s'], 4510], [['90m'], 5400],
      [[''], null], [['10'], null], [['1m1h'], null], [['1x'], null], [['1h1h'], null],
    ]),
  },
  {
    id: 'design-review',
    expected: 'hard',
    prompt:
      'We run a payments service with a Postgres primary and two read replicas. Users report that right after paying, the "orders" page sometimes shows the order as unpaid. In under 150 words: name the most likely root cause and give the fix.',
    check: has(/replica(tion)?\s*lag|replication|read[- ]after[- ]write|stale read/i, /primary|leader|read[- ]your[- ]writes|sticky|consisten/i),
  },
];
