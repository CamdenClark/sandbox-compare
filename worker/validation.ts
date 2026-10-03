import type { Scenario, Settings } from '../src/shared';
const object = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const integer = (x: unknown, min: number, max: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;
const str = (x: unknown, min: number, max: number): x is string => typeof x === 'string' && x.length >= min && x.length <= max;
export function validateSettings(input: unknown): Settings {
  if (!object(input) || !integer(input.intervalHours, 1, 168) || !integer(input.repetitions, 1, 5) || typeof input.enabled !== 'boolean' || !Array.isArray(input.scenarios) || input.scenarios.length < 1 || input.scenarios.length > 12) throw new Error('Use 1–168 hours, 1–5 repetitions, and 1–12 workloads.');
  const ids = new Set<string>();
  const scenarios: Scenario[] = input.scenarios.map(x => {
    if (!object(x) || !str(x.id, 1, 32) || !/^[a-z0-9-]+$/.test(x.id) || ids.has(x.id)) throw new Error('Scenario IDs must be unique and contain lowercase letters, numbers, or hyphens.');
    ids.add(x.id);
    if (x.provider !== 'daytona' && x.provider !== 'e2b') throw new Error('Only the Daytona and E2B adapters are available.');
    if (!str(x.name, 1, 80) || !str(x.description, 0, 300) || !str(x.source, 1, 200) || !str(x.region, 1, 32) || !str(x.command, 1, 8000) || !str(x.healthCommand, 0, 8000) || !str(x.expectedOutput, 1, 200) || typeof x.enabled !== 'boolean' || !integer(x.timeoutSeconds, 10, 180) || !['snapshot', 'image', 'template'].includes(String(x.sourceType))) throw new Error(`Invalid configuration for scenario ${x.id}.`);
    const validResources = x.provider === 'daytona' ? integer(x.cpu, 1, 4) && integer(x.memory, 1, 8) && integer(x.disk, 1, 10) : x.cpu === null && x.memory === null && x.disk === null;
    if (!validResources) throw new Error('Daytona resources must be within configured bounds. E2B resources must be null because its template determines their size.');
    if (x.provider === 'e2b' && (x.sourceType !== 'template' || x.region !== 'provider-default')) throw new Error('E2B requires a template and the provider-default region. Resources are inherited from the template.');
    if (x.provider === 'daytona' && x.sourceType === 'template') throw new Error('Daytona requires a snapshot or Docker image.');
    if (!/^[a-z0-9-]+$/.test(x.region) || /[\s\n\r]/.test(x.source)) throw new Error('Region and source must not contain spaces or newlines.');
    if (x.sourceType === 'image' && (!x.source.includes(':') || /:(latest|lts|stable)$/.test(x.source))) throw new Error('Use a versioned image tag or digest, such as python:3.12-slim.');
    return { id: x.id, name: x.name, description: x.description, provider: x.provider, sourceType: x.sourceType as Scenario['sourceType'], source: x.source, region: x.region, cpu: x.cpu as number | null, memory: x.memory as number | null, disk: x.disk as number | null, command: x.command, healthCommand: x.healthCommand, expectedOutput: x.expectedOutput, timeoutSeconds: x.timeoutSeconds, enabled: x.enabled };
  });
  if (!scenarios.some(s => s.enabled)) throw new Error('Enable at least one scenario. Pause the schedule to stop automatic runs.');
  if (scenarios.filter(s => s.enabled).length * input.repetitions > 30) throw new Error('Limit each batch to 30 evaluations. Reduce workloads or repetitions.');
  return { intervalHours: input.intervalHours, repetitions: input.repetitions, enabled: input.enabled, scenarios };
}
