import { Triangle, ArrowRight, Activity, Percent } from 'lucide-react';

export default function TriangularArbitrage({ triangularOpps = [], fees = {} }) {
  // We'll show the top 10 triangular opportunities
  const opps = triangularOpps.slice(0, 10);

  return (
    <div className="bg-dark-900 border border-slate-800 rounded-2xl p-6 animate-in fade-in">
      <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center">
            <Triangle className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Arbitraje Triangular</h2>
            <p className="text-xs text-slate-400">Rutas Intra-Exchange (ej. USDT ➔ BTC ➔ ETH ➔ USDT)</p>
          </div>
        </div>
      </div>

      {opps.length === 0 ? (
        <div className="text-center py-12 text-slate-500 flex flex-col items-center">
          <Activity className="w-12 h-12 text-slate-700 mb-4 animate-pulse" />
          <p>Escaneando libros de órdenes cruzados en tiempo real...</p>
          <p className="text-xs mt-2">Buscando rutas rentables dentro del mismo exchange.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {opps.map((opp, idx) => {
            const { step1, step2, step3 } = opp.steps;
            
            // Calculate fees for this exchange
            const exFees = fees[opp.exchange] || {};
            const feeTaker = Object.values(exFees)[0]?.taker || 0.001;
            const totalFeeEstimate = (feeTaker * 3 * 100); // rough estimate: 3 taker trades
            
            const netSpread = opp.grossSpreadPct - totalFeeEstimate;
            
            return (
              <div key={idx} className="bg-dark-950 border border-slate-800 rounded-xl p-5 hover:border-indigo-500/50 transition-colors">
                <div className="flex flex-col md:flex-row justify-between md:items-center gap-4 mb-4">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-1 rounded bg-slate-800 text-slate-300 font-bold text-xs uppercase">
                      {opp.exchange}
                    </span>
                    <span className="text-sm font-mono text-slate-400 flex items-center gap-1">
                      USDT <ArrowRight className="w-3 h-3 text-slate-600" /> 
                      BTC <ArrowRight className="w-3 h-3 text-slate-600" /> 
                      {opp.route.split('➔')[2].trim()} <ArrowRight className="w-3 h-3 text-slate-600" /> 
                      USDT
                    </span>
                  </div>
                  <div className="text-right">
                    <div className={`font-bold font-mono text-lg ${netSpread > 0 ? 'text-emerald-400' : 'text-slate-400'}`}>
                      {netSpread > 0 ? '+' : ''}{netSpread.toFixed(4)}% Neto
                    </div>
                    <div className="text-xs text-slate-500 flex items-center gap-1 justify-end">
                      <Percent className="w-3 h-3" />
                      Bruto: {opp.grossSpreadPct.toFixed(4)}% | Fees (3x): -{totalFeeEstimate.toFixed(2)}%
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Step 1 */}
                  <div className="bg-dark-900 border border-slate-800 rounded-lg p-3 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-8 h-8 bg-indigo-500/10 rounded-bl-full"></div>
                    <div className="text-xs text-slate-500 mb-1">Paso 1: {step1.pair}</div>
                    <div className="font-bold text-white flex justify-between items-center">
                      <span className="text-indigo-400 text-sm uppercase">{step1.action}</span>
                      <span className="font-mono text-sm">${step1.price.toLocaleString()}</span>
                    </div>
                  </div>
                  
                  {/* Step 2 */}
                  <div className="bg-dark-900 border border-slate-800 rounded-lg p-3 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-8 h-8 bg-indigo-500/10 rounded-bl-full"></div>
                    <div className="text-xs text-slate-500 mb-1">Paso 2: {step2.pair}</div>
                    <div className="font-bold text-white flex justify-between items-center">
                      <span className="text-indigo-400 text-sm uppercase">{step2.action}</span>
                      <span className="font-mono text-sm">{step2.price.toLocaleString()}</span>
                    </div>
                  </div>
                  
                  {/* Step 3 */}
                  <div className="bg-dark-900 border border-slate-800 rounded-lg p-3 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-8 h-8 bg-indigo-500/10 rounded-bl-full"></div>
                    <div className="text-xs text-slate-500 mb-1">Paso 3: {step3.pair}</div>
                    <div className="font-bold text-white flex justify-between items-center">
                      <span className="text-indigo-400 text-sm uppercase">{step3.action}</span>
                      <span className="font-mono text-sm">${step3.price.toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
