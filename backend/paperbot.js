// Paper bot engine — corre en el backend (Node), NO depende del navegador.
// Replica la matematica del antiguo bot del frontend, pero persistida en el
// proceso del servidor: sigue operando aunque cierres o cambies de pestania.

const REAL_FEES_DEFAULT = { maker: 0.001, taker: 0.001 };

// Persistencia en disco: el estado sobrevive a reinicios del proceso Node.
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '.data');
const DATA_FILE = path.join(DATA_DIR, 'paperbot.json');

function serializeState() {
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
    pending: state.pending,
    signed: [...state.signed]
  };
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(serializeState(), null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('paperbot save:', e.message);
  }
}

function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    state.active = !!d.active;
    if (typeof d.balance === 'number') state.balance = d.balance;
    if (typeof d.tradeSize === 'number') state.tradeSize = d.tradeSize;
    if (typeof d.gasCost === 'number') state.gasCost = d.gasCost;
    if (typeof d.delayMin === 'number') state.delayMin = d.delayMin;
    if (typeof d.survivalPct === 'number') state.survivalPct = d.survivalPct;
    if (d.sellMode === 'maker' || d.sellMode === 'taker') state.sellMode = d.sellMode;
    if (Array.isArray(d.history)) state.history = d.history;
    if (d.stats && typeof d.stats.checked === 'number') state.stats = d.stats;
    if (typeof d.startedAt === 'number') state.startedAt = d.startedAt;
    if (typeof d.lastTradeAt === 'number') state.lastTradeAt = d.lastTradeAt;
    if (Array.isArray(d.pending)) state.pending = d.pending;
    if (Array.isArray(d.signed)) state.signed = new Set(d.signed);
  } catch (e) {
    console.error('paperbot load:', e.message);
  }
}

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
  pending: [],
  stats: { checked: 0, survived: 0 },
  startedAt: null,
  lastTradeAt: null,
  lastTick: null,
  signed: new Set()
};

// Evalua UNA oportunidad con la matematica del bot (slippage real por
// profundidad, entrada taker, salida maker post-only si el top del libro
// absorbe el lote (si no, taker), gas/costo real del exchange de compra).
// La venta de evalOpp es SOLO una estimacion de entrada: el trade real se
// vende MAS TARDE contra el libro fresco (modelo de dos fases, ver tick()).
function evalOpp(opp, snapshot) {
  const buyBook = snapshot.books[opp.buyExchange]?.[opp.buySymbol];
  const sellBook = snapshot.books[opp.sellExchange]?.[opp.sellSymbol];
  const exec = estimateExecution({ asks: buyBook?.asks, bids: sellBook?.bids }, state.tradeSize);
  if (!exec || !exec.executable) return null;
  const buyTaker = snapshot.fees[opp.buyExchange]?.[opp.pair]?.taker ?? REAL_FEES_DEFAULT.taker;
  const qtyAfterBuy = exec.vwap > 0 ? (state.tradeSize / exec.vwap) * (1 - buyTaker) : 0;
  if (qtyAfterBuy <= 0) return null;

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
    buySymbol: opp.buySymbol,
    sellSymbol: opp.sellSymbol,
    buyVwap: exec.vwap,
    sellVwap: sellPrice,
    buyQty: qtyAfterBuy,
    sellFeePct,
    mode: `${sellMode}`,
    net
  };
}

// Vende UNA posicion comprada antes contra el libro ACTUAL (el precio que
// sea a ese momento — mismo riesgo de timing que un retiro real).
function realizePending(p, snapshot) {
  if (!p || !p.buyQty || p.buyQty <= 0) return null;
const sellBook = snapshot.books[p.sellEx]?.[p.sellSymbol];
    const bids = (sellBook?.bids || []).filter(([price, amount]) => price > 0 && amount > 0);
    if (bids.length === 0) return null; // sin libro fresco: esperar al proximo tick

    let sell = estimateSell(bids, p.buyQty);
    let sellPrice = sell.vwap;
    let mode = 'taker';
    let sellFeePct = snapshot.fees[p.sellEx]?.[p.pair]?.taker ?? REAL_FEES_DEFAULT.taker;
    if (state.sellMode === 'maker') {
      const top = bids[0];
      if (top && top[1] >= p.buyQty) {
        sellPrice = top[0];
        mode = 'maker';
        sellFeePct = snapshot.fees[p.sellEx]?.[p.pair]?.maker ?? REAL_FEES_DEFAULT.maker;
        sell = { filledQty: p.buyQty, proceeds: p.buyQty * top[0], vwap: top[0], executable: true };
      }
    }
    if (!sell || sell.filledQty <= 0) return null;

    const filledPct = Math.min(100, Math.round((sell.filledQty / p.buyQty) * 100));
    const gasCost = p.gasCostAtEntry ?? snapshot.withdrawalFees?.[p.buyEx]?.usdt ?? 1.5;
    const net = (sell.proceeds || 0) * (1 - sellFeePct) - gasCost - (p.tradeSize || 0);
    return { net, execSell: sellPrice, soldPct: filledPct, mode };
}

