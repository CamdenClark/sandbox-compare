import type { ProviderId } from '../../src/shared';
import { DaytonaProvider } from './daytona';
import type { SandboxProvider } from './types';

// Add adapters here. Runner, storage, scheduling, and the report UI are provider-independent.
const adapters: Partial<Record<ProviderId, (env: Env) => SandboxProvider>> = {
  daytona: env => new DaytonaProvider(env),
};
export function getProvider(id: ProviderId, env: Env): SandboxProvider {
  const adapter = adapters[id];
  if (!adapter) throw new Error(`Provider ${id} has no adapter yet.`);
  return adapter(env);
}
