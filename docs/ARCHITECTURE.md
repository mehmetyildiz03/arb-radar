# Arb Radar architecture — v0.8.1 Executable Truth

## Objective

Measure Par multi-market dislocations with a same-base closed-cycle model while refusing to confuse a mathematical spot ratio with an executable opportunity.

The central v0.8.1 invariant is:

> A candidate does not enter the expensive capture/sizing pipeline until a canonical same-block micro quote completes the whole supported closed cycle and returns more raw units of the same base asset than it consumed.

## Pipeline

### 1. Discovery

The Par indexer supplies recent launch/market metadata. `lastPriceEth` is not executable price truth and is not required for discovery.

### 2. Screen block

Each tick pins one canonical Robinhood block.

### 3. Closed-cycle graph

`economic/v4Truth.ts` constructs directed same-base cycles:

`base -> buy quote -> Par token -> sell quote -> base`

Common route prefixes are removed. Native ETH and WETH remain distinct real currencies in the canonical V4Quoter path.

Verified coverage is currently hookless all-V4.

### 4. StateView prefilter

V4 StateView slot0 and active liquidity are batched at the screen block.

For positive active-liquidity paths, fee-aware marginal state can cheaply reject a clearly nonpositive direction.

**Zero active liquidity changes the semantics.** slot0 can remain at an extreme boundary tick while the next executable amount must cross into another range. v0.8.1 therefore marks that spot as unreliable and lets the canonical micro quote arbitrate rather than treating the extreme slot0 ratio as an edge.

### 5. Executable micro truth

`prepareLaunchEconomicCandidates` performs an exact same-block V4Quoter closed-cycle quote, default reporting input `$0.01`.

Candidate acceptance requires:

`amountOutRaw > amountInRaw`

Gas is intentionally not part of this gate. The gate asks only whether a real gross cycle edge exists at an executable amount; fixed costs are applied later.

The screen persists:
- micro input,
- raw micro result,
- micro gross multiplier/edge,
- gas estimate,
- whether slot0 marginal state was reliable,
- same-block structural state.

This replaces the old misleading “same-block truth spread”.

### 6. Current-block capture probe

When the scheduler reaches a candidate, it quotes again at the latest block.

If the current-block first probe is gross-negative, `measurement.ts` uses `continueAfterFirst` to terminate the candidate before sizing and later requotes.

If gross-positive but net-negative, sizing continues because a larger input may amortize fixed paper costs.

### 7. Sizing

Default minimum input is `$0.01`.

The analytical two-pool constant-product optimum remains only a seed under strict active-liquidity and curve-metadata assumptions. It is validated by exact quotes.

Otherwise the deterministic eight-size exact grid runs from the configured minimum to maximum.

### 8. Cost model

Exact quote paper net:

`outputUsd - inputUsd - gasUsd - extraCostsUsd - safetyMarginUsd`

Current assumptions:
- canonical V4Quoter gas estimate,
- +20% gas buffer,
- current gas price,
- $0.05 explicit allowance,
- 1% output safety margin.

These are research assumptions, not deployed executor gas.

### 9. Lifecycle

Scheduler/measurement retain bounded concurrency, queue aging and discovery-relative capture timing. A gross-negative first probe is now terminal for the current verified hookless V4 path, avoiding expensive sizing of economically dominated candidates.

### 10. Persistence and run isolation

SQLite schema remains append-only. Process metadata includes:
- `runId`
- `runStartedAtMs`
- `engineVersion=0.8.1-executable-truth`

Current-run dashboard views therefore exclude earlier v0.8 spot-screen noise.

### 11. Dashboard

Funnel:

**Micro-exact truth -> Current-block quoted -> Verified paper positive**

The displayed candidate edge is the canonical micro quote's gross edge, not the StateView slot0 multiplier.

## Live audit evidence

Before the correction, an 8-scan public-RPC sweep tested 48 candidate observations at $0.01/$0.03/$0.10/$0.30/$1/$3/$10:
- 64 successful exact quotes,
- 272 reverts,
- 0 gross-positive exact quotes,
- 0 verified-positive quotes.

Extreme slot0 “edges” were observed where a Par buy hop had active liquidity 0 and tick 887271.

After switching to executable micro screening, a public audit over 26 recent launches on two independent blocks produced zero admitted executable-truth candidates. This is expected behavior when no supported gross-positive cycle exists.

## Canonical contracts

Robinhood Chain:
- V4 StateView: `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`
- V4Quoter: `0x8dc178efb8111bb0973dd9d722ebeff267c98f94`

## Hard boundaries

No private key, signer, write contract or transaction submission path exists.

v0.8.1 still does not prove:
- deployed atomic-executor gas,
- transaction inclusion/capture probability,
- profitability of V3/hooked cycles,
- long-run positive expectancy,
- historical executable LONG5 P&L.

The next expansion, if sustained observation yields no executable-truth candidates, should increase **verified route coverage** (for example mixed V3/V4 via an atomic paper simulator) rather than weakening the micro truth gate or deleting costs to manufacture green.
