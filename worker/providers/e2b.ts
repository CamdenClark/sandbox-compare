import { E2B_PRICING, type Scenario } from '../../src/shared';
import { readBytes, readText } from './http';
import { ProviderError, type CommandResult, type SandboxHandle, type SandboxProvider } from './types';

const API = 'https://api.e2b.app';
const ENVD = 'https://sandbox.e2b.app';
interface E2BSandbox {
  sandboxID: string; templateID: string; envdAccessToken?: string;
  state?: 'running' | 'paused'; cpuCount?: number; memoryMB?: number; diskSizeMB?: number;
  metadata?: Record<string, string>;
}

// Envd commands use Connect's five-byte envelopes, including a terminal frame.
// HTTP 200 alone cannot establish command success.
export function connectFrame(message: unknown, flags = 0): Uint8Array<ArrayBuffer> {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const frame = new Uint8Array(payload.length + 5);
  frame[0] = flags; new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5); return frame;
}
export function decodeCommand(bytes: Uint8Array): CommandResult {
  const decoder = new TextDecoder(), outputDecoder = new TextDecoder(); let offset = 0, terminal = false, exitCode: number | null = null;
  let result = '';
  while (offset < bytes.length) {
    if (terminal || bytes.length - offset < 5) throw new Error('Invalid E2B Connect envelope.');
    const flags = bytes[offset];
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0);
    offset += 5;
    if (![0, 2].includes(flags) || length > bytes.length - offset) throw new Error('Truncated or unsupported E2B Connect frame.');
    const message = JSON.parse(decoder.decode(bytes.subarray(offset, offset + length)));
    offset += length;
    if (flags === 2) {
      terminal = true;
      if (message.error) {
        const status = message.error.code === 'unavailable' ? 503 : message.error.code === 'deadline_exceeded' ? 408 : 500;
        throw new ProviderError(`E2B command RPC ${message.error.code}: ${String(message.error.message).slice(0, 500)}`, status);
      }
      continue;
    }
    const event = message.event;
    if (event?.data) {
      for (const stream of ['stdout', 'stderr'] as const) {
        if (typeof event.data[stream] === 'string') {
          const raw = atob(event.data[stream]);
          result += outputDecoder.decode(Uint8Array.from(raw, char => char.charCodeAt(0)), { stream: true });
        }
      }
    }
    if (event?.end) {
      // Protobuf JSON omits zero-valued scalar fields.
      exitCode = event.end.exitCode ?? 0;
      if (!Number.isInteger(exitCode)) throw new Error('Invalid E2B exit code.');
      // Envd includes an error string for ordinary nonzero shell exits, such as
      // curl's exit 7 while a server starts. Return those to the health poller.
      if (exitCode === 0 && (event.end.error || event.end.exited !== true)) throw new Error(`E2B process did not exit normally: ${event.end.error ?? event.end.status ?? 'unknown'}`);
    }
  }
  if (!terminal || exitCode === null) throw new Error('E2B command stream ended without a confirmed process exit.');
  return { exitCode, result: result + outputDecoder.decode() };
}

