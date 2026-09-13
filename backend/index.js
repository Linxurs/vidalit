const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Initialize CCXT exchanges
const exchanges = {
  binance: new ccxt.binance({ enableRateLimit: true }),
  coinbase: new ccxt.coinbase({ enableRateLimit: true }),
  kraken: new ccxt.kraken({ enableRateLimit: true }),
  bybit: new ccxt.bybit({ enableRateLimit: true }),
  okx: new ccxt.okx({ enableRateLimit: true }),
  mexc: new ccxt.mexc({ enableRateLimit: true }),
  gate: new ccxt.gate({ enableRateLimit: true }),
  kucoin: new ccxt.kucoin({ enableRateLimit: true }),
  bitget: new ccxt.bitget({ enableRateLimit: true })
};

// Supported exchanges (CCXT ids). gateio is 'gate' in CCXT.
const EXCHANGES = ['binance', 'coinbase', 'kraken', 'bybit', 'okx', 'mexc', 'gate', 'kucoin', 'bitget'];
const BASE = 'USDT';
// High-volatility Memecoins + Altcoins + Majors
const ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'AVAX', 'DOGE', 'PEPE', 'SHIB', 'WIF', 'LINK', 'ADA', 'MATIC', 'DOT', 'LTC', 'UNI', 'BCH', 'ARB', 'OP', 'SUI', 'SEI', 'APT', 'TIA', 'INJ', 'RENDER', 'FET', 'NEAR', 'ATOM', 'FIL', 'ICP', 'GALA', 'SAND'];
const CROSS_ASSETS = ['ETH', 'SOL', 'XRP', 'AVAX', 'LINK', 'ADA', 'DOGE', 'LTC', 'NEAR', 'INJ']; // For triangular loops

// Real spot trading fees (base tier / VIP 0, validated Sept 2026).
// CCXT market.taker/maker is unreliable (returns 0 or undefined for
// Coinbase, Kraken, MEXC...), so we use these published rates as source of truth.
const REAL_FEES = {
  binance: { maker: 0.001, taker: 0.001 },      // 0.10% / 0.10% (0.075% con BNB)
  coinbase: { maker: 0.004, taker: 0.006 },     // 0.40% / 0.60% (tier de entrada)
  kraken: { maker: 0.004, taker: 0.008 },       // 0.40% / 0.80% (Tier 1)
  bybit: { maker: 0.001, taker: 0.001 },        // 0.10% / 0.10%
  okx: { maker: 0.0008, taker: 0.001 },         // 0.08% / 0.10%
  mexc: { maker: 0.0, taker: 0.0005 },          // 0.00% / 0.05%
  gate: { maker: 0.001, taker: 0.001 },         // 0.10% / 0.10% (VIP0)
  kucoin: { maker: 0.001, taker: 0.001 },       // 0.10% / 0.10%
  bitget: { maker: 0.001, taker: 0.001 }        // 0.10% / 0.10%
};

// Real USDT withdrawal fees (USD, representative network), verified 2026.
// These pay the "refill": moving USDT between exchanges to keep buy-side capital funded.
// Fees are flat and paid in USDT, so USD cost = fee amount.
// - Binance TRC-20: 1.5 USDT, MEXC TRC-20: 0.5 USDT (checked vs official fee pages, Sep 2026).
// - Coinbase does not support TRC-20: it uses ERC-20 with pass-through gas (variable, ~$6).
const WITHDRAWAL_FEES = {
  binance: { usdt: 1.5, network: 'TRC20' },
  coinbase: { usdt: 6.0, network: 'ERC20' },
  kraken: { usdt: 2.5, network: 'TRC20' },
  bybit: { usdt: 1.0, network: 'TRC20' },
  okx: { usdt: 1.0, network: 'TRC20' },
  mexc: { usdt: 0.5, network: 'TRC20' },
  gate: { usdt: 1.0, network: 'TRC20' },
  kucoin: { usdt: 1.0, network: 'TRC20' },
  bitget: { usdt: 1.0, network: 'TRC20' }
};

// Real ASSET transfer fees, paid IN THE ASSET on its native network, per trade.
// On Kraken, FET is the native Fetch.ai chain (Cosmos-SDK) — NOT ERC-20 — per Kraken's
// "Supported address formats" and "Cryptocurrencies available on Kraken" (2026). Native
// transfers cost fractions of a cent plus a flat exchange fee quoted in FET.
// Exchanges quote this dynamically per coin/network; values below are conservative
// defaults used to convert to USD at the live price. feeUsd = feeInAsset * assetPriceUsd.
const ASSET_TRANSFER_FEES = {
  FET: {
    binance: 1.0, coinbase: 1.0, kraken: 1.0, bybit: 1.0, okx: 1.0,
    mexc: 1.0, gate: 1.0, kucoin: 1.0, bitget: 1.0
  }
};

