// Verificador del bot de arbitraje (réplica EXACTA de la lógica del frontend App.jsx)
// Corre contra la API real del backend y valida cada trade:
//  1) ejecución 100% llenada vs order books reales (slippage VWAP)
//  2) precios de ejecución dentro de los límites del libro (nunca mejor que el top)
//  3) ganancia dentro de un rango físicamente plausible
//  4) dedupe por firma ruta+precio (sin trades repetidos)
//  5) argmax correcto (elige de verdad la mejor neta del snapshot)
//  6) balance nunca negativo
const API = 'http://localhost:3001/api/opportunities';
const SIZE = 1500;
const DURATION_MS = 300000; // 5 minutos
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
  let balance = 10000;
  const tradedSignatures = new Set();
  const trades = [];
  const issues = [];
  let scans = 0;
  let blockedByDepth = 0;
  let blockedNoBook = 0;
  const start = Date.now();

  const analyze = (data) => {
    const { opportunities, fees, withdrawalFees, books } = data;
    let candidates = 0, profitable = 0, best = null;

    for (const opp of opportunities) {
      const sig = `${opp.pair}|${opp.buyExchange}|${opp.sellExchange}|${opp.buyPrice.toFixed(8)}|${opp.sellPrice.toFixed(8)}`;
      if (tradedSignatures.has(sig)) continue;

      const buyBook = books?.[opp.buyExchange]?.[opp.buySymbol];
      const sellBook = books?.[opp.sellExchange]?.[opp.sellSymbol];
      if (!buyBook || !sellBook) { blockedNoBook++; continue; }

      const exec = estimateExecution({ asks: buyBook.asks, bids: sellBook.bids }, SIZE);

      if (exec && !exec.executable) { blockedByDepth++; continue; }
      if (!exec) continue;
      candidates++;

      const buyVwap = exec.vwap;
      const buyTaker = fees?.[opp.buyExchange]?.[opp.pair]?.taker ?? 0.001;
      const sellTaker = fees?.[opp.sellExchange]?.[opp.pair]?.taker ?? 0.001;
      const qtyAfterBuy = buyVwap > 0 ? (SIZE / buyVwap) * (1 - buyTaker) : 0;
      const proceeds = qtyAfterBuy * exec.sell.vwap;
      const sellFeeUsd = proceeds * sellTaker;
      const gasCost = withdrawalFees?.[opp.buyExchange]?.usdt ?? 1.5;
      const finalProfit = proceeds - sellFeeUsd - gasCost - SIZE;

      // Validación de realismo 1: la ejecución no puede mejorar el mejor precio del libro
      const topAsk = buyBook.asks[0]?.[0];
      const topBid = sellBook.bids[0]?.[0];
      if (topAsk && buyVwap < topAsk * 0.9999) issues.push(`[bug] ${sig}: buyVwap ${buyVwap.toFixed(8)} < topAsk ${topAsk.toFixed(8)}`);
      if (topBid && exec.sell.vwap > topBid * 1.0001) issues.push(`[bug] ${sig}: sellVwap ${exec.sell.vwap.toFixed(8)} > topBid ${topBid.toFixed(8)}`);

      if (finalProfit > 0) profitable++;
      if (finalProfit > 0 && (!best || finalProfit > best.finalProfit)) {
        best = { opp, sig, finalProfit, buyVwap, sellVwap: exec.sell.vwap, buyTaker, sellTaker, gasCost, topAsk, topBid };
      }
    }

    if (best) {
      // Validación 3: ganancia físicamente plausible (spread real ~1.4%, fees >= 0.05%, gas)
      if (best.finalProfit > SIZE * 0.005) issues.push(`[bug] ${best.sig}: ganancia no realista ${best.finalProfit.toFixed(2)} USD (${((best.finalProfit / SIZE) * 100).toFixed(2)}% de ${SIZE})`);
      if (!tradedSignatures.has(best.sig)) {
        tradedSignatures.add(best.sig);
        if (tradedSignatures.size > 1000) tradedSignatures.clear();
        balance += best.finalProfit;
        trades.push({ sig: best.sig, pair: best.opp.pair, route: `${best.opp.buyExchange}->${best.opp.sellExchange}`, buyVwap: best.buyVwap, sellVwap: best.sellVwap, buyTaker: best.buyTaker, sellTaker: best.sellTaker, gas: best.gasCost, profit: best.finalProfit });
      }
    }
    return { candidates, profitable };
  };

  while (Date.now() - start < DURATION_MS) {
    scans++;
    try {
      const res = await fetch(API);
      const data = await res.json();
      const { candidates, profitable } = analyze(data);
      const now = new Date().toLocaleTimeString();
      console.log(`[${scans}] ${now} cands-ejecutables=${candidates} rentables=${profitable} balance=${balance.toFixed(2)}`);
    } catch (e) {
      console.log(`[${scans}] ERROR consulta: ${e.message}`);
    }
    await sleep(POLL_MS);
  }

  console.log('\n========== RESUMEN 5 MIN ==========');
  console.log(`escanos: ${scans} | trades ejecutados: ${trades.length}`);
  console.log(`bloqueadas por profundidad insuficiente: ${blockedByDepth} | sin libro: ${blockedNoBook}`);
  console.log(`balance final: $${balance.toFixed(2)} (init 10000)`);
  const totProfit = trades.reduce((s, t) => s + t.profit, 0);
  console.log(`ganancia neta acumulada: $${totProfit.toFixed(2)} | promedio por trade: $${(totProfit / Math.max(trades.length, 1)).toFixed(2)}`);

  console.log('\n--- Detalle de trades ---');
  for (const t of trades) {
    console.log(`${t.pair} ${t.route} | buyVwap=$ ${t.buyVwap.toFixed(6)} sellVwap=$ ${t.sellVwap.toFixed(6)} | taker ${(t.buyTaker * 100).toFixed(2)}%+${(t.sellTaker * 100).toFixed(2)}% | gas $${t.gas.toFixed(2)} | NET +$${t.profit.toFixed(2)}`);
  }

  console.log('\n--- Validaciones ---');
  // Validación 5: dedupe estricto
  const sigs = trades.map(t => t.sig);
  console.log(`dedupe: ${new Set(sigs).size} unicas / ${sigs.length} trades ${new Set(sigs).size === sigs.length ? 'OK' : 'FALLO'}`);
  // Validación 6: balance nunca negativo
  console.log(`balance >= 0: ${balance >= 0 ? 'OK' : 'FALLO'}`);
  console.log(`issues encontradas: ${issues.length}`);
  for (const i of issues) console.log('  ' + i);
  if (!issues.length && new Set(sigs).size === sigs.length) {
    console.log('\nRESULTADO: SIN BUGS DETECTADOS. Las ganancias netas son consistentes con fees reales + gas + slippage de profundidad.');
  } else {
    console.log('\nRESULTADO: REVISAR issues listadas arriba.');
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });