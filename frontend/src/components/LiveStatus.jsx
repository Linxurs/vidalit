import { useState, useEffect } from 'react';
import { ShieldAlert, ShieldCheck, AlertTriangle, Power, RefreshCw, ListChecks } from 'lucide-react';

const API = 'http://localhost:3001';
const API_KEY = import.meta.env.VITE_API_KEY || '';
const authHeaders = API_KEY ? { 'x-api-key': API_KEY } : {};

const STATUS_COLOR = { pending: 'text-cyan-300', in_transit: 'text-amber-300', deposited: 'text-amber-300', done: 'text-emerald-400', failed: 'text-rose-500', stuck: 'text-rose-500', killed: 'text-rose-400' };

export default function LiveStatus() {
  const [st, setSt] = useState(null);
  const [trades, setTrades] = useState([]);
  const [unwound, setUnwound] = useState(null);

  const load = async () => {
    try {
      const r = await fetch(`${API}/api/trader/status`, { headers: authHeaders });
      if (r.ok) setSt(await r.json());
      const t = await fetch(`${API}/api/trader/trades`, { headers: authHeaders });
      if (t.ok) setTrades((await t.json()).trades || []);
    } catch (e) { /* backend apagado */ }
  };

  useEffect(() => { load(); const i = setInterval(load, 5000); return () => clearInterval(i); }, []);

  const kill = async () => {
    if (!window.confirm('¿Kill switch? Detiene toda ejecución y los trades en vuelo quedan para manejo manual. Solo se desactiva reiniciando el backend.')) return;
    try { await fetch(`${API}/api/trader/kill`, { method: 'POST', headers: authHeaders }); } catch (e) {}
    load();
  };

  const unwind = async (ref) => {
    try {
      const r = await fetch(`${API}/api/trader/unwind`, { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ ref }) });
      if (r.ok) setUnwound(await r.json());
    } catch (e) {}
  };

  const cfg = st?.live || {};
  return (
    <div className="space-y-6 animate-in fade-in">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-white font-bold">
          {st?.liveEnabled && !st?.killSwitch
            ? <><ShieldCheck className="w-5 h-5 text-emerald-400" /> Ejecución REAL activa</>
            : <><ShieldAlert className="w-5 h-5 text-slate-400" /> {st ? 'DRY-RUN / apagado' : 'Sin conexión al backend'}</>}
          <span className="text-xs font-normal text-slate-500">{st?.mode}</span>
        </div>
        <button
          onClick={kill}
          disabled={st?.killSwitch}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 disabled:opacity-40">
          <Power className="w-3.5 h-3.5" /> {st?.killSwitch ? 'KILL ACTIVADO' : 'Kill switch'}
        </button>
      </div>

      {st?.killSwitch && (
        <div className="border border-rose-500/30 bg-rose-500/10 rounded-xl p-3 text-sm">
          <AlertTriangle className="w-4 h-4 inline mr-1" /> Kill switch activo: no se ejecuta nada. Revisá los trades en vuelo abajo.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          ['Retiros habilitados', cfg.allowWithdrawals ? 'SÍ' : 'NO', cfg.allowWithdrawals ? 'text-emerald-400' : 'text-rose-500'],
          ['Max tamaño/trade', `$${cfg.maxTradeSize}`, 'text-white'],
          ['Max pérdida diaria', `$${cfg.maxDailyLoss}`, 'text-white'],
          ['Trades concurrentes', `${cfg.maxConcurrentTrades}`, 'text-white'],
          ['Profit mínimo', `${cfg.minNetProfitPct}%`, 'text-white'],
          ['Redes aprobadas', `${(cfg.approvedNetworks || []).length}`, 'text-white'],
          ['Dir. depósito', `${(cfg.depositAddresses || []).length}`, 'text-white'],
          ['Timeout depósito', `${cfg.timeoutMin} min`, 'text-white'],
        ].map(([k, v, c]) => (
          <div key={k} className="bg-dark-900 border border-slate-800 rounded-xl p-3">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">{k}</p>
            <p className={`text-lg font-mono font-bold ${c}`}>{v}</p>
          </div>
        ))}
      </div>

      <div className="bg-dark-900 border border-slate-800 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-white font-bold flex items-center gap-2 text-sm">
            <ListChecks className="w-4 h-4 text-cyan-400" /> Exchanges con claves
          </h3>
          <button onClick={load} className="text-xs flex items-center gap-1 text-slate-400 hover:text-white transition"><RefreshCw className="w-3 h-3" /> Probar</button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs font-mono">
          {st?.perExchange && Object.entries(st.perExchange).map(([ex, v]) => (
            <div key={ex} className="flex items-center justify-between bg-dark-950 border border-slate-800/70 rounded-lg px-3 py-2">
              <span className="text-slate-300">{ex}</span>
              <div className="flex items-center gap-2">
                {v.keyed
                  ? <span className={`${v.probed?.ok === false ? 'text-rose-500' : v.probed?.ok === true ? 'text-emerald-400' : 'text-amber-400'}`}>{v.probed ? (v.probed.ok ? 'auth OK' : v.probed.reason) : 'sin probar'}</span>
                  : <span className="text-slate-600">sin keys</span>}
                {v.canWithdraw ? <span className="text-rose-400">retiro✓</span> : null}
              </div>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-slate-500 mt-3">
          Claves con permiso de trading (sin retiro) + whitelist de IP. Pueden retirar solo si ALLOW_WITHDRAWALS=true en .env.
        </p>
      </div>

      <div className="bg-dark-900 border border-slate-800 rounded-2xl p-4">
        <h3 className="text-white font-bold flex items-center gap-2 text-sm mb-3">
          <ShieldAlert className="w-4 h-4 text-cyan-400" /> Trades en vuelo / registrados
        </h3>
        {trades.length === 0 ? (
          <p className="text-xs text-slate-500 italic py-4">Sin trades. La ejecución solo pasa si TODOS los guardarraíles están OK y elegís una oportunidad en la UI.</p>
        ) : (
          <div className="space-y-2">
            {trades.map(t => (
              <div key={t.ref} className="bg-dark-950 border border-slate-800/70 rounded-lg p-3 text-xs font-mono">
                <div className="flex items-center justify-between">
                  <span className="text-white font-bold">{t.ref}</span>
                  <span className={`font-bold ${STATUS_COLOR[t.status] || 'text-slate-300'}`}>{t.status}</span>
                </div>
                <p className="text-slate-400 mt-1">{t.asset} {t.buyExchange} → {t.sellExchange} · {t.network || '-'} · ${t.tradeSize}</p>
                {t.log?.length ? <p className="text-slate-500 text-[10px] mt-1">{t.log.slice(-3).join(' · ')}</p> : null}
                {['stuck', 'killed', 'in_transit'].includes(t.status) && (
                  <button onClick={() => unwind(t.ref)} className="mt-2 text-[10px] px-2 py-1 rounded border border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20">
                    Unwind (plan manual)
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {unwound && (
          <div className="mt-3 border border-slate-700 rounded-xl p-3 text-xs">
            <p className="font-bold text-white mb-1">Unwind {unwound.ref} ({unwound.status})</p>
            {(unwound.steps || []).map(s => <p key={s} className="text-slate-400">{s}</p>)}
          </div>
        )}
      </div>
    </div>
  );
}