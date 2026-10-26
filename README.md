# JevRouting

A cost-, intelligence- and cache-aware router for coding agents. For every request it asks a **Jev System One** decision model what the task needs, then picks the **provider × effort** with the lowest *expected cost per successful task*. Model data comes from **Slopalytics**: Artificial Analysis benchmarks plus real T3 Code usage. It's cached locally and refreshed daily.

Providers are config, not code. Out of the box it routes across **Claude Code**, **Antigravity** and **OpenCode** (including free models), either through your **LiteLLM** proxy or by calling the CLIs directly.

![Cost per task: Opus 5.5 @ medium vs JevRouting](docs/cost-comparison.svg)

<!-- BENCH-TABLE:START -->
| Task | Expected | claude-opus@medium | Routed to | Routed cost | Pass (base / routed) |
|---|---|---:|---|---:|:---:|
| greet | trivial | $0.130 | claude-haiku@low (Jev L0) | $0.0036 | ✅ / ✅ |
| commit-msg | trivial | $0.084 | claude-haiku@low (Jev L1) | $0.0023 | ✅ / ✅ |
| explain-closure | simple | $0.085 | claude-haiku@high (Jev L2) | $0.0023 | ✅ / ✅ |
| regex-email | simple | $0.085 | claude-haiku@medium (Jev L2) | $0.0023 | ✅ / ✅ |
| fizzbuzz-variant | simple | $0.087 | claude-haiku@high (Jev L2) | $0.0024 | ✅ / ✅ |
| debounce | moderate | $0.091 | claude-haiku@high (Jev L2) | $0.0024 | ✅ / ✅ |
| lru | moderate | $0.090 | claude-sonnet@medium (Jev L3) | $0.052 | ✅ / ✅ |
| interval-merge | moderate | $0.088 | claude-sonnet@medium (Jev L3) | $0.063 | ✅ / ✅ |
| bug-find | moderate | $0.129 | claude-haiku@high (Jev L2) | $0.0026 | ✅ / ✅ |
| topo-sort | hard | $0.102 | claude-sonnet@high (Jev L3) | $0.070 | ✅ / ✅ |
| parse-duration | hard | $0.094 | claude-sonnet@high (Jev L3) | $0.045 | ✅ / ✅ |
| design-review | hard | $0.091 | claude-opus@medium (Jev L5) | $0.144 | ✅ / ✅ |
| **Total** | | **$1.16** | | **$0.391** (−66%) | 12/12 / 12/12 |
<!-- BENCH-TABLE:END -->

**How to read this.** This is 12 real coding requests, each run once through Claude Code on Opus 5.5 at `medium` effort, and once through JevRouting, which used local Clef as Jev and the [CLI config](examples/cli.config.yaml). Both sides start from an empty directory. Every answer is checked automatically; the code answers are executed against test cases. Costs are what Claude Code reports, at API-equivalent prices. Three iterations of the cost model on the same tasks and baseline ([`bench/results/`](bench/results)):

| Run | Change | Routed total | vs Opus@medium | Pass |
|---|---|---:|---:|:---:|
| 1 | initial model | $0.534 | −54% | 12/12 |
| 2 | + harness-token overhead (~17.5K tokens per Claude Code call) | $0.611 | −47% | 12/12 |
| 3 | + one-shot thinking tokens per effort, provider cooldowns, Haiku@high allowed | **$0.391** | **−66%** | 12/12 |

Run 2 got *worse*. Once the fixed harness overhead was in the model, the price gap between efforts looked negligible, so the router drifted to Sonnet@high. Run 3 models the thinking tokens that higher efforts spend even on short answers, and that pushed simple and moderate work down to Haiku. Caveats:

- The suite is small and every task is a one-shot. Agentic, multi-turn work is where warm caches and context pruning matter, and this benchmark doesn't exercise them.
- Routed wall time includes the local Jev call, about 4.6 s on an M4. Hosted Jev is about 0.1–0.2 s.
- Free OpenCode models were in cooldown (quota exhausted) during these runs. With quota available, the router sends some of this work to them at $0 marginal cost.
- Reproduce with `npm run bench -- --baseline-from bench/results/run1.json` (reuses the Opus baseline) and `npm run bench:report -- <result.json> --readme README.md`.

