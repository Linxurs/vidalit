import { SplitSquareHorizontal, Fuel, Wallet, Volume2 } from 'lucide-react';

export default function Header({ demoBalance }) {
  return (
    <header className="border-b border-slate-800/80 bg-dark-900/90 backdrop-blur sticky top-0 z-40 px-4 lg:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-cyan-500 flex items-center justify-center text-white shadow-lg shadow-emerald-500/20 font-black text-xl tracking-wider">
          <SplitSquareHorizontal className="w-6 h-6" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-bold text-lg tracking-tight text-white flex items-center gap-1.5">
              Arbitrage<span className="text-emerald-400">X</span>
              <span className="text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded font-mono font-medium">LIVE SCAN</span>
            </h1>
          </div>
          <p className="text-xs text-slate-400 hidden sm:block">Motor Cuantitativo de Disparidad de Precios & Ejecución</p>
        </div>
      </div>

      <div className="flex items-center gap-2 sm:gap-6 text-xs text-slate-300">
        <div className="hidden md:flex items-center gap-2 bg-dark-850 px-3 py-1.5 rounded-lg border border-slate-800">
          <Fuel className="w-4 h-4 text-amber-400" />
          <span>Gas Red:</span>
          <span className="font-mono text-emerald-400 font-bold">18 Gwei</span>
        </div>

        <div className="flex items-center gap-2 bg-dark-850 px-3 py-1.5 rounded-lg border border-slate-800">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
          </span>
          <span className="hidden sm:inline">Exchanges Activos:</span>
          <span className="font-bold text-emerald-400">5/5</span>
        </div>

        <div className="flex items-center gap-2 bg-emerald-950/40 border border-emerald-500/30 px-3.5 py-1.5 rounded-lg">
          <Wallet className="w-4 h-4 text-emerald-400" />
          <div className="text-right">
            <span className="text-[10px] text-slate-400 block -mb-1">Saldo Demo USDT</span>
            <span className="font-mono font-bold text-emerald-400 text-sm">
              ${demoBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </span>
          </div>
        </div>

        <button className="p-2 rounded-lg bg-dark-850 border border-slate-800 hover:border-slate-700 text-slate-300 hover:text-white transition" title="Activar/Desactivar Alertas">
          <Volume2 className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
