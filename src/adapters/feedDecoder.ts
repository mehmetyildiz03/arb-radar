import { bytesToHex, keccak256, parseTransaction, recoverAddress, type Hex } from 'viem';

// Nitro framing and signature preimage cross-checked against Chainstack rhfeed;
// see docs/SOURCES.md and the independently captured signed fixture.
export interface FeedEntry {
  sequenceNumber: number; blockHash: Hex; blockMetadata?: string; signatureV2: string;
  message: { delayedMessagesRead: number; message: { l2Msg: string; header: {
    kind: number; sender: Hex; blockNumber: number; timestamp: number; requestId?: Hex | null; baseFeeL1?: number | string | null;
  } } };
}
const authority = '0xdaa526086787d9debe1d7f3ffdb1fe50cf8687f4';
function uint64(value: number | bigint): Buffer {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe feed integer');
  const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(value)); return out;
}
function hex(value: string, size?: number): Buffer {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(value)) throw new Error('Invalid feed hex');
  const out = Buffer.from(value.slice(2), 'hex');
  if (size !== undefined && out.length !== size) throw new Error('Invalid feed field length');
  return out;
}
function base64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid base64');
  return Buffer.from(value, 'base64');
}
export function signatureHash(entry: FeedEntry, chainId = 4663): Hex {
  const wrapper = entry.message, incoming = wrapper.message, h = incoming.header;
  if (!Number.isInteger(h.kind) || h.kind < 0 || h.kind > 255) throw new Error('Invalid kind');
  const parts = [Buffer.from('Arbitrum Nitro Feed:'), uint64(chainId), uint64(entry.sequenceNumber), hex(entry.blockHash, 32),
    base64(entry.blockMetadata ?? ''), uint64(wrapper.delayedMessagesRead), Buffer.from([h.kind]), hex(h.sender, 20), uint64(h.blockNumber), uint64(h.timestamp)];
  if (h.requestId != null) parts.push(hex(h.requestId, 32));
  if (h.baseFeeL1 != null) {
    const fee = BigInt(h.baseFeeL1); if (fee < 0n) throw new Error('Negative base fee');
    if (fee > 0n) { const raw = fee.toString(16); parts.push(Buffer.from(raw.length % 2 ? `0${raw}` : raw, 'hex')); }
  }
  parts.push(base64(incoming.l2Msg));
  return keccak256(bytesToHex(Buffer.concat(parts)));
}
export async function verifyEntry(entry: FeedEntry, chainId = 4663): Promise<boolean> {
  try {
    const signature = base64(entry.signatureV2);
    if (signature.length !== 65) return false;
    const recovered = await recoverAddress({ hash: signatureHash(entry, chainId), signature: bytesToHex(signature) });
    return recovered.toLowerCase() === authority;
  } catch { return false; }
}
export function decodeL2(payload: Buffer, depth = 0): { hash: Hex; to: string | null; data: Hex; raw: Hex }[] {
  if (payload.length > 2_000_000 || depth >= 16 || !payload.length) throw new Error('Invalid feed payload');
  if (payload[0] === 4) {
    const raw = bytesToHex(payload.subarray(1)); const tx = parseTransaction(raw);
    return [{ hash: keccak256(raw), to: tx.to ?? null, data: tx.data ?? '0x', raw }];
  }
  if (payload[0] !== 3) throw new Error('Unsupported L2 kind');
  const result: ReturnType<typeof decodeL2> = [];
  let offset = 1;
  while (offset < payload.length) {
    if (offset + 8 > payload.length) throw new Error('Truncated batch');
    const length = Number(payload.readBigUInt64BE(offset)); offset += 8;
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > payload.length) throw new Error('Invalid batch length');
    result.push(...decodeL2(payload.subarray(offset, offset + length), depth + 1)); offset += length;
  }
  return result;
}
export async function decodeVerified(entry: FeedEntry) {
  if (!await verifyEntry(entry)) throw new Error('Unverified sequencer message');
  if (entry.message.message.header.kind !== 3) throw new Error('Delayed/L1 message unsupported');
  return { sequenceNumber: entry.sequenceNumber, blockHash: entry.blockHash,
    timestampMs: entry.message.message.header.timestamp * 1000, verified: true as const,
    transactions: decodeL2(base64(entry.message.message.l2Msg)) };
}
