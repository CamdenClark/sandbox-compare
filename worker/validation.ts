import type { Scenario, Settings } from '../src/shared';
const object = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const integer = (x: unknown, min: number, max: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;
const str = (x: unknown, min: number, max: number): x is string => typeof x === 'string' && x.length >= min && x.length <= max;
export function validateSettings(input: unknown): Settings {
  if (!object(input) || !integer(input.intervalHours, 1, 168) || !integer(input.repetitions, 1, 5) || typeof input.enabled !== 'boolean' || !Array.isArray(input.scenarios) || input.scenarios.length < 1 || input.scenarios.length > 6) throw new Error('Use 1–168 hours, 1–5 repetitions, and 1–6 scenarios.');
  const ids = new Set<string>();
  const scenarios: Scenario[] = input.scenarios.map(x => {
    if (!object(x) || !str(x.id, 1, 32) || !/^[a-z0-9-]+$/.test(x.id) || ids.has(x.id)) throw new Error('Scenario IDs must be unique and contain lowercase letters, numbers, or hyphens.');
    ids.add(x.id);
    if (x.provider !== 'daytona') throw new Error('Only the Daytona adapter is available.');
    if (!str(x.name, 1, 80) || !str(x.description, 0, 300) || !str(x.source, 1, 200) || !str(x.region, 1, 32) || !str(x.command, 1, 8000) || !str(x.healthCommand, 0, 8000) || !str(x.expectedOutput, 1, 200) || typeof x.enabled !== 'boolean' || !integer(x.cpu, 1, 4) || !integer(x.memory, 1, 8) || !integer(x.disk, 1, 10) || !integer(x.timeoutSeconds, 10, 180) || !['snapshot', 'image'].includes(String(x.sourceType))) throw new Error(`Invalid configuration for scenario ${x.id}.`);
    if (!/^[a-z0-9-]+$/.test(x.region) || /[\s\n\r]/.test(x.source)) throw new Error('Region and source must not contain spaces or newlines.');
    if (x.sourceType === 'image' && (!x.source.includes(':') || /:(latest|lts|stable)$/.test(x.source))) throw new Error('Use a versioned image tag or digest, such as python:3.12-slim.');
    return { id: x.id, name: x.name, description: x.description, provider: 'daytona', sourceType: x.sourceType as Scenario['sourceType'], source: x.source, region: x.region, cpu: x.cpu, memory: x.memory, disk: x.disk, command: x.command, healthCommand: x.healthCommand, expectedOutput: x.expectedOutput, timeoutSeconds: x.timeoutSeconds, enabled: x.enabled };
  });
  if (!scenarios.some(s => s.enabled)) throw new Error('Enable at least one scenario. Pause the schedule to stop automatic runs.');
  return { intervalHours: input.intervalHours, repetitions: input.repetitions, enabled: input.enabled, scenarios };
}