## How a request is routed

```mermaid
flowchart LR
  A[request] --> B[sanitize<br/>redact secrets, last 3 user turns,<br/>facts computed in code]
  B --> C{Jev backends<br/>local Clef → OpenCode Zen →<br/>Cloudflare Clef → TypeSafe}
  C -- answers --> D[assessment<br/>difficulty distribution, output size,<br/>agentic, needs-history, risk, model fit]
  C -- all down --> H[heuristic assessor]
  H --> D
  D --> E[rank provider × effort<br/>catalog intelligence + cost/task,<br/>cache warm/cold, billing, reliability]
  E --> F[run plan with fallbacks<br/>LiteLLM or CLI]
  F --> G[log decision · update session cache state · learn reliability]
```

1. **Sanitize.** Secrets are redacted. Jev sees the current ask, at most 3 recent *user* turns within an 8,000-char budget (assistant code dumps hurt calibration), and **facts computed in code**: diff size, files touched, repeated test failures, context size. Jev is calibrated but can't count or do arithmetic, so it never gets raw numbers to compare.
2. **Assess (one Jev call, all questions in one forward pass).**

   | Question | Type | Used for |
   |---|---|---|
   | `difficulty` | score, 6 levels (trivial → frontier) | required intelligence, as a full **distribution** |
   | `outputSize` | score, 4 levels | output-token estimate |
   | `agentic` | noul | weights per-task (agent loop) vs one-shot token cost |
   | `needsHistory` | noul | prune history on handoff (prevents cold-cache re-prefill on a switch) |
   | `risk` | score, 4 levels | raises the intelligence bar; ≥ 2.5 requires `--approve` |
   | `modelFit` | choice over your providers' `strengths` | small, capped bonus in ranking (Jev never sees prices) |
   | `kind`, `latencySensitive` | choice / noul | opt-in (`classifier.extendedQuestions`); otherwise cheap regex |

   Deterministic rules then adjust the distribution. Repeated test failures shift it up one level. A diff over 1,000 lines puts a floor at level 3.
3. **Rank.** Every enabled provider at every effort it allows (with its own Slopalytics variant) becomes a candidate:

   ```
   P(success)  = Σ_level  p(level) · σ((I_variant − I_required(level)) / spread)  ×  reliability
   attempt $   = billingMultiplier × [ agentic·(costPerTask·sizeScale + prefill)
                                     + (1−agentic)·(prefill + outTokens·verbosity·outPrice) ]
   prefill     = contextTokens × (cache warm ? cacheReadPrice : cacheWritePrice)
   objective   = (attempt $ + latencyWeight·minutes) / P(success)  ÷  modelFitBonus
   ```

   - **Effort is chosen too.** Sonnet@high competes against Opus@medium using each variant's own intelligence, cost per task, tokens and time.
   - **Cache-aware.** Each session remembers which provider it last used, when, and how much context it holds. Within that provider's TTL (Anthropic 5 min, OpenAI 30 min, DeepSeek hours…) the candidate pays cache-*read* prices for the context; otherwise it pays cache-*write*. This is the plan's stay-vs-switch inequality, applied with real prices and expiry.
   - **Billing-aware.** `metered` pays list price, `subscription` (Claude Code, Antigravity) is weighted ×0.15 for quota, and `free` (OpenCode free models) ×0.02.
   - **Reliability.** Each candidate starts from the T3 Code completion rate (Slopalytics) and is updated by your own outcomes (a Beta posterior per provider+effort; send feedback via `/v1/jev/feedback`).
   - **Caps and floors.** `maxIntelligence` per provider (e.g. small free models), plus a `minSuccess` floor.
4. **Run** the plan: the winner, then fallbacks on *distinct* providers. Quota and sign-in errors don't count against a model's reliability.
5. **Log** one JSONL row per decision: state hash, Jev answers, the candidate table, attempts and outcome. That's enough to recalibrate `intelligenceByLevel` from real data later.

