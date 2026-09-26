import type { Hex } from 'viem';

/** Speculative dirtiness only: calldata is not an execution result. */
export class ShadowState {
  private lastSequence = -1;
  private readonly hashes = new Map<number, Hex>();
  readonly pools = new Map<string, { sqrtPriceX96: bigint; blockNumber: bigint }>();
  observe(sequence: number, hash: Hex) {
    const previous = this.hashes.get(sequence);
    if (previous === hash) return { status: 'duplicate', nextBlock: sequence + 1 };
    const status = previous ? 'reorg' : sequence < this.lastSequence ? 'out-of-order' : this.lastSequence >= 0 && sequence !== this.lastSequence + 1 ? 'gap' : 'new';
    if (status !== 'new') this.pools.clear();
    this.hashes.set(sequence, hash);
    if (this.hashes.size > 256) this.hashes.delete(this.hashes.keys().next().value!);
    this.lastSequence = Math.max(sequence, this.lastSequence);
    return { status, nextBlock: sequence + 1 };
  }
  reconcile(poolId: string, observed: bigint, canonical: bigint, blockNumber: bigint): boolean {
    if (observed !== canonical) { this.pools.delete(poolId); return false; }
    const prior = this.pools.get(poolId);
    if (!prior || blockNumber >= prior.blockNumber) this.pools.set(poolId, { sqrtPriceX96: canonical, blockNumber });
    return true;
  }
}
