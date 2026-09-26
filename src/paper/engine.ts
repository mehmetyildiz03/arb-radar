import type { LaunchSnapshot, RouteScreen } from "../domain.js";
import { rankScreens } from "../arbitrage/routes.js";

export interface PaperObservation {
  observedAt: number;
  token: string;
  symbol: string;
  buyMarket: string;
  sellMarket: string;
  grossSpreadPct: number;
  feeAdjustedReturnPct: number;
}

export function observeLaunch(launch: LaunchSnapshot, extraCostBps = 0): PaperObservation[] {
  return rankScreens(launch, extraCostBps)
    .filter((screen: RouteScreen) => screen.passesFeeFloor)
    .map((screen) => ({
      observedAt: Date.now(),
      token: launch.token,
      symbol: launch.symbol,
      buyMarket: screen.route.buy.quoteSymbol,
      sellMarket: screen.route.sell.quoteSymbol,
      grossSpreadPct: screen.grossSpreadPct,
      feeAdjustedReturnPct: screen.feeAdjustedReturnPct,
    }));
}
