# ai-workflow-testing — Spec

## One line
A small, generic demo of testing workflows that contain AI steps: **mirror what's deterministic and assert it exactly; taint what a model produces and never assert it verbatim.**

## Why this repo exists
Products increasingly mix deterministic logic with model output. Fixture-based suites either fall behind (new workflows ship constantly) or go flaky (model output changes every run). This repo shows a third option, end to end, in code anyone can run in five minutes.

It is written from scratch. It contains no code, names, schemas or data from any employer.

## What's in the repo

### 1. The system under test: a tiny workflow runner (`app/`)
A Node + TypeScript web app that runs **workflows defined as JSON**. Each workflow is a list of blocks.

**Headless blocks (no UI):**
| Block | Behaviour | Deterministic? |
|---|---|---|
| `math` | arithmetic on state values | yes |
| `string` | concat, upper/lower, trim, template | yes |
| `object` | set / pick / merge fields | yes |
| `condition` | branch to a step based on an expression | yes, unless it reads a tainted value |
| `fetch` | GET from the app's own mock API (`/api/...`) | yes (replayable) |
| `ai` | simulated model: extracts or classifies text, output varies by seed (wording, field order, confidence, occasional extra field) | **no** |
| `id` | generates a random ID | **no** |

**UI blocks (rendered as pages):**
| Block | Behaviour |
|---|---|
| `form` | inputs the user fills; values go into state |
| `details` | read-only display of state values |
| `table` | rows rendered from an array in state |

**Endpoints:**
- `GET /api/workflows` lists published workflows (`{ id, name, published, steps, cases }`). `cases` are named sets of form inputs, keyed by form step and field; tests are generated one per published workflow per case.
- `GET /run/:workflowId` starts a run and renders the first UI step.
- The mock data API (`/api/customers/:id`, `/api/rates`) is deterministic.
- `AI_SEED` env var: seeds the simulated model. If unset, each run uses a random seed. This is how variance is produced on purpose.
- `ENGINE_BUG` env var: injects a deliberate deterministic bug (`math-off-by-one`, `wrong-branch`, `drop-field`). Used to prove the harness catches real defects. Off by default.

**Ship 6–8 example workflows**, each exercising something specific:
1. Pure deterministic: order total with tax (form → math → details).
2. Fetch replay: load a customer by ID, show details.
3. AI extraction: paste an invoice text, the model extracts fields, show them.
4. Taint propagation: a total computed *from* an AI-extracted amount.
5. Branch on model output: route by AI classification confidence (observed routing).
6. Generated ID shown on a confirmation page.
7. Table: list built from fetched data plus one AI-labelled column.
8. Unpublished workflow (must be excluded from tests).

### 2. The test harness (`harness/`)
- **Interpreter (mirror):** replays each workflow's headless blocks test-side to compute the expected state. It re-implements `math`, `string`, `object`, `condition` and `fetch` (GET only, against the live mock API). It does **not** re-implement `ai` or `id`: their outputs are marked *unmirrored*.
- **Taint tracking:** any value from an unmirrored block is tainted, and so is any value derived from a tainted value (through any block). Reading a tainted value makes the result tainted.
- **Assertions:**
  - `assertExact(element, expected)` for clean values.
  - `assertShape(element, rule)` for tainted values: type, non-empty, length/range bounds, allowed set. Never the exact text.
  - Tainted values are never compared verbatim. This is enforced in code: calling `assertExact` on a tainted value throws a harness error.
- **Observed routing:** when a `condition` reads a tainted value, the harness can't predict the branch. It reads which step the app actually rendered, checks that it's one of the valid targets, and continues mirroring from there.
- **Self-updating coverage:** tests are generated at runtime, one per published workflow from `GET /api/workflows`. The run fails if the API errors or returns zero workflows; it never passes empty.
- **Coverage manifest:** for each workflow, write `reports/manifest/<id>.json` listing every element driven, every assertion (exact or shape) and every gap (an element seen but not asserted, with the reason).

### 3. Tests (`tests/`)
- Playwright Test (TypeScript). One generated test per workflow drives the UI step by step and checks each screen against the expected state.
- A small unit-test set for the interpreter and the taint rules (Vitest or Playwright's runner; pick one and stay consistent).

### 4. The proof: `npm run prove`
A script that produces the numbers for the README:
- **Variance run:** the full suite N times (default 20) with random `AI_SEED`s. Expected: 0 failures.
- **Bug runs:** the suite once with each `ENGINE_BUG`. Expected: every injected bug fails at least one test.
- It writes `reports/prove.md` with a results table. **The README quotes this file; it never contains hand-typed results.**

### 5. CI (`.github/workflows/ci.yml`)
- On push/PR: install, lint, typecheck, unit tests, full e2e suite once with a random seed, then upload the Playwright HTML report and manifests as artifacts.
- `workflow_dispatch`: run `npm run prove`.

### 6. README (the write-up)
Sections:
1. The problem (3–4 lines).
2. The approach, with a simple diagram (Mermaid is fine): mirror vs taint vs observed routing.
3. Quickstart (three commands).
4. Results, quoted from `reports/prove.md`.
5. How to add a workflow.
6. Trade-offs and limits: live-data dependence, what shape checks can't catch, when you'd add an LLM-as-judge.

## Stack
Node 22, TypeScript (strict), Express (or Fastify) with server-rendered HTML for the app, Playwright Test, ESLint + Prettier, GitHub Actions. No frontend framework. No external services and no API keys required.

## Out of scope (v1)
Real LLM calls, auth, a database, mobile. Possible v2: an optional real-model mode behind an env var, and an LLM-as-judge example for tainted outputs.

## Milestones (one or more commits each, so the history tells the story)
1. Scaffold: TS, lint, Playwright, CI skeleton.
2. App: engine, deterministic blocks, UI blocks, mock API, 2 workflows.
3. Harness: interpreter + exact assertions; the first generated test passes.
4. `ai` and `id` blocks, taint tracking, shape assertions, observed routing.
5. All example workflows, coverage manifest, unpublished-workflow exclusion.
6. `ENGINE_BUG` injection plus `npm run prove`.
7. README write-up from `reports/prove.md`, final CI.

## Done when
- `npm ci && npx playwright install chromium && npm test` passes from a clean clone.
- `npm run prove` shows 0 failures across 20 random seeds, and every injected bug is caught.
- CI is green and the report artifacts upload.
- The README results come from `reports/prove.md`.
