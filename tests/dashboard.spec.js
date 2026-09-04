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

test("실제 확정봉 분석과 홀드아웃 백테스트가 화면에서 완료된다", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto(PAGE_URL);
  await expect(page.locator("#dataStatus")).toContainText("정상 갱신:", { timeout: 30000 });
  await page.locator("#backtestBtn").click();
  await expect(page.locator(".backtestVerdict")).toBeVisible({ timeout: 90000 });
  await expect(page.locator("#backtestResult")).toContainText("홀드아웃");
  await expect(page.locator("#backtestResult")).toContainText(/표본 부족|양의 성과 관찰|전략 우위 미확인/);
});

test("390px 모바일 화면에서 가로 페이지 넘침이 없다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(PAGE_URL);
  await expect(page.locator("#dataStatus")).toContainText("정상 갱신:", { timeout: 30000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
