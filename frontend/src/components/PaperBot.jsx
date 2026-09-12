import { Settings, Play, Square, RefreshCcw, ArrowRightLeft } from 'lucide-react';

export default function PaperBot({ 
  tradeHistory, 
  botActive, 
  setBotActive,
  botTradeSize,
  setBotTradeSize,
  botGasCost,
  setBotGasCost,
  botDelayMin,
  setBotDelayMin,
  botSurvivalPct,
  setBotSurvivalPct,
  survivalStats = { checked: 0, survived: 0 },
  onReset,
  withdrawalFees
}) {
  return (
    <div className="space-y-6 animate-in fade-in">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        
        {/* Config Panel */}
        <div className="bg-dark-900 border border-slate-800 rounded-2xl p-5 col-span-1">
          <div className="flex items-center gap-2 mb-4 text-emerald-400 font-bold">
            <Settings className="w-5 h-5" />
            Configuración del Bot
          </div>
          
          <div className="space-y-4 text-sm">
            <div>
              <label className="block text-slate-400 mb-1.5 text-xs">Tamaño de Operación (USDT)</label>
              <input 
                type="number" 
                value={botTradeSize}
                onChange={e => setBotTradeSize(Number(e.target.value))}
                className="w-full bg-dark-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1.5 text-xs">Costo de Retiro On-Chain (Gas en USDT)</label>
              <input 
                type="number" 
                step="0.10"
                value={botGasCost}
                placeholder="Auto: usa el fee real del exchange"
                onChange={e => setBotGasCost(Number(e.target.value))}
                className="w-full bg-dark-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono focus:border-emerald-500 focus:outline-none"
              />
              <p className="text-[10px] text-slate-500 mt-1">
                Dejá 0 para usar el <strong>fee real de retiro</strong> del exchange de compra ({tradeHistory.length > 0 ? 'ver historial' : Object.entries(withdrawalFees).map(([ex, f]) => `${ex}:$${f.usdt.toFixed(2)}`).join(' · ')}). El bot evalúa el mercado en tiempo real. Solo enviará órdenes si el <strong>Beneficio Neto</strong> supera el $0.00 más el <strong>colchón de supervivencia</strong> después de descontar las comisiones Taker reales de ambos exchanges (órdenes de mercado que cruzan el libro), el slippage por profundidad real y este costo de Gas.
              </p>
            </div>
            <div>
              <label className="block text-slate-400 mb-1.5 text-xs">Delay de Retiro (min, riesgo de timing)</label>
              <div className="flex items-center gap-2">
                <input 
                  type="number" 
                  min="1"
                  step="1"
                  value={botDelayMin}
                  onChange={e => setBotDelayMin(Math.max(1, Number(e.target.value)))}
                  className="w-full bg-dark-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <p className="text-[10px] text-slate-500 mt-1">
                Tiempo que el bot asume tarda el retiro on-chain entre exchanges. Cada señal ejecutada se re-verifica tras este lapso para medir si el spread <strong>sobrevivió</strong>.
              </p>
            </div>
            <div>
              <label className="block text-slate-400 mb-1.5 text-xs">Colchón de Supervivencia (% del monto)</label>
              <input 
                type="number" 
                min="0"
                step="0.05"
                value={botSurvivalPct}
                onChange={e => setBotSurvivalPct(Math.max(0, Number(e.target.value)))}
                className="w-full bg-dark-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono focus:border-emerald-500 focus:outline-none"
              />
              <p className="text-[10px] text-slate-500 mt-1">
                El bot solo ejecuta si la ganancia neta supera este margen (~${(botTradeSize * botSurvivalPct / 100).toFixed(2)}). Simula que el precio de venta pueda caer ese % durante el retiro y la operación siga siendo rentable.
              </p>
            </div>
            <div>
              <label className="block text-slate-400 mb-1.5 text-xs">Supervivencia del Spread (métrica empírica)</label>
              <div className="bg-dark-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono flex items-center justify-between">
                <span className="text-slate-400">{survivalStats.checked > 0 ? `${survivalStats.survived}/${survivalStats.checked} duraron ${botDelayMin} min` : 'Aún sin mediciones'}</span>
                <span className={`font-bold ${survivalStats.checked === 0 ? 'text-slate-600' : (survivalStats.survived / survivalStats.checked) >= 0.5 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {survivalStats.checked > 0 ? `${Math.round((survivalStats.survived / survivalStats.checked) * 100)}%` : '—'}
                </span>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-800/80">
              <button 
                onClick={() => setBotActive(!botActive)}
                className={`w-full py-3 rounded-xl font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-all ${
                  botActive 
                  ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20 hover:bg-rose-500/20' 
                  : 'bg-emerald-500 text-dark-950 shadow-lg shadow-emerald-500/20 hover:scale-[1.02]'
                }`}>
                {botActive ? <><Square className="w-4 h-4 fill-current"/> Detener Bot</> : <><Play className="w-4 h-4 fill-current"/> Iniciar Bot</>}
              </button>
            </div>
          </div>
        </div>

        {/* History Panel */}
        <div className="bg-dark-900 border border-slate-800 rounded-2xl p-5 col-span-1 md:col-span-2 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-white font-bold flex items-center gap-2">
              <ArrowRightLeft className="w-5 h-5 text-cyan-400" />
              Historial de Ejecuciones (Paper)
            </h3>
            <button 
              onClick={onReset}
              className="text-xs flex items-center gap-1 text-slate-400 hover:text-white transition bg-dark-850 px-2 py-1 rounded border border-slate-800">
              <RefreshCcw className="w-3 h-3" /> Reiniciar Cuenta
            </button>
          </div>

          <div className="flex-1 overflow-x-auto scrollbar-thin border border-slate-800/60 rounded-xl bg-dark-950/50 min-h-[300px]">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-dark-850 text-slate-400 border-b border-slate-800/60">
                  <th className="py-2.5 px-3">Hora</th>
                  <th className="py-2.5 px-3">Par</th>
                  <th className="py-2.5 px-3">Ruta</th>
                  <th className="py-2.5 px-3 text-right">Monto</th>
                  <th className="py-2.5 px-3 text-right">Ejec. Compra→Venta</th>
                  <th className="py-2.5 px-3 text-right">Beneficio</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/40 font-mono">
                {tradeHistory.length === 0 ? (
                  <tr>
                    <td colSpan="6" className="text-center py-10 text-slate-500 italic">
                      No hay operaciones registradas. {botActive ? 'Esperando oportunidad...' : 'Iniciá el bot para comenzar.'}
                    </td>
                  </tr>
                ) : (
                  tradeHistory.map(trade => (
                    <tr key={trade.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-2 px-3 text-slate-400">{trade.time}</td>
                      <td className="py-2 px-3 font-bold text-white">{trade.pair}</td>
                      <td className="py-2 px-3 text-[10px] text-slate-300">{trade.route}</td>
                      <td className="py-2 px-3 text-right">${trade.amount.toLocaleString()}</td>
                      <td className="py-2 px-3 text-right text-slate-300">
                        {trade.execBuy ? `$${trade.execBuy.toLocaleString(undefined, {maximumFractionDigits:6})} → $${trade.execSell.toLocaleString(undefined, {maximumFractionDigits:6})}` : '-'}
                      </td>
                      <td className={`py-2 px-3 text-right font-bold ${trade.profit > 0 ? 'text-emerald-400' : 'text-rose-500'}`}>
                        {trade.profit > 0 ? '+$' : '-$'}{Math.abs(trade.profit).toFixed(2)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  );
}