// In-memory caches
let latestPrices = {};
let marketFees = {};
let latestBooks = {}; // exId -> symbol -> { bids:[[p,q]...], asks:[[p,q]...], timestamp }
let usdtUsd = 1; // USD per 1 USDT (Fiat pairs -> USDT normalization)

// Normalize a price/quantity to USDT terms if the symbol is Fiat-quoted
function toUsdt(price, symbol) {
  return (symbol.endsWith('/USD') && usdtUsd) ? price / usdtUsd : price;
}

// Convert each price in an order book side to USDT terms
function bookToUsdt(side, symbol) {
  return side.map(([price, amount]) => [toUsdt(price, symbol), amount]);
}

// Determine which (exchange, symbol) pairs currently have a positive cross
// spread -> only those need fresh order books (rate-limit friendly).
function spreadCandidates() {
  const candidates = {};
  const exchangeKeys = Object.keys(exchanges);
  for (const asset of ASSETS) {
    const baseSym = `${asset}/${BASE}`;
    const fiatSym = `${asset}/USD`;
    for (let i = 0; i < exchangeKeys.length; i++) {
      for (let j = 0; j < exchangeKeys.length; j++) {
        if (i === j) continue;
        const buyEx = exchangeKeys[i];
        const sellEx = exchangeKeys[j];
        const buySym = latestPrices[buyEx]?.[baseSym] ? baseSym : fiatSym;
        const sellSym = latestPrices[sellEx]?.[baseSym] ? baseSym : fiatSym;
        const buyP = latestPrices[buyEx]?.[buySym]?.ask;
        const sellP = latestPrices[sellEx]?.[sellSym]?.bid;
        if (buyP && sellP && sellP > buyP) {
          (candidates[buyEx] ??= new Set()).add(buySym);
          (candidates[sellEx] ??= new Set()).add(sellSym);
        }
      }
    }
  }
  return candidates;
}

// Fetch real order books (top BOOK_LIMIT levels) for routes with positive spread
async function fetchOrderBooks() {
  const candidates = spreadCandidates();
  const BOOK_LIMIT = 50;
  const FRESH_MS = 20000;

  await Promise.all(Object.entries(candidates).map(async ([exchangeId, symSet]) => {
    const exchange = exchanges[exchangeId];
    if (!exchange.has['fetchOrderBook']) return;
    for (const sym of symSet) {
      // Skip if we already have a fresh book
      if (latestBooks[exchangeId]?.[sym]?.timestamp && (Date.now() - latestBooks[exchangeId][sym].timestamp) < FRESH_MS) continue;
      try {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 6000));
        const book = await Promise.race([
          exchange.fetchOrderBook(sym, BOOK_LIMIT),
          timeout
        ]);
        // Never cache an empty book (transient partial responses kill routes)
        if ((book.bids?.length || 0) === 0 && (book.asks?.length || 0) === 0) continue;
        latestBooks[exchangeId] ??= {};
        latestBooks[exchangeId][sym] = {
          bids: bookToUsdt(book.bids || [], sym),
          asks: bookToUsdt(book.asks || [], sym),
          timestamp: Date.now()
        };
      } catch (e) {
        // Keep the stale book if any, otherwise mark as missing
        if (!latestBooks[exchangeId]?.[sym]) latestBooks[exchangeId] ??= {};
      }
    }
  }));
}

// VWAP execution walking one side of a book.
// For asks: spend up to sizeUsd -> returns effective avg buy price + depth.
// For bids: sell up to sizeQty -> returns effective avg sell price + depth.
function walkBook(side, target, byNotional) {
  let filled = 0, spentqty = 0, spentnotional = 0;
  for (const [price, amount] of side) {
    const notional = price * amount;
    const takeQty = byNotional ? Math.min(amount, (target - spentnotional) / price) : Math.min(amount, target - filled);
    if (takeQty <= 0) break;
    filled += takeQty;
    spentnotional += takeQty * price;
  }
  return { filledQty: filled, filledNotional: spentnotional, vwap: filled > 0 ? spentnotional / filled : null };
}

