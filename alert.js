import fetch from 'node-fetch';

const PUSHOVER_TOKEN = 'a8t6fp9e6bptutj7oqeg3undvgfjhh';
const PUSHOVER_USER = 'up3zcqrqy5g8ei3ixyg533zzcwmu2g';
const POLYGON_KEY = 'AN03qYvyJcOwoFLfmLIsuTKIU0rIT6cH';

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
        sound: priority >= 1 ? 'cashregister' : 'pushover'
      })
    });
    const data = await res.json();
    if (data.status === 1) console.log(`Notification sent: ${title}`);
    else console.log(`Notification failed: ${JSON.stringify(data)}`);
  } catch (e) {
    console.error('Pushover error:', e.message);
  }
}

function getETTime() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return { hour: et.getHours(), minute: et.getMinutes(), et };
}

function inTradingWindow() {
  const { hour, minute } = getETTime();
  const afterStart = hour > TRADE_START_HOUR || (hour === TRADE_START_HOUR && minute >= TRADE_START_MINUTE);
  const beforeEnd = hour < TRADE_END_HOUR;
  return afterStart && beforeEnd;
}

// === POLYGON DATA ===
async function getPolygonBars(ticker, multiplier, timespan, limit = 100) {
  const to = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=${limit}&apiKey=${POLYGON_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.results || data.results.length === 0) throw new Error(`No data for ${ticker}`);
  return data.results;
}

async function getPolygonSnapshot(ticker) {
  const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${POLYGON_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.ticker;
}

async function getOptionsFlow(ticker) {
  try {
    const url = `https://api.polygon.io/v3/snapshot/options/${ticker}?limit=10&sort=open_interest&order=desc&apiKey=${POLYGON_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.results) return null;
    const calls = data.results.filter(o => o.details?.contract_type === 'call').slice(0, 3);
    const puts = data.results.filter(o => o.details?.contract_type === 'put').slice(0, 3);
    return { calls, puts };
  } catch (e) {
    return null;
  }
}

// === INDICATORS ===
function ema(data, period) {
  const k = 2 / (period + 1);
  let val = data[0];
  for (let i = 1; i < data.length; i++) val = data[i] * k + val * (1 - k);
  return val;
}

function sma(data, period) {
  const slice = data.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcADX(bars, period = 14) {
  if (bars.length < period + 1) return { adx: 0, plusDI: 0, minusDI: 0 };
  let plusDMs = [], minusDMs = [], trs = [];
  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].h - bars[i-1].h;
    const downMove = bars[i-1].l - bars[i].l;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i-1].c), Math.abs(bars[i].l - bars[i-1].c));
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

function calcVWAP(bars) {
  let cumTPV = 0, cumVol = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    cumTPV += tp * b.v;
    cumVol += b.v;
  }
  return cumTPV / cumVol;
}

// === FEAR AND GREED ===
async function getFearAndGreed() {
  try {
    const res = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata');
    const data = await res.json();
    const score = Math.round(data.fear_and_greed.score);
    const rating = data.fear_and_greed.rating;
    return { score, rating };
  } catch (e) {
    return { score: 50, rating: 'unknown' };
  }
}

// === ECONOMIC CALENDAR ===
async function checkMacroEvents() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const url = `https://api.polygon.io/vX/reference/financials?date=${today}&apiKey=${POLYGON_KEY}`;
    // Use a known economic events list since Polygon doesn't have a calendar endpoint
    // Check for known high impact dates manually via news
    const newsUrl = `https://api.polygon.io/v2/reference/news?published_utc.gte=${today}&limit=10&apiKey=${POLYGON_KEY}`;
    const newsRes = await fetch(newsUrl);
    const newsData = await newsRes.json();
    const keywords = ['fomc', 'federal reserve', 'cpi', 'inflation', 'jobs report', 'nonfarm', 'gdp', 'interest rate'];
    const alerts = [];
    if (newsData.results) {
      for (const article of newsData.results) {
        const title = article.title.toLowerCase();
        for (const kw of keywords) {
          if (title.includes(kw)) {
            alerts.push(article.title);
            break;
          }
        }
      }
    }
    return alerts;
  } catch (e) {
    return [];
  }
}

// === MORNING BRIEFING ===
async function sendMorningBriefing() {
  try {
    console.log('Sending morning briefing...');

    const [qqqSnap, spySnap, fg, macroEvents] = await Promise.all([
      getPolygonSnapshot('QQQ'),
      getPolygonSnapshot('SPY'),
      getFearAndGreed(),
      checkMacroEvents()
    ]);

    const qqqChange = qqqSnap?.todaysChangePerc?.toFixed(2) || '0';
    const spyChange = spySnap?.todaysChangePerc?.toFixed(2) || '0';
    const qqqPrice = qqqSnap?.day?.c?.toFixed(2) || 'N/A';
    const spyPrice = spySnap?.day?.c?.toFixed(2) || 'N/A';

    let macroWarning = macroEvents.length > 0
      ? `MACRO ALERT: ${macroEvents[0]}`
      : 'No major macro events detected';

    const fgWarning = fg.score < 25 ? 'EXTREME FEAR - high volatility expected' :
                      fg.score > 75 ? 'EXTREME GREED - potential reversal risk' :
                      `Fear/Greed: ${fg.score} (${fg.rating})`;

    const message = `QQQ: $${qqqPrice} (${qqqChange}%)\nSPY: $${spyPrice} (${spyChange}%)\n${fgWarning}\n${macroWarning}\nWindow opens in 5 minutes`;

    await notify('Good Morning - Market Briefing', message, 0);
  } catch (e) {
    console.error('Morning briefing error:', e.message);
  }
}

// === ANALYZE TICKER ===
async function analyzeTicker(ticker, nqBull, nqBear) {
  // 3 minute bars for signal
  const bars3m = await getPolygonBars(ticker, 3, 'minute', 100);
  const closes3m = bars3m.map(b => b.c);
  const price = closes3m[closes3m.length - 1];

  // 15 minute bars for HTF confirmation
  const bars15m = await getPolygonBars(ticker, 15, 'minute', 50);
  const closes15m = bars15m.map(b => b.c);
  const htfFast = ema(closes15m, 9);
  const htfSlow = ema(closes15m, 21);
  const htfBull = htfFast > htfSlow;
  const htfBear = htfFast < htfSlow;

  // Indicators on 3min bars
  const fast = ema(closes3m, 9);
  const slow = ema(closes3m, 21);
  const vwap = calcVWAP(bars3m);
  const rsi = calcRSI(closes3m, 14);
  const { adx } = calcADX(bars3m, 14);
  const volumes = bars3m.map(b => b.v);
  const volAvg = sma(volumes, 20);
  const currentVol = volumes[volumes.length - 1];

  let longScore = 0;
  if (fast > slow) longScore++;
  if (price > vwap) longScore++;
  if (rsi > 55) longScore++;
  if (adx > 20) longScore++;
  if (currentVol > volAvg) longScore++;
  if (nqBull) longScore++;
  if (htfBull) longScore++;

  let shortScore = 0;
  if (fast < slow) shortScore++;
  if (price < vwap) shortScore++;
  if (rsi < 45) shortScore++;
  if (adx > 20) shortScore++;
  if (currentVol > volAvg) shortScore++;
  if (nqBear) shortScore++;
  if (htfBear) shortScore++;

  console.log(`${ticker}: $${price.toFixed(2)} | EMA9: ${fast.toFixed(2)} | EMA21: ${slow.toFixed(2)} | VWAP: ${vwap.toFixed(2)} | RSI: ${rsi.toFixed(1)} | ADX: ${adx.toFixed(1)} | HTF: ${htfBull ? 'BULL' : htfBear ? 'BEAR' : 'FLAT'}`);
  console.log(`${ticker} Long: ${longScore}/7 | Short: ${shortScore}/7`);

  if (longScore >= 5 && nqBull && htfBull) {
    const priority = longScore >= 6 ? 1 : 0;
    console.log(`>>> ${ticker} LONG SIGNAL ${longScore}/7 <<<`);
    await notify(
      `GOD MODE ${longScore}/7 - ${ticker} CALL`,
      `${ticker} CALL signal\nScore: ${longScore}/7\nPrice: $${price.toFixed(2)}\nRSI: ${rsi.toFixed(1)}\nADX: ${adx.toFixed(1)}\nHTF: BULLISH\nNQ: BULLISH`,
      priority
    );
  } else if (shortScore >= 5 && nqBear && htfBear) {
    const priority = shortScore >= 6 ? 1 : 0;
    console.log(`>>> ${ticker} SHORT SIGNAL ${shortScore}/7 <<<`);
    await notify(
      `GOD MODE ${shortScore}/7 - ${ticker} PUT`,
      `${ticker} PUT signal\nScore: ${shortScore}/7\nPrice: $${price.toFixed(2)}\nRSI: ${rsi.toFixed(1)}\nADX: ${adx.toFixed(1)}\nHTF: BEARISH\nNQ: BEARISH`,
      priority
    );
  } else {
    console.log(`${ticker} - No signal.`);
  }
}

// === MAIN LOOP ===
let briefingSent = false;

async function checkSignals() {
  const { hour, minute, et } = getETTime();
  const timeStr = et.toLocaleTimeString("en-US");

  // Morning briefing at 9:30am
  if (hour === 9 && minute === 30 && !briefingSent) {
    briefingSent = true;
    await sendMorningBriefing();
  }

  // Reset briefing flag at midnight
  if (hour === 0 && minute === 0) briefingSent = false;

  if (!inTradingWindow()) {
    const beforeOpen = hour < 9 || (hour === 9 && minute < 35);
    if (beforeOpen) {
      const minsUntil = (TRADE_START_HOUR * 60 + TRADE_START_MINUTE) - (hour * 60 + minute);
      console.log(`${timeStr} ET - ${minsUntil} minutes until 9:35am window opens.`);
    } else {
      console.log(`${timeStr} ET - Trading window closed. See you tomorrow.`);
    }
    return;
  }

  console.log(`\nChecking signals at ${timeStr} ET...`);

  try {
    // Check macro events before trading
    const macroEvents = await checkMacroEvents();
    if (macroEvents.length > 0) {
      console.log(`MACRO WARNING: ${macroEvents[0]} - signals suppressed`);
      await notify('MACRO EVENT WARNING', `Do not trade: ${macroEvents[0]}`, 1);
      return;
    }

    // Fear and greed check
    const fg = await getFearAndGreed();
    console.log(`Fear/Greed: ${fg.score} (${fg.rating})`);

    // NQ futures bias
    const nqBars = await getPolygonBars('NQ', 3, 'minute', 50);
    const nqCloses = nqBars.map(b => b.c);
    const nqFast = ema(nqCloses, 9);
    const nqSlow = ema(nqCloses, 21);
    const nqBull = nqFast > nqSlow;
    const nqBear = nqFast < nqSlow;
    console.log(`NQ Bias: ${nqBull ? 'BULLISH' : nqBear ? 'BEARISH' : 'FLAT'}`);

    // Analyze both tickers
    await analyzeTicker('QQQ', nqBull, nqBear);
    await analyzeTicker('SPY', nqBull, nqBear);

    // Options flow
    const qqqFlow = await getOptionsFlow('QQQ');
    if (qqqFlow) {
      const topCall = qqqFlow.calls[0];
      const topPut = qqqFlow.puts[0];
      if (topCall) console.log(`QQQ Top Call OI: ${topCall.details?.strike_price} strike - ${topCall.open_interest} OI`);
      if (topPut) console.log(`QQQ Top Put OI: ${topPut.details?.strike_price} strike - ${topPut.open_interest} OI`);
    }

  } catch (e) {
    console.error('Error checking signals:', e.message);
  }
}

console.log('God Mode Sniper v3 - Polygon Edition');
console.log('Monitoring: QQQ and SPY');
console.log('Data: Polygon.io real-time');
console.log('Window: 9:35am - 1:00pm ET');
console.log('Indicators: 3min bars, 15min HTF, ADX, RSI, VWAP, Volume, NQ Futures');
await notify('God Mode Sniper v3 Started', 'Polygon data. Morning briefing at 9:30am ET daily.');

checkSignals();
setInterval(checkSignals, CHECK_INTERVAL);