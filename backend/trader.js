// Capa de ejecucion REAL - por defecto en DRY-RUN.
// NUNCA envia ordenes ni retiros salvo que LIVE_TRADING_ENABLED=true y existan
// API keys por exchange en /backend/.env. Hoy existen SOLO las validaciones;
// la ejecucion en vivo queda desactivada de fabrica.
//
// Que valida (los puntos mas criticos de la auditoria):
//  - exista el mercado spot y el exchange soporte market orders
//  - el monto cumpla limite de notional minimo (minNotional) y cantidad minima
//  - la cantidad se ajuste a la precision del instrumento (amountToPrecision)
//  - la red de retiro del asset EN ORIGEN exista como red de deposito EN DESTINO
//    (mandar TRC20 a un exchange que solo acepta ERC20 = fondos IRRECUPERABLES)

const ccxt = require('ccxt');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

dotenv.config();

const EXCHANGE_IDS = ['binance', 'coinbase', 'kraken', 'bybit', 'okx', 'mexc', 'gate', 'kucoin', 'bitget'];

let clients = null;
let clientStore = null;

function getClients() {
  if (clientStore) return clientStore;
  if (clients) return clients;
  clients = buildClients();
  return clients;
}

function isLiveEnabled() {
  return process.env.LIVE_TRADING_ENABLED === 'true';
}

const DATA_DIR = path.join(__dirname, '.data');
const TRADES_FILE = path.join(DATA_DIR, 'live-trades.json');

let killSwitch = false;
let liveTrades = loadTrades();

function loadTrades() {
  try { return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch { return []; }
}
function saveTrades() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TRADES_FILE, JSON.stringify(liveTrades, null, 2));
  } catch { /* no fatal en dry-run */ }
}

// Parsea "ASSET>FROM>TO>NETWORK" separadas por coma: redes aprobadas a mano
// despues del test real 1:1 (ver Fase 1 del diseno seguro).
function parseApprovedNetworks() {
  const out = [];
  for (const entry of (process.env.APPROVED_NETWORKS || '').split(',')) {
    const [asset, from, to, network] = (entry || '').trim().split('>');
    if (asset && from && to && network) out.push({ asset: asset.trim(), from: from.trim(), to: to.trim(), network: network.trim() });
  }
  return out;
}

// "ASSET>EXCHANGE>NETWORK>ADDRESS[>TAG]": direccion de deposito del USUARIO en el
// exchange de venta, verificada por el. Sin esto, nunca se retira dinero.
function parseDepositAddresses() {
  const out = [];
  for (const entry of (process.env.DEPOSIT_ADDRESSES || '').split(',')) {
    const [asset, ex, network, address, tag] = (entry || '').trim().split('>');
    if (asset && ex && network && address) out.push({ asset: asset.trim(), ex: ex.trim(), network: network.trim(), address: address.trim(), tag: (tag || '').trim() });
  }
  return out;
}

function liveConfig() {
  const num = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) && v > 0 ? parseFloat(v) : d; };
  return {
    maxTradeSize: num('MAX_TRADE_SIZE', 50),
    maxDailyLoss: num('MAX_DAILY_LOSS', 10),
    maxConcurrentTrades: Math.max(1, Math.floor(num('MAX_CONCURRENT_TRADES', 1))),
    minNetProfitPct: num('MIN_NET_PROFIT_PCT', 2),
    allowWithdrawals: process.env.ALLOW_WITHDRAWALS === 'true',
    timeoutMin: Math.max(1, Math.floor(num('LIVE_TIMEOUT_MIN', 30))),
    approvedNetworks: parseApprovedNetworks(),
    depositAddresses: parseDepositAddresses()
  };
}

function authFor(id) {
  const key = process.env[`${id.toUpperCase()}_API_KEY`];
  const secret = process.env[`${id.toUpperCase()}_API_SECRET`];
  if (!key || !secret) return null;
  const password = process.env[`${id.toUpperCase()}_API_PASSWORD`];
  return password ? { apiKey: key, secret, password } : { apiKey: key, secret };
}

const authProbe = new Map();

// Prueba las claves una sola vez (solo lectura de balance) y cachea el resultado.
async function authenticated(id) {
  if (authProbe.has(id)) return authProbe.get(id);
  const ex = getClients()[id];
  const a = authFor(id);
  if (!ex || !a) { const r = { ok: false, reason: 'sin keys' }; authProbe.set(id, r); return r; }
  const probe = await withTimeout(ex.fetchBalance().catch(e => e).then(e => ({ ok: !(e instanceof Error), reason: e instanceof Error ? e.message : null })), 10000)
    .catch(e => ({ ok: false, reason: e.message }) );
  authProbe.set(id, probe);
  return probe;
}

