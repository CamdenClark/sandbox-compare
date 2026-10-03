import type { Scenario } from '../../src/shared';
export class ProviderError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export interface SandboxHandle {
  id: string; state: string; region: string; source: string;
  resources: { cpu: number | null; memory: number | null; disk: number | null };
  toolboxUrl: string;
  accessToken?: string;
}
export interface CommandResult { exitCode: number; result: string }
export interface SandboxProvider {
  create(scenario: Scenario, name: string): Promise<SandboxHandle>;
  get(idOrName: string): Promise<SandboxHandle | null>;
  execute(sandbox: SandboxHandle, command: string, timeoutSeconds: number): Promise<CommandResult>;
  delete(idOrName: string): Promise<void>;
  estimateCost(resources: SandboxHandle['resources'], lifetimeMs: number): number | null;
}
