const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const PAGE_URL = "http://127.0.0.1:8787/";
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const TIMEFRAMES = ["1h", "4h"];

async function waitForAnalysis(page, symbol) {
  await page.waitForFunction(
    (expected) => document.querySelector("#symbolLabel")?.textContent === expected
      && document.querySelector("#dataStatus")?.textContent.startsWith("정상 갱신:"),
    symbol,
    { timeout: 30000 }
  );
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  await page.goto(PAGE_URL);
  await waitForAnalysis(page, "BTCUSDT");

  const results = [];
  for (const timeframe of TIMEFRAMES) {
    await page.selectOption("#timeframe", timeframe);
    await waitForAnalysis(page, await page.locator("#symbolLabel").textContent());

    for (const symbol of SYMBOLS) {
      await page.locator("#searchInput").fill(symbol);
      await page.locator("#searchInput").press("Enter");
      await waitForAnalysis(page, symbol);
      await page.locator("#backtestBtn").click();
      await page.locator("#backtestBtn").waitFor({ state: "visible" });
      await page.waitForFunction(() => !document.querySelector("#backtestBtn")?.disabled
        && Boolean(document.querySelector(".backtestVerdict")), null, { timeout: 90000 });

      const result = await page.evaluate(() => {
        const metrics = {};
        document.querySelectorAll(".backtestMetric").forEach((item) => {
          metrics[item.querySelector("span").textContent] = item.querySelector("b").textContent;
        });
        return {
          verdict: document.querySelector(".backtestVerdict").textContent.trim(),
          note: document.querySelector(".backtestNote").textContent.trim(),
          metrics
        };
      });
      results.push({ symbol, timeframe, ...result });
    }
  }

  const settings = await page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll("#settingsGrid input")].map((input) => [input.id, Number(input.value)])
  ));
  await browser.close();

  const output = {
    generatedAt: new Date().toISOString(),
    source: "Binance USDT-M Futures API",
    assumptions: {
      confirmedCandlesOnly: true,
      maximumCandles: 5000,
      holdoutRatio: 0.4,
      entry: "다음 봉 시가",
      feeEachSide: 0.0004,
      slippageEachSide: 0.0002,
      sameBarPriority: "STOP",
      stopGap: "불리한 시가 체결",
      singlePosition: "미청산 포지션 뒤 신호 제외",
      minimumTrades: 30
    },
    settings,
    results
  };
  const outputPath = path.resolve(__dirname, "..", "backtest-results.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
