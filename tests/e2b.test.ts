import { afterEach, describe, expect, it, vi } from 'vitest';
import { E2B_SCENARIOS } from '../src/shared';
import { connectFrame, decodeCommand, E2BProvider } from '../worker/providers/e2b';
import { readBytes } from '../worker/providers/http';
import { runSample } from '../worker/runner';
import { validateSettings } from '../worker/validation';

const env = { E2B_API_KEY: 'project-secret' } as Env;
function stream(...frames: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(frames.reduce((length, frame) => length + frame.length, 0));
  let offset = 0;
  for (const frame of frames) { bytes.set(frame, offset); offset += frame.length; }
  return bytes;
}
const output = (text: string) => connectFrame({ event: { data: { stdout: btoa(text) } } });
const ended = (exitCode = 0) => connectFrame({ event: { end: { exited: true, ...(exitCode ? { exitCode } : {}) } } });
const terminal = () => connectFrame({}, 2);
afterEach(() => vi.unstubAllGlobals());

describe('E2B command verification', () => {
  it('decodes split Unicode output, omitted zero exit codes, and nonzero exits', () => {
    const bytes = new TextEncoder().encode('healthy ✓');
    const data = [...bytes].map(byte => connectFrame({ event: { data: { stdout: btoa(String.fromCharCode(byte)) } } }));
    expect(decodeCommand(stream(...data, ended(), terminal()))).toEqual({ exitCode: 0, result: 'healthy ✓' });
    expect(decodeCommand(stream(output('failed'), ended(7), terminal()))).toEqual({ exitCode: 7, result: 'failed' });
  });
  it('rejects HTTP-success streams with RPC errors, missing exits, or truncated envelopes', () => {
    for (const bytes of [
      stream(output('SANDBOX_HEALTHY'), ended(), connectFrame({ error: { code: 'unavailable', message: 'routing failed' } }, 2)),
      stream(output('SANDBOX_HEALTHY'), terminal()),
      stream(output('SANDBOX_HEALTHY'), ended()),
      connectFrame({}).subarray(0, 6),
    ]) expect(() => decodeCommand(bytes)).toThrow();
  });
  it('cancels oversized provider response streams', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel }));
    await expect(readBytes(response)).rejects.toThrow('64 KiB');
    expect(cancel).toHaveBeenCalled();
  });
  it('sends the ephemeral sandbox token rather than the project key to envd', async () => {
    const fetch = vi.fn(async () => new Response(stream(output('ok'), ended(), terminal())));
    vi.stubGlobal('fetch', fetch);
    await new E2BProvider(env).execute({ id: 'test', state: 'started', region: 'provider-default', source: 'base',
      resources: { cpu: 2, memory: 4, disk: 10 }, toolboxUrl: 'https://sandbox.e2b.app', accessToken: 'sandbox-secret' }, 'printf ok', 5);
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://sandbox.e2b.app/process.Process/Start');
    expect(request.headers).toMatchObject({ 'X-Access-Token': 'sandbox-secret', 'Connect-Timeout-Ms': '5000' });
    expect(JSON.stringify(request)).not.toContain('project-secret');
  });
});

describe('E2B lifecycle and resource accounting', () => {
  it('recovers every matching sandbox across pages after a lost create response', async () => {
    const name = 'sbi-report-e2b-shell-1';
    const match = (sandboxID: string) => ({ sandboxID, templateID: 'base', metadata: { 'sandbox-index': 'benchmark', 'benchmark-name': name } });
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      const query = new URL(url).searchParams;
      expect(query.get('metadata')).toBe(`sandbox-index=benchmark&benchmark-name=${name}`);
      return query.has('nextToken') ? Response.json([match('second')]) : Response.json([match('first'), {
        ...match('unrelated'), metadata: { 'sandbox-index': 'benchmark', 'benchmark-name': 'someone-else' },
      }], { headers: { 'X-Next-Token': 'second-page' } });
    });
    vi.stubGlobal('fetch', fetch);
    await new E2BProvider(env).delete(name);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url)).toEqual([
      'https://api.e2b.app/sandboxes/first', 'https://api.e2b.app/sandboxes/second',
    ]);
  });
  it('records actual template resources and verifies deletion in a complete sample', async () => {
    let alive = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/process.Process/Start')) {
        const bytes = init?.body as Uint8Array;
        const command = JSON.parse(new TextDecoder().decode(bytes.subarray(5))).process.args[2];
        return new Response(stream(output(command.includes('BENCH_READY') ? 'BENCH_READY' : 'SANDBOX_HEALTHY sandbox-secret'), ended(), terminal()));
      }
      if (init?.method === 'POST') {
        expect(JSON.parse(init.body as string)).toMatchObject({ templateID: 'base', timeout: 600, autoPause: false, network: { allowPublicTraffic: false } });
        alive = true;
        return Response.json({ sandboxID: 'test', templateID: 'resolved-template', envdAccessToken: 'sandbox-secret' });
      }
      if (init?.method === 'DELETE') { alive = false; return new Response(null, { status: 204 }); }
      if (url.includes('/v2/sandboxes')) return Response.json([]);
      return alive ? Response.json({ sandboxID: 'test', templateID: 'resolved-template', state: 'running', cpuCount: 2, memoryMB: 512, diskSizeMB: 10240 }) : Response.json({}, { status: 404 });
    });
    vi.stubGlobal('fetch', fetch);
    const sample = await runSample(new E2BProvider(env), E2B_SCENARIOS[0], 'report', 1, 'TEST', ['project-secret']);
    expect(sample.status).toBe('passed'); expect(sample.cleanup).toBe('deleted');
    expect(sample.resources).toEqual({ cpu: 2, memory: .5, disk: 10 });
    expect(sample.actualSource).toBe('resolved-template');
    expect(JSON.stringify(sample)).not.toContain('sandbox-secret');
    expect(sample.output).toContain('[redacted]');
    expect(sample.estimatedCostUsd).not.toBeNull();
  });
  it('accepts templates and rejects unsupported region overrides', () => {
    const settings = { intervalHours: 24, repetitions: 3, enabled: true, scenarios: E2B_SCENARIOS };
    expect(validateSettings(settings)).toEqual(settings);
    expect(() => validateSettings({ ...settings, scenarios: [{ ...E2B_SCENARIOS[0], region: 'us' }] })).toThrow('provider-default');
    expect(() => validateSettings({ ...settings, scenarios: Array.from({ length: 12 }, (_, index) => ({ ...E2B_SCENARIOS[0], id: `workload-${index}` })) })).toThrow('30 evaluations');
  });
});
