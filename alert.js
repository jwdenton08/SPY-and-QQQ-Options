import fetch from 'node-fetch';

const PUSHOVER_TOKEN = 'a8t6fp9e6bptutj7oqeg3undvgfjhh';
const PUSHOVER_USER = 'up3zcqrqy5g8ei3ixyg533zzcwmu2g';

const CHECK_INTERVAL = 1 * 60 * 1000;
const TRADE_START_HOUR = 9;
const TRADE_START_MINUTE = 35;
const TRADE_END_HOUR = 13;

async function notify(title, message, priority = 0) {
  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: PUSHOVER_TOKEN,
        user: PUSHOVER_USER,
        title: title,
        message: message,
        priority: priority,
        sound: 'cashregister'
      })
    });
    const data = await res.json();
    if (data.status === 1) {
      console.log(`Notification sent: ${title}`);
    } else {
      console.log(`Notification failed: ${JSON.stringify(data)}`);
    }
  } catch (e) {
    console.error('Pushover error:', e.message);
  }
}

function getETTime() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return { hour: et.getHours(), minute: et.getMinutes() };
}

function inTradingWindow() {
  const { hour, minute } = getETTime();
  const afterStart = hour > TRADE_START_HOUR || (hour === TRADE_START_HOUR && minute >= TRADE_START_MINUTE);
  const beforeEnd = hour < TRADE_END_HOUR;
  return afterStart && beforeEnd;
}

async function getQuote(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`;
  const res = await fetch(url);
  const data = await res.json();
  const result = data.chart.result[0];
  const closes = result.indicators.quote[0].close.filter(Boolean);
  const highs = result.indicators.quote[0].high.filter(Boolean);
  const lows = result.indicators.quote[0].low.filter(Boolean);
  const volumes = result.indicators.quote[0].volume.filter(Boolean);
  const meta = result.meta;
  return { closes, highs, lows, volumes, meta };
}

function ema(data, period) {
  const k = 2 / (period + 1);
  let emaVal = data[0];
  for (let i = 1; i < data.length; i++) {
    emaVal = data[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

function sma(data, period) {
  const slice = data.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcADX(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return { adx: 0, plusDI: 0, minusDI: 0 };
  let plusDMs = [], minusDMs = [], trs = [];
  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i-1];
    const downMove = lows[i-1] - lows[i];
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    trs.push(tr);
  }
  const avgTR = sma(trs, period);
  const avgPlus = sma(plusDMs, period);
  const avgMinus = sma(minusDMs, period);
  const plusDI = 100 * avgPlus / avgTR;
  const minusDI = 100 * avgMinus / avgTR;
  const dx = 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI);
  return { adx: dx, plusDI, minusDI };
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const rs = gains / (losses || 1);
  return 100 - 100 / (1 + rs);
}

function calcVWAP(highs, lows, closes, volumes) {
  let cumTPV = 0, cumVol = 0;
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumTPV += tp * volumes[i];
    cumVol += volumes[i];
  }
  return cumTPV / cumVol;
}

async function analyzeTicker(ticker, nqBull, nqBear) {
  const { closes, highs, lows, volumes, meta } = await getQuote(ticker);
  const price = closes[closes.length - 1];

  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const vwap = calcVWAP(highs, lows, closes, volumes);
  const rsi = calcRSI(closes);
  const { adx } = calcADX(highs, lows, closes);
  const volAvg = sma(volumes, 20);
  const currentVol = volumes[volumes.length - 1];

  let longScore = 0;
  if (fast > slow) longScore++;
  if (price > vwap) longScore++;
  if (rsi > 55) longScore++;
  if (adx > 20) longScore++;
  if (currentVol > volAvg) longScore++;
  if (nqBull) longScore++;

  let shortScore = 0;
  if (fast < slow) shortScore++;
  if (price < vwap) shortScore++;
  if (rsi < 45) shortScore++;
  if (adx > 20) shortScore++;
  if (currentVol > volAvg) shortScore++;
  if (nqBear) shortScore++;

  console.log(`${ticker}: $${price.toFixed(2)} | EMA9: ${fast.toFixed(2)} | EMA21: ${slow.toFixed(2)} | VWAP: ${vwap.toFixed(2)} | RSI: ${rsi.toFixed(1)} | ADX: ${adx.toFixed(1)}`);
  console.log(`${ticker} Long Score: ${longScore}/6 | Short Score: ${shortScore}/6`);

  if (longScore >= 5 && nqBull) {
    console.log(`>>> ${ticker} LONG SIGNAL FIRED <<<`);
    await notify(
      `GOD MODE - ${ticker} BUY CALL`,
      `${ticker} CALL signal fired\nScore: ${longScore}/6\nPrice: $${price.toFixed(2)}\nRSI: ${rsi.toFixed(1)}\nADX: ${adx.toFixed(1)}\nNQ: BULLISH`,
      1
    );
  } else if (shortScore >= 5 && nqBear) {
    console.log(`>>> ${ticker} SHORT SIGNAL FIRED <<<`);
    await notify(
      `GOD MODE - ${ticker} BUY PUT`,
      `${ticker} PUT signal fired\nScore: ${shortScore}/6\nPrice: $${price.toFixed(2)}\nRSI: ${rsi.toFixed(1)}\nADX: ${adx.toFixed(1)}\nNQ: BEARISH`,
      1
    );
  } else {
    console.log(`${ticker} - No signal.`);
  }
}

async function checkSignals() {
  const { hour, minute } = getETTime();
  const timeStr = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" });

  if (!inTradingWindow()) {
    const beforeOpen = hour < 9 || (hour === 9 && minute < 35);
    if (beforeOpen) {
      const minsUntil = (TRADE_START_HOUR * 60 + TRADE_START_MINUTE) - (hour * 60 + minute);
      console.log(`${timeStr} ET - ${minsUntil} minutes until 9:35am window opens.`);
    } else {
      console.log(`${timeStr} ET - Trading window closed for today. See you tomorrow.`);
    }
    return;
  }

  console.log(`\nChecking signals at ${timeStr} ET...`);

  try {
    const nq = await getQuote("NQ%3DF");
    const nqFast = ema(nq.closes, 9);
    const nqSlow = ema(nq.closes, 21);
    const nqBull = nqFast > nqSlow;
    const nqBear = nqFast < nqSlow;

    console.log(`NQ Bias: ${nqBull ? "BULLISH" : nqBear ? "BEARISH" : "FLAT"}`);

    await analyzeTicker("QQQ", nqBull, nqBear);
    await analyzeTicker("SPY", nqBull, nqBear);

  } catch (e) {
    console.error("Error checking signals:", e.message);
  }
}

console.log("God Mode Sniper Alert System running...");
console.log("Monitoring: QQQ and SPY");
console.log("Trading window: 9:35am - 1:00pm ET");
console.log("Checking every 1 minute");
await notify("God Mode Sniper Started", "Monitoring QQQ and SPY. Window opens 9:35am ET.");

checkSignals();
setInterval(checkSignals, CHECK_INTERVAL);