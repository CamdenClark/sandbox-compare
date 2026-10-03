import type { ProviderId } from '../../src/shared';
import { DaytonaProvider } from './daytona';
import { E2BProvider } from './e2b';
import type { SandboxProvider } from './types';

// Add adapters here. Runner, storage, scheduling, and the report UI are provider-independent.
const adapters: Partial<Record<ProviderId, (env: Env) => SandboxProvider>> = {
  daytona: env => new DaytonaProvider(env),
  e2b: env => new E2BProvider(env),
};
export function getProvider(id: ProviderId, env: Env): SandboxProvider {
  const adapter = adapters[id];
  if (!adapter) throw new Error(`Provider ${id} has no adapter yet.`);
  return adapter(env);
}
export function providerConnected(id: ProviderId, env: Env): boolean {
  return id === 'daytona' ? Boolean(env.DAYTONA_API_KEY) : id === 'e2b' ? Boolean(env.E2B_API_KEY) : false;
}
export function runtimeSecrets(env: Env): string[] {
  return [env.DAYTONA_API_KEY, env.E2B_API_KEY, env.ADMIN_TOKEN];
}
