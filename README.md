# Sandbox Index

A public sandbox benchmarking site on Cloudflare Workers, with D1 measurement storage and durable Cloudflare Workflows. Daytona is implemented first. The adapter registry supports adding E2B, Modal, Cloudflare Sandbox, and Vercel Sandbox. The public page displays measured providers only.

## Run locally

Requires Node 22+ and an authenticated Wrangler CLI.

```sh
npm ci
cp .dev.vars.example .dev.vars
# Set DAYTONA_API_KEY and a long random ADMIN_TOKEN in .dev.vars.
npm run db:local
npm run dev
```

Open http://localhost:8787. To hot-reload the UI, run `npm run dev:ui` in a second terminal. The Vite server proxies `/api` to Wrangler.

The public page shows results, history, methodology, pricing, and data downloads. It has no admin controls, sign-in, or configuration pages. Write endpoints require `ADMIN_TOKEN` from `.dev.vars`. Keep that file private; it is ignored by Git. The Daytona key never reaches the browser or a sandbox.

## Run a real evaluation

```sh
npm run eval -- https://sandbox-compare.sync-cheap.workers.dev
# Or use the URL printed by wrangler deploy, or http://localhost:8787.
```

The script securely reads the admin token, triggers a real Workflow, polls for completion, and saves JSON and Markdown reports in the ignored `artifacts/` directory. Public data downloads retain the individual measurements. Partial or failed reports cause the script to exit nonzero.

Defaults: every 24 hours, three repetitions of each of three enabled workloads (nine fresh sandboxes per report). The shell workload verifies output. Python and Node workloads launch a server and poll HTTP from inside the sandbox. A verified `python:3.12-slim` image scenario is available but disabled by default. To change cadence (1–168 hours), repetitions (1–5), or workload definitions (up to six), submit a complete Settings JSON object to `PUT /api/settings` with the admin bearer token. `GET /api/dashboard` supplies the current settings. Each measurement batch retains its configuration.

Cloudflare Cron runs hourly. Due dates round up to the next hourly tick after the configured interval; subsequent scheduled reports are exactly N hours apart under normal operation. The first report is scheduled after one interval, and manual runs or saved settings reset the next due time. Set `enabled: false` through the settings API to pause automatic runs. A D1 lock prevents concurrent reports. Interrupted Workflows are reconciled on the next cron check. Timing operations are not automatically retried as new samples.

## Deploy

The Wrangler configuration includes the database created for this workspace. For another account, create a D1 database and replace its ID.

```sh
npm run db:remote
npm run deploy
npx wrangler secret bulk .dev.vars
```

`wrangler deploy` publishes the static site, API, Workflow, and hourly cron. `secret bulk` securely uploads the local key and admin token. Never place either in `wrangler.jsonc` or command arguments.

## GitHub deployment