## Quick start

```bash
npm install
cp .env.example .env          # add whatever backends/keys you have
npm run build && npm link     # or use `npx tsx src/cli.ts …`

jev decide "Refactor the auth middleware to support OAuth2 PKCE across our 6 services"
jev route  "Write a one-line commit message for renaming getUser to fetchUser"
jev route --config examples/cli.config.yaml "…"   # talk to the CLIs directly, no LiteLLM
jev serve --port 4100                             # OpenAI-compatible proxy
jev catalog refresh                               # force a Slopalytics refresh
```

`jev decide` prints the full reasoning:

```
assessment: jev (clef-flash, 4593ms)
  kind=refactor level=4 needs I≥52 risk=1.85 agentic=0.82 history=0.08
candidates:
  ✓ claude-opus@medium             I=51.2 p=0.68 cost=  $0.140 (list $0.934) ~2.3min
  ✓ claude-sonnet@xhigh            I=51.9 p=0.70 cost=  $0.211 (list $1.406) ~5.1min
plan: claude-opus@medium → claude-sonnet@xhigh
```

### OpenAI-compatible proxy

`jev serve` exposes `/v1/chat/completions`. Use `model: "jev-auto"` to route, or a provider id to pin one. `reasoning_effort` pins an effort. The session comes from `x-jev-session-id`, `x-litellm-session-id`, `x-claude-code-session-id`, `metadata.session_id` or `user`. Responses carry a `jev` block with the decision, plus the headers `x-jev-provider`, `x-jev-effort` and `x-jev-cost-usd`. High-risk tasks return **409** with the decision; resend with `"jev": {"approve": true}`. The server also has `POST /v1/jev/decide` (plan only) and `POST /v1/jev/feedback` (`{providerId, effort, ok}`). Set `JEV_SERVER_KEY` to require a bearer token.

## Configuring providers

Everything lives in [`jev.config.yaml`](jev.config.yaml) (LiteLLM-backed) or [`examples/cli.config.yaml`](examples/cli.config.yaml) (direct CLIs). Strings support `${ENV}` and `${ENV:-default}`.

```yaml
providers:
  claude-sonnet:
    kind: litellm                       # litellm | cli | mock
    model: claudecode/claude-sonnet-5-5 # your LiteLLM model_name
    catalogId: claude-sonnet-5-5        # Slopalytics family (inferred from model when omitted)
    billing: subscription               # metered | subscription | free
    efforts: [low, medium, high, xhigh] # efforts the router may pick
    strengths: Strong all-round coder; features, refactors, tests and reviews.
  opencode-glm-flash:
    kind: cli
    preset: opencode                    # claude-code | opencode | antigravity, or custom command/args
    model: opencode/glm-5.3-flash-free
    billing: free
    maxIntelligence: 46                 # never send it tasks needing more
```

Optional per provider: `pricing` (USD per 1M tokens, overrides the catalog), `cacheTtlSec`, `effortMap` (e.g. DeepSeek only accepts low/high/max), `intelligence` / `costPerTask` priors for models no catalog knows, `timeoutMs` and `enabled`. To swap a backend, change `model` (and `catalogId`), or add a block. `routing.only` and `routing.fallback` restrict or extend the pool.

## Model data: Slopalytics first, cached daily