// Fetch order books periodically
async function fetchPrices() {
  const symbols = [...ASSETS.map(asset => `${asset}/${BASE}`), ...CROSS_ASSETS.map(asset => `${asset}/BTC`)];

  // Reference rate USDT/USD (par fondos a USDT, no asumir 1:1)
  try {
    const ft = await exchanges.kraken.fetchTicker('USDT/USD');
    if (ft && ft.bid && ft.ask) usdtUsd = (ft.bid + ft.ask) / 2;
  } catch (e) {
    // Keep the last known rate
  }
  
  await Promise.all(Object.entries(exchanges).map(async ([exchangeId, exchange]) => {
    try {
      let fetchSymbols = symbols;
      if (exchangeId === 'coinbase' || exchangeId === 'kraken') {
         fetchSymbols = [...ASSETS.map(asset => `${asset}/USD`), ...CROSS_ASSETS.map(asset => `${asset}/BTC`)];
      }
      
      // CCXT fetchTickers throws an error if any symbol is invalid for that exchange
      const validSymbols = fetchSymbols.filter(sym => exchange.markets && exchange.markets[sym]);

      if (exchange.has['fetchTickers'] && validSymbols.length > 0) {
         console.log(`Fetching ${validSymbols.length} pairs from ${exchangeId}...`);
         
         const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000));
         const tickers = await Promise.race([
            exchange.fetchTickers(validSymbols),
            timeout
         ]);
         
         console.log(`Success ${exchangeId}`);
         
         if (!latestPrices[exchangeId]) {
            latestPrices[exchangeId] = {};
         }
         
         for (const [symbol, ticker] of Object.entries(tickers)) {
            // Keep the exact symbol for cross pairs
            const assetKey = symbol;
            if (ticker.bid && ticker.ask) {
               let bid = ticker.bid;
               let ask = ticker.ask;
               // Normaliza precios Fiat (USD) a términos USDT usando la tasa real
               if (symbol.endsWith('/USD')) {
                  bid = bid / usdtUsd;
                  ask = ask / usdtUsd;
               }
               latestPrices[exchangeId][assetKey] = {
                  bid,
                  ask,
                  timestamp: Date.now()
               };
            }
         }
      }
    } catch (error) {
      console.error(`Error fetching from ${exchangeId}:`, error.message);
    }
  }));
}

// Initialize and load markets to get precise fees
async function initMarkets() {
  console.log('Loading exchange markets and real fees...');
  await Promise.all(Object.entries(exchanges).map(async ([exchangeId, exchange]) => {
    try {
      await exchange.loadMarkets();
      marketFees[exchangeId] = {};
      
      const initSymbols = [...ASSETS.map(asset => `${asset}/${BASE}`), ...CROSS_ASSETS.map(asset => `${asset}/BTC`)];
      
      for (const sym of initSymbols) {
        let fetchSym = sym;
        if ((exchangeId === 'coinbase' || exchangeId === 'kraken') && sym.endsWith(BASE)) {
           fetchSym = sym.replace(BASE, 'USD');
        }
        
        const market = exchange.markets[fetchSym];
        if (market) {
          const realFee = REAL_FEES[exchangeId] || { maker: 0.001, taker: 0.001 };
          marketFees[exchangeId][sym] = {
            taker: realFee.taker,
            maker: realFee.maker
          };
        }
      }
      console.log(`Loaded fees for ${exchangeId}`);
    } catch (error) {
      console.error(`Error loading markets for ${exchangeId}:`, error.message);
    }
  }));
}

// Start bot
initMarkets().then(() => {
  fetchPrices();
  setInterval(fetchPrices, 10000);
  const loopBooks = async () => {
    try { await fetchOrderBooks(); } catch (e) { /* keep going */ }
    setTimeout(loopBooks, 10000);
  };
  loopBooks();
});

