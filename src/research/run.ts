import { randomUUID } from 'node:crypto';

export interface RunContext {
  runId: string;
  engineVersion: string;
  runStartedAtMs: number;
}

export function createRunContext(engineVersion = '0.10.0-mixed-route-coverage', now = Date.now): RunContext {
  return {
    runId: randomUUID(),
    engineVersion,
    runStartedAtMs: now(),
  };
}

export function withRun<T extends Record<string, unknown>>(run: RunContext, value: T): T & RunContext {
  return { ...value, ...run };
}
