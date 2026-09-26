export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Bounded HTTP retries; never retry application-level reverts as successful quotes. */
export function resilientFetch(base: typeof fetch = fetch, wait = sleep): typeof fetch {
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try { response = await base(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) }); }
      catch (error) {
        if (attempt >= 3 || init?.signal?.aborted) throw error;
        await wait(250 * 2 ** attempt); continue;
      }
      if (![429, 502, 503, 504].includes(response.status) || attempt >= 3) return response;
      const retry = response.headers.get('retry-after');
      const delay = retry === null ? 250 * 2 ** attempt : /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      await response.body?.cancel();
      await wait(Math.min(10_000, Math.max(250, Number.isFinite(delay) ? delay : 250 * 2 ** attempt)));
    }
  };
}
