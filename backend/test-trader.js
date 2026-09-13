// Tests de la capa de ejecucion (trader.js) — no operan nada, solo validan logica.
// Uso: node test-trader.js

const trader = require('./trader');
const assert = require('assert');

function fakeEx(id, { precisionDivisor = 1000000, minAmount = 0.0001, minCost = 10 } = {}) {
  return {
    id,
    has: { createMarketOrder: true },
    markets: {
      'BTC/USDT': { spot: true, limits: { cost: { min: minCost }, amount: { min: minAmount } } },
      'FET/USDT': { spot: true, limits: { cost: { min: 5 }, amount: { min: 1 } } }
    },
    amountToPrecision: (sym, a) => Math.round(a * precisionDivisor) / precisionDivisor
  };
}

// Stub "completo" de un exchange para poder ejecutar la cadena buy->withdraw->sell.
function liveEx(id) {
  return {
    id,
    has: { createMarketOrder: true },
    markets: {
      'FET/USDT': { spot: true, limits: { cost: { min: 5 }, amount: { min: 1 } } },
      'FET/USD': { spot: true, limits: { cost: { min: 5 }, amount: { min: 1 } } }
    },
    amountToPrecision: (sym, a) => Math.round(a * 1000) / 1000,
    loadMarkets: async function () { return this.markets; },
    fetchBalance: async () => ({ total: {} }),
    createMarketOrder: async function (sym, side, amt) { this.orders = this.orders || []; this.orders.push({ sym, side, amt }); return { id: `O-${side}-${sym}-${amt}` }; },
    withdraw: async function (code, amount, address, tag, params) { this.withdrawals = this.withdrawals || []; this.withdrawals.push({ code, amount, address, params }); return { id: `W-${code}` }; },
    fetchDeposits: async function () { return this.deposits || []; },
    fetchCurrencies: async () => ({
      FET: { networks: { TRC20: { withdraw: true, deposit: true, fee: 1 }, ERC20: { withdraw: true, deposit: true } } }
    })
  };
}

const LIVE_DATA = {
  books: {},
  fees: {
    binance: { 'FET/USDT': { taker: 0.001, maker: 0.001 } },
    kraken: { 'FET/USD': { taker: 0.001, maker: 0.001 } }
  },
  transferFees: { FET: { binance: { feeInAsset: 1 } } }
};

const LIVE_OPP = {
  asset: 'FET', pair: 'FET/USDT', buySymbol: 'FET/USDT', sellSymbol: 'FET/USD',
  buyExchange: 'binance', sellExchange: 'kraken',
  buyPrice: 0.16, sellPrice: 0.17, grossSpreadPct: 6.2
};

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, 'FALLO: ' + name);
  passed += 1;
  console.log('  ok -', name);
}

console.log('== validacion de compra (usd -> precision) ==');
const ex = fakeEx('fake');
const buy = trader.validateUsdAmount(ex, 'BTC/USDT', 1500, 60000, 'buy');
ok('compra 1500 USD a 60k -> 0.025 BTC', buy.ok && Math.abs(buy.amount - 0.025) < 1e-6);
ok('amountUsd coherente', Math.abs(buy.amountUsd - 1500) < 0.01);

console.log('== validacion de venta (cantidad real) ==');
const sell = trader.validateQtyAmount(ex, 'BTC/USDT', 0.025, 60050);
ok('venta 0.025 BTC a 60k -> ok', sell.ok);
ok('sell.amount == 0.025 (no re-convertido)', Math.abs(sell.amount - 0.025) < 1e-9);

console.log('== bloqueo por notional minimo ==');
const small = trader.validateQtyAmount(ex, 'BTC/USDT', 0.00001, 60000);
ok('cantidad menor al minimo -> bloqueado', !small.ok && small.reasons.length > 0);

console.log('== validacion de red de retiro (sin red comun -> bloquea) ==');
const fromNet = { USDT: { networks: { TRC20: { withdraw: true, fee: 1 }, ERC20: { withdraw: true, fee: 6 } } }, FET: { networks: { BEP20: { withdraw: true } } } };
  const toNet = { USDT: { networks: { ERC20: { deposit: true }, TRC20: { deposit: true } } }, FET: { networks: { ERC20: { deposit: true } } } };
