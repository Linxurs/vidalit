import { Info, Loader } from 'lucide-react';

export default function SpatialArbitrage({ opportunities, minSpread, assetFilter, setAssetFilter, setActiveTab, setActiveOpportunity }) {
  const filteredOpps = opportunities.filter(o => 
    o.grossSpreadPct >= minSpread && 
    (assetFilter === 'ALL' || o.asset === assetFilter)
  );

  return (
    <div className="space-y-4 animate-in fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2 text-slate-400">
          <Info className="w-4 h-4 text-emerald-400" />
          <span>Compara libros de órdenes entre los 9 exchanges (Binance, Coinbase, Kraken, Bybit, OKX, MEXC, Gate, KuCoin y Bitget) en tiempo real.</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500">Filtrar Cripto:</span>
          <div className="flex gap-1">
            {['ALL', 'BTC', 'ETH', 'SOL', 'XRP', 'AVAX'].map(asset => (
              <button 
                key={asset}
                onClick={() => setAssetFilter(asset)}
                className={`px-2.5 py-1 rounded font-mono ${assetFilter === asset ? 'bg-slate-800 text-emerald-400 font-bold border border-emerald-500/30' : 'bg-dark-900 text-slate-400 hover:text-white border border-slate-800'}`}>
                {asset}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-dark-900 border border-slate-800/80 rounded-2xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-dark-850/90 text-slate-400 border-b border-slate-800 text-[11px] uppercase tracking-wider font-semibold">
                <th className="py-3.5 px-4">Par</th>
                <th className="py-3.5 px-4">Comprar en (Ask)</th>
                <th className="py-3.5 px-4">Vender en (Bid)</th>
                <th className="py-3.5 px-4">Spread Bruto</th>
                <th className="py-3.5 px-4 text-right">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {filteredOpps.length === 0 ? (
                <tr>
                  <td colSpan="5" className="text-center py-12 text-slate-500">
                    <Loader className="w-6 h-6 animate-spin mx-auto text-emerald-400 mb-2" />
                    <p>Buscando oportunidades &gt; {minSpread}%...</p>
                  </td>
                </tr>
              ) : (
                filteredOpps.map(opp => (
                  <tr key={opp.id} className="hover:bg-slate-800/40 transition group">
                    <td className="py-3 px-4 font-bold text-white flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
                      {opp.pair}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-1.5">
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold border bg-slate-800 border-slate-700 capitalize text-slate-300">
                          {opp.buyExchange}
                        </span>
                        <span className="text-slate-200 font-bold">${opp.buyPrice.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:6})}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-1.5">
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold border bg-slate-800 border-slate-700 capitalize text-slate-300">
                          {opp.sellExchange}
                        </span>
                        <span className="text-slate-200 font-bold">${opp.sellPrice.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:6})}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-emerald-400 font-bold">
                      +{opp.grossSpreadPct.toFixed(4)}%
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button 
                        onClick={() => {
                          setActiveOpportunity(opp);
                          setActiveTab('calculator');
                        }}
                        className="px-3 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500 text-emerald-300 hover:text-dark-950 font-bold text-[11px] uppercase tracking-wider border border-emerald-500/30 transition">
                        Simular
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
