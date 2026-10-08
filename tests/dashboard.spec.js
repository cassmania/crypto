const { test, expect } = require("@playwright/test");

const PAGE_URL = "http://127.0.0.1:8787/";

test("EMA, Wilder RSI, MACD, ATR, Bollinger 계산이 기준값과 일치한다", async ({ page }) => {
  await page.goto(PAGE_URL);
  await page.waitForFunction(() => Boolean(window.__dashboardTest));

  const result = await page.evaluate(() => {
    const prices = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64
    ];
    const candles = [
      { high: 11, low: 9, close: 10 },
      { high: 12, low: 10, close: 11 },
      { high: 14, low: 10, close: 13 },
      { high: 14, low: 11, close: 12 }
    ];
    return {
      ema: window.__dashboardTest.ema([1, 2, 3, 4, 5], 3),
      rsi: window.__dashboardTest.rsi(prices, 14),
      macd: window.__dashboardTest.macd([1, 2, 3, 4, 5]),
      atr: window.__dashboardTest.atr(candles, 3),
      bollinger: window.__dashboardTest.bollinger([1, 2, 3, 4], 3)
    };
  });

  expect(result.ema).toEqual([1, 1.5, 2.25, 3.125, 4.0625]);
  expect(result.rsi[13]).toBeNull();
  expect(result.rsi[14]).toBeCloseTo(70.4641, 3);
  expect(result.rsi[15]).toBeCloseTo(66.2496, 3);
  expect(result.macd.line[4]).toBeCloseTo(0.6315484, 6);
  expect(result.macd.signal[4]).toBeCloseTo(0.2282461, 6);
  expect(result.macd.histogram[4]).toBeCloseTo(0.4033023, 6);
  expect(result.atr[1]).toBeNull();
  expect(result.atr[2]).toBeCloseTo(2.6666667, 6);
  expect(result.atr[3]).toBeCloseTo(2.7777778, 6);
  expect(result.bollinger[0]).toBeNull();
  expect(result.bollinger[1]).toBeNull();
  expect(result.bollinger[2].middle).toBeCloseTo(2, 8);
  expect(result.bollinger[2].upper).toBeCloseTo(3.6329932, 6);
  expect(result.bollinger[2].lower).toBeCloseTo(0.3670068, 6);
});

test("같은 봉에서 손절과 목표가 모두 닿으면 손절을 우선한다", async ({ page }) => {
  await page.goto(PAGE_URL);
  const exit = await page.evaluate(() => window.__dashboardTest.resolveTradeExit(
    [{ time: 1, open: 100, high: 110, low: 90, close: 101 }],
    { type: "LONG", entryIndex: 0, invalidation: 95, target: 105 }
  ));
  expect(exit).toEqual({ exitIndex: 0, exitPrice: 95, exitReason: "STOP" });
});

test("손절선을 건너뛴 갭은 불리한 시가로 체결한다", async ({ page }) => {
  await page.goto(PAGE_URL);
  const exit = await page.evaluate(() => window.__dashboardTest.resolveTradeExit(
    [
      { time: 1, open: 100, high: 102, low: 99, close: 101 },
      { time: 2, open: 92, high: 94, low: 90, close: 93 }
    ],
    { type: "LONG", entryIndex: 0, invalidation: 95, target: 105 }
  ));
  expect(exit).toEqual({ exitIndex: 1, exitPrice: 92, exitReason: "STOP_GAP" });
});

test("성과 요약이 승률, Profit Factor, 기대 R, 최대낙폭을 계산한다", async ({ page }) => {
  await page.goto(PAGE_URL);
  const summary = await page.evaluate(() => window.__dashboardTest.summarizeTrades([
    { netR: 2 }, { netR: -1 }, { netR: -.5 }
  ]));
  expect(summary.trades).toBe(3);
  expect(summary.winRate).toBeCloseTo(33.3333, 3);
  expect(summary.profitFactor).toBeCloseTo(1.3333, 3);
  expect(summary.expectancyR).toBeCloseTo(.1666667, 6);
  expect(summary.maxDrawdownR).toBeCloseTo(1.5, 6);
});

test("청산되지 않은 포지션 뒤의 신호는 새 거래로 계산하지 않는다", async ({ page }) => {
  await page.goto(PAGE_URL);
  const trades = await page.evaluate(() => window.__dashboardTest.simulateSignalTrades(
    [
      { time: 1, open: 100, high: 101, low: 99, close: 100 },
      { time: 2, open: 100, high: 101, low: 99, close: 100 },
      { time: 3, open: 100, high: 101, low: 99, close: 100 }
    ],
    [
      { type: "LONG", entryIndex: 0, price: 100, invalidation: 90, target: 110, pending: false },
      { type: "SHORT", entryIndex: 1, price: 100, invalidation: 110, target: 90, pending: false }
    ]
  ));
  expect(trades).toHaveLength(1);
  expect(trades[0].exitReason).toBe("BOUNDARY");
  expect(trades[0].exitIndex).toBe(2);
  expect(trades[0].netR).toBeLessThan(0); // 가격 불변이어도 진입·청산 비용은 남는다.
});

test("지지·저항 후보는 현재가 방향과 거리순을 지키고 가격 구간을 포함한다", async ({ page }) => {
  await page.goto(PAGE_URL);
  const result = await page.evaluate(() => {
    const candles = Array.from({ length: 100 }, (_, index) => {
      const center = 100 + Math.sin(index / 4) * 6 + Math.sin(index / 11) * 2;
      return {
        time: index,
        open: center - .4,
        high: center + 1.2,
        low: center - 1.1,
        close: center + .3,
        volume: 1000 + (index % 13) * 120
      };
    });
    return window.__dashboardTest.calculateTradeLevels(candles, 100, 2, {
      lookback: 100,
      bins: 30
    });
  });

  expect(result.supports.length).toBeGreaterThan(0);
  expect(result.resistances.length).toBeGreaterThan(0);
  expect(result.supports.every((level) => level.price < 100)).toBeTruthy();
  expect(result.resistances.every((level) => level.price > 100)).toBeTruthy();
  expect(result.supports.every((level) => level.zoneLow < level.price && level.zoneHigh > level.price)).toBeTruthy();
  expect(result.resistances.every((level) => level.zoneLow < level.price && level.zoneHigh > level.price)).toBeTruthy();
  expect(result.supports.map((level) => level.price)).toEqual(
    [...result.supports.map((level) => level.price)].sort((a, b) => b - a)
  );
  expect(result.resistances.map((level) => level.price)).toEqual(
    [...result.resistances.map((level) => level.price)].sort((a, b) => a - b)
  );
});

test("실제 확정봉 분석과 홀드아웃 백테스트가 화면에서 완료된다", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto(PAGE_URL);
  await expect(page.locator("#dataStatus")).toContainText("정상 갱신:", { timeout: 30000 });
  await page.locator("#backtestBtn").click();
  await expect(page.locator(".backtestVerdict")).toBeVisible({ timeout: 90000 });
  await expect(page.locator("#backtestResult")).toContainText("홀드아웃");
  await expect(page.locator("#backtestResult")).toContainText(/표본 부족|양의 성과 관찰|전략 우위 미확인/);
});

test("360px와 390px 모바일 화면에서 가로 페이지 넘침이 없다", async ({ page }) => {
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(PAGE_URL);
    await expect(page.locator("#dataStatus")).toContainText("정상 갱신:", { timeout: 30000 });
    const layout = await page.evaluate(() => {
      const card = document.querySelector(".chartPanel").getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cardWidthRatio: card.width / document.documentElement.clientWidth
      };
    });
    expect(layout.overflow).toBeLessThanOrEqual(1);
    expect(layout.cardWidthRatio).toBeGreaterThan(.93);
  }
});

test("1920px 화면은 차트 폭을 채우고 하단 카드를 3열로 배치한다", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(PAGE_URL);
  await expect(page.locator("#dataStatus")).toContainText("정상 갱신:", { timeout: 30000 });
  const layout = await page.evaluate(() => {
    const chartPanel = document.querySelector(".chartPanel").getBoundingClientRect();
    const side = document.querySelector(".side");
    const firstCards = [...side.children].slice(0, 3).map((element) => element.getBoundingClientRect());
    return {
      chartWidthRatio: chartPanel.width / document.documentElement.clientWidth,
      distinctColumns: new Set(firstCards.map((rect) => Math.round(rect.left))).size,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      panelBackground: getComputedStyle(document.querySelector(".panel")).backgroundColor
    };
  });
  expect(layout.chartWidthRatio).toBeGreaterThan(.95);
  expect(layout.distinctColumns).toBe(3);
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.colorScheme).toBe("light");
  expect(layout.panelBackground).toContain("255, 255, 255");
});

