import { writeFileSync } from 'node:fs';
const token = '0x9bbd4d06ac29d8900b34998a56e96a33c16220f0';
async function capture(url) {
  const capturedAt = new Date().toISOString();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return { url, capturedAt, status: response.status, body: await response.json() };
  } catch (error) { return { url, capturedAt, status: null, body: null, error: String(error) }; }
}
const launch = await capture(`https://api.par.family/launches/${token}`);
const trades = await capture(`https://api.par.family/trades?token=${token}&limit=2000`);
writeFileSync('tests/fixtures/long5-original.json', JSON.stringify({ token, launch, trades }, null, 2) + '\n');
console.log({ token, launchStatus: launch.status, tradesStatus: trades.status, trades: Array.isArray(trades.body) ? trades.body.length : null });
