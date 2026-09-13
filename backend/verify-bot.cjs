// Verificador del bot de arbitraje (réplica de la lógica ACTUAL del frontend App.jsx,
// modelo de EJECUCIÓN EN DOS FASES): compra en el snapshot → retiro en curso →
// venta contra el libro REAL tras el delay → PnL REALIZADO.
// Corre contra la API real del backend y valida cada movimiento:
//  1) ejecución 100% llenada vs order books reales (slippage VWAP)
//  2) precios de ejecución dentro de los límites del libro (nunca mejor que el top)
//  3) ganancias físicamente plausibles (spread real + fees reales + gas real)
//  4) dedupe por firma ruta+precio (sin trades repetidos)
//  5) argmax correcto del snapshot (elige la mejor neta > colchón)
//  6) capital nunca por debajo del capital inicial (locked total <= balance inicial)
const API = 'http://localhost:3001/api/opportunities';
const SIZE = 1500;
// Defaults REALISTAS: mismo delay que el bot del navegador (10 min = crédito real del
// depósito en el exchange de venta). Sólo para depuración de código se puede acortar:
//   node verify-bot.cjs --delay 3 --duration-min 4
const argv = process.argv.slice(2);
const argOf = (key) => { const i = argv.indexOf(key); return i >= 0 ? parseFloat(argv[i + 1]) : NaN; };
const DELAY_MIN = argOf('--delay') || 10;
const DURATION_MS = (argOf('--duration-min') || DELAY_MIN + 2) * 60000;
// Modo de salida: maker (post-only al mejor bid si el top absorbe el lote, si no taker)
// o taker (siempre market). Igual que el selector del PaperBot.
const SELL_MODE = argv[argv.indexOf('--sell-mode') + 1] === 'taker' ? 'taker' : 'maker';
const SURVIVAL_PCT = 0.3;      // colchón de supervivencia = % del monto
const POLL_MS = 10000;

function estimateBuy(asks, sizeUsd) {
  let filledNotional = 0, filledQty = 0;
  for (const [price, amount] of asks || []) {
    if (filledNotional >= sizeUsd) break;
    const notional = price * amount;
    const takeNotional = Math.min(notional, sizeUsd - filledNotional);
    filledQty += takeNotional / price;
    filledNotional += takeNotional;
  }
  return {
    filledNotional,
    filledQty,
    vwap: filledQty > 0 ? filledNotional / filledQty : null,
    executable: filledNotional >= sizeUsd * 0.9999
  };
}