test("V3 신뢰도 헬퍼가 승률 CI와 손익분기 승률을 계산한다", async ({ page }) => {
  await page.goto(PAGE_URL);
  await page.waitForFunction(() => Boolean(window.__dashboardTest?.wilsonInterval));
  const result = await page.evaluate(() => {
    const t = window.__dashboardTest;
    return {
      ci: t.wilsonInterval(380, 1102),
      breakeven: t.breakevenWinRate(3, 1.5),
      small: t.wilsonInterval(0, 0),
      insufficient: t.backtestVerdict({ trades: 20, expectancyR: 1, profitFactor: 2 }),
      noEdge: t.backtestVerdict({ trades: 100, expectancyR: -0.02, profitFactor: 0.96 }),
      positive: t.backtestVerdict({ trades: 100, expectancyR: 0.05, profitFactor: 1.1 })
    };
  });
  expect(result.ci.lower).toBeLessThan(34.48);
  expect(result.ci.upper).toBeGreaterThan(34.48);
  expect(result.breakeven).toBeCloseTo(34.53, 1);
  expect(result.small).toEqual({ lower: 0, upper: 0 });
  expect(result.insufficient).toBe("표본 부족");
  expect(result.noEdge).toBe("전략 우위 미확인");
  expect(result.positive).toBe("양의 성과 관찰");
});

test("V4 손익분기가 손절폭에 따라 스케일링된다", async ({ page }) => {
  await page.goto(PAGE_URL);
  await page.waitForFunction(() => Boolean(window.__dashboardTest?.breakevenWinRate));
  const result = await page.evaluate(() => {
    const t = window.__dashboardTest;
    return {
      legacy: t.breakevenWinRate(3, 1.5),
      current: t.breakevenWinRate(3, 2),
      explicit: t.breakevenWinRate(3, 1.5, 0.054),
      defaults: { sl: t.DEFAULT_SETTINGS.sl, gate: t.DEFAULT_SETTINGS.useVolGate }
    };
  });
  expect(result.legacy).toBeCloseTo(34.53, 1);
  expect(result.current).toBeCloseTo(40.81, 1);
  expect(result.explicit).toBeCloseTo(34.53, 1);
  expect(result.defaults.sl).toBe(2);
  expect(result.defaults.gate).toBe(true);
});

test("V4 변동성 게이트가 저변동 신호를 걸러낸다", async ({ page }) => {
  await page.goto(PAGE_URL);
  await page.waitForFunction(() => Boolean(window.__dashboardTest?.passesVolatilityGate));
  const result = await page.evaluate(() => {
    const t = window.__dashboardTest;
    const high = Array.from({ length: 100 }, () => 10);
    const lowAtEnd = [...high.slice(0, 99), 1];
    const highAtEnd = [...high.slice(0, 99), 20];
    const gate = {
      lowBlocked: t.passesVolatilityGate(lowAtEnd, 99),
      highPassed: t.passesVolatilityGate(highAtEnd, 99),
      warmupPassed: t.passesVolatilityGate([1, 2, 3], 2),
      pct: t.atrPercentile(lowAtEnd, 99, 100)
    };
    const candles = Array.from({ length: 200 }, (_, index) => {
      const center = 100 + Math.sin(index / 4) * 6 + Math.sin(index / 11) * 2;
      return {
        time: index,
        open: center - .4,
        high: center + 1.2,
        low: center - 1.1,
        close: center + .3,
        volume: 1000 + (index % 13) * 120
      };
    });
    const base = { lookback: 30, bins: 12, smoothLength: 5, smoothStages: 2, atrLength: 14, sensitivity: .15, retest: .35, sl: 2, tp: 3 };
    const off = t.dynamicPoc(candles, { ...base, useVolGate: false }).signals;
    const on = t.dynamicPoc(candles, { ...base, useVolGate: true }).signals;
    return { gate, offCount: off.length, onCount: on.length };
  });
  expect(result.gate.lowBlocked).toBe(false);
  expect(result.gate.highPassed).toBe(true);
  expect(result.gate.warmupPassed).toBe(true);
  expect(result.gate.pct).toBeLessThan(.3);
  expect(result.onCount).toBeLessThanOrEqual(result.offCount);
});
