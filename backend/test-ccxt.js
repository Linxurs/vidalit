const ccxt = require('ccxt');

async function test() {
  const ex = new ccxt.binance();
  try {
    const tickers = await ex.fetchTickers(['BTC/USDT', 'ETH/USDT']);
    console.log(Object.keys(tickers));
  } catch (e) {
    console.error(e);
  }
}
test();