[Check and deploy](https://github.com/CamdenClark/sandbox-compare/actions/workflows/deploy.yml) runs type checking, tests, the UI build, and a Worker bundle check on pull requests and pushes to `main`. After checks pass, a push to `main` applies D1 migrations, deploys the Worker, assets, Workflow, and cron, and verifies the public site and API. You can also run it manually from GitHub Actions on `main`. Production deployments run one at a time.

Configure these under the repository's **Settings → Secrets and variables → Actions**:

- Secret `CLOUDFLARE_API_TOKEN`: an API token scoped to the target Cloudflare account with Workers Scripts, D1, and Workflows edit permissions plus Account Settings read. A local Wrangler OAuth login cannot authenticate GitHub Actions. See [Cloudflare's CI setup](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
- Variable `CLOUDFLARE_ACCOUNT_ID`: the account owning the Worker and D1 database.

`DAYTONA_API_KEY` and `ADMIN_TOKEN` remain Worker secrets in Cloudflare. Routine deployments preserve them; they do not belong in GitHub source or CI credentials. Pull request checks have no deployment credentials and do not run paid benchmarks. If deploying a fork to another account, update the database ID in `wrangler.jsonc`, the deployment URL in the workflow, and upload the Worker secrets once using the local deploy instructions.

## What the measurements mean

- **Sandbox creation:** create request to API acknowledgement, returning a sandbox ID. This does not mean it is ready.
- **Started:** create request to observing the provider's started state.
- **Command ready:** create request to successful execution of a verified shell marker.
- **Time to healthy:** create request to the workload or health command exiting zero and containing the expected marker.
- **Workload:** first ready command to verified workload health.
- **Cleanup:** delete request through confirmation that the sandbox no longer exists.

Timings are observed from Cloudflare Workflows and include API/network latency. Startup polling is every 200 ms; health polling is every 250 ms. The `runnerColo` field records the initiating request's Cloudflare location, not a guarantee of Workflow placement. Workflows can execute elsewhere. No Workflow scheduling time is included in sample durations. Every sample gets a fresh instance, but provider-managed image caches and warm pools may be used. These measurements do not establish a guaranteed cold-start distribution.

Success requires both workload health and confirmed cleanup. Failed samples remain visible and count in success rates, but are excluded from latency aggregates. Median and p95 use linear interpolation. Three samples are exploratory; p95 is not a stable estimate of production tail latency. History only compares configurations that match exactly.

Sandboxes are deleted in `finally`, including by deterministic name after a lost create response. The runner verifies deletion. Sandboxes also have a ten-minute wall-clock TTL, two-minute idle stop, and immediate deletion on stop as fallback controls. Cleanup errors are recorded. Image builds may consume most of a timeout; increase the scenario timeout or prepare a snapshot if appropriate.

Pricing uses Daytona's published rates as of October 2, 2026, multiplied by observed lifetime and actual returned resources. It is a list-price estimate, includes all disk at list price, and excludes credits, free storage allowances, image build fees, and Cloudflare costs. Unknown lifetimes are represented as `null`. This is not actual invoiced spend. Pricing source: https://www.daytona.io/pricing.

Custom commands and their output are included in public report exports. Use nonsensitive benchmark commands. To evaluate Claude Code, prepare a snapshot/image with it installed and define an appropriate command and marker. For example, `claude --version` measures CLI readiness without requiring an Anthropic credential.

## Add a provider

1. Implement `SandboxProvider` in `worker/providers/types.ts`: `create`, `get`, `execute`, `delete`, and `estimateCost`.
2. Register the adapter in `worker/providers/index.ts` and its metadata in `src/shared.ts`.
3. Extend settings validation for that provider, and add its secret with Wrangler.
4. Define provider-specific sources/regions; ensure commands produce the same health markers for comparable scenarios.
5. Run a real evaluation and confirm deletion before enabling automatic reports.

The runner, report schema, scheduler, exports, and UI are shared. Daytona Docker images use the provider's `buildInfo` API with a `FROM` Dockerfile; snapshots use the snapshot API directly. Use pinned image tags or digests for repeatable comparisons.

## Verify

```sh
npm run cf-typegen
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run
```

Tests cover lost create responses, key redaction, output verification, delayed health, cleanup failures, failure-aware statistics, and bounds on configurable spending. A real deployed report is the integration test for the Workers/Workflow/D1/Daytona path.

## First verified live results

On October 2, 2026, the deployed Worker completed [report 8e41163](https://sandbox-compare.sync-cheap.workers.dev/api/reports/8e411631-a09e-4ec6-8c54-75d4b995f968.json): nine of nine samples passed, with every sandbox deletion confirmed. Each workload used three fresh `daytona-small` instances in the US region.

| Workload | Create API median | Command ready median | Healthy median |
| --- | --- | --- | --- |
| Shell command | 117 ms | 434 ms | 569 ms |
| Python HTTP server | 115 ms | 273 ms | 557 ms |
| Node HTTP server | 121 ms | 259 ms | 658 ms |

The separate [image validation report](https://sandbox-compare.sync-cheap.workers.dev/api/reports/5965855a-57ac-4b68-bdaf-d4309dbbfa5a.json) completed four of four samples, including a fresh `python:3.12-slim` image sandbox that reached verified shell health in 11.366 seconds. This is one image-build observation, not an image startup distribution. Initial failed integration reports remain in the archive.
