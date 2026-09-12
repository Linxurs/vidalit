import { useRef, useState, useEffect } from 'react';
import { RefreshCw, Globe, Shapes, Calculator, History } from 'lucide-react';
import Header from './components/Header';
import KpiCards from './components/KpiCards';
import SpatialArbitrage from './components/SpatialArbitrage';
import TriangularArbitrage from './components/TriangularArbitrage';
import ProfitCalculator from './components/Calculator';
import PaperBot from './components/PaperBot';
import { estimateExecution } from './utils/slippage';

function App() {
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
  const [botDelayMin, setBotDelayMin] = useState(3);
  const [botSurvivalPct, setBotSurvivalPct] = useState(0.3);
  const [withdrawalFees, setWithdrawalFees] = useState({});
  const [tradeHistory, setTradeHistory] = useState([]);
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
  const survivalRef = useRef(null); // { pair, buyEx, sellEx, detectedAt } señal a re-verificar tras el delay

  useEffect(() => {
    if (!botActive || opportunities.length === 0) return;

    // Evalúa UNA oportunidad con la misma matemática que el bot (slippage real
    // por profundidad, taker en ambas patas, gas real del exchange de compra).
    // Devuelve {sig, buyVwap, sellVwap, net} o null si no es ejecutable.
    const evalOpp = (opp) => {
      const buyBook = books[opp.buyExchange]?.[opp.buySymbol];
      const sellBook = books[opp.sellExchange]?.[opp.sellSymbol];
      const exec = estimateExecution({ asks: buyBook?.asks, bids: sellBook?.bids }, botTradeSize);
      if (!exec || !exec.executable) return null;
      const buyTaker = fees[opp.buyExchange]?.[opp.pair]?.taker ?? 0.001;
      const sellTaker = fees[opp.sellExchange]?.[opp.pair]?.taker ?? 0.001;
      const qtyAfterBuy = exec.vwap > 0 ? (botTradeSize / exec.vwap) * (1 - buyTaker) : 0;
      const proceeds = qtyAfterBuy * exec.sell.vwap;
      const gasCost = botGasCost > 0 ? botGasCost : (withdrawalFees[opp.buyExchange]?.usdt ?? 1.5);
      const net = proceeds - proceeds * sellTaker - gasCost - botTradeSize;
      return {
        sig: `${opp.pair}|${opp.buyExchange}|${opp.sellExchange}|${opp.buyPrice.toFixed(8)}|${opp.sellPrice.toFixed(8)}`,
        pair: opp.pair,
        buyEx: opp.buyExchange,
        sellEx: opp.sellExchange,
        buyVwap: exec.vwap,
        sellVwap: exec.sell.vwap,
        net
      };
    };

    const transferMs = botDelayMin * 60000;

    // Fase 1 — MÉTRICA DE SUPERVIVENCIA: cuando una señal tiene la edad del delay,
    // re-evaluamos la MISMA ruta con el libro ACTUAL para ver si el edge sobrevivió
    // el lapso real de retiro (esto mide el riesgo de timing que el modelo aproxima).
    if (survivalRef.current && Date.now() - survivalRef.current.detectedAt >= transferMs) {
      const pend = survivalRef.current;
      let survived = false;
      for (const opp of opportunities) {
        if (opp.pair !== pend.pair || opp.buyExchange !== pend.buyEx || opp.sellExchange !== pend.sellEx) continue;
        const r = evalOpp(opp);
        if (r && r.net > 0) { survived = true; break; }
      }
      setSurvivalStats(s => ({ checked: s.checked + 1, survived: s.survived + (survived ? 1 : 0) }));
      survivalRef.current = null;
    }

    // Fase 2 — El bot exige un COLCHÓN de supervivencia: la ganancia neta debe
    // superar por el margen (default 0.3%) el monto, para que una ruta recién sea
    // ejecutable si tras el delay el precio de venta cayera hasta ese %.
    const colchonUsd = botTradeSize * (botSurvivalPct / 100);
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

    tradedSignaturesRef.current.add(best.sig);
    if (tradedSignaturesRef.current.size > 1000) tradedSignaturesRef.current.clear();

    setDemoBalance(b => b + best.net);
    setTradeHistory(prev => [{
      id: `${best.pair}-${best.buyEx}-${best.sellEx}-${Date.now()}`,
      time: new Date().toLocaleTimeString(),
      pair: best.pair,
      route: `${best.buyEx} ➔ ${best.sellEx}`,
      amount: botTradeSize,
      execBuy: best.buyVwap,
      execSell: best.sellVwap,
      profit: best.net
    }, ...prev].slice(0, 50)); // Keep last 50 trades

    // Registrar la señal para medir si el premium sobrevive el delay real
    survivalRef.current = { pair: best.pair, buyEx: best.buyEx, sellEx: best.sellEx, detectedAt: Date.now() };
  }, [opportunities, botActive, botTradeSize, botGasCost, botDelayMin, botSurvivalPct, withdrawalFees, fees, books]);

  const resetPaperAccount = () => {
    tradedSignaturesRef.current = new Set();
    survivalRef.current = null;
    setSurvivalStats({ checked: 0, survived: 0 });
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
        {activeTab === 'calculator' && <ProfitCalculator fees={fees} activeOpportunity={activeOpportunity} withdrawalFees={withdrawalFees} books={books} />}
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
            onReset={resetPaperAccount}
            withdrawalFees={withdrawalFees}
          />
        )}

      </main>
    </div>
  );
}

export default App;
