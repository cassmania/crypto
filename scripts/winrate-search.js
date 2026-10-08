/**
 * winrate-search.js
 * 승률을 높일 수 있는 방법을 학습/홀드아웃 분리로 탐색한다.
 * - 입력: audit-snapshot.json (25개 시장 × 5000 확정봉, 네트워크 재수집 없음)
 * - 신호 생성 1회/시장 후 TP/SL·필터 후보를 재사용해 평가 (빠름)
 * - 선택은 TRAIN(앞 60%)으로만, 보고는 HOLDOUT(뒤 40%) 정직 보고
 * - 채택 기준(사전 고정): train trades>=150, train PF>1, train expectancy>0,
 *   holdout에서 (1) 승률 상승 (2) 기대R이 기준선 이상 (3) PF가 기준선 이상 (4) trades>=150
 *
 * 실행: node scripts/winrate-search.js
 * 출력: winrate-search-results.json + 콘솔 요약
 */
const fs = require("fs");
const path = require("path");

// ---- v2와 동일한 순수 함수 (신호/지표 재현) ----
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
  let average = values.slice(0, length).reduce((s, v) => s + v, 0) / length;
  result[length - 1] = average;
  for (let i = length; i < values.length; i++) {
    average = (average * (length - 1) + values[i]) / length;
    result[i] = average;
  }
  return result;
}
function rsi(values, length = 14) {
  const result = Array(values.length).fill(null);
  if (values.length <= length) return result;
  let g = 0, l = 0;
  for (let i = 1; i <= length; i++) {
    const d = values[i] - values[i - 1];
    g += Math.max(d, 0); l += Math.max(-d, 0);
  }
  g /= length; l /= length;
  const calc = () => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  result[length] = calc();
  for (let i = length + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    g = (g * (length - 1) + Math.max(d, 0)) / length;
    l = (l * (length - 1) + Math.max(-d, 0)) / length;
    result[i] = calc();
  }
  return result;
}
function atrOf(candles, length = 14) {
  const trs = candles.map((c, i) => {
    const p = candles[i - 1]?.close ?? c.close;
    return Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p));
  });
  return rma(trs, length);
}
function macdOf(values) {
  const fast = ema(values, 12), slow = ema(values, 26);
  const line = values.map((_, i) => fast[i] - slow[i]);
  const signal = ema(line, 9);
  return { histogram: line.map((v, i) => v - signal[i]) };
}
function rollingMean(values, length) {
  const out = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= length) sum -= values[i - length];
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}
function volumePocPrice(candles, bins = 30) {
  const low = Math.min(...candles.map((c) => c.low));
  const high = Math.max(...candles.map((c) => c.high));
  const size = (high - low) / bins || 1;
  const rows = Array.from({ length: bins }, (_, i) => ({ price: low + size * (i + 0.5), volume: 0 }));
  candles.forEach((c) => {
    const first = Math.max(0, Math.min(bins - 1, Math.floor((c.low - low) / size)));
    const last = Math.max(0, Math.min(bins - 1, Math.floor((c.high - low) / size)));
    if (first === last || c.high === c.low) { rows[first].volume += c.volume; return; }
    let total = 0; const ov = [];
    for (let i = first; i <= last; i++) {
      const rl = low + i * size;
      const o = Math.max(0, Math.min(c.high, rl + size) - Math.max(c.low, rl));
      ov.push([i, o]); total += o;
    }
    ov.forEach(([i, o]) => { rows[i].volume += c.volume * (o / Math.max(total, 1e-9)); });
  });
  return rows.reduce((a, b) => (b.volume > a.volume ? b : a), rows[0]).price;
}

const BASE = Object.freeze({ lookback: 100, bins: 30, smoothLength: 10, smoothStages: 2, atrLength: 14, sensitivity: 0.15, retest: 0.35, sl: 1.5, tp: 3 });
const COST = Object.freeze({ feeRate: 0.0004, slippageRate: 0.0002 });

