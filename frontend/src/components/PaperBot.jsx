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
  sellMode = 'maker',
  setSellMode,
  survivalStats = { checked: 0, survived: 0 },
  pendingTrades = [],
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
              <label className="block text-slate-400 mb-1.5 text-xs">Costo de Retiro del Activo (USDT, por trade)</label>
              <input 
                type="number" 
                step="0.10"
                value={botGasCost}
                placeholder="Auto: usa el fee real del exchange"
                onChange={e => setBotGasCost(Number(e.target.value))}
                className="w-full bg-dark-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono focus:border-emerald-500 focus:outline-none"
              />
              <p className="text-[10px] text-slate-500 mt-1">
                Dejá 0 para usar el <strong>fee real de retiro del ACTIVO</strong> (FET a precio live, ~$0.17 hoy). Se cobra <em>en el activo</em> y se transfiere por la <strong>red nativa Fetch.ai</strong>, no USDT. El fee de retiro USDT (${Object.entries(withdrawalFees).map(([ex, f]) => `${ex}: $${f.usdt.toFixed(2)}`).join(' · ')} de refill) solo paga al <em>reponer capital</em> entre exchanges, no por trade. El bot evalúa el mercado en tiempo real y solo envía órdenes si el <strong>Beneficio Neto</strong> supera el colchón tras descontar comisiones reales (entrada <strong>Taker</strong> cruzando el libro; salida <strong>Maker</strong> post-only al mejor bid si el top lo absorbe, si no Taker), slippage por profundidad real y este costo.
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
                El bloqueo de la red nativa es rápido, pero lo que domina es el <strong>crédito del depósito en el exchange de venta</strong> (5–10'+ por confirmaciones; más lento la primera vez o con revisión manual). 10 min es el valor medio conservador. Cada operación se <strong>vende tras este lapso contra el libro real</strong>, midiendo si el spread sobrevivió.
              </p>
            </div>
            <div>
              <label className="block text-slate-400 mb-1.5 text-xs">Modo de Venta (salida)</label>
              <select 
                value={sellMode}
                onChange={e => setSellMode(e.target.value)}
                className="w-full bg-dark-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono focus:border-emerald-500 focus:outline-none">
                <option value="maker">Maker (post-only al mejor bid)</option>
                <option value="taker">Taker (market)</option>
              </select>
              <p className="text-[10px] text-slate-500 mt-1">
                <strong>Maker</strong>: si el mejor nivel del libro absorbe el lote, se postea sin cruzar y se paga fee maker (Kraken 0.40%); si no, cae a taker (0.80%). <strong>Taker</strong>: siempre cruza el libro al precio de mercado. El resto no llenado se vende al mejor bid (sin castigos inventados).
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

          {/* Retiros en curso: compra hecha, venta pendiente hasta que el retiro llega */}
          {pendingTrades.length > 0 && (
            <div className="mb-4 border border-cyan-500/20 bg-cyan-500/5 rounded-xl p-3">
              <p className="text-[10px] uppercase tracking-wider text-cyan-300 font-bold mb-2">
                Retiros en curso (compra hecha, vendiendo tras {botDelayMin} min)
              </p>
              <div className="space-y-1.5">
                {pendingTrades.map(pt => {
                  const elapsed = Math.round((Date.now() - pt.boughtAt) / 1000);
                  const total = botDelayMin * 60;
                  return (
                    <div key={pt.id} className="flex items-center justify-between text-xs font-mono text-slate-300">
                      <span>{pt.pair} {pt.route}</span>
                      <span className="text-slate-500">${pt.size.toLocaleString()}</span>
                      <span className="text-cyan-300">{elapsed >= total ? 'Vendiendo…' : `${total - elapsed}s restantes`}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex-1 overflow-x-auto scrollbar-thin border border-slate-800/60 rounded-xl bg-dark-950/50 min-h-[300px]">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-dark-850 text-slate-400 border-b border-slate-800/60">
                  <th className="py-2.5 px-3">Hora</th>
                  <th className="py-2.5 px-3">Par</th>
                  <th className="py-2.5 px-3">Ruta</th>
                  <th className="py-2.5 px-3 text-right">Monto</th>
                  <th className="py-2.5 px-3 text-right">Ejec. Compra→Venta</th>
                  <th className="py-2.5 px-3 text-right">Llenado Venta</th>
                  <th className="py-2.5 px-3 text-right">Beneficio</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/40 font-mono">
                {tradeHistory.length === 0 ? (
                  <tr>
                    <td colSpan="7" className="text-center py-10 text-slate-500 italic">
                      No hay operaciones cerradas. {botActive ? 'Esperando oportunidad…' : 'Iniciá el bot para comenzar.'}
                    </td>
                  </tr>
                ) : (
                  tradeHistory.map(trade => (
                    <tr key={trade.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-2 px-3 text-slate-400">{trade.time}</td>
                      <td className="py-2 px-3 font-bold text-white">{trade.pair}</td>
                      <td className="py-2 px-3 text-[10px] text-slate-300">{trade.route}{trade.mode ? <span className="text-slate-500"> · {trade.mode.toUpperCase()}</span> : ''}</td>
                      <td className="py-2 px-3 text-right">${trade.amount.toLocaleString()}</td>
                      <td className="py-2 px-3 text-right text-slate-300">
                        {trade.execBuy ? `$${trade.execBuy.toLocaleString(undefined, {maximumFractionDigits:6})} → $${trade.execSell.toLocaleString(undefined, {maximumFractionDigits:6})}` : '-'}
                      </td>
                      <td className={`py-2 px-3 text-right ${trade.soldPct >= 100 ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {trade.soldPct ?? 100}%
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