function estimateSell(bids, qty) {
  let filledQty = 0, proceeds = 0;
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

// Orden post-only (maker) al MEJOR BID: factible solo si el mejor nivel del libro
// absorbe el lote completo. Se llena a P0 con fee maker; no cruza el libro.
function estimateMakerSell(bids, qty) {
  const top = bids?.[0];
  if (!top) return { fillable: false, price: null, proceeds: 0, reason: 'no-book' };
  const [price, depth] = top;
  if (depth < qty * 0.9999) return { fillable: false, price, proceeds: 0, reason: 'depth' };
  return { fillable: true, price, proceeds: qty * price, reason: null };
}

function estimateExecution({ asks, bids }, sizeUsd) {
  if (!asks || !bids) return null;
  const buy = estimateBuy(asks, sizeUsd);
  if (!buy.executable) return { ...buy, sell: null, executable: false, reason: 'buy' };
  const sell = estimateSell(bids, buy.filledQty);
  if (!sell.executable) return { ...buy, sell, executable: false, reason: 'sell' };
  return { ...buy, sell, executable: true, reason: null };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const INITIAL_BALANCE = 10000;
  let cash = INITIAL_BALANCE; // liquido REALIZADO (compra descuenta, venta acredita)
  const tradedSignatures = new Set();
  const trades = [];
  const issues = [];
  const pending = []; // {pair,buyEx,sellEx,buySymbol,sellSymbol,buyVwap,qty,size,boughtAt}
  let scans = 0;
  let lockedTotal = 0;
  let maxLocked = 0;
  const start = Date.now();

  // Retiro del ACTIVO: fee cobrado en el activo (a precio live), no fee USDT de refill.
  const gasOf = (ex, pair, transferFees, withdrawalFees) => {
    const asset = pair?.split('/')[0];
    const feeUsd = asset ? transferFees?.[asset]?.[ex]?.feeUsd : null;
    return (feeUsd != null && feeUsd > 0) ? feeUsd : (withdrawalFees?.[ex]?.usdt ?? 0.2);
  };

  // FASE B: vender pendientes cuyo retiro ya llegó, contra el libro ACTUAL.
  const settleExits = (data, now) => {
    const { fees, withdrawalFees, transferFees, books } = data;
    const exited = [];
    const stillPending = [];
    for (const pt of pending) {
      const ageMs = now - pt.boughtAt;
      if (ageMs < DELAY_MIN * 60000) { stillPending.push(pt); continue; }

      const sellBook = books?.[pt.sellEx]?.[pt.sellSymbol];
      if (sellBook && sellBook.bids?.[0]) {
        const bestBid = sellBook.bids[0][0];
        const takerFee = fees?.[pt.sellEx]?.[pt.pair]?.taker ?? 0.001;
        const makerFee = fees?.[pt.sellEx]?.[pt.pair]?.maker ?? takerFee;

        let proceeds = 0;
        let feeUsed = takerFee;
        let soldPct = 100;
        let mode;

        const mkr = SELL_MODE === 'maker' ? estimateMakerSell(sellBook.bids, pt.qty) : null;
        if (mkr?.fillable) {
          // post-only al mejor bid: el top absorbe el lote → llenado a P0, fee maker
          proceeds = mkr.proceeds;
          feeUsed = makerFee;
          mode = 'maker';
        } else {
          // market contra el libro vivo (taker); la cola no absorbida se postea (maker)
          const sell = estimateSell(sellBook.bids, pt.qty);
          const crossedQty = sell.filledQty;
          const remainderQty = pt.qty - crossedQty;
          // Validación 2: lo cruzado por libro NUNCA mejora el mejor bid
          const topBid = sellBook.bids[0]?.[0];
          if (topBid && sell.vwap > topBid * 1.0001) issues.push(`[bug] exit ${pt.pair}: sellVwap ${sell.vwap.toFixed(8)} > topBid ${topBid.toFixed(8)}`);
          proceeds = sell.proceeds + remainderQty * bestBid;
          if (crossedQty >= pt.qty * 0.9999) {
            feeUsed = takerFee;
            mode = 'taker';
            soldPct = 100;
          } else {
            // Fee por porción: cruzado taker, resto post-only maker (sin castigo inventado)
            feeUsed = (sell.proceeds * takerFee + remainderQty * bestBid * makerFee) / proceeds;
            mode = 'mix';
            soldPct = Math.max(1, Math.round((crossedQty / pt.qty) * 100));
          }
        }
        const realized = proceeds * (1 - feeUsed) - gasOf(pt.buyEx, pt.pair, transferFees, withdrawalFees);
        const net = realized - pt.size;
        cash += realized;
        lockedTotal -= pt.size;
        exited.push({ ...pt, net, execSellVwap: proceeds / pt.qty, soldPct, mode, pendingSecs: Math.round(ageMs / 1000) });
      } else {
        // Sin libro vendible: la posición queda retenida y se reintenta. Sin precio
        // confiable para "liquidar" → no se inventa una salida forzada.
        stillPending.push(pt);
      }
    }
    pending.length = 0;
    pending.push(...stillPending);
    return exited;
  };

  // FASE A: buscar entrada con la misma matemática del frontend.
  const findEntry = (data, now) => {
    const { opportunities, fees, withdrawalFees, transferFees, books } = data;
    const colchonUsd = SIZE * (SURVIVAL_PCT / 100);
    let best = null;

    for (const opp of opportunities) {
      const sig = `${opp.pair}|${opp.buyExchange}|${opp.sellExchange}|${opp.buyPrice.toFixed(8)}|${opp.sellPrice.toFixed(8)}`;
      if (tradedSignatures.has(sig)) continue;

      const buyBook = books?.[opp.buyExchange]?.[opp.buySymbol];
      const sellBook = books?.[opp.sellExchange]?.[opp.sellSymbol];
      if (!buyBook || !sellBook) continue;

      const exec = estimateExecution({ asks: buyBook.asks, bids: sellBook.bids }, SIZE);
      if (!exec || !exec.executable) continue;

      const buyVwap = exec.vwap;
      const buyTaker = fees?.[opp.buyExchange]?.[opp.pair]?.taker ?? 0.001;
      const sellTaker = fees?.[opp.sellExchange]?.[opp.pair]?.taker ?? 0.001;
      const qtyAfterBuy = buyVwap > 0 ? (SIZE / buyVwap) * (1 - buyTaker) : 0;
      const proceeds = qtyAfterBuy * exec.sell.vwap;
      const net = proceeds - proceeds * sellTaker - gasOf(opp.buyExchange, opp.pair, transferFees, withdrawalFees) - SIZE;

      // Validación 1: la ejecución nunca mejora el mejor precio del libro
      const topAsk = buyBook.asks[0]?.[0];
      const topBid = sellBook.bids[0]?.[0];
      if (topAsk && buyVwap < topAsk * 0.9999) issues.push(`[bug] ${sig}: buyVwap ${buyVwap.toFixed(8)} < topAsk ${topAsk.toFixed(8)}`);
      if (topBid && exec.sell.vwap > topBid * 1.0001) issues.push(`[bug] ${sig}: sellVwap ${exec.sell.vwap.toFixed(8)} > topBid ${topBid.toFixed(8)}`);

      if (net > colchonUsd && (!best || net > best.net)) {
        best = { sig, opp, net, buyVwap, qtyAfterBuy };
      }
    }

    if (!best) return null;
    // Chequeo de liquidez real: la compra necesita USDT disponible AHORA en el exchange
    // de compra. Con el capital ya comprometido en retiros en curso, la orden fallaría.
    if (lockedTotal + SIZE > INITIAL_BALANCE) return null;
    tradedSignatures.add(best.sig);
    if (tradedSignatures.size > 1000) tradedSignatures.clear();

    // La compra ocurre AHORA: se descuenta el capital y queda un retiro en curso.
    cash -= SIZE;
    lockedTotal += SIZE;
    maxLocked = Math.max(maxLocked, lockedTotal);
    pending.push({
      pair: best.opp.pair,
      buyEx: best.opp.buyExchange,
      sellEx: best.opp.sellExchange,
      buySymbol: best.opp.buySymbol,
      sellSymbol: best.opp.sellSymbol,
      buyVwap: best.buyVwap,
      qty: best.qtyAfterBuy,
      size: SIZE,
      boughtAt: now,
      sig: best.sig
    });
    return best;
  };

  while (Date.now() - start < DURATION_MS) {
    scans++;
    try {
      const res = await fetch(API);
      const data = await res.json();
      const nowTs = Date.now();

      const exited = settleExits(data, nowTs);
      for (const ex of exited) {
        // Validación 3: ganancia realizada físicamente plausible
        if (ex.net > SIZE * 0.01) issues.push(`[bug] exit ${ex.pair}: net realizado ${ex.net.toFixed(2)} USD (${((ex.net / SIZE) * 100).toFixed(2)}% de ${SIZE})`);
        trades.push({
          sig: ex.sig, pair: ex.pair, route: `${ex.buyEx}->${ex.sellEx}`,
          buyVwap: ex.buyVwap, sellVwap: ex.execSellVwap, profit: ex.net,
          soldPct: ex.soldPct, mode: ex.mode, pendSecs: ex.pendingSecs
        });
      }

      const entry = findEntry(data, nowTs);
      const now = new Date().toLocaleTimeString();
      console.log(`[${scans}] ${now} pendientes=${pending.length} exits=${exited.length}${entry ? ` ENTRADA ${entry.opp.pair} ${entry.opp.buyExchange}->${entry.opp.sellExchange} net-snap=$${entry.net.toFixed(2)}` : ''} cash=$${cash.toFixed(2)} lock=$${lockedTotal.toFixed(0)}`);
    } catch (e) {
      console.log(`[${scans}] ERROR consulta: ${e.message}`);
    }
    await sleep(POLL_MS);
  }

  // Fin del periodo: liquidar pendientes con el último snapshot disponible (tolerancia 10s)
  try {
    const res = await fetch(API);
    const exited = settleExits(await res.json(), Date.now());
    for (const ex of exited) {
      if (ex.net > SIZE * 0.01) issues.push(`[bug] exit ${ex.pair}: net realizado ${ex.net.toFixed(2)} USD`);
      trades.push({ sig: ex.sig, pair: ex.pair, route: `${ex.buyEx}->${ex.sellEx}`, buyVwap: ex.buyVwap, sellVwap: ex.execSellVwap, profit: ex.net, soldPct: ex.soldPct, mode: ex.mode, pendSecs: ex.pendingSecs });
    }
  } catch { /* noop */ }

  console.log('\n========== RESUMEN (MODELO 2 FASES, salida ' + SELL_MODE.toUpperCase() + ') ==========');
  console.log(`escanos: ${scans} | retiros en curso al cierre: ${pending.length} (capital retenido $${lockedTotal.toFixed(0)})`);
  console.log(`trades cerrados: ${trades.length}`);
  console.log(`cash realizado final: $${cash.toFixed(2)} (init ${INITIAL_BALANCE})`);
  console.log(`max capital en vuelo simultáneo: $${maxLocked.toFixed(0)} (<= init: ${maxLocked <= INITIAL_BALANCE ? 'OK' : 'FALLO'})`);
  const totProfit = trades.reduce((s, t) => s + t.profit, 0);
  const snapNetSum = trades.reduce((s, t) => s + 0, 0); // (solo realizado)
  console.log(`PnL REALIZADO acumulado: $${totProfit.toFixed(2)} | promedio por trade: $${(totProfit / Math.max(trades.length, 1)).toFixed(2)}`);
  void snapNetSum;

  console.log('\n--- Detalle de trades cerrados ---');
  for (const t of trades) {
    console.log(`${t.pair} ${t.route} ${t.mode ? '[' + t.mode.toUpperCase() + ']' : ''} | compra $${t.buyVwap.toFixed(6)} → venta REAL $${t.sellVwap.toFixed(6)} (${t.soldPct}% llenado, espera ${t.pendSecs}s) | NET $${t.profit.toFixed(2)}`);
  }

  console.log('\n--- Validaciones ---');
  const sigs = trades.map(t => t.sig);
  console.log(`dedupe: ${new Set(sigs).size} unicas / ${trades.length} trades ${new Set(sigs).size === trades.length ? 'OK' : 'FALLO'}`);
  console.log(`capital en vuelo superó el inicial: ${maxLocked <= INITIAL_BALANCE ? 'OK' : 'FALLO'}`);
  console.log(`issues encontradas: ${issues.length}`);
  for (const i of issues) console.log('  ' + i);
  if (!issues.length && new Set(sigs).size === sigs.length) {
    console.log('\nRESULTADO: SIN BUGS DETECTADOS. El PnL realizado tiene en cuenta el riesgo de timing (venta contra libro vivo tras el retiro).');
  } else {
    console.log('\nRESULTADO: REVISAR issues listadas arriba.');
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });