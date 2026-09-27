import { randomUUID } from 'node:crypto';

export interface RunContext {
  runId: string;
  engineVersion: string;
  startedAtMs: number;
}

export function createRunContext(engineVersion = '0.8.0-economic-truth', now = Date.now): RunContext {
  return {
    runId: randomUUID(),
    engineVersion,
    startedAtMs: now(),
  };
}

export function withRun<T extends Record<string, unknown>>(run: RunContext, value: T): T & RunContext {
  return { ...value, ...run };
}
