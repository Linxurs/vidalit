import { useState, useEffect } from 'react';
import { RefreshCw, Globe, Shapes, Calculator, History } from 'lucide-react';
import Header from './components/Header';
import KpiCards from './components/KpiCards';
import SpatialArbitrage from './components/SpatialArbitrage';
import TriangularArbitrage from './components/TriangularArbitrage';
import ProfitCalculator from './components/Calculator';
import PaperBot from './components/PaperBot';

function App() {
  const [activeTab, setActiveTab] = useState('spatial');
  const [opportunities, setOpportunities] = useState([]);
  const [triangularOpps, setTriangularOpps] = useState([]);
  const [prices, setPrices] = useState({});
  const [fees, setFees] = useState({});
  const [books, setBooks] = useState({});
  const [activeOpportunity, setActiveOpportunity] = useState(null);
  const [assetFilter, setAssetFilter] = useState('ALL');
  const [withdrawalFees, setWithdrawalFees] = useState({});
const [transferFees, setTransferFees] = useState({});
  const [exchangeInfo, setExchangeInfo] = useState({ total: 9, active: 0 });
  const [usdtUsd, setUsdtUsd] = useState(1);
  const [bot, setBot] = useState({ active: false, balance: 10000, tradeSize: 1500, gasCost: 0, delayMin: 3, survivalPct: 0.3, sellMode: 'maker', history: [], stats: { checked: 0, survived: 0 } });

  const API = 'http://localhost:3001';

  const syncBot = async () => {
    try {
      const r = await fetch(`${API}/api/paper-bot`);
      if (r.ok) setBot(await r.json());
    } catch (err) { /* keep last known state */ }
  };

  const botControl = async (action) => {
    try { await fetch(`${API}/api/paper-bot/${action}`, { method: 'POST' }); } catch (err) {}
    syncBot();
  };

  const botConfig = async (patch) => {
    try {
      await fetch(`${API}/api/paper-bot/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
    } catch (err) {}
    setBot(b => ({ ...b, ...patch }));
    syncBot();
  };

  // Modo de venta (salida): 'maker' post-only al top del libro si absorbe el lote (si no, taker) | 'taker' market.
  const sellMode = bot.sellMode || 'maker';
  const setSellMode = (v) => botConfig({ sellMode: v });

  const fetchOpportunities = async () => {
    try {
      const res = await fetch(`${API}/api/opportunities`);
      const data = await res.json();
      setOpportunities(data.opportunities || []);
      setTriangularOpps(data.triangular || []);
      setPrices(data.prices || {});
      if (data.fees) setFees(data.fees);
      if (data.withdrawalFees) setWithdrawalFees(data.withdrawalFees);
      if (data.transferFees) setTransferFees(data.transferFees);
      if (data.books) setBooks(data.books);
      if (data.exchanges) setExchangeInfo(data.exchanges);
      if (typeof data.usdtUsd === 'number') setUsdtUsd(data.usdtUsd);
    } catch (err) {
      console.error('Error fetching opportunities:', err);
    }
    syncBot();
  };

  useEffect(() => {
    fetchOpportunities();
    const interval = setInterval(fetchOpportunities, 10000); // 10 seconds to match backend
    return () => clearInterval(interval);
  }, []);

  // Al volver a la pestaña (aunque el navegador la congeló en background),
  // refrescar al instante para mostrar el estado real del bot (motor en backend).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchOpportunities();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const resetPaperAccount = () => {
    botControl('reset');
  };

  return (
    <div className="bg-dark-950 text-slate-100 min-h-screen font-sans flex flex-col antialiased selection:bg-emerald-500/20 selection:text-emerald-400">
      <Header demoBalance={bot.balance} exchanges={exchangeInfo} usdtUsd={usdtUsd} />

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 lg:p-6 space-y-6">
        <KpiCards 
          opportunities={opportunities} 
          demoBalance={bot.balance} 
          botActive={bot.active} 
          botLastTick={bot.lastTick}
          setBotActive={() => botControl(bot.active ? 'stop' : 'start')} 
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
            tradeHistory={bot.history}
            botActive={bot.active}
            setBotActive={() => botControl(bot.active ? 'stop' : 'start')}
            botTradeSize={bot.tradeSize}
            setBotTradeSize={v => botConfig({ tradeSize: Number(v) })}
            botGasCost={bot.gasCost}
            setBotGasCost={v => botConfig({ gasCost: Number(v) })}
            botDelayMin={bot.delayMin}
            setBotDelayMin={v => botConfig({ delayMin: Math.max(1, Number(v)) })}
            botSurvivalPct={bot.survivalPct}
            setBotSurvivalPct={v => botConfig({ survivalPct: Math.max(0, Number(v)) })}
            survivalStats={bot.stats}
            pendingTrades={bot.pending || []}
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