// API Endpoint to get current opportunities
app.get('/api/opportunities', (req, res) => {
   const opps = [];
   const triangularOpps = [];
   const exchangeKeys = Object.keys(exchanges);
   
   // 1. Spatial Arbitrage
   ASSETS.forEach(asset => {
       const baseSym = `${asset}/${BASE}`;
       const fiatSym = `${asset}/USD`;
       
       for (let i = 0; i < exchangeKeys.length; i++) {
          for (let j = 0; j < exchangeKeys.length; j++) {
             if (i === j) continue;
             const buyEx = exchangeKeys[i];
             const sellEx = exchangeKeys[j];
             
             // Check which symbol key exists in the cache (USDT vs USD)
             const buySym = latestPrices[buyEx]?.[baseSym] ? baseSym : fiatSym;
             const sellSym = latestPrices[sellEx]?.[baseSym] ? baseSym : fiatSym;
             
             if (latestPrices[buyEx]?.[buySym]?.ask && latestPrices[sellEx]?.[sellSym]?.bid) {
                const buyPrice = latestPrices[buyEx][buySym].ask;
                const sellPrice = latestPrices[sellEx][sellSym].bid;
                
                if (sellPrice > buyPrice) {
                    const grossSpreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;
                    if (grossSpreadPct > 0) {
                       opps.push({
                          id: `${asset}-${buyEx}-${sellEx}-${Date.now()}`,
                          asset,
                          pair: baseSym,
                          buySymbol: buySym,
                          sellSymbol: sellSym,
                          buyExchange: buyEx,
                          sellExchange: sellEx,
                          buyPrice,
                          sellPrice,
                          grossSpreadPct
                       });
                    }
                 }
             }
          }
       }
   });
   
    // 2. Triangular Arbitrage (Intra-Exchange)
    // Route: USDT -> BTC -> CROSS -> USDT
    exchangeKeys.forEach(ex => {
       const prices = latestPrices[ex];
       if (!prices) return;
       
       const btcUsdtSym = prices['BTC/USDT'] ? 'BTC/USDT' : 'BTC/USD';
       const btcUsdt = prices[btcUsdtSym];
       if (!btcUsdt) return;
       
       CROSS_ASSETS.forEach(cross => {
           const crossBtcSym = `${cross}/BTC`;
           const crossUsdtSym = prices[`${cross}/USDT`] ? `${cross}/USDT` : `${cross}/USD`;
           
           const crossBtc = prices[crossBtcSym];
           const crossUsdt = prices[crossUsdtSym];
           
           if (btcUsdt?.ask && crossBtc?.ask && crossUsdt?.bid) {
               // Step 1: Buy BTC with USDT
               const step1AmountBtc = 1000 / btcUsdt.ask;
               // Step 2: Buy CROSS with BTC
               const step2AmountCross = step1AmountBtc / crossBtc.ask;
               // Step 3: Sell CROSS for USDT
               const finalUsdt = step2AmountCross * crossUsdt.bid;
               
               const grossSpreadPct = ((finalUsdt - 1000) / 1000) * 100;
               
               if (grossSpreadPct > -100) { // Keep all valid computations for the UI
                  triangularOpps.push({
                      id: `${ex}-${cross}-triangular-${Date.now()}`,
                      exchange: ex,
                      route: `USDT ➔ BTC ➔ ${cross} ➔ USDT`,
                      grossSpreadPct,
                      steps: {
                         step1: { pair: btcUsdtSym, action: 'Buy BTC', price: btcUsdt.ask },
                         step2: { pair: crossBtcSym, action: `Buy ${cross}`, price: crossBtc.ask },
                         step3: { pair: crossUsdtSym, action: `Sell ${cross}`, price: crossUsdt.bid }
                      }
                  });
               }
           }
       });
    });
    
    opps.sort((a, b) => b.grossSpreadPct - a.grossSpreadPct);
    triangularOpps.sort((a, b) => b.grossSpreadPct - a.grossSpreadPct);

    // Exponer solo los order books frescos (tope de libro, en términos USDT)
    const books = {};
    const FRESH_BOOK_MS = 30000;
    for (const [exId, symbols] of Object.entries(latestBooks)) {
      for (const [sym, book] of Object.entries(symbols)) {
        if ((book.bids?.length || 0) === 0 && (book.asks?.length || 0) === 0) continue;
        if (Date.now() - book.timestamp <= FRESH_BOOK_MS) {
          books[exId] ??= {};
          books[exId][sym] = { bids: book.bids, asks: book.asks, timestamp: book.timestamp };
        }
      }
    }

    // Transfer fee del activo por trade, en USD, a precio live (fee cobrado EN EL ACTIVO).
    const transferFees = {};
    for (const [asset, feeByEx] of Object.entries(ASSET_TRANSFER_FEES)) {
      transferFees[asset] = {};
      // kraken/coinbase cotizan el par en USD; el resto en USDT
      const keyFor = (exId) => (exId === 'kraken' || exId === 'coinbase') ? `${asset}/USD` : `${asset}/${BASE}`;
      let fallbackUsd = null;
      for (const [exId, feeInAsset] of Object.entries(feeByEx)) {
        const px = latestPrices[exId]?.[keyFor(exId)]?.bid;
        const usd = (px != null) ? feeInAsset * toUsdt(px, keyFor(exId)) : null;
        if (usd == null) fallbackUsd ??= (latestPrices[exId]?.[keyFor(exId)]?.bid);
        transferFees[asset][exId] = { feeInAsset, feeUsd: usd, priceUsd: usd != null ? usd / feeInAsset : null };
      }
      // fallback: precio del activo (ya normalizado a USDT≈USD en latestPrices) desde cualquier exchange
      if (fallbackUsd != null) {
        for (const [exId, feeInAsset] of Object.entries(feeByEx)) {
          if (transferFees[asset][exId].feeUsd == null) {
            const feePrice = toUsdt(fallbackUsd, '');
            transferFees[asset][exId] = { feeInAsset, feeUsd: feeInAsset * feePrice, priceUsd: feePrice };
          }
        }
      }
    }

    res.json({ opportunities: opps, triangular: triangularOpps, prices: latestPrices, fees: marketFees, withdrawalFees: WITHDRAWAL_FEES, transferFees, books });
});

app.listen(PORT, () => {
  console.log(`ArbitrageX backend running on port ${PORT}`);
});
