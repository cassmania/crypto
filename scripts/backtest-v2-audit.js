const fs = require("fs");
const path = require("path");

const API = "https://fapi.binance.com";
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT"];
const TIMEFRAMES = ["1h", "4h", "8h", "12h", "1d"];
const MAX_CANDLES = 5000;
const HOLDOUT_RATIO = 0.4;
const COST = Object.freeze({ feeRate: 0.0004, slippageRate: 0.0002 });
const SETTINGS = Object.freeze({
  lookback: 100,
  bins: 30,
  smoothLength: 10,
  smoothStages: 2,
  atrLength: 14,
  sensitivity: 0.15,
  retest: 0.35,
  sl: 1.5,
  tp: 3
});
const INTERVAL_MS = Object.freeze({
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "8h": 8 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000
});

function ema(values, length) {
  const alpha = 2 / (length + 1);
  const result = [];
  values.forEach((value, index) => {
    result[index] = index === 0 ? value : value * alpha + result[index - 1] * (1 - alpha);
  });
  return result;
}

function rma(values, length) {
  const result = Array(values.length).fill(null);
  if (values.length < length) return result;
  let average = values.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  result[length - 1] = average;
  for (let index = length; index < values.length; index++) {
    average = (average * (length - 1) + values[index]) / length;
    result[index] = average;
  }
  return result;
}

function rsi(values, length = 14) {
  const result = Array(values.length).fill(null);
  if (values.length <= length) return result;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= length; index++) {
    const difference = values[index] - values[index - 1];
    averageGain += Math.max(difference, 0);
    averageLoss += Math.max(-difference, 0);
  }
  averageGain /= length;
  averageLoss /= length;
  const calculate = () => {
    if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
    return 100 - 100 / (1 + averageGain / averageLoss);
  };
  result[length] = calculate();
  for (let index = length + 1; index < values.length; index++) {
    const difference = values[index] - values[index - 1];
    averageGain = (averageGain * (length - 1) + Math.max(difference, 0)) / length;
    averageLoss = (averageLoss * (length - 1) + Math.max(-difference, 0)) / length;
    result[index] = calculate();
  }
  return result;
}

function atr(candles, length = 14) {
  const trueRanges = candles.map((candle, index) => {
    const previousClose = candles[index - 1]?.close ?? candle.close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });
  return rma(trueRanges, length);
}

function macd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  const line = values.map((_, index) => fast[index] - slow[index]);
  const signal = ema(line, 9);
  return { line, signal, histogram: line.map((value, index) => value - signal[index]) };
}

function rollingMean(values, length) {
  const result = Array(values.length).fill(null);
  let sum = 0;
  for (let index = 0; index < values.length; index++) {
    sum += values[index];
    if (index >= length) sum -= values[index - length];
    if (index >= length - 1) result[index] = sum / length;
  }
  return result;
}

function bollinger(values, length = 20) {
  const result = Array(values.length).fill(null);
  for (let index = length - 1; index < values.length; index++) {
    const slice = values.slice(index - length + 1, index + 1);
    const middle = slice.reduce((sum, value) => sum + value, 0) / length;
    const variance = slice.reduce((sum, value) => sum + (value - middle) ** 2, 0) / length;
    const deviation = Math.sqrt(variance);
    result[index] = { upper: middle + deviation * 2, middle, lower: middle - deviation * 2 };
  }
  return result;
}

function volumeProfile(candles, bins = SETTINGS.bins) {
  const low = Math.min(...candles.map((candle) => candle.low));
  const high = Math.max(...candles.map((candle) => candle.high));
  const size = (high - low) / bins || 1;
  const rows = Array.from({ length: bins }, (_, index) => ({
    price: low + size * (index + 0.5),
    volume: 0,
    index
  }));

  candles.forEach((candle) => {
    const first = Math.max(0, Math.min(bins - 1, Math.floor((candle.low - low) / size)));
    const last = Math.max(0, Math.min(bins - 1, Math.floor((candle.high - low) / size)));
    if (first === last || candle.high === candle.low) {
      rows[first].volume += candle.volume;
      return;
    }
    let overlapTotal = 0;
    const overlaps = [];
    for (let index = first; index <= last; index++) {
      const rowLow = low + index * size;
      const rowHigh = rowLow + size;
      const overlap = Math.max(0, Math.min(candle.high, rowHigh) - Math.max(candle.low, rowLow));
      overlaps.push({ index, overlap });
      overlapTotal += overlap;
    }
    overlaps.forEach(({ index, overlap }) => {
      rows[index].volume += candle.volume * (overlap / Math.max(overlapTotal, 1e-9));
    });
  });

  return rows.reduce((highest, row) => row.volume > highest.volume ? row : highest, rows[0]);
}

function dynamicPoc(candles, settings = SETTINGS) {
  const atrValues = atr(candles, settings.atrLength);
  const raw = candles.map((_, index) => {
    const window = candles.slice(Math.max(0, index - settings.lookback + 1), index + 1);
    return volumeProfile(window, settings.bins).price;
  });
  const filtered = [];
  raw.forEach((value, index) => {
    if (index === 0) {
      filtered.push(value);
      return;
    }
    const threshold = (atrValues[index] ?? 0) * settings.sensitivity;
    filtered.push(Math.abs(value - filtered[index - 1]) >= threshold ? value : filtered[index - 1]);
  });
  let smooth = [...filtered];
  for (let stage = 0; stage < settings.smoothStages; stage++) {
    smooth = ema(smooth, settings.smoothLength);
  }
  const upper = smooth.map((value, index) => Number.isFinite(atrValues[index]) ? value + atrValues[index] : null);
  const lower = smooth.map((value, index) => Number.isFinite(atrValues[index]) ? value - atrValues[index] : null);
  const signals = [];
  let lastSignalIndex = -10;
  const warmupIndex = Math.max(settings.lookback - 1, settings.atrLength - 1);

  for (let index = Math.max(3, warmupIndex); index < candles.length; index++) {
    const candle = candles[index];
    const previous = candles[index - 1];
    let longRetest = false;
    let shortRetest = false;
    for (let check = Math.max(0, index - 3); check < index; check++) {
      const tolerance = atrValues[check] * settings.retest;
      if (candles[check].low <= smooth[check] + tolerance && candles[check].close >= smooth[check]) longRetest = true;
      if (candles[check].high >= smooth[check] - tolerance && candles[check].close <= smooth[check]) shortRetest = true;
    }
    const longBreak = longRetest && previous.close <= upper[index - 1]
      && candle.close > upper[index] && candle.close > smooth[index];
    const shortBreak = shortRetest && previous.close >= lower[index - 1]
      && candle.close < lower[index] && candle.close < smooth[index];
    const type = longBreak ? "LONG" : shortBreak ? "SHORT" : null;
    if (!type || index - lastSignalIndex < 3) continue;
    const entryCandle = candles[index + 1];
    const entryPrice = entryCandle?.open ?? candle.close;
    const risk = atrValues[index];
    signals.push({
      type,
      signalIndex: index,
      entryIndex: entryCandle ? index + 1 : null,
      price: entryPrice,
      pending: !entryCandle,
      invalidation: type === "LONG" ? entryPrice - risk * settings.sl : entryPrice + risk * settings.sl,
      target: type === "LONG" ? entryPrice + risk * settings.tp : entryPrice - risk * settings.tp
    });
    lastSignalIndex = index;
  }
  return { smooth, signals };
}

function resolveTradeExit(candles, signal) {
  for (let index = signal.entryIndex; index < candles.length; index++) {
    const candle = candles[index];
    const stopGap = signal.type === "LONG"
      ? candle.open < signal.invalidation
      : candle.open > signal.invalidation;
    if (stopGap) return { exitIndex: index, exitPrice: candle.open, exitReason: "STOP_GAP" };
    const stopHit = signal.type === "LONG"
      ? candle.low <= signal.invalidation
      : candle.high >= signal.invalidation;
    const targetHit = signal.type === "LONG"
      ? candle.high >= signal.target
      : candle.low <= signal.target;
    if (stopHit) return { exitIndex: index, exitPrice: signal.invalidation, exitReason: "STOP" };
    if (targetHit) return { exitIndex: index, exitPrice: signal.target, exitReason: "TARGET" };
  }
  return null;
}

function simulateTrades(candles, signals, filter, startIndex, endIndex) {
  const trades = [];
  let occupiedUntil = -1;
  let openTrades = 0;
  for (const signal of signals) {
    if (signal.pending || signal.entryIndex < startIndex || signal.entryIndex >= endIndex || signal.entryIndex <= occupiedUntil) continue;
    if (!filter(signal)) continue;
    const risk = Math.abs(signal.price - signal.invalidation);
    if (!(risk > 0)) continue;
    const exit = resolveTradeExit(candles.slice(0, endIndex), signal);
    if (!exit) {
      openTrades += 1;
      continue;
    }
    const direction = signal.type === "LONG" ? 1 : -1;
    const grossPnl = direction * (exit.exitPrice - signal.price);
    const tradingCost = (signal.price + exit.exitPrice) * (COST.feeRate + COST.slippageRate);
    trades.push({ ...signal, ...exit, netR: (grossPnl - tradingCost) / risk });
    occupiedUntil = exit.exitIndex;
  }
  return { trades, openTrades };
}

function summarizeTrades(trades) {
  const wins = trades.filter((trade) => trade.netR > 0);
  const losses = trades.filter((trade) => trade.netR <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netR, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netR, 0));
  const totalR = trades.reduce((sum, trade) => sum + trade.netR, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const trade of trades) {
    equity += trade.netR;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }
  return {
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancyR: trades.length ? totalR / trades.length : 0,
    totalR,
    maxDrawdownR
  };
}

function createFilters(candles, dynamic) {
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const macdData = macd(closes);
  const bb = bollinger(closes, 20);
  const volumeSma20 = rollingMean(volumes, 20);
  const long = (signal) => signal.type === "LONG";
  const direction = (signal, bullish) => long(signal) ? bullish : !bullish;
  const definitions = {
    baseline: () => true,
    ema_trend: (signal) => direction(signal, ema20[signal.signalIndex] > ema50[signal.signalIndex]),
    rsi_regime: (signal) => {
      const value = rsi14[signal.signalIndex];
      return long(signal) ? value >= 50 && value <= 70 : value <= 50 && value >= 30;
    },
    macd_momentum: (signal) => direction(signal, macdData.histogram[signal.signalIndex] > 0),
    bollinger_mid: (signal) => {
      const row = bb[signal.signalIndex];
      return Boolean(row) && direction(signal, closes[signal.signalIndex] > row.middle);
    },
    volume_active: (signal) => {
      const index = signal.signalIndex;
      return Number.isFinite(volumeSma20[index]) && volumes[index] >= volumeSma20[index];
    }
  };
  definitions.ema_rsi = (signal) => definitions.ema_trend(signal) && definitions.rsi_regime(signal);
  definitions.ema_macd = (signal) => definitions.ema_trend(signal) && definitions.macd_momentum(signal);
  definitions.rsi_macd = (signal) => definitions.rsi_regime(signal) && definitions.macd_momentum(signal);
  definitions.ema_rsi_volume = (signal) => definitions.ema_trend(signal)
    && definitions.rsi_regime(signal) && definitions.volume_active(signal);
  return { definitions, indicators: { ema20, ema50, rsi14, macdData, bb, volumeSma20, dynamicPoc: dynamic.smooth } };
}

function directionalReliability(candles, indicators, startIndex, horizon = 3) {
  const closes = candles.map((candle) => candle.close);
  const rules = {
    ema20_50: (index) => Math.sign(indicators.ema20[index] - indicators.ema50[index]),
    rsi50: (index) => Number.isFinite(indicators.rsi14[index]) ? Math.sign(indicators.rsi14[index] - 50) : 0,
    macdHistogram: (index) => Math.sign(indicators.macdData.histogram[index]),
    bollingerMiddle: (index) => indicators.bb[index]
      ? Math.sign(closes[index] - indicators.bb[index].middle)
      : 0,
    dynamicPoc: (index) => Math.sign(closes[index] - indicators.dynamicPoc[index])
  };
  return Object.fromEntries(Object.entries(rules).map(([name, rule]) => {
    let samples = 0;
    let hits = 0;
    let directionalReturnBps = 0;
    for (let index = startIndex; index + horizon < candles.length; index++) {
      const prediction = rule(index);
      const futureReturn = closes[index + horizon] / closes[index] - 1;
      if (!prediction || !Number.isFinite(futureReturn) || futureReturn === 0) continue;
      samples += 1;
      if (Math.sign(futureReturn) === prediction) hits += 1;
      directionalReturnBps += futureReturn * prediction * 10000;
    }
    return [name, {
      horizonBars: horizon,
      samples,
      hitRate: samples ? hits / samples * 100 : 0,
      averageDirectionalReturnBps: samples ? directionalReturnBps / samples : 0
    }];
  }));
}

