// Pump.fun bonding-curve math on virtual reserves (constant product).
// The PumpPortal feed reports vSolInBondingCurve / vTokensInBondingCurve in
// human units (SOL / tokens), so all math here stays in those units.

/** Spot price in SOL per token. */
export function price(vSol, vTok) {
  if (!(vSol > 0) || !(vTok > 0)) return 0;
  return vSol / vTok;
}

/**
 * Tokens received for `solIn` SOL (before platform fees are deducted by the caller).
 * Constant product: (vSol + solIn) * (vTok - out) = vSol * vTok
 */
export function buyTokensOut(vSol, vTok, solIn) {
  if (!(solIn > 0) || !(vSol > 0) || !(vTok > 0)) return 0;
  return vTok - (vSol * vTok) / (vSol + solIn);
}

/**
 * SOL received for selling `tokensIn` tokens (before fees).
 * (vSol - out) * (vTok + tokensIn) = vSol * vTok
 */
export function sellSolOut(vSol, vTok, tokensIn) {
  if (!(tokensIn > 0) || !(vSol > 0) || !(vTok > 0)) return 0;
  return vSol - (vSol * vTok) / (vTok + tokensIn);
}

/** Reserves after a buy of `solIn` SOL. */
export function afterBuy(vSol, vTok, solIn) {
  const out = buyTokensOut(vSol, vTok, solIn);
  return { vSol: vSol + solIn, vTok: vTok - out, tokensOut: out };
}

/** Reserves after a sell of `tokensIn` tokens. */
export function afterSell(vSol, vTok, tokensIn) {
  const out = sellSolOut(vSol, vTok, tokensIn);
  return { vSol: vSol - out, vTok: vTok + tokensIn, solOut: out };
}
