import { Zap, Radar, LineChart, Bot } from 'lucide-react';

export default function KpiCards({ opportunities, demoBalance, botActive, setBotActive }) {
  const bestOpp = opportunities.length > 0 ? opportunities[0] : null;

  return (
    <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div className="bg-dark-900 border border-slate-800/90 rounded-2xl p-4 relative overflow-hidden group hover:border-emerald-500/40 transition">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Mayor Spread Bruto</span>
          <span className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-xs">
            <Zap className="w-4 h-4" />
          </span>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-2xl font-black font-mono text-emerald-400">
            {bestOpp ? `+${bestOpp.grossSpreadPct.toFixed(2)}%` : '0.00%'}
          </span>
          <span className="text-xs text-slate-400 font-mono">{bestOpp?.pair || '-'}</span>
        </div>
        <p className="text-xs text-slate-500 mt-1 truncate">
          {bestOpp ? `${bestOpp.buyExchange} ➔ ${bestOpp.sellExchange}` : 'Buscando...'}
        </p>
      </div>

      <div className="bg-dark-900 border border-slate-800/90 rounded-2xl p-4 relative overflow-hidden group hover:border-cyan-500/40 transition">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Oportunidades</span>
          <span className="w-8 h-8 rounded-lg bg-cyan-500/10 text-cyan-400 flex items-center justify-center text-xs">
            <Radar className="w-4 h-4" />
          </span>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-2xl font-black font-mono text-white">{opportunities.length}</span>
          <span className="text-xs text-cyan-400 font-medium">identificadas</span>
        </div>
        <p className="text-xs text-slate-500 mt-1">Escaneando tiempo real</p>
      </div>

      <div className="bg-dark-900 border border-slate-800/90 rounded-2xl p-4 relative overflow-hidden group hover:border-violet-500/40 transition">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold tracking-wider text-slate-400 uppercase">PnL Paper Trading</span>
          <span className="w-8 h-8 rounded-lg bg-violet-500/10 text-violet-400 flex items-center justify-center text-xs">
            <LineChart className="w-4 h-4" />
          </span>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-2xl font-black font-mono text-emerald-400">
            +${(demoBalance - 10000).toFixed(2)}
          </span>
        </div>
        <p className="text-xs text-slate-500 mt-1">Capital inicial: $10,000</p>
      </div>

      <div className="bg-dark-900 border border-slate-800/90 rounded-2xl p-4 relative overflow-hidden group hover:border-amber-500/40 transition">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold tracking-wider text-slate-400 uppercase">Bot Auto-Arbitraje</span>
          <span className="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center text-xs">
            <Bot className="w-4 h-4" />
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <div>
            <span className={`text-sm font-black font-mono ${botActive ? 'text-emerald-400' : 'text-slate-400'}`}>
              {botActive ? 'ACTIVO' : 'DETENIDO'}
            </span>
          </div>
          <button 
            onClick={() => setBotActive(!botActive)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase transition ${
              botActive 
                ? 'bg-rose-500/20 hover:bg-rose-500 text-rose-300 hover:text-dark-950 border border-rose-500/30' 
                : 'bg-slate-800 hover:bg-emerald-600 text-slate-200 hover:text-white border border-slate-700'
            }`}>
            {botActive ? 'Detener' : 'Iniciar'}
          </button>
        </div>
      </div>
    </section>
  );
}