function tick(snapshot) {
  state.lastTick = Date.now();
  if (!state.active) return;

  const delayMs = state.delayMin * 60000;

  // FASE 1 — RESOLVER posiciones vencidas con el libro FRESCO del momento.
  // Modelo de dos fases: la compra fue concreta (buyVwap/buyQty del tick de
  // entrada) y la venta ocurre AHORA al precio que haya, esperando el lapso
  // del retiro. El PnL solo se acredita al vender de verdad.
  const due = state.pending.filter(p => Date.now() - p.boughtAt >= delayMs);
  for (const p of due) {
    const realized = realizePending(p, snapshot);
    if (!realized) continue; // esperar a tener libro fresco
    state.pending = state.pending.filter(x => x.id !== p.id);
    state.balance += realized.net;
    state.lastTradeAt = Date.now();
    state.stats.checked += 1;
    if (realized.net > 0) state.stats.survived += 1;
    state.history = [{
      id: `${p.pair}-${p.buyEx}-${p.sellEx}-${Date.now()}`,
      time: new Date().toLocaleTimeString(),
      pair: p.pair,
      route: `${p.buyEx} \u2794 ${p.sellEx}`,
      amount: p.tradeSize,
      execBuy: p.buyVwap,
      execSell: realized.execSell,
      soldPct: realized.soldPct,
      mode: realized.mode,
      profit: realized.net
    }, ...state.history].slice(0, 50);
    save();
  }

  // FASE 2 — ENTRAR: compra concreta hoy; la venta queda diferida arriba.
  const colchonUsd = state.tradeSize * (state.survivalPct / 100);
  let best = null;
  for (const opp of snapshot.opportunities || []) {
    const sig = `${opp.pair}|${opp.buyExchange}|${opp.sellExchange}|${opp.buyPrice.toFixed(8)}|${opp.sellPrice.toFixed(8)}`;
    if (state.signed.has(sig)) continue;
    const r = evalOpp(opp, snapshot);
    if (!r) continue;
    if (r.net > colchonUsd && (!best || r.net > best.net)) best = { ...r, net: r.net };
  }
  if (!best) return;

  state.signed.add(best.sig);
  if (state.signed.size > 1000) state.signed.clear();

  state.pending.push({
    id: `${best.pair}-${best.buyEx}-${best.sellEx}-${Date.now()}`,
    pair: best.pair,
    buyEx: best.buyEx,
    sellEx: best.sellEx,
    buySymbol: best.buySymbol,
    sellSymbol: best.sellSymbol,
    tradeSize: state.tradeSize,
    buyVwap: best.buyVwap,
    buyQty: best.buyQty,
    gasCostAtEntry: state.gasCost > 0 ? state.gasCost : null,
    mode: best.mode,
    boughtAt: Date.now()
  });
  save();
}

function start() {
  if (!state.active) {
    state.active = true;
    state.startedAt = state.startedAt || Date.now();
  }
  save();
}

function stop() {
  state.active = false;
  save();
}

function reset() {
  state.signed = new Set();
  state.pending = [];
  state.stats = { checked: 0, survived: 0 };
  state.history = [];
  state.balance = 10000;
  state.startedAt = null;
  state.lastTradeAt = null;
  save();
}

function config(params) {
  if (params && typeof params === 'object') {
    if (typeof params.tradeSize === 'number') state.tradeSize = Math.max(1, params.tradeSize);
    if (typeof params.gasCost === 'number') state.gasCost = Math.max(0, params.gasCost);
    if (typeof params.delayMin === 'number') state.delayMin = Math.max(0.5, params.delayMin);
    if (typeof params.survivalPct === 'number') state.survivalPct = Math.max(0, params.survivalPct);
    if (params.sellMode === 'maker' || params.sellMode === 'taker') state.sellMode = params.sellMode;
    save();
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
    pending: state.pending.map(p => ({
      id: p.id,
      pair: p.pair,
      route: `${p.buyEx} \u2794 ${p.sellEx}`,
      size: p.tradeSize,
      boughtAt: p.boughtAt
    })),
    stats: state.stats,
    startedAt: state.startedAt,
    lastTradeAt: state.lastTradeAt,
    lastTick: state.lastTick
  };
}

load();

module.exports = { tick, start, stop, reset, config, snapshot, _test: {
  // Hook de pruebas: envejece las posiciones para simular el lapso de retiro.
  agePending(ms) { state.pending.forEach(p => { p.boughtAt -= ms; }); }
} };