function status() {
  const keyed = EXCHANGE_IDS.filter(id => authFor(id) !== null);
  const cfg = liveConfig();
  const inFlight = liveTrades.filter(t => !['done', 'failed', 'killed'].includes(t.status));
  return {
    mode: isLiveEnabled() ? 'live' : 'dry-run',
    liveEnabled: isLiveEnabled(),
    killSwitch,
    live: { ...cfg, approvedNetworks: cfg.approvedNetworks, depositAddresses: cfg.depositAddresses },
    endpoints: { check: '/api/trader/check', status: '/api/trader/status', execute: '/api/trader/execute', kill: '/api/trader/kill', unwind: '/api/trader/unwind', probe: '/api/trader/probe' },
    exchangesWithKeys: keyed.length,
    exchangesConfigured: EXCHANGE_IDS.length,
    authenticated: keyed,
    perExchange: Object.fromEntries(EXCHANGE_IDS.map(id => {
      const a = authFor(id);
      const probed = authProbe.get(id);
      return [id, { keyed: !!a, probed: probed ? { ok: probed.ok, reason: probed.reason } : null, canTrade: !!a, canWithdraw: cfg.allowWithdrawals && !!a }];
    })),
    inFlight,
    tradeCount: liveTrades.length,
    note: 'dry-run: solo valida parametros reales (precision, notional, red); no mueve fondos.'
  };
}

function buildClients() {
  if (clients) return clients;
  clients = {};
  for (const id of EXCHANGE_IDS) {
    const klass = ccxt[id];
    if (!klass) continue;
    const auth = authFor(id);
    clients[id] = new klass({
      enableRateLimit: true,
      ...(auth ? auth : {})
    });
  }
  return clients;
}

