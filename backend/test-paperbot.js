const assert = require('assert');
const pb = require('./paperbot');

const EX = 'binance';
const PAIR = 'BTC/USDT';

function snap(bookBid, bookAsk) {
  return {
    opportunities: [{ pair: PAIR, buyExchange: EX, sellExchange: EX, buyPrice: bookAsk, sellPrice: bookBid, buySymbol: PAIR, sellSymbol: PAIR }],
    books: { [EX]: { [PAIR]: { bids: [[bookBid, 100000]], asks: [[bookAsk, 100000]] } } },
    fees: { [EX]: { [PAIR]: { taker: 0.001, maker: 0.0005 } } },
    withdrawalFees: { [EX]: { usdt: 0.7 } }
  };
}
function snapResolve(bookBid, bookAsk) {
  const s = snap(bookBid, bookAsk);
  s.opportunities = [];
  return s;
}

const results = [];
const R = (name, fn) => { try { fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}: ${e.message}`); } };

function boot(delayMin, sellMode) {
  pb.reset(); pb.start(); pb.config({ tradeSize: 1000, delayMin, survivalPct: 0.3, sellMode, gasCost: 0 });
}

function main() {
  // ── Entrada: pending SIN acreditar balance ─────────────────────────────
  boot(3, 'taker');
  pb.tick(snap(1.10, 1.05));
  let s = pb.snapshot();
  R('entrada genera pending', () => { assert.strictEqual(s.pending.length, 1); });
  R('balance no se acredita al entrar', () => { assert.strictEqual(s.balance, 10000); });

  // ── Antes del delay: sigue pendiente ───────────────────────────────────
  pb.tick(snapResolve(0.98, 0.98));
  s = pb.snapshot();
  R('posicion joven: aun en pending', () => { assert.strictEqual(s.pending.length, 1); });
  R('sin resolucion prematura', () => { assert.strictEqual(s.balance, 10000); });

  // ── Tras el delay (vencida): se resuelve contra libro fresco ──────────
  pb._test.agePending(3 * 60000 + 1000);
  pb.tick(snapResolve(0.98, 0.98));
  s = pb.snapshot();
  R('vencida: sale del pending', () => { assert.strictEqual(s.pending.length, 0); });
  R('usa precio fresco (0.98), no el de entrada', () => {
    assert.ok(s.history[0].execSell <= 0.99, `execSell=${s.history[0].execSell}`);
  });
  R('PnL negativo real (no optimismo)', () => {
    assert.ok(s.balance < 10000, `balance=${s.balance}`);
    assert.ok(s.history[0].profit < 0);
  });
  R('stats.checked contado al vender', () => { assert.strictEqual(s.stats.checked, 1); });

  // ── Sin oportunidad: no entra ──────────────────────────────────────────
  boot(3, 'taker');
  pb.tick(snapResolve(1.10, 1.05));
  R('sin oportunidad: sin pending', () => { assert.deepStrictEqual(pb.snapshot().pending, []); });

  // ── Sin libro fresco: espera, no vende a 0 ─────────────────────────────
  boot(3, 'taker');
  pb.tick(snap(1.10, 1.05));
  pb.tick({ ...snapResolve(0.98, 0.98), books: {} });
  s = pb.snapshot();
  R('sin libro fresco: sigue en pending', () => { assert.strictEqual(s.pending.length, 1); });

  // ── PnL cuadra a mano (taker) ──────────────────────────────────────────
  // 1000 @1.05 taker(0.1%) -> qty=951.43; vende @1.10 taker(0.1%):
  // proceeds 1046.57; net = 1046.57*0.999 - 0.7 - 1000 = 44.83
  boot(3, 'taker');
  pb.tick(snap(1.10, 1.05));
  pb._test.agePending(3 * 60000 + 1000);
  pb.tick(snapResolve(1.10, 1.05));
  s = pb.snapshot();
  R('PnL cuadra a mano (~44.83)', () => {
    const profit = s.history[0].profit;
    assert.ok(Math.abs(profit - 44.83) < 0.5, `profit=${profit}`);
  });
  R('survived=1 con net positivo', () => { assert.strictEqual(s.stats.survived, 1); });

  // ── persisted state sobrevive restart ──────────────────────────────────
  pb.tick(snap(1.10, 1.05)); // pending nuevo
  const before = pb.snapshot().pending.length;
  delete require.cache[require.resolve('./paperbot')];
  const pb2 = require('./paperbot');
  R('pending persiste tras restart', () => { assert.strictEqual(pb2.snapshot().pending.length, before); });

  const fails = results.filter(ok => !ok).length;
  console.log(`\n${results.length - fails}/${results.length} checks OK`);
  process.exit(fails ? 1 : 0);
}

main();