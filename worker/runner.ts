import type { Sample, Scenario } from '../src/shared';
import type { SandboxHandle, SandboxProvider } from './providers/types';
import { ProviderError } from './providers/daytona';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function safeError(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[redacted]');
  return message.slice(0, 1000);
}
export async function runSample(provider: SandboxProvider, scenario: Scenario, reportId: string, repetition: number, runnerColo: string, secrets: string[] = []): Promise<Sample> {
  const name = `sbi-${reportId}-${scenario.id}-${repetition}`;
  const t0 = Date.now(); let sandbox: SandboxHandle | null = null;
  const sample: Sample = {
    id: `${reportId}-${scenario.id}-${repetition}`, reportId, scenarioId: scenario.id, scenarioName: scenario.name, provider: scenario.provider,
    repetition, startedAt: new Date(t0).toISOString(), finishedAt: '', status: 'failed', sandboxId: null,
    region: scenario.region, actualSource: null, resources: { cpu: scenario.cpu, memory: scenario.memory, disk: scenario.disk },
    createApiMs: null, startedMs: null, commandReadyMs: null, workloadMs: null, healthyMs: null, cleanupMs: null,
    lifetimeMs: 0, estimatedCostUsd: null, cleanup: 'not-created', error: null, output: '', runnerColo, probeAttempts: 0,
  };
  try {
    // A replay must never reuse a warm sandbox and report it as a fresh measurement.
    const existing = await provider.get(name);
    if (existing) throw new Error('Interrupted sample found an existing sandbox; excluded from timing statistics.');
    const start = Date.now();
    sample.startedAt = new Date(start).toISOString();
    sandbox = await provider.create(scenario, name);
    sample.createApiMs = Date.now() - start;
    sample.sandboxId = sandbox.id; sample.region = sandbox.region; sample.actualSource = sandbox.source; sample.resources = sandbox.resources;
    const deadline = start + scenario.timeoutSeconds * 1000;
    while (sandbox.state !== 'started') {
      if (Date.now() >= deadline) throw new Error(`Sandbox did not start within ${scenario.timeoutSeconds}s.`);
      await sleep(200);
      sandbox = await provider.get(sandbox.id);
      if (!sandbox) throw new Error('Sandbox disappeared during startup.');
    }
    sample.startedMs = Date.now() - start;
    while (true) {
      if (Date.now() >= deadline) throw new Error('Command readiness timed out.');
      try {
        const ready = await provider.execute(sandbox, "printf 'BENCH_READY'", 5);
        sample.probeAttempts++;
        if (ready.exitCode === 0 && ready.result.includes('BENCH_READY')) break;
      } catch (error) {
        sample.probeAttempts++;
        if (!(error instanceof ProviderError && [408, 409, 425, 502, 503, 504].includes(error.status))) throw error;
      }
      await sleep(200);
    }
    sample.commandReadyMs = Date.now() - start;
    const workloadStart = Date.now();
    const command = await provider.execute(sandbox, scenario.command, Math.min(scenario.timeoutSeconds, 60));
    sample.output = command.result.slice(0, 4000);
    if (command.exitCode !== 0) throw new Error(`Workload exited ${command.exitCode}: ${command.result.slice(0, 500)}`);
    if (scenario.healthCommand) {
      const healthDeadline = workloadStart + scenario.timeoutSeconds * 1000;
      let lastOutput = '';
      while (true) {
        if (Date.now() >= healthDeadline) throw new Error(`Health check timed out: ${lastOutput.slice(0, 300)}`);
        const health = await provider.execute(sandbox, scenario.healthCommand, 5);
        sample.probeAttempts++; lastOutput = health.result;
        if (health.exitCode === 0 && health.result.includes(scenario.expectedOutput)) { sample.output = health.result.slice(0, 4000); break; }
        await sleep(250);
      }
    } else if (!command.result.includes(scenario.expectedOutput)) throw new Error('Command output did not contain the expected health marker.');
    sample.workloadMs = Date.now() - workloadStart;
    sample.healthyMs = Date.now() - start;
    sample.status = 'passed';
  } catch (error) { sample.error = safeError(error, secrets); }
  finally {
    // Delete by deterministic name even when create timed out before returning an ID.
    const cleanupStart = Date.now();
    try {
      await provider.delete(sandbox?.id ?? name);
      const cleanupDeadline = Date.now() + 45000;
      while (true) {
        const remaining = await provider.get(sandbox?.id ?? name);
        if (!remaining) break;
        if (Date.now() >= cleanupDeadline) throw new Error('Sandbox deletion could not be confirmed; TTL remains the fallback.');
        await sleep(500);
      }
      sample.cleanup = sandbox ? 'deleted' : 'not-created';
    } catch (error) {
      sample.cleanup = 'failed'; sample.status = 'failed';
      sample.error = [sample.error, `Cleanup: ${safeError(error, secrets)}`].filter(Boolean).join('; ');
    }
    sample.cleanupMs = Date.now() - cleanupStart;
    sample.finishedAt = new Date().toISOString();
    sample.lifetimeMs = Date.now() - Date.parse(sample.startedAt);
    sample.estimatedCostUsd = sandbox && sample.cleanup === 'deleted' ? provider.estimateCost(sandbox.resources, sample.lifetimeMs) : null;
    sample.output = safeError(sample.output, secrets);
  }
  return sample;
}