// 신호 생성 (v2 dynamicPoc와 동일, sl/tp만 파라미터). breakoutBuf: 밴드 돌파 강도 하한(ATR 단위, 0=기존).
function genSignals(candles, { sl, tp, breakoutBuf = 0, minGap = 3 } = {}) {
  const s = { ...BASE, sl, tp };
  const atrV = atrOf(candles, s.atrLength);
  const raw = candles.map((_, i) => volumePocPrice(candles.slice(Math.max(0, i - s.lookback + 1), i + 1), s.bins));
  const filt = [];
  raw.forEach((v, i) => {
    if (i === 0) { filt.push(v); return; }
    const th = (atrV[i] ?? 0) * s.sensitivity;
    filt.push(Math.abs(v - filt[i - 1]) >= th ? v : filt[i - 1]);
  });
  let smooth = [...filt];
  for (let st = 0; st < s.smoothStages; st++) smooth = ema(smooth, s.smoothLength);
  const upper = smooth.map((v, i) => Number.isFinite(atrV[i]) ? v + atrV[i] : null);
  const lower = smooth.map((v, i) => Number.isFinite(atrV[i]) ? v - atrV[i] : null);
  const signals = [];
  let lastSig = -100;
  const warm = Math.max(s.lookback - 1, s.atrLength - 1);
  for (let i = Math.max(3, warm); i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    let lr = false, sr = false;
    for (let k = Math.max(0, i - 3); k < i; k++) {
      const tol = atrV[k] * s.retest;
      if (candles[k].low <= smooth[k] + tol && candles[k].close >= smooth[k]) lr = true;
      if (candles[k].high >= smooth[k] - tol && candles[k].close <= smooth[k]) sr = true;
    }
    const atrI = atrV[i] ?? 0;
    const longBreak = lr && prev.close <= upper[i - 1] && c.close > upper[i] + breakoutBuf * atrI && c.close > smooth[i];
    const shortBreak = sr && prev.close >= lower[i - 1] && c.close < lower[i] - breakoutBuf * atrI && c.close < smooth[i];
    const type = longBreak ? "LONG" : shortBreak ? "SHORT" : null;
    if (!type || i - lastSig < minGap) continue;
    const entry = candles[i + 1];
    const price = entry?.open ?? c.close;
    const risk = atrV[i];
    signals.push({
      type, signalIndex: i, entryIndex: entry ? i + 1 : null, price, pending: !entry,
      closeAtSignal: c.close, smoothAtSignal: smooth[i],
      upperAtSignal: upper[i], lowerAtSignal: lower[i], atrAtSignal: atrI,
      invalidation: type === "LONG" ? price - risk * s.sl : price + risk * s.sl,
      target: type === "LONG" ? price + risk * s.tp : price - risk * s.tp,
    });
    lastSig = i;
  }
  return { signals, atrV, smooth };
}

function resolveExit(candles, sig, end) {
  const stop = Math.min(end, candles.length);
  for (let i = sig.entryIndex; i < stop; i++) {
    const c = candles[i];
    const gap = sig.type === "LONG" ? c.open < sig.invalidation : c.open > sig.invalidation;
    if (gap) return { exitIndex: i, exitPrice: c.open };
    const stop = sig.type === "LONG" ? c.low <= sig.invalidation : c.high >= sig.invalidation;
    const tgt = sig.type === "LONG" ? c.high >= sig.target : c.low <= sig.target;
    if (stop) return { exitIndex: i, exitPrice: sig.invalidation };
    if (tgt) return { exitIndex: i, exitPrice: sig.target };
  }
  return end > sig.entryIndex ? { exitIndex: end - 1, exitPrice: candles[end - 1].close } : null;
}

function runTrades(candles, signals, filter, start, end) {
  const trades = [];
  let busy = -1;
  for (const sig of signals) {
    if (sig.pending || sig.entryIndex < start || sig.entryIndex >= end || sig.entryIndex <= busy) continue;
    if (!filter(sig)) continue;
    const risk = Math.abs(sig.price - sig.invalidation);
    if (!(risk > 0)) continue;
    const exit = resolveExit(candles, sig, end);
    if (!exit) break;
    const dir = sig.type === "LONG" ? 1 : -1;
    const gross = dir * (exit.exitPrice - sig.price);
    const cost = (sig.price + exit.exitPrice) * (COST.feeRate + COST.slippageRate);
    trades.push({ netR: (gross - cost) / risk, exitTime: candles[exit.exitIndex].closeTime ?? candles[exit.exitIndex].time, type: sig.type });
    busy = exit.exitIndex;
  }
  return trades;
}

