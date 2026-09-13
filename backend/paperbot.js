// Paper bot engine — corre en el backend (Node), NO depende del navegador.
// Replica la matematica del antiguo bot del frontend, pero persistida en el
// proceso del servidor: sigue operando aunque cierres o cambies de pestania.

const REAL_FEES_DEFAULT = { maker: 0.001, taker: 0.001 };

function estimateBuy(asks, sizeUsd) {
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

function estimateSell(bids, qty) {
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

function estimateExecution({ asks, bids }, sizeUsd) {
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

const state = {
  active: false,
  balance: 10000,
  tradeSize: 1500,
  gasCost: 0,
  delayMin: 3,
  survivalPct: 0.3,
  sellMode: 'maker',
  history: [],
  stats: { checked: 0, survived: 0 },
  startedAt: null,
  lastTradeAt: null,
  lastTick: null,
  signed: new Set(),
  survival: null
};

// Evalua UNA oportunidad con la matematica del bot (slippage real por
// profundidad, entrada taker, salida maker post-only si el top del libro
// absorbe el lote (si no, taker), gas/costo real del exchange de compra).
function evalOpp(opp, snapshot) {
  const buyBook = snapshot.books[opp.buyExchange]?.[opp.buySymbol];
  const sellBook = snapshot.books[opp.sellExchange]?.[opp.sellSymbol];
  const exec = estimateExecution({ asks: buyBook?.asks, bids: sellBook?.bids }, state.tradeSize);
  if (!exec || !exec.executable) return null;
  const buyTaker = snapshot.fees[opp.buyExchange]?.[opp.pair]?.taker ?? REAL_FEES_DEFAULT.taker;
  const qtyAfterBuy = exec.vwap > 0 ? (state.tradeSize / exec.vwap) * (1 - buyTaker) : 0;

  let sellPrice = exec.sell.vwap;
  let sellMode = 'taker';
  let sellFeePct = snapshot.fees[opp.sellExchange]?.[opp.pair]?.taker ?? REAL_FEES_DEFAULT.taker;
  if (state.sellMode === 'maker') {
    const top = sellBook?.bids?.[0];
    if (top && top[1] >= qtyAfterBuy) {
      sellPrice = top[0];
      sellMode = 'maker';
      sellFeePct = snapshot.fees[opp.sellExchange]?.[opp.pair]?.maker ?? REAL_FEES_DEFAULT.maker;
    }
  }

  const proceeds = qtyAfterBuy * sellPrice;
  const gasCost = state.gasCost > 0 ? state.gasCost : (snapshot.withdrawalFees[opp.buyExchange]?.usdt ?? 1.5);
  const net = proceeds - proceeds * sellFeePct - gasCost - state.tradeSize;
  return {
    sig: `${opp.pair}|${opp.buyExchange}|${opp.sellExchange}|${opp.buyPrice.toFixed(8)}|${opp.sellPrice.toFixed(8)}`,
    pair: opp.pair,
    buyEx: opp.buyExchange,
    sellEx: opp.sellExchange,
    buyVwap: exec.vwap,
    sellVwap: sellPrice,
    sellFeePct,
    mode: `${sellMode}`,
    net
  };
}

function tick(snapshot) {
  state.lastTick = Date.now();
  if (!state.active) return;
  const opportunities = snapshot.opportunities;
  if (!opportunities || opportunities.length === 0) return;

  const transferMs = state.delayMin * 60000;

  // Fase 1 — METRICA DE SUPERVIVENCIA: cuando una senal tiene la edad del delay,
  // re-evaluamos la MISMA ruta con el libro ACTUAL para ver si el edge sobrevivio
  // el lapso real de retiro.
  if (state.survival && Date.now() - state.survival.detectedAt >= transferMs) {
    const pend = state.survival;
    let survived = false;
    for (const opp of opportunities) {
      if (opp.pair !== pend.pair || opp.buyExchange !== pend.buyEx || opp.sellExchange !== pend.sellEx) continue;
      const r = evalOpp(opp, snapshot);
      if (r && r.net > 0) { survived = true; break; }
    }
    state.stats.checked += 1;
    if (survived) state.stats.survived += 1;
    state.survival = null;
  }

  // Fase 2 — el bot exige un COLCHON de supervivencia: la ganancia neta debe
  // superar por el margen (default 0.3%) el monto.
  const colchonUsd = state.tradeSize * (state.survivalPct / 100);
  let best = null;
  for (const opp of opportunities) {
    const sig = `${opp.pair}|${opp.buyExchange}|${opp.sellExchange}|${opp.buyPrice.toFixed(8)}|${opp.sellPrice.toFixed(8)}`;
    if (state.signed.has(sig)) continue;
    const r = evalOpp(opp, snapshot);
    if (!r) continue;
    if (r.net > colchonUsd && (!best || r.net > best.net)) {
      best = { ...r, net: r.net };
    }
  }
  if (!best) return;

  state.signed.add(best.sig);
  if (state.signed.size > 1000) state.signed.clear();

  state.balance += best.net;
  state.lastTradeAt = Date.now();
  state.history = [{
    id: `${best.pair}-${best.buyEx}-${best.sellEx}-${Date.now()}`,
    time: new Date().toLocaleTimeString(),
    pair: best.pair,
    route: `${best.buyEx} \u2794 ${best.sellEx}`,
    amount: state.tradeSize,
    execBuy: best.buyVwap,
    execSell: best.sellVwap,
    mode: best.mode,
    profit: best.net
  }, ...state.history].slice(0, 50);

  state.survival = { pair: best.pair, buyEx: best.buyEx, sellEx: best.sellEx, detectedAt: Date.now() };
}

function start() {
  if (!state.active) {
    state.active = true;
    state.startedAt = state.startedAt || Date.now();
  }
}

function stop() {
  state.active = false;
}

function reset() {
  state.signed = new Set();
  state.survival = null;
  state.stats = { checked: 0, survived: 0 };
  state.history = [];
  state.balance = 10000;
  state.startedAt = null;
  state.lastTradeAt = null;
}

function config(params) {
  if (params && typeof params === 'object') {
    if (typeof params.tradeSize === 'number') state.tradeSize = Math.max(1, params.tradeSize);
    if (typeof params.gasCost === 'number') state.gasCost = Math.max(0, params.gasCost);
    if (typeof params.delayMin === 'number') state.delayMin = Math.max(0.5, params.delayMin);
    if (typeof params.survivalPct === 'number') state.survivalPct = Math.max(0, params.survivalPct);
    if (params.sellMode === 'maker' || params.sellMode === 'taker') state.sellMode = params.sellMode;
  }
}

function snapshot() {
  return {
    active: state.active,
    balance: state.balance,
    tradeSize: state.tradeSize,
    gasCost: state.gasCost,
    delayMin: state.delayMin,
    survivalPct: state.survivalPct,
    sellMode: state.sellMode,
    history: state.history,
    stats: state.stats,
    startedAt: state.startedAt,
    lastTradeAt: state.lastTradeAt,
    lastTick: state.lastTick
  };
}

module.exports = { tick, start, stop, reset, config, snapshot };