function auditCandles(candles, timeframe) {
  const expected = INTERVAL_MS[timeframe];
  let gaps = 0;
  let duplicates = 0;
  let invalidOhlc = 0;
  let nonPositivePrice = 0;
  let zeroVolume = 0;
  const seen = new Set();
  candles.forEach((candle, index) => {
    if (seen.has(candle.time)) duplicates += 1;
    seen.add(candle.time);
    if (index > 0 && candle.time - candles[index - 1].time !== expected) gaps += 1;
    if (candle.high < Math.max(candle.open, candle.close)
      || candle.low > Math.min(candle.open, candle.close)
      || candle.high < candle.low) invalidOhlc += 1;
    if (Math.min(candle.open, candle.high, candle.low, candle.close) <= 0) nonPositivePrice += 1;
    if (candle.volume <= 0) zeroVolume += 1;
  });
  return { candles: candles.length, gaps, duplicates, invalidOhlc, nonPositivePrice, zeroVolume };
}

async function fetchJson(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "crypto-dashboard-backtest-audit/2.0" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function fetchServerTime() {
  const data = await fetchJson(`${API}/fapi/v1/time`);
  return Number(data.serverTime);
}

async function fetchCandles(symbol, timeframe, serverTime) {
  const collected = [];
  let endTime = serverTime;
  for (let page = 0; page < 4 && collected.length < MAX_CANDLES; page++) {
    const params = new URLSearchParams({
      symbol,
      interval: timeframe,
      limit: "1500",
      endTime: String(endTime)
    });
    const batch = await fetchJson(`${API}/fapi/v1/klines?${params}`);
    if (!batch.length) break;
    collected.push(...batch);
    endTime = Number(batch[0][0]) - 1;
    if (batch.length < 1500) break;
  }
  const unique = new Map(collected
    .filter((row) => Number(row[6]) < serverTime)
    .map((row) => [Number(row[0]), {
      time: Number(row[0]),
      closeTime: Number(row[6]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5])
    }]));
  return [...unique.values()].sort((a, b) => a.time - b.time).slice(-MAX_CANDLES);
}

function aggregateRows(rows) {
  const trades = rows.flatMap((row) => row.trades);
  const summary = summarizeTrades(trades);
  return {
    ...summary,
    combinations: rows.length,
    positiveCombinations: rows.filter((row) => summarizeTrades(row.trades).expectancyR > 0).length,
    worstCombinationDrawdownR: Math.max(...rows.map((row) => summarizeTrades(row.trades).maxDrawdownR), 0)
  };
}

function roundDeep(value) {
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundDeep(item)]));
  }
  if (typeof value === "number" && Number.isFinite(value)) return Number(value.toFixed(6));
  return value;
}

