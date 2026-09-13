// Estimación de ejecución real contra un order book real (precios en USDT).
// - estimateBuy: gastar `sizeUsd` cruzando el ask book (orden market de compra).
// - estimateSell: vender `qty` cruzando el bid book (orden market de venta).

export function estimateBuy(asks, sizeUsd) {
  let filledNotional = 0;
  let filledQty = 0;
  for (const [price, amount] of asks || []) {
    if (filledNotional >= sizeUsd) break;
    const notional = price * amount;
    const takeNotional = Math.min(notional, sizeUsd - filledNotional);
    const takeQty = takeNotional / price;
    filledNotional += takeNotional;
    filledQty += takeQty;
  }
  return {
    filledNotional,
    filledQty,
    vwap: filledQty > 0 ? filledNotional / filledQty : null,
    executable: filledNotional >= sizeUsd * 0.9999
  };
}

export function slippageFromTop(vwap, topPrice) {
  if (!vwap || !topPrice) return null;
  return ((vwap - topPrice) / topPrice) * 100;
}

export function estimateSell(bids, qty) {
  let filledQty = 0;
  let proceeds = 0;
  for (const [price, amount] of bids || []) {
    if (filledQty >= qty) break;
    const takeQty = Math.min(amount, qty - filledQty);
    filledQty += takeQty;
    proceeds += takeQty * price;
  }
  return {
    filledQty,
    proceeds,
    vwap: filledQty > 0 ? proceeds / filledQty : null,
    executable: filledQty >= qty * 0.9999
  };
}

// Orden post-only (maker) al MEJOR BID: sólo es factible si el mejor nivel del libro
// (profundidad resting a P0) absorbe el lote completo. Se llena a P0 con fee maker;
// nada de esto cruza el libro. Si el top no cubre, no hay cierre maker garantizado.
export function estimateMakerSell(bids, qty) {
  const top = bids?.[0];
  if (!top) return { fillable: false, price: null, proceeds: 0, reason: 'no-book' };
  const [price, depth] = top;
  if (depth < qty * 0.9999) return { fillable: false, price, proceeds: 0, reason: 'depth' };
  return { fillable: true, price, proceeds: qty * price, reason: null };
}

// Ejecución completa de una operación: comprar USDT, vender el activo.
export function estimateExecution({ asks, bids }, sizeUsd) {
  if (!asks || !bids) return null;
  const buy = estimateBuy(asks, sizeUsd);
  if (!buy.executable) {
    return { ...buy, sell: null, executable: false, reason: 'buy' };
  }
  const sell = estimateSell(bids, buy.filledQty);
  if (!sell.executable) {
    return { ...buy, sell, executable: false, reason: 'sell' };
  }
  return { ...buy, sell, executable: true, reason: null };
}