(async () => {
  // Red comun para USDT entre dos exchanges compatibles
  const fakeClients = {
    binance: { fetchCurrencies: async () => fromNet },
    kraken: { fetchCurrencies: async () => toNet }
  };
  const original = null;
  trader._setClients(fakeClients);
  const r1 = await trader.resolveWithdrawNetwork('USDT', 'binance', 'kraken');
  trader._setClients(null);
  ok('USDT -> red comun TRC20/ERC20 encontrada', r1.network === 'TRC20' || r1.network === 'ERC20');
  ok('fee de red expuesta', r1.fee);

  // SIN red comun para FET: la operacion queda BLOQUEADA (fondos a salvo)
  const r2 = await trader.resolveWithdrawNetwork('FET', 'binance', 'kraken');
  ok('FET sin red comun -> null (bloquea)', r2.network === null && r2.reason !== null);

  console.log('\n== guardarrailes de la capa segura (ejecucion real) ==');

  const oldEnv = {};
  const set = (k, v) => { oldEnv[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  const setLiveEnv = () => {
    set('LIVE_TRADING_ENABLED', 'true');
    set('MAX_TRADE_SIZE', '5000');
    set('MIN_NET_PROFIT_PCT', '0');
    set('ALLOW_WITHDRAWALS', 'true');
    set('BINANCE_API_KEY', 'k'); set('BINANCE_API_SECRET', 's');
    set('KRAKEN_API_KEY', 'k'); set('KRAKEN_API_SECRET', 's');
    set('APPROVED_NETWORKS', 'FET>binance>kraken>TRC20');
    set('DEPOSIT_ADDRESSES', 'FET>kraken>TRC20>TABC123');
  };
  const restoreEnv = () => { for (const k of Object.keys(oldEnv)) { if (oldEnv[k] === undefined) delete process.env[k]; else process.env[k] = oldEnv[k]; } };

  const buyEx = liveEx('binance');
  const sellEx = liveEx('kraken');
  trader._setClients({ binance: buyEx, kraken: sellEx });
  trader._test.reset();

  // 1) LIVE off (default) -> bloqueado, sin ordenes
  set('LIVE_TRADING_ENABLED', 'false');
  let r = await trader.execute(LIVE_OPP, 1500, LIVE_DATA);
  ok('dry-run: LIVE apagado -> bloqueado', r.ok === false && r.reasons.some(x => x.includes('LIVE_TRADING_ENABLED')));
  ok('dry-run: no se coloco ninguna orden', !(buyEx.orders || []).length);

  // 2) LIVE on pero red NO aprobada -> bloqueado
  setLiveEnv(); set('APPROVED_NETWORKS', '');
  r = await trader.execute(LIVE_OPP, 1500, LIVE_DATA);
  ok('red no aprobada -> bloqueado', r.ok === false && r.reasons.some(x => x.includes('no aprobada')));

  // 3) red aprobada pero SIN direccion de deposito -> bloqueado (no retira a ciegas)
  set('APPROVED_NETWORKS', 'FET>binance>kraken>TRC20'); set('DEPOSIT_ADDRESSES', '');
  r = await trader.execute(LIVE_OPP, 1500, LIVE_DATA);
  ok('falta direccion de deposito -> bloqueado', r.ok === false && r.reasons.some(x => x.includes('deposito')));

  // 4) kill switch -> bloqueado
  set('DEPOSIT_ADDRESSES', 'FET>kraken>TRC20>TABC123');
  trader.kill();
  r = await trader.execute(LIVE_OPP, 1500, LIVE_DATA);
  ok('kill switch -> bloqueado', r.ok === false && r.reasons.some(x => x.includes('kill switch')));
  trader._test.reset();

  // 5) perdida diaria superada -> bloqueado
  trader._test.seed({ status: 'done', net: -15, doneAt: Date.now() });
  r = await trader.execute(LIVE_OPP, 1500, LIVE_DATA);
  ok('perdida diaria >= MAX_DAILY_LOSS -> bloqueado', r.ok === false && r.reasons.some(x => x.includes('perdida diaria')));
  trader._test.reset();

  // 6) tope de trades concurrentes -> bloqueado
  trader._test.seed({ status: 'in_transit', createdAt: Date.now() });
  r = await trader.execute(LIVE_OPP, 1500, LIVE_DATA);
  ok('trades activos >= MAX_CONCURRENT_TRADES -> bloqueado', r.ok === false && r.reasons.some(x => x.includes('trades activos')));
  trader._test.reset();

  // 7) todos los guardarrailes OK -> compra + retiro colocados (phase in_transit)
  r = await trader.execute(LIVE_OPP, 1500, LIVE_DATA);
  ok('guardarrailes OK -> trade auth in_transit', r.ok === true && r.phase === 'in_transit' && !!r.ref);
  ok('orden de compra colocada en origen', (buyEx.orders || []).some(o => o.side === 'buy'));
  ok('retiro hecho por la red aprobada', (buyEx.withdrawals || []).some(w => w.code === 'FET'));
  ok('trade guardado con estado rastreable', trader.trades().some(t => t.ref === r.ref && t.status === 'in_transit'));

  // 8) monitor cierra el trade apenas llega el deposito
  sellEx.deposits = [{ asset: 'FET', status: 'ok', timestamp: Date.now() }];
  await trader.sweepDeposits();
  const doneTrade = trader.trades().find(t => t.ref === r.ref);
  ok('deposito OK -> trade done y vendido en destino', doneTrade && doneTrade.status === 'done');
  ok('orden de venta colocada en destino', (sellEx.orders || []).some(o => o.side === 'sell'));

  restoreEnv();
  trader._test.reset();
  trader._setClients(null);
  ok('estado de prueba restaurado', true);

  console.log(`\n${passed} checks OK`);
})().catch(e => { console.error('ERROR', e); process.exit(1); });