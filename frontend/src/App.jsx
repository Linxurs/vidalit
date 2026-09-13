import { useRef, useState, useEffect } from 'react';
import { RefreshCw, Globe, Shapes, Calculator, History } from 'lucide-react';
import Header from './components/Header';
import KpiCards from './components/KpiCards';
import SpatialArbitrage from './components/SpatialArbitrage';
import TriangularArbitrage from './components/TriangularArbitrage';
import ProfitCalculator from './components/Calculator';
import PaperBot from './components/PaperBot';
import { estimateExecution, estimateSell, estimateMakerSell } from './utils/slippage';

function App() {
  const INITIAL_BALANCE = 10000;
  const [activeTab, setActiveTab] = useState('spatial');
  const [opportunities, setOpportunities] = useState([]);
  const [triangularOpps, setTriangularOpps] = useState([]);
  const [prices, setPrices] = useState({});
  const [fees, setFees] = useState({});
  const [books, setBooks] = useState({});
  const [activeOpportunity, setActiveOpportunity] = useState(null);
  const [demoBalance, setDemoBalance] = useState(10000);
  const [assetFilter, setAssetFilter] = useState('ALL');
  const [botActive, setBotActive] = useState(false);
  const [botTradeSize, setBotTradeSize] = useState(1500);
  const [botGasCost, setBotGasCost] = useState(0);
  const [botDelayMin, setBotDelayMin] = useState(10);
  const [botSurvivalPct, setBotSurvivalPct] = useState(0.3);
  const [sellMode, setSellMode] = useState('maker');
  const [withdrawalFees, setWithdrawalFees] = useState({});
  const [transferFees, setTransferFees] = useState({});
  const [tradeHistory, setTradeHistory] = useState([]);
  const [pendingTrades, setPendingTrades] = useState([]);
  const [survivalStats, setSurvivalStats] = useState({ checked: 0, survived: 0 });

  const fetchOpportunities = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/opportunities');
      const data = await res.json();
      setOpportunities(data.opportunities || []);
      setTriangularOpps(data.triangular || []);
      setPrices(data.prices || {});
      if (data.fees) setFees(data.fees);
      if (data.withdrawalFees) setWithdrawalFees(data.withdrawalFees);
      if (data.transferFees) setTransferFees(data.transferFees);
      if (data.books) setBooks(data.books);
    } catch (err) {
      console.error('Error fetching opportunities:', err);
    }
  };

  useEffect(() => {
    fetchOpportunities();
    const interval = setInterval(fetchOpportunities, 10000); // 10 seconds to match backend
    return () => clearInterval(interval);
  }, []);

  const tradedSignaturesRef = useRef(new Set());

  useEffect(() => {
    if (!botActive) return;

    const transferMs = botDelayMin * 60000;
    const colchonUsd = botTradeSize * (botSurvivalPct / 100);
    // Costo por trade = fee de retiro DEL ACTIVO (cobrado en el activo, a precio live),
    // no el fee USDT (que solo aplica al refill de capital entre exchanges).
    const gasCostOf = (ex, pair) => {
      if (botGasCost > 0) return botGasCost;
      const asset = pair?.split('/')[0];
      const feeUsd = asset && transferFees[asset]?.[ex]?.feeUsd;
      return (feeUsd != null && feeUsd > 0) ? feeUsd : (withdrawalFees[ex]?.usdt ?? 1.5);
    };

    // FASE B — SALIDAS PENDIENTES: la compra ya ocurrió (el capital ya se descontó).
    // Tras el delay que dura el retiro on-chain, vendemos contra el libro ACTUAL
    // (precio real de salida + riesgo de timing) y recién ahí se acredita el líquido.
    // Venta REAL, sin heurísticas inventadas: si el MEJOR NIVEL del libro absorbe el
    // lote completo → orden post-only (maker, fee maker, llenado a P0). Si no, se
    // cruza como market (taker, fee taker) y el resto —lo que el libro no cubrió—
    // queda como orden post-only al mejor bid (se llena a P0 cuando ese nivel se
    // consume; NO hay "castigo 0.5%" inventado).
    if (pendingTrades.length > 0) {
      const exited = [];
      const stillPending = [];
      for (const pt of pendingTrades) {
        const pendingMs = (Date.now() - pt.boughtAt) / 1000;
        if (pendingMs * 1000 < transferMs) { stillPending.push(pt); continue; }

        const sellBook = books[pt.sellEx]?.[pt.sellSymbol];

        if (sellBook && sellBook.bids?.[0]) {
          const bestBid = sellBook.bids[0][0];
          const takerFee = fees[pt.sellEx]?.[pt.pair]?.taker ?? 0.001;
          const makerFee = fees[pt.sellEx]?.[pt.pair]?.maker ?? takerFee;

          let proceeds = 0;
          let feeUsed = takerFee;
          let soldPct = 100;
          let mode;
          let execSell;

          const makerExit = sellMode === 'maker' ? estimateMakerSell(sellBook.bids, pt.qty) : null;
          if (makerExit?.fillable) {
            proceeds = makerExit.proceeds;
            feeUsed = makerFee;
            mode = 'maker';
            execSell = bestBid;
          } else {
            const sell = estimateSell(sellBook.bids, pt.qty);
            const crossedQty = sell.filledQty;
            const remainderQty = pt.qty - crossedQty;
            proceeds = sell.proceeds + remainderQty * bestBid;
            if (crossedQty >= pt.qty * 0.9999) {
              feeUsed = takerFee;
              mode = 'taker';
              soldPct = 100;
            } else {
              // Fee por porción: lo cruzado paga taker; la cola queda post-only (maker)
              feeUsed = (sell.proceeds * takerFee + remainderQty * bestBid * makerFee) / proceeds;
              mode = 'mix';
              soldPct = Math.max(1, Math.round((crossedQty / pt.qty) * 100));
            }
            execSell = proceeds / pt.qty;
          }

          const realized = proceeds * (1 - feeUsed) - gasCostOf(pt.buyEx, pt.pair);
          const net = realized - pt.size;
          setDemoBalance(b => b + realized);
          setSurvivalStats(s => ({ checked: s.checked + 1, survived: s.survived + (net > 0 ? 1 : 0) }));
          exited.push({ id: pt.id, pair: pt.pair, route: `${pt.buyEx} ➔ ${pt.sellEx}`, amount: pt.size, execBuy: pt.buyVwap, execSell, profit: net, soldPct, mode, pendingMs: Math.round(pendingMs) });
        } else {
          // Sin libro vendible (el top del exchange de venta no tiene compradores o el
          // libro no está disponible): la posición queda retenida y se reintenta en el
          // siguiente scan. No hay precio confiable para "liquidar" → no se inventa
          // una salida forzada a precio arbitrario.
          stillPending.push(pt);
        }
      }

      if (exited.length) {
        setTradeHistory(prev => [...exited.map(e => ({
          id: e.id,
          time: new Date().toLocaleTimeString(),
          pair: e.pair,
          route: e.route,
          amount: e.amount,
          execBuy: e.execBuy,
          execSell: e.execSell,
          profit: e.profit,
          soldPct: e.soldPct,
          mode: e.mode,
          pendingSecs: e.pendingMs
        })), ...prev].slice(0, 50));
      }
      setPendingTrades(stillPending);
    }

    if (opportunities.length === 0) return;

    // Evalúa UNA oportunidad con la misma matemática que el bot (slippage real
    // por profundidad, taker en ambas patas, gas real del exchange de compra).
    const evalOpp = (opp) => {
      const buyBook = books[opp.buyExchange]?.[opp.buySymbol];
      const sellBook = books[opp.sellExchange]?.[opp.sellSymbol];
      const exec = estimateExecution({ asks: buyBook?.asks, bids: sellBook?.bids }, botTradeSize);
      if (!exec || !exec.executable) return null;
      const buyTaker = fees[opp.buyExchange]?.[opp.pair]?.taker ?? 0.001;
      const sellTaker = fees[opp.sellExchange]?.[opp.pair]?.taker ?? 0.001;
      const qtyAfterBuy = exec.vwap > 0 ? (botTradeSize / exec.vwap) * (1 - buyTaker) : 0;
      const proceeds = qtyAfterBuy * exec.sell.vwap;
      const gasCost = gasCostOf(opp.buyExchange, opp.pair);
      const net = proceeds - proceeds * sellTaker - gasCost - botTradeSize;
      return {
        sig: `${opp.pair}|${opp.buyExchange}|${opp.sellExchange}|${opp.buyPrice.toFixed(8)}|${opp.sellPrice.toFixed(8)}`,
        pair: opp.pair,
        buyEx: opp.buyExchange,
        sellEx: opp.sellExchange,
        buySymbol: opp.buySymbol,
        sellSymbol: opp.sellSymbol,
        buyVwap: exec.vwap,
        sellVwap: exec.sell.vwap,
        net
      };
    };

    // FASE A — ENTRADAS: el bot solo compra si la ganancia neta supera el COLCHÓN
    // de supervivencia (margen que absorbe una caída del precio durante el retiro).
    let best = null;
    for (const opp of opportunities) {
      const sig = `${opp.pair}|${opp.buyExchange}|${opp.sellExchange}|${opp.buyPrice.toFixed(8)}|${opp.sellPrice.toFixed(8)}`;
      if (tradedSignaturesRef.current.has(sig)) continue;
      const r = evalOpp(opp);
      if (!r) continue;
      if (r.net > colchonUsd && (!best || r.net > best.net)) {
        best = { ...r, net: r.net };
      }
    }

    if (!best) return;

    // Chequeo de liquidez real: para comprar hace falta USDT disponible AHORA en el
    // exchange de compra. Si el capital ya está comprometido en retiros en curso
    // (o el pool se sobregiró), la orden de compra fallaría por fondos insuficientes.
    const committed = pendingTrades.reduce((s, p) => s + p.size, 0);
    if (committed + botTradeSize > INITIAL_BALANCE) return;

    tradedSignaturesRef.current.add(best.sig);
    if (tradedSignaturesRef.current.size > 1000) tradedSignaturesRef.current.clear();

    const buyTaker = fees[best.buyEx]?.[best.pair]?.taker ?? 0.001;
    const qtyAfterBuy = best.buyVwap > 0 ? (botTradeSize / best.buyVwap) * (1 - buyTaker) : 0;

    // La compra ocurre AHORA: se descuenta el capital y queda un retiro en curso.
    // La venta (Fase B) ocurrirá recién tras `botDelayMin` contra el libro real,
    // así el balance refleja el PnL REALIZADO (no el del snapshot).
    setDemoBalance(b => b - botTradeSize);
    setPendingTrades(prev => [...prev, {
      id: `${best.pair}-${best.buyEx}-${best.sellEx}-${Date.now()}`,
      pair: best.pair,
      buyEx: best.buyEx,
      sellEx: best.sellEx,
      buySymbol: best.buySymbol,
      sellSymbol: best.sellSymbol,
      buyVwap: best.buyVwap,
      qty: qtyAfterBuy,
      size: botTradeSize,
      boughtAt: Date.now()
    }]);
  }, [opportunities, botActive, botTradeSize, botGasCost, botDelayMin, botSurvivalPct, sellMode, withdrawalFees, transferFees, fees, books, pendingTrades]);

  const resetPaperAccount = () => {
    tradedSignaturesRef.current = new Set();
    setSurvivalStats({ checked: 0, survived: 0 });
    setPendingTrades([]);
    setTradeHistory([]);
    setDemoBalance(10000);
  };

  return (
    <div className="bg-dark-950 text-slate-100 min-h-screen font-sans flex flex-col antialiased selection:bg-emerald-500/20 selection:text-emerald-400">
      <Header demoBalance={demoBalance} />

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 lg:p-6 space-y-6">
        <KpiCards 
          opportunities={opportunities} 
          demoBalance={demoBalance} 
          botActive={botActive} 
          setBotActive={setBotActive} 
        />

        {/* Tab Controls & Filters */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-1 bg-dark-900 p-1 rounded-xl border border-slate-800 text-xs font-medium w-full sm:w-auto overflow-x-auto scrollbar-thin">
            <button 
              onClick={() => setActiveTab('spatial')}
              className={`px-4 py-2 rounded-lg transition flex items-center gap-2 ${activeTab === 'spatial' ? 'bg-emerald-500 text-dark-950 font-bold shadow-md shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <Globe className="w-4 h-4" /> Arbitraje Espacial
            </button>
            <button 
              onClick={() => setActiveTab('triangular')}
              className={`px-4 py-2 rounded-lg transition flex items-center gap-2 ${activeTab === 'triangular' ? 'bg-emerald-500 text-dark-950 font-bold shadow-md shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <Shapes className="w-4 h-4" /> Arbitraje Triangular
            </button>
            <button 
              onClick={() => setActiveTab('calculator')}
              className={`px-4 py-2 rounded-lg transition flex items-center gap-2 ${activeTab === 'calculator' ? 'bg-emerald-500 text-dark-950 font-bold shadow-md shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <Calculator className="w-4 h-4" /> Calculadora & Slippage
            </button>
            <button 
              onClick={() => setActiveTab('history')}
              className={`px-4 py-2 rounded-lg transition flex items-center gap-2 ${activeTab === 'history' ? 'bg-emerald-500 text-dark-950 font-bold shadow-md shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}>
              <History className="w-4 h-4" /> Historial / Paper Bot
            </button>
          </div>

          <div className="flex items-center gap-3 self-end sm:self-auto text-xs">
            <button onClick={fetchOpportunities} className="flex items-center gap-1.5 bg-dark-900 border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-white px-3 py-1.5 rounded-lg transition active:scale-95">
              <RefreshCw className="w-3.5 h-3.5" />
              <span className="hidden md:inline">Actualizar</span>
            </button>
          </div>
        </div>

        {/* Tab Views */}
        {activeTab === 'spatial' && (
          <SpatialArbitrage 
            opportunities={opportunities} 
            minSpread={0} 
            assetFilter={assetFilter} 
            setAssetFilter={setAssetFilter}
            setActiveTab={setActiveTab}
            setActiveOpportunity={setActiveOpportunity}
          />
        )}
        {activeTab === 'triangular' && <TriangularArbitrage triangularOpps={triangularOpps} fees={fees} />}
        {activeTab === 'calculator' && <ProfitCalculator fees={fees} activeOpportunity={activeOpportunity} withdrawalFees={withdrawalFees} transferFees={transferFees} sellMode={sellMode} books={books} />}
        {activeTab === 'history' && (
          <PaperBot 
            tradeHistory={tradeHistory}
            botActive={botActive}
            setBotActive={setBotActive}
            botTradeSize={botTradeSize}
            setBotTradeSize={setBotTradeSize}
            botGasCost={botGasCost}
            setBotGasCost={setBotGasCost}
            botDelayMin={botDelayMin}
            setBotDelayMin={setBotDelayMin}
            botSurvivalPct={botSurvivalPct}
            setBotSurvivalPct={setBotSurvivalPct}
            survivalStats={survivalStats}
            pendingTrades={pendingTrades}
            sellMode={sellMode}
            setSellMode={setSellMode}
            onReset={resetPaperAccount}
            withdrawalFees={withdrawalFees}
          />
        )}

      </main>
    </div>
  );
}

export default App;
