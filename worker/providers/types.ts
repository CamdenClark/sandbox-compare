import type { Scenario } from '../../src/shared';
export interface SandboxHandle {
  id: string; state: string; region: string; source: string;
  resources: { cpu: number; memory: number; disk: number };
  toolboxUrl: string;
}
export interface CommandResult { exitCode: number; result: string }
export interface SandboxProvider {
  create(scenario: Scenario, name: string): Promise<SandboxHandle>;
  get(idOrName: string): Promise<SandboxHandle | null>;
  execute(sandbox: SandboxHandle, command: string, timeoutSeconds: number): Promise<CommandResult>;
  delete(idOrName: string): Promise<void>;
  estimateCost(resources: SandboxHandle['resources'], lifetimeMs: number): number | null;
}
