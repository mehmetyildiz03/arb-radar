import type { DirectedRoute, LaunchSnapshot, RouteScreen } from "../domain.js";
import { twoLegFeeMultiplier } from "../pricing/fees.js";

export function enumerateDirectedRoutes(launch: LaunchSnapshot): DirectedRoute[] {
  if (launch.kind !== "multi" || launch.markets.length < 2) return [];

  const routes: DirectedRoute[] = [];
  for (const buy of launch.markets) {
    for (const sell of launch.markets) {
      if (buy.index === sell.index) continue;
      routes.push({ token: launch.token, buy, sell, poolFeeUnits: launch.poolFeeUnits });
    }
  }
  return routes;
}

export function screenRoute(route: DirectedRoute, extraCostBps = 0): RouteScreen | null {
  const buyPrice = route.buy.tokenPriceEth;
  const sellPrice = route.sell.tokenPriceEth;
  if (!(buyPrice > 0) || !(sellPrice > 0) || sellPrice <= buyPrice) return null;

  const grossPriceRatio = sellPrice / buyPrice;
  const grossSpreadPct = (grossPriceRatio - 1) * 100;
  const feeMultiplier = twoLegFeeMultiplier(route.poolFeeUnits, route.poolFeeUnits);
  const extraMultiplier = 1 - extraCostBps / 10_000;
  const feeAdjustedMultiplier = grossPriceRatio * feeMultiplier * extraMultiplier;
  const feeAdjustedReturnPct = (feeAdjustedMultiplier - 1) * 100;

  return {
    route,
    grossPriceRatio,
    grossSpreadPct,
    feeAdjustedReturnPct,
    passesFeeFloor: feeAdjustedReturnPct > 0,
  };
}

export function rankScreens(launch: LaunchSnapshot, extraCostBps = 0): RouteScreen[] {
  return enumerateDirectedRoutes(launch)
    .map((route) => screenRoute(route, extraCostBps))
    .filter((x): x is RouteScreen => x !== null)
    .sort((a, b) => b.feeAdjustedReturnPct - a.feeAdjustedReturnPct);
}
