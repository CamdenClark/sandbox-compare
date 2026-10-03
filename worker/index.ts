import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { PROVIDER_PRICING, PROVIDERS, nextScheduledTime, type Settings } from '../src/shared';
import { control, finishReport, getReports, saveSample } from './store';
import { getProvider, providerConnected, runtimeSecrets } from './providers';
import { runSample, safeError } from './runner';
import { validateSettings } from './validation';

interface RunParams { reportId: string; settings: Settings; runnerColo: string }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

async function authorize(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false;
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
  const encoder = new TextEncoder();
  // Compare fixed-size hashes to avoid exposing token length or prefix.
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(token)),
    crypto.subtle.digest('SHA-256', encoder.encode(env.ADMIN_TOKEN)),
  ]);
  return timingSafeEqual(new Uint8Array(actual), new Uint8Array(expected));
}

export async function startReport(env: Env, trigger: 'manual' | 'scheduled', runnerColo = 'workflow'): Promise<string | null> {
  const state = await control(env);
  const settings: Settings = JSON.parse(state.settings_json);
  if (trigger === 'scheduled' && (!settings.enabled || Date.now() < state.next_run_at)) return null;
  for (const provider of new Set(settings.scenarios.filter(s => s.enabled).map(s => s.provider))) {
    if (!providerConnected(provider, env)) throw new Error(`Configure ${provider.toUpperCase()}_API_KEY before running benchmarks.`);
  }
  const id = crypto.randomUUID(); const now = Date.now();
  const claim = await env.DB.prepare('UPDATE control SET active_run = ?, lease_until = ?, next_run_at = ? WHERE id = 1 AND active_run IS NULL AND (? = 1 OR next_run_at <= ?)').bind(id, now + 6 * 3600000, nextScheduledTime(now, settings.intervalHours), trigger === 'manual' ? 1 : 0, now).run();
  if (!claim.meta.changes) return null;
  try {
    const expected = settings.scenarios.filter(s => s.enabled).length * settings.repetitions;
    await env.DB.prepare('INSERT INTO reports (id, started_at, status, trigger, settings_json, expected_samples) VALUES (?, ?, ?, ?, ?, ?)').bind(id, new Date(now).toISOString(), 'queued', trigger, JSON.stringify(settings), expected).run();
    await env.BENCHMARK.create({ id, params: { reportId: id, settings, runnerColo } satisfies RunParams });
    return id;
  } catch (error) {
    await finishReport(env, id, 'failed', safeError(error, runtimeSecrets(env)));
    throw error;
  }
}

