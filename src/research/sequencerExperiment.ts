import WebSocket from 'ws';
import { createPublicClient, http, decodeFunctionData, encodeAbiParameters, keccak256 } from 'viem';
import { ADDRESSES, robinhoodChain, multiRouterAbi, swapEvent, poolManagerAbi } from 'par-sdk';
import { decodeVerified, type FeedEntry } from '../adapters/feedDecoder.js';
import { ResearchStore, json } from './store.js';
import { ShadowState } from './shadow.js';
import { loadConfig } from '../config.js';

const config = loadConfig();
const store = new ResearchStore(process.env.RADAR_DB ?? 'data/radar.sqlite');
const client = createPublicClient({ chain: robinhoodChain, transport: http(config.robinhoodRpcUrl, { retryCount: 2, retryDelay: 500, timeout: 10_000 }) });
const shadow = new ShadowState();
const socket = new WebSocket(config.robinhoodFeedUrl, { perMessageDeflate: true, maxPayload: 2_000_000, handshakeTimeout: 10_000 });
let queue = Promise.resolve(); let pending = 0; let received = 0;
socket.on('message', raw => {
  const receivedAt = Date.now();
  if (pending >= 8) { store.record('sequencer_observations', 'overload', { dropped: true }, { timestampMs: receivedAt, blockNumber: null, source: config.robinhoodFeedUrl }); return; }
  pending++;
  queue = queue.then(async () => {
    const frame = JSON.parse(raw.toString()) as { messages?: FeedEntry[] };
    for (const entry of frame.messages ?? []) {
      const decoded = await decodeVerified(entry);
      received++;
      const transition = shadow.observe(decoded.sequenceNumber, decoded.blockHash);
      if (transition.status === 'duplicate') continue;
      const ageMs = receivedAt - decoded.timestampMs;
      const relevant = decoded.transactions.filter(tx => tx.to?.toLowerCase() === ADDRESSES.multiRouter.toLowerCase());
      const candidates = relevant.map(tx => {
        try { const call = decodeFunctionData({ abi: multiRouterAbi, data: tx.data }); return { hash: tx.hash, functionName: call.functionName, args: call.args }; }
        catch { return { hash: tx.hash, unsupported: true }; }
      });
      const provenance = { timestampMs: receivedAt, blockNumber: decoded.sequenceNumber, source: config.robinhoodFeedUrl };
      store.record('sequencer_observations', String(decoded.sequenceNumber), { ...transition, ageMs, candidates, entry,
        speculative: true, note: 'Already ordered; outcomes unknown. Next-block preparation only.' }, provenance);
      if (!relevant.length || ageMs > 5000 || ageMs < 0) continue;
      const start = Date.now();
      const blockNumber = BigInt(decoded.sequenceNumber);
      const block = await client.getBlock({ blockNumber });
      if (block.hash !== decoded.blockHash) throw new Error('Feed/RPC block mismatch');
      const logs = await client.getLogs({ address: ADDRESSES.poolManager, event: swapEvent, fromBlock: blockNumber, toBlock: blockNumber });
      const last = new Map<string, typeof logs[number]>();
      for (const log of logs) if (log.args.id && log.blockHash === decoded.blockHash) last.set(log.args.id, log);
      for (const [poolId, log] of last) {
        if (log.args.sqrtPriceX96 === undefined) continue;
        const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [log.args.id!, 6n]));
        const word = await client.readContract({ address: ADDRESSES.poolManager, abi: poolManagerAbi, functionName: 'extsload', args: [slot], blockNumber });
        const canonical = BigInt(word) & ((1n << 160n) - 1n);
        const matches = shadow.reconcile(poolId, log.args.sqrtPriceX96, canonical, blockNumber);
        store.record('sequencer_observations', poolId, { matches, observed: log.args.sqrtPriceX96, canonical,
          targetBlock: transition.nextBlock, state: 'RPC-reconciled; no speculative EVM execution' }, { timestampMs: Date.now(), blockNumber, source: config.robinhoodRpcUrl });
      }
      store.record('rpc_latency_samples', 'feed-reconciliation', { durationMs: Date.now() - start }, { timestampMs: start, blockNumber, source: config.robinhoodRpcUrl });
    }
  }).catch(error => { store.record('sequencer_observations', 'error', { error: String(error) }, { timestampMs: Date.now(), blockNumber: null, source: config.robinhoodFeedUrl }); }).finally(() => { pending--; });
});
socket.on('error', error => { console.error(String(error)); process.exitCode = 1; });
const duration = Number(process.env.FEED_SECONDS ?? 15);
const timer = setTimeout(() => socket.close(), Math.min(300, Math.max(1, Number.isFinite(duration) ? duration : 15)) * 1000);
process.once('SIGINT', () => socket.close());
socket.once('close', () => { clearTimeout(timer); void queue.finally(() => { console.log(json({ paperOnly: true, verifiedMessages: received, reconciledPools: shadow.pools.size })); store.close(); }); });
