import { afterEach, describe, expect, it, vi } from 'vitest';
import { aggregate, DEFAULT_SETTINGS, nextScheduledTime, percentile, shellQuote, type Sample } from '../src/shared';
import { execFileSync } from 'node:child_process';
import { runSample } from '../worker/runner';
import { validateSettings } from '../worker/validation';
import type { SandboxHandle, SandboxProvider } from '../worker/providers/types';
import { createPayload } from '../worker/providers/daytona';

function fakeProvider(options: { createFail?: boolean; healthFails?: number; cleanupFail?: boolean; wrongMarker?: boolean } = {}): SandboxProvider & { delete: ReturnType<typeof vi.fn> } {
  let alive = false; let checks = 0;
  const handle: SandboxHandle = { id: 'test-sandbox', state: 'started', region: 'us', source: 'test', resources: { cpu: 1, memory: 1, disk: 3 }, toolboxUrl: 'https://proxy.app.daytona.io/toolbox' };
  return {
    create: async () => { if (options.createFail) { alive = true; throw new Error('Create response lost with secret-test-key'); } alive = true; return handle; },
    get: async () => alive ? handle : null,
    execute: async (_sandbox, command) => {
      if (command.includes('BENCH_READY')) return { exitCode: 0, result: 'BENCH_READY' };
      if (command.includes('curl')) return ++checks <= (options.healthFails ?? 0) ? { exitCode: 7, result: 'Connection refused' } : { exitCode: 0, result: 'SANDBOX_HEALTHY' };
      return { exitCode: 0, result: options.wrongMarker ? 'WRONG' : 'SANDBOX_HEALTHY' };
    },
    delete: vi.fn(async () => { if (options.cleanupFail) throw new Error('Cannot delete'); alive = false; }),
    estimateCost: () => .001,
  };
}
afterEach(() => vi.useRealTimers());
describe('real benchmark failure boundaries', () => {
  it('preserves embedded quotes in commands accepted by real shells', () => {
    const command = `printf '%s' ${shellQuote(`require("node:http").listen(3000); 'quoted'`)}`;
    expect(execFileSync('sh', ['-c', command], { encoding: 'utf8' })).toBe(`require("node:http").listen(3000); 'quoted'`);
    expect(() => execFileSync('sh', ['-n', '-c', DEFAULT_SETTINGS.scenarios[2].command])).not.toThrow();
  });
  it('deletes by deterministic name after a lost create response and redacts keys', async () => {
    const provider = fakeProvider({ createFail: true });
    const result = await runSample(provider, DEFAULT_SETTINGS.scenarios[0], 'report-id', 1, 'TEST', ['secret-test-key']);
    expect(result.status).toBe('failed');
    expect(result.healthyMs).toBeNull();
    expect(result.estimatedCostUsd).toBeNull();
    expect(result.error).not.toContain('secret-test-key');
    expect(provider.delete).toHaveBeenCalledWith('sbi-report-id-shell-1');
  });
  it('requires the expected marker even when a command exits successfully', async () => {
    const result = await runSample(fakeProvider({ wrongMarker: true }), DEFAULT_SETTINGS.scenarios[0], 'report-id', 1, 'TEST');
    expect(result.status).toBe('failed');
    expect(result.cleanup).toBe('deleted');
    expect(result.error).toContain('expected health marker');
  });
  it('waits for an actual healthy response and includes probe delays', async () => {
    vi.useFakeTimers();
    const promise = runSample(fakeProvider({ healthFails: 2 }), DEFAULT_SETTINGS.scenarios[1], 'report-id', 1, 'TEST');
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.status).toBe('passed');
    expect(result.probeAttempts).toBe(4);
    expect(result.healthyMs).toBeGreaterThanOrEqual(500);
    expect(result.cleanup).toBe('deleted');
  });
  it('marks cleanup failures and does not invent a known lifetime cost', async () => {
    const result = await runSample(fakeProvider({ cleanupFail: true }), DEFAULT_SETTINGS.scenarios[0], 'report-id', 1, 'TEST');
    expect(result.status).toBe('failed');
    expect(result.cleanup).toBe('failed');
    expect(result.estimatedCostUsd).toBeNull();
  });
  it('excludes failures from latency statistics but counts them in the denominator', () => {
    const samples = [{ scenarioId: 'shell', status: 'passed', createApiMs: 100, commandReadyMs: 200, healthyMs: 300, estimatedCostUsd: .01 }, { scenarioId: 'shell', status: 'failed', createApiMs: 9999, commandReadyMs: 9999, healthyMs: 9999, estimatedCostUsd: .02 }] as Sample[];
    const result = aggregate(samples, DEFAULT_SETTINGS.scenarios)[0];
    expect(result.healthyMedianMs).toBe(300); expect(result.passed).toBe(1); expect(result.total).toBe(2); expect(result.costUsd).toBeCloseTo(.03);
    expect(percentile([], .95)).toBeNull(); expect(percentile([10, 20, 30], .95)).toBe(29);
  });
});
describe('cost control validation', () => {
  it('aligns due dates to hourly cron ticks without shortening the interval', () => {
    const start = Date.parse('2026-10-03T00:31:20Z');
    expect(new Date(nextScheduledTime(start, 24)).toISOString()).toBe('2026-10-04T01:00:00.000Z');
    expect(nextScheduledTime(start, 24) - start).toBeGreaterThanOrEqual(24 * 3600000);
  });
  it('inherits snapshot resources and only sends custom resources for Docker images', () => {
    const snapshot = createPayload(DEFAULT_SETTINGS.scenarios[0], 'test');
    expect(snapshot).not.toHaveProperty('cpu');
    expect(snapshot).not.toHaveProperty('memory');
    expect(snapshot).not.toHaveProperty('disk');
    expect(snapshot).toHaveProperty('ttlMinutes', 10);
    const image = createPayload({ ...DEFAULT_SETTINGS.scenarios[0], sourceType: 'image', source: 'python:3.12-slim', cpu: 2 }, 'test');
    expect(image).toHaveProperty('cpu', 2);
    expect(image).toHaveProperty('buildInfo.dockerfileContent', 'FROM python:3.12-slim\n');
  });
  it('rejects unsupported providers, duplicate IDs, image injection, and excessive samples', () => {
    for (const change of [
      { repetitions: 6 },
      { scenarios: [DEFAULT_SETTINGS.scenarios[0], DEFAULT_SETTINGS.scenarios[0]] },
      { scenarios: [{ ...DEFAULT_SETTINGS.scenarios[0], provider: 'modal' }] },
      { scenarios: [{ ...DEFAULT_SETTINGS.scenarios[0], provider: 'e2b' }] },
      { scenarios: [{ ...DEFAULT_SETTINGS.scenarios[0], sourceType: 'template' }] },
      { scenarios: [{ ...DEFAULT_SETTINGS.scenarios[0], sourceType: 'image', source: 'node:22\nRUN curl bad.example' }] },
    ]) expect(() => validateSettings({ ...DEFAULT_SETTINGS, ...change })).toThrow();
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });
});
