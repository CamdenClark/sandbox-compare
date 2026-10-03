import { DAYTONA_PRICING, type Scenario } from '../../src/shared';
import type { CommandResult, SandboxHandle, SandboxProvider } from './types';

export class ProviderError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
interface DaytonaSandbox { id: string; state: string; target: string; snapshot: string; cpu: number; memory: number; disk: number; toolboxProxyUrl: string; errorReason?: string }

export function createPayload(s: Scenario, name: string) {
  // Snapshot resources are fixed by the snapshot; custom resources are valid only for images.
  const source = s.sourceType === 'snapshot' ? { snapshot: s.source } : {
    buildInfo: { dockerfileContent: `FROM ${s.source}\n`, contextHashes: [] },
    cpu: s.cpu, memory: s.memory, disk: s.disk,
  };
  return { ...source, name, target: s.region, public: false, autoStopInterval: 2,
    autoDeleteInterval: 0, ttlMinutes: 10, labels: { 'sandbox-index': 'benchmark', 'benchmark-name': name } };
}

async function readBounded(response: Response, maxBytes = 65536): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('Provider response exceeded 64 KiB; keep benchmark output small.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const buffer = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(buffer);
}

export class DaytonaProvider implements SandboxProvider {
  constructor(private env: Env) {}
  private async request<T>(url: string, method = 'GET', body?: unknown, timeoutMs = 30000): Promise<T> {
    if (!this.env.DAYTONA_API_KEY) throw new Error('DAYTONA_API_KEY is not configured.');
    const response = await fetch(url, {
      method, headers: { Authorization: `Bearer ${this.env.DAYTONA_API_KEY}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await readBounded(response);
    if (!response.ok) throw new ProviderError(`Daytona HTTP ${response.status}: ${text.slice(0, 500)}`, response.status);
    return text ? JSON.parse(text) as T : undefined as T;
  }
  private handle(sandbox: DaytonaSandbox): SandboxHandle {
    if (!sandbox.id) throw new Error('Daytona did not return a sandbox ID.');
    if (['error', 'build_failed', 'destroyed'].includes(sandbox.state)) throw new Error(`Sandbox ${sandbox.state}: ${sandbox.errorReason ?? 'provider failure'}`);
    const toolbox = sandbox.toolboxProxyUrl || this.env.DAYTONA_TOOLBOX_URL;
    const url = new URL(toolbox);
    if (url.protocol !== 'https:' || !(url.hostname === 'daytona.io' || url.hostname.endsWith('.daytona.io'))) throw new Error('Untrusted Daytona toolbox host.');
    return { id: sandbox.id, state: sandbox.state, region: sandbox.target, source: sandbox.snapshot,
      resources: { cpu: sandbox.cpu, memory: sandbox.memory, disk: sandbox.disk }, toolboxUrl: toolbox.replace(/\/$/, '') };
  }
  async create(s: Scenario, name: string): Promise<SandboxHandle> {
    const body = createPayload(s, name);
    return this.handle(await this.request<DaytonaSandbox>(`${this.env.DAYTONA_API_URL}/sandbox`, 'POST', body));
  }
  async get(idOrName: string): Promise<SandboxHandle | null> {
    try {
      const sandbox = await this.request<DaytonaSandbox>(`${this.env.DAYTONA_API_URL}/sandbox/${encodeURIComponent(idOrName)}`);
      return sandbox.state === 'destroyed' ? null : this.handle(sandbox);
    }
    catch (error) { if (error instanceof ProviderError && error.status === 404) return null; throw error; }
  }
  async execute(sandbox: SandboxHandle, command: string, timeoutSeconds: number): Promise<CommandResult> {
    const result = await this.request<{ exitCode?: number; result: string }>(`${sandbox.toolboxUrl}/${encodeURIComponent(sandbox.id)}/process/execute`, 'POST', { command, timeout: timeoutSeconds }, (timeoutSeconds + 5) * 1000);
    return { exitCode: result.exitCode ?? -1, result: result.result ?? '' };
  }
  async delete(idOrName: string): Promise<void> {
    try { await this.request(`${this.env.DAYTONA_API_URL}/sandbox/${encodeURIComponent(idOrName)}`, 'DELETE'); }
    catch (error) { if (!(error instanceof ProviderError && error.status === 404)) throw error; }
  }
  estimateCost(r: SandboxHandle['resources'], lifetimeMs: number): number {
    return lifetimeMs / 3600000 * (r.cpu * DAYTONA_PRICING.cpuHour + r.memory * DAYTONA_PRICING.memoryGiBHour + r.disk * DAYTONA_PRICING.diskGiBHour);
  }
}