export class E2BProvider implements SandboxProvider {
  constructor(private env: Env) {}
  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<{ data: T; next: string | null }> {
    if (!this.env.E2B_API_KEY) throw new Error('E2B_API_KEY is not configured.');
    const response = await fetch(`${API}${path}`, {
      method, headers: { 'X-API-Key': this.env.E2B_API_KEY, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const text = await readText(response);
    if (!response.ok) throw new ProviderError(`E2B HTTP ${response.status}: ${text.slice(0, 500)}`, response.status);
    return { data: text ? JSON.parse(text) as T : undefined as T, next: response.headers.get('X-Next-Token') };
  }
  private handle(s: E2BSandbox): SandboxHandle {
    if (!s.sandboxID || !/^[a-zA-Z0-9-]+$/.test(s.sandboxID)) throw new Error('E2B did not return a valid sandbox ID.');
    return { id: s.sandboxID, state: s.state === 'paused' ? 'paused' : 'started', region: 'provider-default',
      source: s.templateID, resources: { cpu: s.cpuCount ?? null, memory: s.memoryMB === undefined ? null : s.memoryMB / 1024,
        disk: s.diskSizeMB === undefined ? null : s.diskSizeMB / 1024 }, toolboxUrl: ENVD, accessToken: s.envdAccessToken };
  }
  private async find(name: string): Promise<E2BSandbox[]> {
    const metadata = new URLSearchParams({ 'sandbox-index': 'benchmark', 'benchmark-name': name }).toString();
    const query = new URLSearchParams({ metadata, limit: '20', state: 'running,paused' });
    const matches: E2BSandbox[] = [];
    for (let page = 0; page < 20; page++) {
      const { data, next } = await this.request<E2BSandbox[]>(`/v2/sandboxes?${query}`);
      if (!Array.isArray(data)) throw new Error('Invalid E2B sandbox list.');
      matches.push(...data.filter(s => s.metadata?.['benchmark-name'] === name && s.metadata?.['sandbox-index'] === 'benchmark'));
      if (!next) return matches;
      query.set('nextToken', next);
    }
    throw new Error('E2B cleanup lookup exceeded its pagination limit.');
  }
  async create(s: Scenario, name: string): Promise<SandboxHandle> {
    const { data } = await this.request<E2BSandbox>('/v2/sandboxes', 'POST', {
      templateID: s.source, timeout: 600, autoPause: false,
      network: { allowPublicTraffic: false },
      metadata: { 'sandbox-index': 'benchmark', 'benchmark-name': name },
    });
    return this.handle(data);
  }
  async get(idOrName: string): Promise<SandboxHandle | null> {
    try {
      if (idOrName.startsWith('sbi-')) {
        const [match] = await this.find(idOrName);
        return match ? this.handle(match) : null;
      }
      return this.handle((await this.request<E2BSandbox>(`/sandboxes/${encodeURIComponent(idOrName)}`)).data);
    } catch (error) { if (error instanceof ProviderError && error.status === 404) return null; throw error; }
  }
  async execute(sandbox: SandboxHandle, command: string, timeoutSeconds: number): Promise<CommandResult> {
    if (!sandbox.accessToken) throw new Error('E2B did not return a secured command access token.');
    const response = await fetch(`${ENVD}/process.Process/Start`, {
      method: 'POST', headers: { 'Content-Type': 'application/connect+json', 'Connect-Protocol-Version': '1',
        'Connect-Timeout-Ms': String(timeoutSeconds * 1000), 'E2b-Sandbox-Id': sandbox.id, 'E2b-Sandbox-Port': '49983',
        'X-Access-Token': sandbox.accessToken },
      body: connectFrame({ process: { cmd: '/bin/bash', args: ['-l', '-c', command] }, stdin: false }),
      signal: AbortSignal.timeout((timeoutSeconds + 5) * 1000),
    });
    if (!response.ok) throw new ProviderError(`E2B command HTTP ${response.status}: ${(await readText(response)).slice(0, 500)}`, response.status);
    return decodeCommand(await readBytes(response));
  }
  async delete(idOrName: string): Promise<void> {
    const ids = idOrName.startsWith('sbi-') ? (await this.find(idOrName)).map(s => s.sandboxID) : [idOrName];
    for (const id of ids) {
      try { await this.request(`/sandboxes/${encodeURIComponent(id)}`, 'DELETE'); }
      catch (error) { if (!(error instanceof ProviderError && error.status === 404)) throw error; }
    }
  }
  estimateCost(r: SandboxHandle['resources'], lifetimeMs: number): number | null {
    if (r.cpu === null || r.memory === null) return null;
    return lifetimeMs / 3600000 * (r.cpu * E2B_PRICING.cpuHour + r.memory * E2B_PRICING.memoryGiBHour);
  }
}
