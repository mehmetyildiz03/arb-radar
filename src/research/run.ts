import { randomUUID } from 'node:crypto';

export interface RunContext {
  runId: string;
  engineVersion: string;
  runStartedAtMs: number;
}

export function createRunContext(engineVersion = '0.8.2-economic-truth-depth-aware', now = Date.now): RunContext {
  return {
    runId: randomUUID(),
    engineVersion,
    runStartedAtMs: now(),
  };
}

export function withRun<T extends Record<string, unknown>>(run: RunContext, value: T): T & RunContext {
  return { ...value, ...run };
}
