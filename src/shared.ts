export type ProviderId = 'daytona' | 'e2b' | 'modal' | 'cloudflare' | 'vercel';
export interface Scenario {
  id: string;
  name: string;
  description: string;
  provider: ProviderId;
  sourceType: 'snapshot' | 'image' | 'template';
  source: string;
  region: string;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  command: string;
  healthCommand: string;
  expectedOutput: string;
  timeoutSeconds: number;
  enabled: boolean;
}
export interface Settings { intervalHours: number; repetitions: number; enabled: boolean; scenarios: Scenario[] }
export interface Sample {
  id: string; reportId: string; scenarioId: string; scenarioName: string; provider: ProviderId;
  repetition: number; startedAt: string; finishedAt: string; status: 'passed' | 'failed';
  sandboxId: string | null; region: string; actualSource: string | null;
  resources: { cpu: number | null; memory: number | null; disk: number | null };
  createApiMs: number | null; startedMs: number | null; commandReadyMs: number | null;
  workloadMs: number | null; healthyMs: number | null; cleanupMs: number | null;
  lifetimeMs: number; estimatedCostUsd: number | null;
  cleanup: 'deleted' | 'not-created' | 'failed'; error: string | null; output: string;
  runnerColo: string; probeAttempts: number;
}
export interface Aggregate {
  scenarioId: string; scenarioName: string; provider: ProviderId;
  source: string; region: string; total: number; passed: number;
  createMedianMs: number | null; readyMedianMs: number | null; healthyMedianMs: number | null;
  healthyP95Ms: number | null; costUsd: number | null;
}
export interface Report {
  id: string; startedAt: string; finishedAt: string | null;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed';
  trigger: 'manual' | 'scheduled'; settings: Settings; expectedSamples: number;
  samples: Sample[]; aggregates: Aggregate[]; error: string | null;
}
export interface Dashboard {
  settings: Settings; reports: Report[]; nextRunAt: string | null; activeRun: string | null;
  providers: { id: ProviderId; name: string; enabled: boolean; connected: boolean; url: string }[];
}
export const PROVIDERS = [
  { id: 'daytona', name: 'Daytona', enabled: true, url: 'https://www.daytona.io' },
  { id: 'e2b', name: 'E2B', enabled: true, url: 'https://e2b.dev' },
  { id: 'modal', name: 'Modal', enabled: false, url: 'https://modal.com' },
  { id: 'cloudflare', name: 'Cloudflare', enabled: false, url: 'https://developers.cloudflare.com/sandbox/' },
  { id: 'vercel', name: 'Vercel', enabled: false, url: 'https://vercel.com/docs/vercel-sandbox' },
] as const;
export const DAYTONA_PRICING = {
  cpuHour: 0.0504, memoryGiBHour: 0.0162, diskGiBHour: 0.000108,
  checkedAt: '2026-10-02', source: 'https://www.daytona.io/pricing',
  note: 'List-price estimate from observed lifetime and actual resources. Includes all disk at list price; excludes credits, free storage allowances, image builds, and Cloudflare costs. Not an invoice.',
};
export const E2B_PRICING = {
  cpuHour: 0.0504, memoryGiBHour: 0.0162, diskGiBHour: 0,
  checkedAt: '2026-10-03', source: 'https://e2b.dev/pricing',
  note: 'List-price compute estimate from observed lifetime and actual template resources. Storage is included. Excludes credits, subscription fees, template builds, and Cloudflare costs. Not an invoice.',
};
export const PROVIDER_PRICING = { daytona: DAYTONA_PRICING, e2b: E2B_PRICING };
export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export function nextScheduledTime(now: number, intervalHours: number): number {
  const hour = 3600000;
  return Math.ceil((now + intervalHours * hour) / hour) * hour;
}
const DAYTONA_DEFAULT_SETTINGS: Settings = {
  intervalHours: 24, repetitions: 3, enabled: true,
  scenarios: [
    {
      id: 'shell', name: 'Shell command', description: 'Start a fresh sandbox and execute a verified shell command.',
      provider: 'daytona', sourceType: 'snapshot', source: 'daytona-small', region: 'us',
      cpu: 1, memory: 1, disk: 3, command: "printf 'SANDBOX_HEALTHY'",
      healthCommand: '', expectedOutput: 'SANDBOX_HEALTHY', timeoutSeconds: 120, enabled: true,
    },
    {
      id: 'python-http', name: 'Python HTTP server', description: 'Launch Python’s HTTP server and verify an HTTP response inside the sandbox.',
      provider: 'daytona', sourceType: 'snapshot', source: 'daytona-small', region: 'us',
      cpu: 1, memory: 1, disk: 3,
      command: "sh -lc 'mkdir -p /tmp/bench-web; printf SANDBOX_HEALTHY > /tmp/bench-web/index.html; nohup python3 -m http.server 3000 --bind 127.0.0.1 --directory /tmp/bench-web >/tmp/bench-server.log 2>&1 </dev/null &'",
      healthCommand: "curl --fail --silent --max-time 2 http://127.0.0.1:3000/", expectedOutput: 'SANDBOX_HEALTHY', timeoutSeconds: 120, enabled: true,
    },
    {
      id: 'node-http', name: 'Node HTTP server', description: 'Launch a Node.js server and verify its health endpoint inside the sandbox.',
      provider: 'daytona', sourceType: 'snapshot', source: 'daytona-small', region: 'us',
      cpu: 1, memory: 1, disk: 3,
      command: `sh -lc ${shellQuote(`nohup node -e ${shellQuote('require("node:http").createServer((req,res)=>{res.end("SANDBOX_HEALTHY")}).listen(3000,"127.0.0.1")')} >/tmp/bench-server.log 2>&1 </dev/null &`)}`,
      healthCommand: 'curl --fail --silent --max-time 2 http://127.0.0.1:3000/', expectedOutput: 'SANDBOX_HEALTHY', timeoutSeconds: 120, enabled: true,
    },
    {
      id: 'python-image', name: 'Python image · shell', description: 'Start from a public Docker image. Enable to compare image provisioning with a prepared snapshot.',
      provider: 'daytona', sourceType: 'image', source: 'python:3.12-slim', region: 'us',
      cpu: 1, memory: 1, disk: 3, command: "printf 'SANDBOX_HEALTHY'",
      healthCommand: '', expectedOutput: 'SANDBOX_HEALTHY', timeoutSeconds: 120, enabled: false,
    },
  ],
};
export const E2B_SCENARIOS: Scenario[] = DAYTONA_DEFAULT_SETTINGS.scenarios.filter(s => s.enabled).map(s => ({
  ...s, id: `e2b-${s.id}`, provider: 'e2b', sourceType: 'template', source: 'base', region: 'provider-default',
  cpu: null, memory: null, disk: null,
}));
export const DEFAULT_SETTINGS: Settings = {
  ...DAYTONA_DEFAULT_SETTINGS, scenarios: [...DAYTONA_DEFAULT_SETTINGS.scenarios, ...E2B_SCENARIOS],
};

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index), hi = Math.ceil(index);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo));
}
export function aggregate(samples: Sample[], scenarios: Scenario[]): Aggregate[] {
  return scenarios.filter(s => s.enabled).map(s => {
    const all = samples.filter(x => x.scenarioId === s.id);
    const passed = all.filter(x => x.status === 'passed');
    const values = (key: 'createApiMs' | 'commandReadyMs' | 'healthyMs') => passed.flatMap(x => x[key] === null ? [] : [x[key]]);
    return {
      scenarioId: s.id, scenarioName: s.name, provider: s.provider, source: s.source, region: s.region,
      total: all.length, passed: passed.length, createMedianMs: percentile(values('createApiMs'), .5),
      readyMedianMs: percentile(values('commandReadyMs'), .5), healthyMedianMs: percentile(values('healthyMs'), .5),
      healthyP95Ms: percentile(values('healthyMs'), .95),
      costUsd: all.length && all.every(x => x.estimatedCostUsd !== null) ? all.reduce((sum, x) => sum + x.estimatedCostUsd!, 0) : null,
    };
  });
}
