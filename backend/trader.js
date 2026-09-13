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

function authFor(id) {
  const key = process.env[`${id.toUpperCase()}_API_KEY`];
  const secret = process.env[`${id.toUpperCase()}_API_SECRET`];
  return key && secret ? { apiKey: key, secret } : null;
}

function status() {
  const authed = EXCHANGE_IDS.filter(id => authFor(id) !== null);
  return {
    mode: isLiveEnabled() ? 'live' : 'dry-run',
    liveEnabled: isLiveEnabled(),
    endpoints: { check: '/api/trader/check', status: '/api/trader/status' },
    exchangesWithKeys: authed.length,
    exchangesConfigured: EXCHANGE_IDS.length,
    authenticated: authed,
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

module.exports = { status, plan, validateUsdAmount, validateQtyAmount, resolveWithdrawNetwork, _setClients: (c) => { clientStore = c; } };