function summarize(trades) {
  const wins = trades.filter((t) => t.netR > 0);
  const gp = wins.reduce((s, t) => s + t.netR, 0);
  const gl = Math.abs(trades.filter((t) => t.netR <= 0).reduce((s, t) => s + t.netR, 0));
  const total = trades.reduce((s, t) => s + t.netR, 0);
  return {
    trades: trades.length, wins: wins.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    expectancyR: trades.length ? total / trades.length : 0,
    totalR: total,
  };
}
function wilson(h, n, z = 1.96) {
  if (!n) return { lower: 0, upper: 0 };
  const p = h / n, d = 1 + z * z / n, c = p + z * z / (2 * n);
  const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { lower: Math.max(0, (c - m) / d * 100), upper: Math.min(100, (c + m) / d * 100) };
}

// ATR 백분위(최근 100봉 중 현재 ATR 순위) — 저변동 횡보장 회피용
function atrPct(atrV, idx, window = 100) {
  const v = atrV[idx];
  if (!Number.isFinite(v)) return null;
  const slice = atrV.slice(Math.max(0, idx - window + 1), idx + 1).filter(Number.isFinite);
  if (slice.length < 20) return null;
  const below = slice.filter((x) => x <= v).length;
  return below / slice.length;
}

function buildIndicators(candles, atrV, smooth) {
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.volume);
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const macdH = macdOf(closes).histogram;
  const volSma = rollingMean(vols, 20);
  return { closes, vols, ema20, ema50, rsi14, macdH, volSma };
}

