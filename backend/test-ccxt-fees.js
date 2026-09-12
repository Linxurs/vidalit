const ccxt = require('ccxt');

async function testFees() {
  const binance = new ccxt.binance();
  await binance.loadMarkets();
  console.log('Binance BTC/USDT fee:', binance.markets['BTC/USDT'].taker, binance.markets['BTC/USDT'].maker);
}
testFees().catch(console.error);
