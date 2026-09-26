/**
 * Important: Robinhood's sequencer feed is NOT a public mempool.
 * The sequencer has already ordered/built the block when the message is broadcast.
 * v0.1 therefore treats the feed as an early observation/reconciliation source,
 * not as a front-running signal. A later adapter can maintain a shadow pool state
 * from decoded transactions and target the NEXT block.
 */
export interface SequencerObservation {
  sequenceNumber: number;
  blockHash?: string;
  receivedAtMs: number;
  transactionCount: number;
}

export interface SequencerSource {
  start(onObservation: (observation: SequencerObservation) => void): Promise<() => void>;
}

export class DisabledSequencerSource implements SequencerSource {
  async start(): Promise<() => void> {
    return () => undefined;
  }
}
