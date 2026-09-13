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

  console.log(`\n${passed} checks OK`);
})().catch(e => { console.error('ERROR', e); process.exit(1); });