async function withTimeout(promise, ms = 8000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function ensureMarkets(ex, id) {
  if (!ex.markets || Object.keys(ex.markets).length === 0) {
    await withTimeout(ex.loadMarkets());
  }
  return ex;
}

// Valida CANTIDAD de activo a vender (precision + limites). No convierte usd->cantidad.
function validateQtyAmount(ex, symbol, qty, price) {
  const market = ex.markets?.[symbol];
  if (!market) return { ok: false, reasons: ['mercado no listado'] };
  if (!market.spot) return { ok: false, reasons: ['instrumento no es spot'] };
  if (!(ex.has && ex.has.createMarketOrder)) return { ok: false, reasons: [`${ex.id} no soporta market orders`] };
  if (!(qty > 0) || !Number.isFinite(qty)) return { ok: false, reasons: ['cantidad invalida'] };

  const reasons = [];
  let amount;
  try { amount = Number(ex.amountToPrecision(symbol, qty)); } catch { amount = qty; }

  const minAmount = market.limits?.amount?.min;
  if (minAmount && amount < minAmount) reasons.push(`cantidad ${amount} < min ${minAmount}`);

  const amountUsd = price * amount;
  const minCost = market.limits?.cost?.min;
  if (minCost && amountUsd < minCost) reasons.push(`notional ${amountUsd.toFixed(2)} < minimo ${minCost}`);

  return { ok: reasons.length === 0, reasons, amount, amountUsd, side: 'sell', symbol };
}

// Convierte un monto en USDT a cantidad del base ajustada a la precision real
// del instrumento y valida los limites del exchange.
function validateUsdAmount(ex, symbol, usd, price, side) {
  const market = ex.markets?.[symbol];
  if (!market) return { ok: false, reasons: ['mercado no listado'] };
  if (!market.spot) return { ok: false, reasons: ['instrumento no es spot'] };
  if (!(ex.has && ex.has.createMarketOrder)) return { ok: false, reasons: [`${ex.id} no soporta market orders`] };
  if (!(price > 0) || !Number.isFinite(price)) return { ok: false, reasons: ['sin referencia de precio valida'] };

  const reasons = [];
  const minCost = market.limits?.cost?.min;
  if (minCost && usd < minCost) reasons.push(`notional ${usd.toFixed(2)} < minimo ${minCost}`);

  const rawAmount = usd / price;
  let amount;
  try { amount = Number(ex.amountToPrecision(symbol, rawAmount)); } catch { amount = rawAmount; }

  const minAmount = market.limits?.amount?.min;
  if (minAmount && amount < minAmount) reasons.push(`cantidad ${amount} < min ${minAmount}`);

  const amountUsd = amount * price;
  if (minCost && amountUsd < minCost) reasons.push(`notional ajustado ${amountUsd.toFixed(2)} < minimo ${minCost}`);

  return { ok: reasons.length === 0, reasons, amount, amountUsd, side, symbol };
}

// Red de retiro comun: intersecta redes del asset donde el exchange ORIGEN permite
// retiro (network.withdraw) con redes donde el DESTINO acepta deposito.
// Fallback conservador: null (bloquea la operacion) si no se puede verificar.
const networksCache = new Map();

async function fetchNetworks(ex, id) {
  const key = id;
  if (networksCache.has(key)) return networksCache.get(key);
  let result = null;
  try {
    const currencies = await withTimeout(ex.fetchCurrencies(), 10000);
    result = currencies ? Object.entries(currencies).reduce((acc, [code, cur]) => {
      if (cur && cur.networks && typeof cur.networks === 'object') acc[code] = cur.networks;
      return acc;
    }, {}) : {};
  } catch (e) {
    networksCache.set(key, null);
    return null;
  }
  networksCache.set(key, result);
  return result;
}

async function resolveWithdrawNetwork(asset, fromId, toId) {
  const fromNetworks = await fetchNetworks(getClients()[fromId], fromId);
  const toNetworks = await fetchNetworks(getClients()[toId], toId);
  if (!fromNetworks || !toNetworks) return { network: null, reason: 'fetchCurrencies no disponible; bloquear operacion' };

  const fromAsset = fromNetworks[asset];
  const toAsset = toNetworks[asset];
  if (!fromAsset || !toAsset) return { network: null, reason: `redes no registradas para ${asset}` };

  const withdrawable = Object.entries(fromAsset).filter(([n, info]) => info && info.withdraw !== false);
  const depositable = Object.entries(toAsset).filter(([n, info]) => info && info.deposit !== false);

  const common = withdrawable
    .map(([n]) => n)
    .filter(n => depositable.some(([dn]) => dn === n));

  const preferred = ['TRC20', 'TRX', 'ERC20', 'BEP20', 'POLYGON', 'AVAX-C', 'ARBITRUM', 'OPTIMISM'];
  const network = common.sort((a, b) => preferred.indexOf(a) === -1 ? 1 : preferred.indexOf(a) - (preferred.indexOf(b) === -1 ? 0 : preferred.indexOf(b)))[0] || null;

  if (!network) return { network: null, reason: `sin red comun de retiro/deposito para ${asset} (${fromId}->${toId})` };
  const feeInfo = fromAsset[network];
  const fee = (feeInfo && Number(feeInfo.fee) > 0) ? Number(feeInfo.fee) : null;
  return { network, fee, reason: null };
}

// Plan de ejecucion (dry-run): valida paramteros reales de ambas patas + red de
// retiro. No coloca ninguna orden.
async function plan(opp, tradeSize, data) {
  const clientsData = getClients();
  const buyEx = clientsData[opp.buyExchange];
  const sellEx = clientsData[opp.sellExchange];
  if (!buyEx || !sellEx) return { ok: false, reasons: [`exchange no soportado: ${opp.buyExchange}/${opp.sellExchange}`] };

  const [buyExReady, sellExReady] = await Promise.all([
    ensureMarkets(buyEx, opp.buyExchange).catch(() => null),
    ensureMarkets(sellEx, opp.sellExchange).catch(() => null)
  ]);
  if (!buyExReady || !sellExReady) {
    return { ok: false, reasons: ['no se pudo cargar markets (probable bloqueo de red/geo)'] };
  }

  const buyBook = data?.books?.[opp.buyExchange]?.[opp.buySymbol];
  const sellBook = data?.books?.[opp.sellExchange]?.[opp.sellSymbol];
  const buyVwap = buyBook?.asks?.[0]?.[0] || opp.buyPrice;
  const sellVwap = sellBook?.bids?.[0]?.[0] || opp.sellPrice;

  const buy = validateUsdAmount(buyExReady, opp.buySymbol, tradeSize, buyVwap, 'buy');
  const buyQty = buy.ok ? buy.amount : tradeSize / buyVwap;
  const netQty = buyQty * (1 - (data?.fees?.[opp.buyExchange]?.[opp.pair]?.taker || 0.001));
  const sell = validateQtyAmount(sellExReady, opp.sellSymbol, netQty, sellVwap);

  const withdraw = await resolveWithdrawNetwork(opp.asset, opp.buyExchange, opp.sellExchange);

  const reasons = [];
  if (!buy.ok) reasons.push(...buy.reasons.map(r => `compra: ${r}`));
  if (!sell.ok) reasons.push(...sell.reasons.map(r => `venta: ${r}`));
  if (withdraw.network) {
    reasons.push(`red retiro: ${withdraw.network}${withdraw.fee ? ` (fee ${withdraw.fee})` : ''} — VERIFICADA`);
  } else {
    reasons.push(`retiro: ${withdraw.reason || 'sin red verificada'}`);
  }

  return {
    ok: buy.ok && sell.ok && !!withdraw.network,
    mode: isLiveEnabled() ? 'live-prep' : 'dry-run',
    pair: opp.pair,
    route: `${opp.buyExchange} -> ${opp.sellExchange}`,
    tradeSize,
    legs: {
      buy: { exchange: opp.buyExchange, symbol: opp.buySymbol, sizeUsd: tradeSize, refPrice: buyVwap, ...buy },
      sell: { exchange: opp.sellExchange, symbol: opp.sellSymbol, refPrice: sellVwap, ...sell }
    },
    withdraw: { network: withdraw.network || null, fee: withdraw.fee ?? null, reason: withdraw.reason || null },
    grossSpreadPct: opp.grossSpreadPct,
    reasons,
    blockedBy: reasons.filter(r => r.startsWith('compra') || r.startsWith('venta') || r.startsWith('retiro:'))
  };
}

// Estimacion de beneficio neto usando fees REALES (taker por pata) + fee de
// retiro cobrado EN EL ACTIVO. Sin fee registrado => no estima (bloquea).
function netEstimate(opp, planResult, data) {
  try {
    const takerBuy = data?.fees?.[opp.buyExchange]?.[opp.pair]?.taker ?? 0.001;
    const takerSell = data?.fees?.[opp.sellExchange]?.[opp.pair]?.taker ?? 0.001;
    const buyAmount = planResult.legs?.buy?.amount || (planResult.tradeSize / (planResult.legs?.buy?.refPrice || 1));
    const netQty = buyAmount * (1 - takerBuy);
    const feeInAsset = data?.transferFees?.[opp.asset]?.[opp.buyExchange]?.feeInAsset;
    if (feeInAsset == null) return { ok: false, reason: 'sin fee de transferencia registrado' };
    const sellQty = Math.max(0, netQty - feeInAsset);
    const sellVwap = planResult.legs?.sell?.refPrice ?? opp.sellPrice;
    const proceeds = sellQty * (1 - takerSell) * sellVwap;
    const net = proceeds - planResult.tradeSize;
    return { ok: true, net, netPct: (net / planResult.tradeSize) * 100, sellQty, feeInAsset };
  } catch (e) { return { ok: false, reason: e.message }; }
}

function isToday(ts) {
  const d = new Date(ts || 0);
  const n = new Date();
  return d.toDateString() === n.toDateString();
}

// Guardarrailes duros de la ejecucion real. MUCHOS motivos => BLOQUEA.
function liveGuards(opp, planResult, data) {
  const cfg = liveConfig();
  const reasons = [];
  if (killSwitch) reasons.push('kill switch activado');
  if (!isLiveEnabled()) reasons.push('dry-run: LIVE_TRADING_ENABLED no esta en true');
  if (!planResult.ok) reasons.push('plan de validacion no apto (precision/notional/red)');
  if (planResult.tradeSize > cfg.maxTradeSize) reasons.push(`tradeSize ${planResult.tradeSize} > MAX_TRADE_SIZE ${cfg.maxTradeSize}`);

  const est = netEstimate(opp, planResult, data);
  if (est && est.ok && est.netPct < cfg.minNetProfitPct) reasons.push(`beneficio neto ${est.netPct.toFixed(2)}% < MIN_NET_PROFIT_PCT ${cfg.minNetProfitPct}%`);
  else if (est && !est.ok) reasons.push(est.reason);

  const active = liveTrades.filter(t => ['pending', 'in_transit', 'deposited'].includes(t.status)).length;
  if (active >= cfg.maxConcurrentTrades) reasons.push(`trades activos ${active} >= MAX_CONCURRENT_TRADES ${cfg.maxConcurrentTrades}`);

  const todayLoss = liveTrades.filter(t => t.status === 'done' && isToday(t.doneAt)).reduce((acc, t) => acc + Math.min(0, t.net ?? 0), 0);
  if (Math.abs(todayLoss) >= cfg.maxDailyLoss) reasons.push(`perdida diaria -$${Math.abs(todayLoss).toFixed(2)} >= MAX_DAILY_LOSS ${cfg.maxDailyLoss}`);

  const approved = cfg.approvedNetworks.find(a => a.asset === opp.asset && a.from === opp.buyExchange && a.to === opp.sellExchange && a.network === planResult.withdraw?.network);
  if (!cfg.allowWithdrawals) reasons.push('ALLOW_WITHDRAWALS no habilitado');
  else if (!approved) reasons.push(`red ${planResult.withdraw?.network || 'sin verificar'} no aprobada en APPROVED_NETWORKS para ${opp.asset} ${opp.buyExchange}->${opp.sellExchange}`);

  const addr = cfg.depositAddresses.find(a => a.asset === opp.asset && a.ex === opp.sellExchange && a.network === planResult.withdraw?.network);
  if (!addr) reasons.push(`falta direccion de deposito (DEPOSIT_ADDRESSES) para ${opp.asset} en ${opp.sellExchange}`);

  if (!authFor(opp.buyExchange)) reasons.push(`sin keys para ${opp.buyExchange}`);
  if (!authFor(opp.sellExchange)) reasons.push(`sin keys para ${opp.sellExchange}`);

  return reasons;
}

// Ejecuta la ruta de forma SEGURA y rastreable:
//   bloqueado -> pending (buy) -> in_transit (withdraw) -> done (sell on deposit)
// Cualquier fallo deja un registro con estado failed/stuck + instrucciones de unwind.
async function execute(opp, tradeSize, data) {
  const planResult = await plan(opp, tradeSize, data);
  const reasons = liveGuards(opp, planResult, data);
  if (reasons.length || !planResult.ok) {
    return { ok: false, ref: null, phase: 'blocked', reasons, plan: planResult };
  }

  const cfg = liveConfig();
  const est = netEstimate(opp, planResult, data);
  if (!est || !est.ok) return { ok: false, ref: null, phase: 'blocked', reasons: [est?.reason || 'sin estimacion'], plan: planResult };

  const approved = cfg.approvedNetworks.find(a => a.asset === opp.asset && a.from === opp.buyExchange && a.to === opp.sellExchange && a.network === planResult.withdraw.network);
  const addr = cfg.depositAddresses.find(a => a.asset === opp.asset && a.ex === opp.sellExchange && a.network === planResult.withdraw.network);

  const ref = crypto.randomUUID().slice(0, 8);
  const record = {
    ref,
    asset: opp.asset,
    pair: opp.pair,
    buyExchange: opp.buyExchange,
    sellExchange: opp.sellExchange,
    buySymbol: opp.buySymbol,
    sellSymbol: opp.sellSymbol,
    network: planResult.withdraw.network,
    tradeSize,
    sellAmount: Number(est.sellQty.toFixed(8)),
    status: 'pending',
    createdAt: Date.now(),
    log: [`creado ${new Date().toISOString()}`]
  };
  liveTrades.push(record);

  const buyEx = getClients()[opp.buyExchange];
  try {
    const buy = planResult.legs.buy;
    const order = await withTimeout(buyEx.createMarketOrder(opp.buySymbol, 'buy', buy.amount), 15000);
    record.buyOrderId = order?.id || null;
    record.log.push(`compra ${buy.amount} ${opp.asset} en ${opp.buyExchange} (orden ${order?.id || '?'})`);
  } catch (e) {
    record.status = 'failed';
    record.failReason = `compra: ${e.message}`;
    record.log.push('FALLO ' + record.failReason);
    saveTrades();
    return { ok: false, ref, phase: 'failed', reasons: [record.failReason], record };
  }

  if (cfg.allowWithdrawals) {
    try {
      const w = await withTimeout(buyEx.withdraw(opp.asset, record.sellAmount, addr.address, addr.tag || undefined, { network: planResult.withdraw.network }), 20000);
      record.withdrawId = w?.id || null;
      record.status = 'in_transit';
      record.log.push(`retiro ${record.sellAmount} ${opp.asset} *${planResult.withdraw.network}* hacia ${opp.sellExchange} (${addr.address.slice(0, 10)}…) (${w?.id || '?'})`);
    } catch (e) {
      record.status = 'failed';
      record.failReason = `retiro: ${e.message}; fondos quedaron en ${opp.buyExchange}`;
      record.log.push('FALLO ' + record.failReason);
      saveTrades();
      return { ok: false, ref, phase: 'failed', reasons: [record.failReason], record };
    }
  }

  saveTrades();
  return { ok: true, ref, phase: record.status, record, plan: planResult };
}

// Monitorea depósitos en llegada y cierra cada trade vendiendo apenas aparece.
async function sweepDeposits() {
  if (!isLiveEnabled()) return;
  const cfg = liveConfig();
  const pending = liveTrades.filter(t => t.status === 'in_transit');
  for (const t of pending) {
    const sellEx = getClients()[t.sellExchange];
    if (!sellEx) { t.status = 'stuck'; t.failReason = `exchange ${t.sellExchange} sin cliente`; t.log.push(t.failReason); saveTrades(); continue; }
    const elapsedMin = (Date.now() - t.createdAt) / 60000;
    let deposits = [];
    try {
      deposits = await withTimeout(sellEx.fetchDeposits(t.asset, undefined, Date.now() - (Math.max(0, elapsedMin - 5) + 5) * 60000), 12000);
    } catch (e) {
      t.log.push(`no se pudo consultar depositos: ${e.message}`);
    }
    const found = deposits.find(d => d && d.status === 'ok' && String(d.asset || '').toUpperCase() === t.asset.toUpperCase());
    if (found) {
      try {
        const sell = await withTimeout(sellEx.createMarketOrder(t.sellSymbol, 'sell', t.sellAmount), 15000);
        t.status = 'done';
        t.doneAt = Date.now();
        t.sellOrderId = sell?.id || null;
        t.log.push(`deposito OK -> venta ${t.sellAmount} ${t.asset} en ${t.sellExchange} (orden ${sell?.id || '?'})`);
      } catch (e) {
        t.status = 'stuck';
        t.failReason = `deposito recibido pero la venta fallo: ${e.message}`;
        t.log.push(t.failReason);
      }
      saveTrades();
      continue;
    }
    if (elapsedMin >= cfg.timeoutMin) {
      t.status = 'stuck';
      t.failReason = `el deposito no llego (${Math.floor(elapsedMin)} min)`;
      t.log.push(t.failReason);
    }
    saveTrades();
  }
}

// Kill switch: apaga la ejecucion y marca los in-flight para manejo manual.
// Solo se desactiva reiniciando el backend (a proposito, para que sea DELIBERADO).
function kill() {
  killSwitch = true;
  for (const t of liveTrades) {
    if (t.status === 'done' || t.status === 'failed') continue;
    t.status = 'killed';
    t.killedAt = Date.now();
    t.log.push('kill switch activado');
  }
  saveTrades();
  return { ok: true, killSwitch, reason: 'ejecucion detenida; fondos in-flight requieren manejo manual (ver unwind)' };
}

function unwind(ref) {
  const t = liveTrades.find(x => x.ref === ref);
  if (!t) return { ok: false, reason: 'trade no encontrado' };
  const steps = [
    `1. Verifica en ${t.buyExchange} (app del exchange) el saldo y las ordenes abiertas.`,
    `2. Si quedo ${t.asset} comprado, vendelo en ${t.buyExchange} (market) y volve a USDT.`,
    t.status !== 'pending' && t.status !== 'failed'
      ? `3. Si el retiro llego a ${t.sellExchange}, vendelo alla y confirmá que el deposito este en estado ok.`
      : '',
    `4. Si algo no encaja, revoca los permisos de la key y contacta soporte del exchange.`
  ].filter(Boolean);
  return { ok: true, ref, status: t.status, log: t.log, steps };
}

module.exports = { status, plan, execute, sweepDeposits, kill, unwind, liveGuards, netEstimate, liveConfig, authFor, authenticated, trades: () => liveTrades, validateUsdAmount, validateQtyAmount, resolveWithdrawNetwork, _setClients: (c) => { clientStore = c; },
  _test: {
    reset: () => { killSwitch = false; liveTrades = []; networksCache.clear(); authProbe.clear(); saveTrades(); },
    seed: (t) => { liveTrades.push(t); }
  } };