| Source | What it gives | Default |
|---|---|---|
| **[Slopalytics](https://slopalytics.com)** | ~700 model × effort variants: AA intelligence, cost per task, tokens per task, time, speed, list prices; real T3 Code usage: cache-aware prices, completion rate, cache hit rate | on (primary) |
| **[models.dev](https://models.dev)** | pricing incl. cache read/write and context for models Slopalytics lacks | on (gap-fill) |
| **[Artificial Analysis API](https://artificialanalysis.ai/documentation)** | intelligence index for models Slopalytics lacks | on if `AA_API_KEY` is set |

Slopalytics has no JSON API for benchmarks, so the variants are parsed from its JS bundle with a strict literal parser (no `eval`); usage comes from `/data/t3-usage.json`. Each source is cached under `~/.cache/jev-routing/` and refreshed at most once per `catalog.maxAgeHours` (24). Writes are atomic and guarded by a lock. If a refresh fails, the router uses the stale cache, and failing that a **bundled snapshot**, so it never runs without data. Toggle sources under `catalog.sources`.

## Jev backends: hosted vs local

Any System One-compatible endpoint works. They're tried in order; one is skipped when its env vars are empty, and a backend that returns 429 is skipped until its `Retry-After`:

| Backend | Model | Setup | Latency (this router's request) |
|---|---|---|---|
| **Local Clef (MLX)** | `clef-flash-4bit` | `scripts/clef-serve.sh`, then `JEV_LOCAL_URL=http://127.0.0.1:8765/v1` | **~4.6 s** on an M4/16 GB for the 6-question request (~1.1K tokens); ~0.9 s for a single short question |
| **OpenCode Zen** | `jev-1.13-free` | `JEV_API_KEY` (OpenCode key) | JEV_ZEN_LATENCY |
| **Cloudflare Workers AI** | `clef-flash` | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AUTH_TOKEN` (10K free neurons/day) | provider-reported ~0.2 s |
| **TypeSafe direct** | `jev-1.13.0` | `TYPESAFE_API_KEY` | ~127 ms p50 / 231 ms p95 (LiteLLM benchmark) |

On local Clef, latency grows roughly linearly with input tokens (~4 ms per token on an M4). That's why the default question set is lean and the rubrics are short. Hosted Jev evaluates all questions in parallel, so `classifier.extendedQuestions: true` costs almost nothing there. Local Clef wins on privacy, has no quota, and is free. Hosted Jev wins on latency. If every backend is down, a conservative heuristic assessor takes over and the decision log records why.

```bash
scripts/clef-serve.sh                                     # creates a venv, downloads ~6 GB once, serves on :8765
CLEF_MODEL=mlx-community/clef-4bit scripts/clef-serve.sh  # 27B variant, needs a 32 GB+ Mac
```

## What changed from the original (Gemini "argon") plan

- **Jev assesses; it no longer picks a tier.** A static 4-tier → model map ignores the data. Here Jev estimates *what the task needs* (as a distribution), and code optimizes over the live catalog, including effort.
- **Fixed API misuse.** `noul` takes no `criteria`. The `@typesafe-ai/sdk` package and LiteLLM's `classifier_type: jev` from the plan don't exist, so the client here is a small `fetch` wrapper. The plan's fallback branch dropped fields such as `effortLevel`.
- **Uncertainty is used, not thrown away.** P(success) integrates over the difficulty distribution. Picking one level (or a quantile) biased routing upward by about one level in practice.
- **Cache economics are computed per candidate** with real prices and TTL expiry, instead of a one-off worked example.
- **Dropped:** Kubernetes pod discovery, Bedrock load balancing and Copilot quota arbitrage (irrelevant when driving CLIs or LiteLLM), plus the hard-coded benchmark tables (they're fetched daily now).
- **Added:** learned reliability, an approval gate, an OpenAI-compatible proxy, a Jev failover pool, local Clef, a heuristic fallback, and secondary catalog sources.

## Development

```bash
npm test                       # unit + integration (mock LiteLLM server, fake CLIs, fixtures)
JEV_LIVE=1 npm run test:live   # live: Slopalytics, OpenCode free model
npm run typecheck
npx tsx bench/run.ts --config examples/cli.config.yaml   # baseline vs routed benchmark
npx tsx bench/report.ts bench/results/<run>.json         # → docs/cost-comparison.svg + table
```

Layout: `src/jev` (System One client + failover pool) · `src/catalog` (Slopalytics, models.dev, AA, cache) · `src/router` (assessment, ranking, sessions, outcomes, engine) · `src/providers` (LiteLLM, CLI, mock) · `src/server.ts` · `src/cli.ts` · `bench/`.