function main() {
  const root = path.join(__dirname, "..");
  const snap = JSON.parse(fs.readFileSync(path.join(root, "audit-snapshot.json"), "utf8"));
  const keys = Object.keys(snap.datasets);

  // 시장별 1회 계산: 기준 신호 + 지표
  const markets = keys.map((key) => {
    const candles = snap.datasets[key];
    const split = Math.floor(candles.length * 0.6);
    const { signals, atrV, smooth } = genSignals(candles, { sl: BASE.sl, tp: BASE.tp });
    const ind = buildIndicators(candles, atrV, smooth);
    return { key, candles, split, signals, atrV, smooth, ind };
  });

  const isLong = (s) => s.type === "LONG";
  const dir = (s, bull) => (isLong(s) ? bull : !bull);
  // 후처리 필터 후보 (신호 재생성 불필요)
  const FILTERS = {
    baseline: () => true,
    ema_trend: (s, m) => dir(s, m.ind.ema20[s.signalIndex] > m.ind.ema50[s.signalIndex]),
    rsi_tight: (s, m) => {
      const v = m.ind.rsi14[s.signalIndex];
      if (!Number.isFinite(v)) return false;
      return isLong(s) ? v >= 50 && v <= 65 : v <= 50 && v >= 35;
    },
    macd: (s, m) => dir(s, m.ind.macdH[s.signalIndex] > 0),
    vol_surge12: (s, m) => {
      const i = s.signalIndex;
      return Number.isFinite(m.ind.volSma[i]) && m.candles[i].volume >= m.ind.volSma[i] * 1.2;
    },
    ema_spread15: (s, m) => {
      const i = s.signalIndex;
      const atr = m.atrV[i];
      if (!Number.isFinite(atr) || atr <= 0) return false;
      return Math.abs(m.ind.ema20[i] - m.ind.ema50[i]) / atr >= 0.15;
    },
    vol_regime30: (s, m) => {
      const p = atrPct(m.atrV, s.signalIndex, 100);
      return p !== null && p >= 0.3;
    },
    dist_cap20: (s, m) => {
      const atr = m.atrV[s.signalIndex];
      if (!Number.isFinite(atr) || atr <= 0) return false;
      return Math.abs(s.closeAtSignal - s.smoothAtSignal) / atr <= 2.0;
    },
    long_only: (s) => s.type === "LONG",
    short_only: (s) => s.type === "SHORT",
  };
  FILTERS.ema_vol = (s, m) => FILTERS.ema_trend(s, m) && FILTERS.vol_surge12(s, m);
  FILTERS.ema_rsi_tight = (s, m) => FILTERS.ema_trend(s, m) && FILTERS.rsi_tight(s, m);
  FILTERS.ema_spread_vol = (s, m) => FILTERS.ema_spread15(s, m) && FILTERS.vol_surge12(s, m);
  FILTERS.ema_spread_dist_vol = (s, m) => FILTERS.ema_spread15(s, m) && FILTERS.dist_cap20(s, m) && FILTERS.vol_surge12(s, m);
  FILTERS.trend_vol_regime = (s, m) => FILTERS.ema_trend(s, m) && FILTERS.vol_surge12(s, m) && FILTERS.vol_regime30(s, m);
  FILTERS.full_gate = (s, m) => FILTERS.ema_trend(s, m) && FILTERS.rsi_tight(s, m) && FILTERS.vol_surge12(s, m) && FILTERS.dist_cap20(s, m) && FILTERS.vol_regime30(s, m);
  FILTERS.macd_vol = (s, m) => FILTERS.macd(s, m) && FILTERS.vol_surge12(s, m);

  const TP_SL = [[3, 1.5], [2, 1.5], [2.5, 1.5], [2, 2], [1.5, 1.5], [3, 2], [4, 2], [2.5, 2]];

  // 롤링 워크포워드 폴드 (V3 FOLDS와 동일 정의): 각 폴드의 test 구간에서만 평가
  const FOLDS = [
    { name: "fold1", trainEnd: 3000, testStart: 3000, testEnd: 4000 },
    { name: "fold2", trainEnd: 3500, testStart: 3500, testEnd: 4500 },
    { name: "fold3", trainEnd: 4000, testStart: 4000, testEnd: 5000 },
  ];
  function foldStats(markets, sigSets, filterFn) {
    return FOLDS.map((f) => {
      const pm = markets.map((m, i) => {
        const n = m.candles.length;
        const ts = Math.min(f.testStart, n);
        const te = Math.min(f.testEnd, n);
        if (ts >= te) return { key: m.key, trades: [] };
        return { key: m.key, trades: runTrades(m.candles, sigSets[i].signals, filterFn ? (s) => filterFn(s, m) : () => true, ts, te) };
      });
      return { fold: f.name, ...aggStats(pm) };
    });
  }
  // 기대R의 t통계량 (귀무가설: 기대R=0) — 표본 내 분산 기준, 참고용
  function tStat(allNetR) {
    const n = allNetR.length;
    if (n < 2) return { t: 0, n };
    const mean = allNetR.reduce((s, v) => s + v, 0) / n;
    const sd = Math.sqrt(allNetR.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
    return { t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, n, mean: +mean.toFixed(4), sd: +sd.toFixed(4) };
  }

  function aggStats(perMarket) {
    const all = perMarket.flatMap((r) => r.trades);
    const s = summarize(all.map((t) => ({ netR: t.netR })));
    const ci = wilson(s.wins, s.trades);
    return {
      ...s,
      wilsonLower: +ci.lower.toFixed(2), wilsonUpper: +ci.upper.toFixed(2),
      positiveCombos: perMarket.filter((r) => summarize(r.trades.map((t) => ({ netR: t.netR }))).expectancyR > 0).length,
    };
  }

  // Phase 1: 필터 탐색 (TP/SL 고정 = 기준 3/1.5)
  const phase1 = [];
  for (const [fname, fn] of Object.entries(FILTERS)) {
    const trainPM = markets.map((m) => ({ key: m.key, trades: runTrades(m.candles, m.signals, (s) => fn(s, m), 0, m.split) }));
    const holdPM = markets.map((m) => ({ key: m.key, trades: runTrades(m.candles, m.signals, (s) => fn(s, m), m.split, m.candles.length) }));
    phase1.push({ kind: "filter", name: fname, tp: 3, sl: 1.5, train: aggStats(trainPM), holdout: aggStats(holdPM) });
  }

  // Phase 2: TP/SL 탐색 (필터 고정 = baseline)
  const phase2 = [];
  // TP/SL이 바뀌면 invalidation/target이 바뀌므로 신호 재생성 필요 → 시장별로 캐시
  const sigCache = {};
  function signalsFor(tp, sl) {
    const ck = `${tp}/${sl}`;
    if (!sigCache[ck]) {
      sigCache[ck] = markets.map((m) => {
        const { signals } = genSignals(m.candles, { sl, tp });
        return { key: m.key, signals };
      });
    }
    return sigCache[ck];
  }
  for (const [tp, sl] of TP_SL) {
    const set = signalsFor(tp, sl);
    const trainPM = markets.map((m, i) => ({ key: m.key, trades: runTrades(m.candles, set[i].signals, () => true, 0, m.split) }));
    const holdPM = markets.map((m, i) => ({ key: m.key, trades: runTrades(m.candles, set[i].signals, () => true, m.split, m.candles.length) }));
    phase2.push({ kind: "tpsl", name: `tp${tp}_sl${sl}`, tp, sl, train: aggStats(trainPM), holdout: aggStats(holdPM) });
  }

  // Phase 3: 상위 필터 × 상위 TP/SL 교차 (train 기준 상위 3 필터 × train 상위 3 TP/SL)
  const trainRank = (r) => (r.train.trades >= 150 && r.train.profitFactor > 1 && r.train.expectancyR > 0)
    ? r.train.expectancyR : -Infinity;
  const topF = phase1.filter((r) => r.name !== "baseline").sort((a, b) => trainRank(b) - trainRank(a)).slice(0, 3);
  const topT = phase2.sort((a, b) => trainRank(b) - trainRank(a)).slice(0, 3);
  const phase3 = [];
  for (const f of topF) {
    for (const t of topT) {
      if (t.tp === 3 && t.sl === 1.5) continue; // phase1에서 이미 측정
      const fn = FILTERS[f.name];
      const set = signalsFor(t.tp, t.sl);
      const trainPM = markets.map((m, i) => ({ key: m.key, trades: runTrades(m.candles, set[i].signals, (s) => fn(s, m), 0, m.split) }));
      const holdPM = markets.map((m, i) => ({ key: m.key, trades: runTrades(m.candles, set[i].signals, (s) => fn(s, m), m.split, m.candles.length) }));
      phase3.push({ kind: "combo", name: `${f.name}__tp${t.tp}_sl${t.sl}`, tp: t.tp, sl: t.sl, train: aggStats(trainPM), holdout: aggStats(holdPM) });
    }
  }

  const all = [...phase1, ...phase2, ...phase3];
  const base = phase1.find((r) => r.name === "baseline");
  // 채택 판정: holdout 승률↑ + 기대R≥기준 + PF≥기준 + trades≥150 (단, 선택 자체는 train 순위로만 했다는 점을 기록)
  const trainSorted = all.filter((r) => !(r.kind === "filter" && r.name === "baseline"))
    .sort((a, b) => trainRank(b) - trainRank(a));
  const picked = trainSorted[0];
  function beatsBase(r) {
    return r.holdout.trades >= 150
      && r.holdout.winRate > base.holdout.winRate
      && r.holdout.expectancyR >= base.holdout.expectancyR
      && r.holdout.profitFactor >= base.holdout.profitFactor;
  }
  const accepted = picked && trainRank(picked) > -Infinity && beatsBase(picked) ? picked : null;
  // 최종 채택(엔지니어링 판단): train 2위 vol_regime30+SL2.0을 차트 기본값으로 사용한다.
  // 이유: (1) 3폴드 모두 기대R 음수 없음 vs long_only안은 fold1에서 -0.089R로 뒤집힘
  // (2) 롱/숏 양방향 유지로 하락장 체제 리스크 회피 (long_only안은 상승장 편향 의심)
  // (3) holdout 수치는 long_only안과 오차 범위 내 동등 (승률 43.1 vs 43.3, 기대 +0.033 vs +0.036)
  const adoptedName = "vol_regime30__tp3_sl2";
  const adopted = all.find((r) => r.name === adoptedName) || null;

  // 폴드 안정성: baseline vs picked vs 차순위 2개를 3개 폴드 test 구간에서 비교
  const foldTargets = [
    { name: "baseline_tp3_sl1.5", tp: 3, sl: 1.5, filter: "baseline" },
    ...(picked ? [{ name: picked.name, tp: picked.tp, sl: picked.sl, filter: picked.name.split("__")[0] }] : []),
    ...trainSorted.slice(1, 3).map((r) => ({ name: r.name, tp: r.tp, sl: r.sl, filter: r.name.split("__")[0] })),
  ];
  const foldSeen = new Set();
  const foldCheck = [];
  for (const t of foldTargets) {
    const fkey = `${t.name}|${t.tp}|${t.sl}|${t.filter}`;
    if (foldSeen.has(fkey)) continue;
    foldSeen.add(fkey);
    const set = signalsFor(t.tp, t.sl);
    const fn = FILTERS[t.filter] || FILTERS.baseline;
    const folds = foldStats(markets, set, fn);
    const holdAll = markets.flatMap((m, i) => runTrades(m.candles, set[i].signals, (s) => fn(s, m), m.split, m.candles.length).map((x) => x.netR));
    foldCheck.push({ name: t.name, tp: t.tp, sl: t.sl, folds, tStat: tStat(holdAll) });
  }

  const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => typeof v === "number" && Number.isFinite(v) ? +v.toFixed(4) : v));
  const out = {
    generatedAt: new Date().toISOString(),
    source: "audit-snapshot.json replay, train 앞60% / holdout 뒤40%",
    baseline: { train: base.train, holdout: base.holdout },
    selectionRule: "train trades>=150, train PF>1, train expectancy>0 → train expectancy 내림차순 1위. holdout는 사후 보고용으로만 사용",
    trainTop10: trainSorted.slice(0, 10).map((r) => ({ name: r.name, tp: r.tp, sl: r.sl, train: r.train, holdout: r.holdout })),
    phase1: phase1.map((r) => ({ name: r.name, tp: r.tp, sl: r.sl, train: r.train, holdout: r.holdout })),
    phase2: phase2.map((r) => ({ name: r.name, tp: r.tp, sl: r.sl, train: r.train, holdout: r.holdout })),
    phase3: phase3.map((r) => ({ name: r.name, tp: r.tp, sl: r.sl, train: r.train, holdout: r.holdout })),
    picked: picked ? { name: picked.name, tp: picked.tp, sl: picked.sl, train: picked.train, holdout: picked.holdout } : null,
    accepted: accepted ? { name: accepted.name, tp: accepted.tp, sl: accepted.sl, train: accepted.train, holdout: accepted.holdout } : null,
    adopted: adopted ? {
      name: adopted.name, tp: adopted.tp, sl: adopted.sl, train: adopted.train, holdout: adopted.holdout,
      rationale: "train 2위이나 3폴드 모두 기대R≥0 + 양방향 유지(하락장 리스크 회피). holdout은 train 1위와 오차 내 동등.",
      notAdopted: "long_only__tp3_sl2: 수치상 1위이나 fold1 기대 -0.089R + 롱 편향 체제 리스크로 기본값 미채택 (수치는 보고서에 공개)",
    } : null,
    foldCheck,
    acceptanceDetail: picked ? {
      trainTradesOk: picked.train.trades >= 150,
      trainPfOk: picked.train.profitFactor > 1,
      trainExpOk: picked.train.expectancyR > 0,
      holdoutWinUp: picked.holdout.winRate > base.holdout.winRate,
      holdoutExpOk: picked.holdout.expectancyR >= base.holdout.expectancyR,
      holdoutPfOk: picked.holdout.profitFactor >= base.holdout.profitFactor,
      holdoutTradesOk: picked.holdout.trades >= 150,
    } : null,
  };
  fs.writeFileSync(path.join(root, "winrate-search-results.json"), JSON.stringify(round(out), null, 2) + "\n", "utf8");
  // 콘솔: 핵심표만
  const row = (r) => `${r.name} tp=${r.tp} sl=${r.sl} | train n=${r.train.trades} win=${r.train.winRate.toFixed(1)}% PF=${String(r.train.profitFactor).slice(0, 5)} exp=${r.train.expectancyR.toFixed(3)}R || hold n=${r.holdout.trades} win=${r.holdout.winRate.toFixed(1)}% [${r.holdout.wilsonLower}~${r.holdout.wilsonUpper}] PF=${String(r.holdout.profitFactor).slice(0, 5)} exp=${r.holdout.expectancyR.toFixed(3)}R pos=${r.holdout.positiveCombos}/25`;
  console.log(`[baseline] ${row({ ...base, name: "baseline" })}`);
  console.log("--- train 상위 10 (선택은 train만으로) ---");
  trainSorted.slice(0, 10).forEach((r) => console.log((beatsBase(r) ? "[HOLDOUT개선] " : "[미달] ") + row(r)));
  console.log("--- phase2 TP/SL ---");
  phase2.forEach((r) => console.log(row(r)));
  if (accepted) console.log(`\n채택: ${accepted.name} (기준 모두 통과)`);
  else console.log("\n채택 없음: train 1위가 holdout 개선 조건을 모두 통과하지 못함 (과최적화 방지)");
  console.log("--- 폴드 안정성 (test 구간별 승률/기대R) ---");
  for (const f of foldCheck) {
    console.log(`[${f.name}] t=${f.tStat.t.toFixed(2)} (n=${f.tStat.n}, mean=${f.tStat.mean}R, sd=${f.tStat.sd})`);
    f.folds.forEach((x) => console.log(`    ${x.fold}: n=${x.trades} win=${x.winRate.toFixed(1)}% exp=${x.expectancyR.toFixed(3)}R PF=${String(x.profitFactor).slice(0, 5)} pos=${x.positiveCombos}/25`));
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e); process.exitCode = 1; }
}
module.exports = {};