export class BenchmarkWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { reportId, settings, runnerColo } = event.payload;
    try {
      await step.do('start report', async () => {
        await this.env.DB.prepare('UPDATE reports SET status = ? WHERE id = ?').bind('running', reportId).run();
      });
      // Sequential fresh sandboxes keep resource demand predictable. No measurement retries.
      // All timing happens inside one step, excluding Workflow scheduling delays.
      for (let repetition = 1; repetition <= settings.repetitions; repetition++) {
        for (const scenario of settings.scenarios.filter(s => s.enabled)) {
          const sample = await step.do(`measure ${scenario.id} ${repetition}`, { retries: { limit: 0, delay: '1 second' }, timeout: '8 minutes' }, async () => {
            return runSample(getProvider(scenario.provider, this.env), scenario, reportId, repetition, runnerColo, runtimeSecrets(this.env));
          });
          await step.do(`save ${scenario.id} ${repetition}`, async () => { await saveSample(this.env, sample); });
        }
      }
      await step.do('finish report', async () => {
        const [report] = await getReports(this.env, reportId);
        const passed = report.samples.filter(s => s.status === 'passed').length;
        const status = report.samples.length !== report.expectedSamples || !passed ? 'failed' : passed === report.expectedSamples ? 'completed' : 'partial';
        await finishReport(this.env, reportId, status);
      });
    } catch (error) {
      await step.do('record workflow failure', async () => {
        // Recover potentially orphaned sandboxes by deterministic name after a step interruption.
        for (const s of settings.scenarios.filter(x => x.enabled)) {
          const provider = getProvider(s.provider, this.env);
          for (let r = 1; r <= settings.repetitions; r++) {
            try { await provider.delete(`sbi-${reportId}-${s.id}-${r}`); }
            catch (cleanupError) { console.error(JSON.stringify({ event: 'cleanup-failed', reportId, error: safeError(cleanupError, runtimeSecrets(this.env)) })); }
          }
        }
        await finishReport(this.env, reportId, 'failed', safeError(error, runtimeSecrets(this.env)));
      });
    }
    return { reportId };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === '/api/dashboard' && request.method === 'GET') {
        const state = await control(env);
        const settings: Settings = JSON.parse(state.settings_json);
        return json({ settings, reports: await getReports(env), activeRun: state.active_run,
          nextRunAt: settings.enabled ? new Date(state.next_run_at).toISOString() : null,
          providers: PROVIDERS.map(p => ({ ...p, connected: providerConnected(p.id, env) })), pricing: PROVIDER_PRICING });
      }
      const reportMatch = url.pathname.match(/^\/api\/reports\/([a-f0-9-]{36})(\.json|\.md)?$/);
      if (reportMatch && request.method === 'GET') {
        const [report] = await getReports(env, reportMatch[1]);
        if (!report) return json({ error: 'Report not found.' }, 404);
        if (reportMatch[2] === '.md') {
          const lines = [`# Sandbox Index — ${report.startedAt}`, '', `Status: ${report.status}. Trigger: ${report.trigger}. Samples: ${report.samples.length}/${report.expectedSamples}.`, '', '| Provider | Workload | Passed | Create median | Ready median | Healthy median | Healthy p95 |', '| --- | --- | --- | --- | --- | --- | --- |', ...report.aggregates.map(a => `| ${a.provider} | ${a.scenarioName.replaceAll('|', '\\|')} | ${a.passed}/${a.total} | ${a.createMedianMs ?? '—'} ms | ${a.readyMedianMs ?? '—'} ms | ${a.healthyMedianMs ?? '—'} ms | ${a.healthyP95Ms ?? '—'} ms |`), '', 'Times are client-observed from Cloudflare, including network latency. Ready means a verified shell command. Health probes run inside the sandbox. Fresh sandbox instances may use provider caches or warm pools. Small-sample p95 uses linear interpolation and is not a stable tail estimate.', '', ...Object.entries(PROVIDER_PRICING).filter(([provider]) => report.aggregates.some(a => a.provider === provider)).flatMap(([provider, price]) => [`Pricing (${provider}): ${price.note}`, price.source]), '', '## Raw samples', '', '```json', JSON.stringify(report.samples, null, 2), '```'];
          return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="sandbox-report-${report.id}.md"` } });
        }
        return Response.json({ ...report, pricing: PROVIDER_PRICING }, { headers: { 'Cache-Control': 'no-store', ...(reportMatch[2] ? { 'Content-Disposition': `attachment; filename="sandbox-report-${report.id}.json"` } : {}) } });
      }
      if (request.method === 'POST' || request.method === 'PUT') {
        const origin = request.headers.get('Origin');
        if (origin && origin !== url.origin) return json({ error: 'Cross-origin writes are disabled.' }, 403);
        if (!(await authorize(request, env))) return json({ error: 'Enter your admin token to run benchmarks or change settings.' }, 401);
        if (url.pathname === '/api/auth' && request.method === 'POST') return json({ authorized: true });
        if (url.pathname === '/api/runs' && request.method === 'POST') {
          const id = await startReport(env, 'manual', String(request.cf?.colo ?? 'local'));
          return id ? json({ reportId: id }, 202) : json({ error: 'A benchmark is already running.' }, 409);
        }
        if (url.pathname === '/api/settings' && request.method === 'PUT') {
          const body = await request.text();
          if (body.length > 64000) return json({ error: 'Settings too large.' }, 413);
          const settings = validateSettings(JSON.parse(body));
          await control(env);
          await env.DB.prepare('UPDATE control SET settings_json = ?, next_run_at = ? WHERE id = 1').bind(JSON.stringify(settings), nextScheduledTime(Date.now(), settings.intervalHours)).run();
          return json({ settings });
        }
      }
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      const message = safeError(error, runtimeSecrets(env));
      console.error(JSON.stringify({ event: 'api-error', path: url.pathname, error: message }));
      return json({ error: message }, url.pathname === '/api/settings' ? 400 : 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const state = await control(env);
      if (state.active_run) {
        try {
          const instance = await env.BENCHMARK.get(state.active_run);
          const status = await instance.status();
          if (['errored', 'terminated', 'complete'].includes(status.status)) {
            const [report] = await getReports(env, state.active_run);
            if (!report || ['running', 'queued'].includes(report.status)) await finishReport(env, state.active_run, 'failed', 'Workflow stopped before report finalization.');
            else await env.DB.prepare('UPDATE control SET active_run = NULL, lease_until = NULL WHERE active_run = ?').bind(state.active_run).run();
          }
        } catch (error) {
          if (state.lease_until && state.lease_until < Date.now()) await finishReport(env, state.active_run, 'failed', 'Workflow lease expired. Sandbox TTL handles abandoned instances.');
          else console.error(JSON.stringify({ event: 'workflow-reconcile-error', error: safeError(error, runtimeSecrets(env)) }));
        }
      }
      await startReport(env, 'scheduled');
    })());
  },
} satisfies ExportedHandler<Env>;
