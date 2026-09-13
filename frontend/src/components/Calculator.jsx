import { useState } from 'react';
import { Calculator as CalcIcon, Settings2, Wallet, AlertTriangle } from 'lucide-react';
import { estimateExecution, slippageFromTop } from '../utils/slippage';

export default function ProfitCalculator({ fees, activeOpportunity, withdrawalFees = {}, transferFees = {}, sellMode = 'maker', books = {} }) {
  const [tradeSize, setTradeSize] = useState(1000);
  const [gasFee, setGasFee] = useState(0); // 0 = usar fee real del exchange
  
  if (!activeOpportunity) {
    return (
      <div className="bg-dark-900 border border-slate-800 rounded-2xl p-6 animate-in fade-in flex flex-col items-center justify-center min-h-[400px]">
        <CalcIcon className="w-12 h-12 text-slate-700 mb-4" />
        <h3 className="text-slate-300 font-bold text-lg mb-2">Calculadora de Profit & Slippage</h3>
        <p className="text-slate-500 text-sm max-w-md text-center">
          Para simular una operación, ve a la pestaña de Arbitraje Espacial y haz clic en "Simular" en cualquier oportunidad.
        </p>
      </div>
    );
  }

  const { asset, pair, buyExchange, sellExchange, buyPrice, sellPrice, grossSpreadPct, buySymbol, sellSymbol } = activeOpportunity;
  
  // Ejecución real: cruzar el order book real (VWAP por profundidad) con taker en ambas patas
  const buyTakerFee = fees[buyExchange]?.[pair]?.taker || 0.001;
  const sellTakerFee = fees[sellExchange]?.[pair]?.taker || 0.001;
  const sellMakerFee = fees[sellExchange]?.[pair]?.maker || sellTakerFee;

  const buyBook = books[buyExchange]?.[buySymbol];
  const sellBook = books[sellExchange]?.[sellSymbol];
  const exec = estimateExecution({ asks: buyBook?.asks, bids: sellBook?.bids }, tradeSize);
  const buyVwap = exec?.vwap ?? buyPrice;
  const sellVwap = exec?.sell?.vwap ?? sellPrice;
  const buySlippage = slippageFromTop(buyVwap, buyBook?.asks?.[0]?.[0]);
  const sellSlippage = slippageFromTop(exec?.sell?.vwap, sellBook?.bids?.[0]?.[0]);
  const insufficientDepth = !buyBook || !sellBook || !exec || !exec.executable;
  
  // Calculate execution details
  const amountCrypto = exec?.filledQty > 0 ? exec.filledQty : tradeSize / buyPrice;
  const buyFeeUsd = tradeSize * buyTakerFee;
  const cryptoAfterBuyFee = amountCrypto * (1 - buyTakerFee);
  
  const sellVolumeUsd = cryptoAfterBuyFee * sellVwap;

  // Modo de venta REAL: si el mejor nivel del libro absorbe el lote → post-only
  // (maker, llenado a P0, fee maker). Si no (o modo taker) → market cruzando el libro.
  const topBid = sellBook?.bids?.[0]?.[0];
  const topBidQty = sellBook?.bids?.[0]?.[1] ?? 0;
  const makerFillable = topBid != null && topBidQty >= amountCrypto * 0.9999;
  const sellIsMaker = sellMode === 'maker' && makerFillable;
  const effectiveSellVolume = sellIsMaker ? cryptoAfterBuyFee * topBid : sellVolumeUsd;
  const effectiveSellFeePct = sellIsMaker ? sellMakerFee : sellTakerFee;

  const sellFeeUsd = effectiveSellVolume * effectiveSellFeePct;

  // Retiro del ACTIVO (fee cobrado en el activo, a precio live) por trade.
  // 0 en el input = auto con el fee de transferencia real; si el backend viejo no lo trae, cae al fee USDT.
  const actualTransfer = transferFees[asset]?.[buyExchange]?.feeUsd;
  const actualGas = gasFee > 0 ? gasFee : (actualTransfer != null && actualTransfer > 0 ? actualTransfer : (withdrawalFees[buyExchange]?.usdt ?? 0.2));
  const transferDisplay = (actualTransfer != null && actualTransfer > 0) ? `$${actualTransfer.toFixed(3)}` : `$${(withdrawalFees[buyExchange]?.usdt ?? 0.2).toFixed(2)} (fallback USDT)`;

  const netRevenue = effectiveSellVolume - sellFeeUsd - actualGas;
  const netProfit = netRevenue - tradeSize;
  const netProfitPct = (netProfit / tradeSize) * 100;

  return (
    <div className="bg-dark-900 border border-slate-800 rounded-2xl p-6 animate-in fade-in space-y-6">
      <div className="flex items-center gap-3 border-b border-slate-800 pb-4">
        <div className="w-10 h-10 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
          <CalcIcon className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-white">Calculadora de Ejecución Real</h2>
          <p className="text-xs text-slate-400">Simulación rigurosa con comisiones reales (publicadas y verificadas) de cada exchange: entrada Taker; salida Maker (post-only al mejor bid) si el top del libro absorbe el lote, si no Taker.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Input & Config */}
        <div className="col-span-1 space-y-4">
          <div className="bg-dark-950 border border-slate-800 rounded-xl p-4">
            <h3 className="text-sm font-bold text-slate-300 flex items-center gap-2 mb-4">
              <Settings2 className="w-4 h-4 text-emerald-400" />
              Parámetros de Simulación
            </h3>
            
            <div className="space-y-4 text-sm">
              <div>
                <label className="block text-slate-400 mb-1.5 text-xs">Oportunidad Seleccionada</label>
                <div className="bg-dark-900 border border-slate-700 rounded px-3 py-2 text-white font-mono text-xs flex justify-between">
                  <span>{buyExchange.toUpperCase()} ➔ {sellExchange.toUpperCase()}</span>
                  <span className="text-emerald-400">+{grossSpreadPct.toFixed(2)}%</span>
                </div>
              </div>

              <div>
                <label className="block text-slate-400 mb-1.5 text-xs">Capital a invertir (USDT)</label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-slate-500">$</span>
                  <input 
                    type="number" 
                    value={tradeSize}
                    onChange={e => setTradeSize(Number(e.target.value))}
                    className="w-full bg-dark-900 border border-slate-700 rounded-lg pl-7 pr-3 py-2 text-white font-mono focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-400 mb-1.5 text-xs">Retiro del Activo / transferencia (USDT)</label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-slate-500">$</span>
                  <input 
                    type="number" 
                    step="0.1"
                    value={gasFee}
                    placeholder={`Auto: ${transferDisplay}`}
                    onChange={e => setGasFee(Number(e.target.value))}
                    className="w-full bg-dark-900 border border-slate-700 rounded-lg pl-7 pr-3 py-2 text-white font-mono focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <p className="text-[10px] text-slate-500 mt-1">
                  Fee de retiro del <strong>{asset}</strong> en {buyExchange} (auto: {transferDisplay}), cobrado en el activo sobre su red nativa (en Kraken: Fetch.ai nativa). No es retiro de USDT: ese fee solo aplica al refill de capital.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Breakdown */}
        <div className="col-span-1 lg:col-span-2 space-y-4">
          {insufficientDepth && (
            <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 animate-pulse-subtle">
              <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-bold text-amber-300">Profundidad insuficiente para ${tradeSize.toLocaleString()}</p>
                <p className="text-xs text-amber-200/70 mt-1">
                  El order book real de {buyExchange}/{sellExchange} no cubre el monto. {!buyBook ? `Libro de ${buyExchange} no disponible.` : !sellBook ? `Libro de ${sellExchange} no disponible.` : 'La operación quedaría parcialmente sin llenar.'} Ajustá
                  el capital o buscá una oportunidad con más liquidez.
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            
            {/* Compra */}
            <div className="bg-dark-950 border border-slate-800 rounded-xl p-4">
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">1. Compra ({buyExchange})</h4>
              <div className="space-y-2 text-sm font-mono">
                <div className="flex justify-between">
                  <span className="text-slate-500">Top Ask:</span>
                  <span className="text-white">${buyPrice.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Precio Ejec. (VWAP):</span>
                  <span className="text-white">${buyVwap.toFixed(6)}</span>
                </div>
                {buySlippage !== null && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Slippage Compra:</span>
                    <span className={buySlippage > 0.01 ? 'text-amber-400' : 'text-emerald-400'}>+{buySlippage.toFixed(3)}%</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-slate-500">Volumen {asset} (llenado):</span>
                  <span className="text-white">{amountCrypto.toFixed(6)} {asset}</span>
                </div>
                <div className="flex justify-between pt-2 border-t border-slate-800">
                                  <span className="text-slate-500">Fee Taker ({(buyTakerFee * 100).toFixed(2)}%):</span>
                                  <span className="text-rose-400">-${buyFeeUsd.toFixed(2)}</span>
                                </div>
              </div>
            </div>

            {/* Venta */}
            <div className="bg-dark-950 border border-slate-800 rounded-xl p-4">
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">2. Venta ({sellExchange})</h4>
              <div className="space-y-2 text-sm font-mono">
                <div className="flex justify-between">
                  <span className="text-slate-500">Top Bid:</span>
                  <span className="text-white">${sellPrice.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Precio Ejec. (VWAP):</span>
                  <span className="text-white">${sellVwap.toFixed(6)}</span>
                </div>
                {sellSlippage !== null && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">Slippage Venta:</span>
                    <span className={sellSlippage > 0.01 ? 'text-amber-400' : 'text-emerald-400'}>-{Math.abs(sellSlippage).toFixed(3)}%</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-slate-500">Valor Bruto:</span>
                  <span className="text-white">${sellVolumeUsd.toFixed(2)}</span>
                </div>
                <div className="flex justify-between pt-2 border-t border-slate-800">
                  <span className="text-slate-500">Fee {sellIsMaker ? 'Maker' : 'Taker'} ({(effectiveSellFeePct * 100).toFixed(2)}%):</span>
                  <span className="text-rose-400">-${sellFeeUsd.toFixed(2)}</span>
                </div>
                {sellMode === 'maker' && !makerFillable && (
                  <div className="flex justify-between text-[10px] text-amber-400/80">
                    <span className="text-slate-500">Mejor bid no absorbe el lote → cae a taker</span>
                    <span>↳ mix</span>
                  </div>
                )}
              </div>
            </div>

          </div>

          {/* Resultado Neto */}
          <div className="bg-dark-950 border border-slate-800 rounded-xl p-5 mt-4">
             <div className="flex items-center justify-between mb-4">
               <h4 className="text-sm font-bold text-slate-300 flex items-center gap-2">
                 <Wallet className="w-4 h-4 text-emerald-400" />
                 Resultado Final Neto
               </h4>
             </div>
             
             <div className="flex flex-col md:flex-row gap-6 items-center">
               <div className="flex-1 space-y-2 text-sm font-mono w-full">
<div className="flex justify-between">
                    <span className="text-slate-500">Total Venta (VWAP, post-compra):</span>
                    <span className="text-emerald-400">+${(effectiveSellVolume - tradeSize).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-rose-400/80">
                    <span>Fee {sellIsMaker ? 'Maker' : 'Taker'} Venta:</span>
                    <span>-${sellFeeUsd.toFixed(2)}</span>
                  </div>
                 <div className="flex justify-between text-rose-400/80 pb-2 border-b border-slate-800">
                   <span>Retiro del Activo ({asset}):</span>
                   <span>-${actualGas.toFixed(2)}</span>
                 </div>
                 <div className="flex justify-between pt-2 text-base font-bold">
                   <span className="text-slate-300">PnL Neto ({netProfitPct.toFixed(2)}%):</span>
                   <span className={netProfit > 0 ? 'text-emerald-400' : 'text-rose-500'}>
                     {netProfit > 0 ? '+' : ''}${netProfit.toFixed(2)}
                   </span>
                 </div>
               </div>
               
               <div className="w-full md:w-1/3 flex flex-col items-center justify-center p-4 bg-dark-900 rounded-xl border border-slate-800">
                 <span className="text-xs text-slate-400 uppercase tracking-wider mb-1">Decisión de Algoritmo</span>
                 {netProfit > 0 ? (
                   <span className="text-xl font-black text-emerald-400 animate-pulse-subtle">APROBADO</span>
                 ) : (
                   <span className="text-xl font-black text-rose-500">DENEGADO</span>
                 )}
               </div>
             </div>
          </div>

        </div>
      </div>
    </div>
  );
}