async function main() {
  const serverTime = await fetchServerTime();
  const datasets = [];
  for (const timeframe of TIMEFRAMES) {
    for (const symbol of SYMBOLS) {
      process.stdout.write(`검사 중: ${symbol} ${timeframe}\n`);
      const candles = await fetchCandles(symbol, timeframe, serverTime);
      const splitIndex = Math.floor(candles.length * (1 - HOLDOUT_RATIO));
      const dynamic = dynamicPoc(candles);
      const { definitions, indicators } = createFilters(candles, dynamic);
      const training = {};
      const holdout = {};
      for (const [name, filter] of Object.entries(definitions)) {
        training[name] = simulateTrades(candles, dynamic.signals, filter, 0, splitIndex);
        holdout[name] = simulateTrades(candles, dynamic.signals, filter, splitIndex, candles.length);
      }
      datasets.push({
        symbol,
        timeframe,
        startTime: candles[0]?.time ?? null,
        endTime: candles.at(-1)?.closeTime ?? null,
        splitIndex,
        integrity: auditCandles(candles, timeframe),
        reliability: directionalReliability(candles, indicators, splitIndex),
        training,
        holdout
      });
    }
  }

  const candidateNames = Object.keys(datasets[0].training);
  const aggregate = { training: {}, holdout: {} };
  for (const name of candidateNames) {
    aggregate.training[name] = aggregateRows(datasets.map((dataset) => dataset.training[name]));
    aggregate.holdout[name] = aggregateRows(datasets.map((dataset) => dataset.holdout[name]));
  }
  const eligible = candidateNames
    .filter((name) => name !== "baseline" && aggregate.training[name].trades >= 150)
    .sort((a, b) => {
      const pfDifference = aggregate.training[b].profitFactor - aggregate.training[a].profitFactor;
      return pfDifference || aggregate.training[b].expectancyR - aggregate.training[a].expectancyR;
    });
  const selectedCandidate = eligible[0] ?? null;
  const baseline = aggregate.holdout.baseline;
  const selected = selectedCandidate ? aggregate.holdout[selectedCandidate] : null;
  const nonWorseCombinations = selectedCandidate
    ? datasets.filter((dataset) => {
      const candidateSummary = summarizeTrades(dataset.holdout[selectedCandidate].trades);
      const baselineSummary = summarizeTrades(dataset.holdout.baseline.trades);
      return candidateSummary.expectancyR >= baselineSummary.expectancyR;
    }).length
    : 0;
  const acceptance = selected ? {
    selectedCandidate,
    nonWorseCombinations,
    minimumTradesPassed: selected.trades >= 150,
    profitFactorImproved: selected.profitFactor > baseline.profitFactor,
    expectancyImproved: selected.expectancyR > baseline.expectancyR,
    drawdownNotWorse: selected.worstCombinationDrawdownR <= baseline.worstCombinationDrawdownR,
    majorityCombinationsNotWorse: nonWorseCombinations >= Math.ceil(datasets.length / 2)
  } : { selectedCandidate: null };
  acceptance.accepted = Boolean(selected
    && acceptance.minimumTradesPassed
    && acceptance.profitFactorImproved
    && acceptance.expectancyImproved
    && acceptance.drawdownNotWorse
    && acceptance.majorityCombinationsNotWorse);

  const compactDatasets = datasets.map((dataset) => ({
    symbol: dataset.symbol,
    timeframe: dataset.timeframe,
    startTime: dataset.startTime,
    endTime: dataset.endTime,
    splitIndex: dataset.splitIndex,
    integrity: dataset.integrity,
    reliability: dataset.reliability,
    training: Object.fromEntries(Object.entries(dataset.training).map(([name, result]) => [name, {
      ...summarizeTrades(result.trades),
      openTrades: result.openTrades
    }])),
    holdout: Object.fromEntries(Object.entries(dataset.holdout).map(([name, result]) => [name, {
      ...summarizeTrades(result.trades),
      openTrades: result.openTrades
    }]))
  }));

  const output = roundDeep({
    generatedAt: new Date().toISOString(),
    serverTime,
    source: "Binance USDT-M Futures API",
    assumptions: {
      confirmedCandlesOnly: true,
      symbols: SYMBOLS,
      timeframes: TIMEFRAMES,
      maximumCandles: MAX_CANDLES,
      holdoutRatio: HOLDOUT_RATIO,
      entry: "신호 확정 다음 봉 시가",
      feeEachSide: COST.feeRate,
      slippageEachSide: COST.slippageRate,
      sameBarPriority: "STOP",
      stopGap: "불리한 시가 체결",
      candidateSelection: "앞 60% 학습 구간 집계 Profit Factor 우선",
      minimumAcceptedHoldoutTrades: 150
    },
    settings: SETTINGS,
    aggregate,
    acceptance,
    datasets: compactDatasets
  });
  const outputPath = path.resolve(__dirname, "..", "backtest-v2-results.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`완료: ${outputPath}\n`);
  process.stdout.write(`${JSON.stringify(roundDeep({ aggregate, acceptance }), null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
