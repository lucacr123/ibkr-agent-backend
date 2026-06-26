import express from "express";
import cors from "cors";
import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";
import webpush from "web-push";
import { XMLParser } from "fast-xml-parser";

const app = express();
app.use(cors());
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const FLEX_TOKEN    = process.env.IBKR_FLEX_TOKEN   || "";
const FLEX_QUERY_ID = process.env.IBKR_FLEX_QUERY_ID|| "";
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL   = process.env.VAPID_EMAIL       || "mailto:you@example.com";

const RESEND_KEY   = process.env.RESEND_API_KEY  || "";
const REPORT_TO    = process.env.REPORT_EMAIL_TO || "rodriguez.albacar.joaquin@gmail.com";
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const parser    = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
if (VAPID_PUBLIC && VAPID_PRIVATE) webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

// ─── Helpers ──────────────────────────────────────────────────────
const toArr = v => Array.isArray(v) ? v : v ? [v] : [];
const n     = v => parseFloat(v || 0);
const fmt   = v => n(v).toFixed(2);
const YAHOO_SYMBOLS = { CSPX:"CSPX.L", CSNDX:"CNDX.L", CSSX5E:"CSSX5E.SW", IEEM:"IEEM.L", IUSE:"IUSE.L", NQSE:"NQSE.DE", SPCX:"SPCX.L", VUAG:"VUAG.L", VWRL:"VWRL.L", VFEM:"VFEM.L" };
const yfSymbol = s => YAHOO_SYMBOLS[(s || "").toUpperCase()] || s;

// ─── Flex Web Service ─────────────────────────────────────────────
const FLEX_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";

async function fetchFlex() {
  if (!FLEX_TOKEN || !FLEX_QUERY_ID) throw new Error("Missing IBKR_FLEX_TOKEN or IBKR_FLEX_QUERY_ID");
  const sendRes  = await fetch(`${FLEX_BASE}/SendRequest?t=${FLEX_TOKEN}&q=${FLEX_QUERY_ID}&v=3`, { headers: { "User-Agent": "Node/18" } });
  const sendData = parser.parse(await sendRes.text());
  if (sendData?.FlexStatementResponse?.Status !== "Success")
    throw new Error(`Flex SendRequest failed: ${JSON.stringify(sendData)}`);
  const refCode = sendData.FlexStatementResponse.ReferenceCode;
  const url     = sendData.FlexStatementResponse.Url;
  await new Promise(r => setTimeout(r, 8000));
  for (let i = 0; i < 10; i++) {
    const res  = await fetch(`${url}?t=${FLEX_TOKEN}&q=${refCode}&v=3`, { headers: { "User-Agent": "Node/18" } });
    const data = parser.parse(await res.text());
    const raw  = data?.FlexQueryResponse?.FlexStatements?.FlexStatement
              ?? data?.FlexStatementResponse?.FlexStatements?.FlexStatement;
    if (raw) return Array.isArray(raw) ? raw : [raw];
    await new Promise(r => setTimeout(r, 3000 + i * 1000));
  }
  throw new Error("Flex report never became available after retries");
}

let _cache = null, _cacheTime = 0;
async function getStatements(force = false) {
  if (!force && _cache && Date.now() - _cacheTime < 15 * 60 * 1000) return _cache;
  _cache     = await fetchFlex();
  _cacheTime = Date.now();
  return _cache;
}

function latestPerAccount(stmts) {
  const map = {};
  for (const s of stmts) {
    const id = s.accountId;
    if (!map[id] || (s.whenGenerated || "") > (map[id].whenGenerated || "")) map[id] = s;
  }
  return Object.values(map);
}

function getFxRates(stmt) {
  const rates = { EUR: 1 };
  toArr(stmt?.ConversionRates?.ConversionRate).forEach(r => { rates[r.fromCurrency] = n(r.rate); });
  return rates;
}

// ─── Build portfolio ──────────────────────────────────────────────
async function buildPortfolio(force = false) {
  const all   = await getStatements(force);
  const stmts = latestPerAccount(all);

  const eurStmt       = stmts.find(s => (s?.AccountInformation?.currency || "EUR") === "EUR") || stmts[0];
  const masterFxRates = getFxRates(eurStmt);

  const accounts = stmts.map(stmt => {
    const info      = stmt?.AccountInformation || {};
    const fxRates   = getFxRates(stmt);
    const equityRows = toArr(stmt?.EquitySummaryInBase?.EquitySummaryByReportDateInBase);
    const equity    = equityRows[equityRows.length - 1] || {};
    const positions = toArr(stmt?.OpenPositions?.OpenPosition).filter(p => p.levelOfDetail === "SUMMARY" || !p.levelOfDetail);
    const mtmBySymbol = {};
    toArr(stmt?.MTMPerformanceSummaryInBase?.MTMPerformanceSummaryUnderlying).filter(p => p.symbol).forEach(p => { mtmBySymbol[p.symbol] = p; });
    const ytdBySymbol = {};
    toArr(stmt?.MTDYTDPerformanceSummary?.MTDYTDPerformanceSummaryUnderlying).filter(p => p.symbol).forEach(p => { ytdBySymbol[p.symbol] = p; });
    const cashRows = toArr(stmt?.CashReport?.CashReportCurrency);
    const baseCash = cashRows.find(c => c.currency === "BASE_SUMMARY") || cashRows[0] || {};
    const changeInNAV = stmt?.ChangeInNAV || {};
    const baseCurrency = info.currency || "EUR";
    const acctFxToEUR  = baseCurrency === "EUR" ? 1 : (masterFxRates[baseCurrency] || 1);

    return {
      accountId:         stmt.accountId,
      accountName:       info.name || "",
      baseCurrency,
      netLiquidation:    n(equity.total),
      netLiquidationEUR: n(equity.total) * acctFxToEUR,
      cash:              n(equity.cash),
      cashEUR:           n(equity.cash) * acctFxToEUR,
      stockValue:        n(equity.stock),
      stockValueEUR:     n(equity.stock) * acctFxToEUR,
      dividendAccruals:  n(equity.dividendAccruals),
      acctFxToEUR,
      ytdReturn:     n(changeInNAV.twr),
      startingValue: n(changeInNAV.startingValue) * acctFxToEUR,
      endingValue:   n(changeInNAV.endingValue)   * acctFxToEUR,
      ytdGainEUR:    (n(changeInNAV.endingValue) - n(changeInNAV.startingValue)) * acctFxToEUR,
      commissions:   n(baseCash.commissions),
      deposits:      n(baseCash.deposits),
      withdrawals:   n(baseCash.withdrawals),
      dividends:     n(baseCash.dividends),
      brokerInterest: n(baseCash.brokerInterest),
      positions: positions.map(p => {
        const fxRate    = n(p.fxRateToBase) || fxRates[p.currency] || 1;
        const mtm       = mtmBySymbol[p.symbol] || {};
        const ytd       = ytdBySymbol[p.symbol] || {};
        const valueEUR  = n(p.positionValue) * fxRate;
        const unrealEUR = n(mtm.priorOpenMtm);
        const unrealRaw = fxRate > 0 ? unrealEUR / fxRate : unrealEUR;
        const costMoney = n(p.costBasisMoney);
        const costEUR   = costMoney * fxRate;
        return {
          symbol: p.symbol, description: p.description, assetCategory: p.assetCategory,
          currency: p.currency, quantity: n(p.position), markPrice: n(p.markPrice),
          costBasisPrice: n(p.costBasisPrice), positionValue: n(p.positionValue),
          positionValueEUR: valueEUR, unrealizedPnl: unrealRaw, unrealizedPnlEUR: unrealEUR,
          costBasisMoneyEUR: costEUR, returnPct: costMoney > 0 ? ((n(p.positionValue) - costMoney) / costMoney) * 100 : 0,
          percentOfAccountNAV: n(p.percentOfNAV), fxRateToBase: fxRate,
          ytdPnl: n(ytd.markToMarketYTD), mtdPnl: n(ytd.markToMarketMTD),
        };
      }),
      fxRates,
    };
  });

  const totalNLV = accounts.reduce((s, a) => s + a.netLiquidationEUR, 0);
  const symbolMap = {};
  for (const acct of accounts) {
    for (const p of acct.positions) {
      if (!symbolMap[p.symbol]) {
        symbolMap[p.symbol] = { symbol: p.symbol, description: p.description, assetCategory: p.assetCategory,
          totalValueEUR: 0, totalUnrealEUR: 0, totalCostEUR: 0, totalYtdPnl: 0, legs: [] };
      }
      symbolMap[p.symbol].totalValueEUR  += p.positionValueEUR;
      symbolMap[p.symbol].totalUnrealEUR += p.unrealizedPnlEUR;
      symbolMap[p.symbol].totalCostEUR   += p.costBasisMoneyEUR;
      symbolMap[p.symbol].totalYtdPnl    += (p.ytdPnl || 0);
      symbolMap[p.symbol].legs.push({ accountId: acct.accountId, currency: p.currency, quantity: p.quantity,
        markPrice: p.markPrice, positionValue: p.positionValue, unrealizedPnl: p.unrealizedPnl, costBasisPrice: p.costBasisPrice });
    }
  }

  const combinedPositions = Object.values(symbolMap)
    .sort((a, b) => b.totalValueEUR - a.totalValueEUR)
    .map(s => ({ ...s, allocationPct: totalNLV > 0 ? (s.totalValueEUR / totalNLV) * 100 : 0,
      totalValueEUR: +s.totalValueEUR.toFixed(2), totalUnrealEUR: +s.totalUnrealEUR.toFixed(2),
      totalCostEUR: +s.totalCostEUR.toFixed(2), returnPct: s.totalCostEUR > 0 ? ((s.totalValueEUR - s.totalCostEUR) / s.totalCostEUR) * 100 : 0 }));

  const totalUnrealEUR = +combinedPositions.reduce((s, p) => s + p.totalUnrealEUR, 0).toFixed(2);
  const totalYtdGainEUR = +accounts.reduce((s, a) => s + (a.ytdGainEUR || 0), 0).toFixed(2);
  const portfolioMetrics = await computePortfolioMetrics(combinedPositions, totalNLV);

  return {
    accounts,
    combined: {
      totalNetLiquidation:   +totalNLV.toFixed(2),
      totalCash:             +accounts.reduce((s, a) => s + a.cashEUR, 0).toFixed(2),
      totalStockValue:       +accounts.reduce((s, a) => s + a.stockValueEUR, 0).toFixed(2),
      totalUnrealizedPnlEUR: totalUnrealEUR,
      totalYtdGainEUR,
      avgYtdReturnPct:       +(accounts.reduce((s, a) => s + (a.ytdReturn || 0), 0) / accounts.length).toFixed(2),
      totalCommissions:      +accounts.reduce((s, a) => s + a.commissions, 0).toFixed(2),
      totalDividends:        +accounts.reduce((s, a) => s + a.dividends, 0).toFixed(2),
      totalBrokerInterest:   +accounts.reduce((s, a) => s + a.brokerInterest, 0).toFixed(2),
      positionCount:         combinedPositions.length,
      positions:             combinedPositions,
      metrics1Y:             portfolioMetrics,
    },
  };
}

// ─── Quant Analytics Engine ───────────────────────────────────────
function rets(closes)    { return closes.slice(1).map((v, i) => (v - closes[i]) / closes[i]).filter(v => Number.isFinite(v)); }
function mean(arr)       { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function std(arr)        { if (!arr.length) return 0; const m = mean(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length); }
function rollingFn(arr, w, fn) { if (arr.length < w) return new Array(arr.length).fill(null); const out = new Array(Math.max(w - 1, 0)).fill(null); for (let i = w - 1; i < arr.length; i++) out.push(fn(arr.slice(i - w + 1, i + 1))); return out; }
function sharpe(r, period = 252) { const m = mean(r), s = std(r); return s === 0 ? 0 : (m / s) * Math.sqrt(period); }
function sortino(r, period = 252) { const m = mean(r); const neg = r.filter(v => v < 0); const ds = neg.length ? Math.sqrt(neg.reduce((s, v) => s + v * v, 0) / neg.length) : 0; return ds === 0 ? 0 : (m / ds) * Math.sqrt(period); }
function maxDD(closes)   { let peak = -Infinity, dd = 0; for (const c of closes) { if (c > peak) peak = c; const d = (c - peak) / peak * 100; if (d < dd) dd = d; } return dd; }
function quantile(arr, q) { const xs = arr.filter(Number.isFinite).sort((a,b)=>a-b); if (!xs.length) return null; const pos = (xs.length - 1) * q; const base = Math.floor(pos), rest = pos - base; return xs[base + 1] !== undefined ? xs[base] + rest * (xs[base + 1] - xs[base]) : xs[base]; }
function histVaR(r, level = 0.95) { const q = quantile(r, 1 - level); return q === null ? null : -q; }
function histCVaR(r, level = 0.95) { const q = quantile(r, 1 - level); if (q === null) return null; const tail = r.filter(v => v <= q); return tail.length ? -mean(tail) : -q; }
function skewness(r) { const s = std(r), m = mean(r); return !r.length || s === 0 ? 0 : mean(r.map(v => ((v - m) / s) ** 3)); }
function kurtosis(r) { const s = std(r), m = mean(r); return !r.length || s === 0 ? 0 : mean(r.map(v => ((v - m) / s) ** 4)) - 3; }
function returnDistribution(r, bins = 20) { const vals = r.filter(Number.isFinite); if (!vals.length) return []; const min = Math.min(...vals), max = Math.max(...vals); const width = (max - min) / bins || 1; const out = Array.from({ length: bins }, (_, i) => ({ binStart: +(100 * (min + i * width)).toFixed(2), binEnd: +(100 * (min + (i + 1) * width)).toFixed(2), count: 0 })); vals.forEach(v => { const idx = Math.min(Math.floor((v - min) / width), bins - 1); out[idx].count += 1; }); return out; }
function betaFn(a, b)    { if (!a.length || a.length !== b.length) return null; const ma = mean(a), mb = mean(b); const cov = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / a.length; const vb = b.reduce((s, v) => s + (v - mb) ** 2, 0) / b.length; return vb === 0 ? null : cov / vb; }
function corrFn(a, b)    { if (!a.length || a.length !== b.length) return null; const ma = mean(a), mb = mean(b), sa = std(a), sb = std(b); if (sa === 0 || sb === 0) return null; return a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / (a.length * sa * sb); }

async function fetchYahooCloses(symbol, range = "1y") {
  symbol = yfSymbol(symbol);
  const interval = range === "1d" ? "5m" : "1d";
  const res  = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${symbol}`);
  const { timestamp, indicators } = result;
  const q = indicators?.quote?.[0] || {};
  const bars = (timestamp || []).map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: q.close?.[i] ?? null })).filter(b => b.close !== null);
  return { bars, meta: result.meta };
}

function cumulativeFromReturns(r) { let v = 1; return r.map(x => (v *= (1 + x))); }
function maxDDFromReturns(r) { const c = cumulativeFromReturns(r); return maxDD(c.map(v => v * 100)); }
function annualizedReturn(r) { if (!r.length) return 0; const total = r.reduce((s,v)=>s*(1+v),1); return Math.pow(total, 252 / r.length) - 1; }
function informationRatio(a, b) { const len = Math.min(a.length, b.length); if (!len) return null; const active = a.slice(-len).map((v,i)=>v - b.slice(-len)[i]); const te = std(active); return te === 0 ? null : (mean(active) / te) * Math.sqrt(252); }
async function fetchYahooReturnSeries(symbol, range = "1y") {
  const { bars } = await fetchYahooCloses(yfSymbol(symbol), range);
  const out = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]?.close;
    const cur = bars[i]?.close;
    if (prev && cur && Number.isFinite(prev) && Number.isFinite(cur)) out.push({ date: bars[i].date, ret: (cur - prev) / prev });
  }
  return out;
}

function sampleCov(a, b) {
  const len = Math.min(a.length, b.length);
  if (len < 2) return 0;
  const aa = a.slice(-len), bb = b.slice(-len);
  const ma = mean(aa), mb = mean(bb);
  return aa.reduce((s, v, i) => s + (v - ma) * (bb[i] - mb), 0) / (len - 1);
}

function covarianceMatrix(returnMatrix) {
  const n = returnMatrix.length;
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => sampleCov(returnMatrix[i], returnMatrix[j])));
}

function correlationMatrixFromReturns(items) {
  const out = {};
  for (let i = 0; i < items.length; i++) {
    out[items[i].symbol] = {};
    for (let j = 0; j < items.length; j++) out[items[i].symbol][items[j].symbol] = +(corrFn(items[i].returns, items[j].returns) || 0).toFixed(3);
  }
  return out;
}

async function computePortfolioMetrics(positions, totalNLV) {
  try {
    const rawItems = [];
    for (const p of positions) {
      const weight = totalNLV > 0 ? p.totalValueEUR / totalNLV : 0;
      if (!weight) continue;
      try {
        const series = await fetchYahooReturnSeries(p.symbol, "1y");
        if (series.length) rawItems.push({ symbol: p.symbol, yahooSymbol: yfSymbol(p.symbol), weight, series });
      } catch {}
    }
    if (!rawItems.length) return null;

    // Align all ETF daily returns by actual Yahoo dates, then renormalise to invested assets.
    // This is the user's requested model: current weights + 1Y correlation/covariance from daily returns.
    const commonDates = rawItems.map(x => new Set(x.series.map(r => r.date))).reduce((acc, set) => new Set([...acc].filter(d => set.has(d))));
    const dates = [...commonDates].sort();
    if (dates.length < 30) return null;
    const items = rawItems.map(x => {
      const byDate = new Map(x.series.map(r => [r.date, r.ret]));
      return { ...x, returns: dates.map(d => byDate.get(d)).filter(Number.isFinite) };
    }).filter(x => x.returns.length === dates.length);
    if (!items.length) return null;

    const investedWeight = items.reduce((s, x) => s + x.weight, 0);
    const weights = items.map(x => x.weight / investedWeight);
    const returnMatrix = items.map(x => x.returns);
    const cov = covarianceMatrix(returnMatrix);
    const corr = correlationMatrixFromReturns(items);

    const pr = dates.map((_, t) => items.reduce((s, x, i) => s + weights[i] * x.returns[t], 0));
    const totalReturn = pr.reduce((s, v) => s * (1 + v), 1) - 1;
    const annRet = annualizedReturn(pr);
    const dailyVol = Math.sqrt(weights.reduce((rowSum, wi, i) => rowSum + weights.reduce((colSum, wj, j) => colSum + wi * wj * cov[i][j], 0), 0));
    const annVol = dailyVol * Math.sqrt(252);

    let br = [];
    try {
      const bench = await fetchYahooReturnSeries("^GSPC", "1y");
      const bmap = new Map(bench.map(r => [r.date, r.ret]));
      br = dates.map(d => bmap.get(d)).filter(Number.isFinite);
    } catch {}

    const len = Math.min(pr.length, br.length || pr.length);
    const prAligned = pr.slice(-len);
    const brAligned = br.length ? br.slice(-len) : [];
    const active = brAligned.length ? prAligned.map((v, i) => v - brAligned[i]) : [];
    const trackingError = active.length ? std(active) * Math.sqrt(252) : null;
    const activeAnnRet = brAligned.length ? annualizedReturn(prAligned) - annualizedReturn(brAligned) : null;
    const infoRatio = trackingError && trackingError !== 0 ? activeAnnRet / trackingError : null;

    const mdd = maxDDFromReturns(pr);
    const downside = pr.filter(v => v < 0);
    const downsideVol = downside.length ? Math.sqrt(downside.reduce((s, v) => s + v * v, 0) / downside.length) * Math.sqrt(252) : 0;
    const var95 = histVaR(pr, 0.95), var99 = histVaR(pr, 0.99), cvar95 = histCVaR(pr, 0.95), cvar99 = histCVaR(pr, 0.99);

    return {
      period: "1y",
      days: pr.length,
      investedWeightPct: +(investedWeight * 100).toFixed(2),
      totalReturnPct: +(totalReturn * 100).toFixed(2),
      annualizedReturnPct: +(annRet * 100).toFixed(2),
      averageDailyReturnPct: +(mean(pr) * 100).toFixed(4),
      annualizedVolPct: +(annVol * 100).toFixed(2),
      sharpe: std(pr) === 0 ? null : +(mean(pr) / std(pr)).toFixed(3),  // pandas: mean/std no annualisation
      sortino: downsideVol === 0 ? null : +(annRet / downsideVol).toFixed(3),
      maxDrawdownPct: +mdd.toFixed(2),
      var95Pct: var95 === null ? null : +(var95 * 100).toFixed(2),
      var99Pct: var99 === null ? null : +(var99 * 100).toFixed(2),
      cvar95Pct: cvar95 === null ? null : +(cvar95 * 100).toFixed(2),
      cvar99Pct: cvar99 === null ? null : +(cvar99 * 100).toFixed(2),
      calmar: mdd === 0 ? null : +(annRet / Math.abs(mdd / 100)).toFixed(3),
      informationRatioVsSPX: infoRatio === null ? null : +infoRatio.toFixed(3),
      trackingErrorVsSPXPct: trackingError === null ? null : +(trackingError * 100).toFixed(2),
      skewness: +skewness(pr).toFixed(3),
      kurtosis: +kurtosis(pr).toFixed(3),
      dates,
      portfolioReturnsPct: pr.map(v => +(v * 100).toFixed(4)),
      portfolioIndex: cumulativeFromReturns(pr).map(v => +(v * 100).toFixed(3)),
      rollingSharpe30: rollingFn(pr, 30, arr => { const ar = annualizedReturn(arr); const av = std(arr) * Math.sqrt(252); return av === 0 ? null : +(ar / av).toFixed(4); }),
      weights: items.map((x, i) => ({ symbol: x.symbol, yahooSymbol: x.yahooSymbol, weightPct: +(weights[i] * 100).toFixed(2) })),
      correlationMatrix: corr,
      covarianceMethod: "1Y daily Yahoo returns, date-aligned; annual vol = sqrt(w'Σw) × sqrt(252)",
      method: "current portfolio weights × 1Y Yahoo daily-return correlation/covariance matrix; Sharpe = annualized return / covariance-based annualized volatility"
    };
  } catch { return null; }
}

async function fetchMarketNews(input = {}) {
  const symbols = (input.symbols && input.symbols.length ? input.symbols : ["^GSPC","^IXIC","^DJI","^STOXX50E","^FTSE","^TNX","EURUSD=X","GC=F","CL=F"]).map(yfSymbol);
  const feeds = [
    `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbols.join(","))}&region=US&lang=en-US`,
    "https://www.investing.com/rss/news_25.rss",
    "https://www.investing.com/rss/news_285.rss"
  ];
  const items = [];
  for (const url of feeds) {
    try {
      const xml = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })).text();
      const data = parser.parse(xml);
      const rows = toArr(data?.rss?.channel?.item).slice(0, 12);
      rows.forEach(x => items.push({ title: x.title, link: x.link, published: x.pubDate, source: data?.rss?.channel?.title || "Market news" }));
    } catch {}
  }
  const seen = new Set();
  return { count: items.length, headlines: items.filter(x => x.title && !seen.has(x.title) && seen.add(x.title)).slice(0, input.limit || 12) };
}

async function marketSnapshot() {
  const symbols = ["^GSPC","^IXIC","^DJI","^STOXX50E","^FTSE","^TNX","DX-Y.NYB","EURUSD=X","GC=F","CL=F","BTC-USD"];
  const quotes = await executeTool("get_multiple_quotes", { symbols });
  return { asOf: new Date().toISOString(), quotes };
}


// ─── Symbol news ──────────────────────────────────────────────────
async function fetchSymbolNews(symbol, limit = 5) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=${limit}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const d = await res.json();
    const news = (d?.news || []).slice(0, limit).map(n => ({
      title: n.title, publisher: n.publisher,
      published: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
      link: n.link,
    }));
    if (news.length) return news;
  } catch {}
  return [];
}

// ─── Email report ─────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!RESEND_KEY) { console.log("📧 No RESEND_API_KEY — email skipped:", subject); return { ok: false }; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "IBKR Agent <onboarding@resend.dev>", to, subject, html }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Resend: ${JSON.stringify(data)}`);
  console.log("📧 Email sent:", subject, "→", to, "id:", data.id);
  return { ok: true, id: data.id };
}

async function buildAndSendReport(to) {
  const [portfolio, newsData, macro] = await Promise.all([
    buildPortfolio().catch(() => null),
    fetchMarketNews({}).catch(() => ({ headlines: [] })),
    marketSnapshot().catch(() => ({ quotes: [] })),
  ]);
  const combined = portfolio?.combined || {};
  const positions = combined.positions || [];
  const metrics = combined.metrics1Y;

  const nlv = `€${(combined.totalNetLiquidation||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const unrealPnl = combined.totalUnrealizedPnlEUR || 0;
  const unrealCol = unrealPnl >= 0 ? "#2ECC71" : "#E74C3C";
  const unrealStr = `${unrealPnl>=0?"+":""}€${Math.abs(unrealPnl).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const twr = combined.avgYtdReturnPct || 0;
  const twrCol = twr >= 0 ? "#2ECC71" : "#E74C3C";

  const headlinesHtml = (newsData?.headlines||[]).slice(0,5).map(h =>
    `<li style="margin-bottom:10px;line-height:1.5"><a href="${h.link||"#"}" style="color:#4A9EFF;text-decoration:none;font-size:14px">${h.title}</a><br><span style="color:#5A6280;font-size:11px">${h.publisher||""} ${h.published?`· ${new Date(h.published).toLocaleDateString()}`:""}}</span></li>`
  ).join("") || "<li style='color:#5A6280'>No headlines available</li>";

  const macroRows = (macro?.quotes||[]).slice(0,10).map(q => {
    const c = q.changePct>=0?"#2ECC71":"#E74C3C";
    const arrow = q.changePct>=0?"▲":"▼";
    return `<tr style="border-bottom:1px solid #1A1E2A"><td style="padding:7px 8px;color:#EDF0F7;font-size:13px">${q.symbol}</td><td style="padding:7px 8px;font-family:monospace;font-size:13px;color:#EDF0F7">${(q.price||0).toFixed(2)}</td><td style="padding:7px 8px;font-family:monospace;font-size:13px;color:${c}">${arrow} ${(q.changePct||0).toFixed(2)}%</td></tr>`;
  }).join("");

  const maxPct = Math.max(...positions.map(p=>p.allocationPct||0), 1);
  const allocBars = positions.slice(0,8).map(p => {
    const w = Math.round((p.allocationPct/maxPct)*180);
    const col = p.allocationPct > 20 ? "#C9A84C" : "#4A9EFF";
    return `<tr><td style="padding:4px 8px 4px 0;font-family:monospace;font-size:12px;color:#EDF0F7;white-space:nowrap">${p.symbol}</td><td><div style="background:${col};height:12px;width:${w}px;border-radius:3px;display:inline-block"></div></td><td style="padding-left:8px;font-family:monospace;font-size:12px;color:#C9A84C">${p.allocationPct.toFixed(1)}%</td></tr>`;
  }).join("");

  const concentration = positions.filter(p=>p.allocationPct>25);
  const risks = [
    concentration.length ? `<div style="background:#2A1A1A;border-left:4px solid #E74C3C;border-radius:0 10px 10px 0;padding:12px;margin-bottom:10px"><strong style="color:#E74C3C">⚠️ Concentration risk</strong><p style="margin:6px 0 0;font-size:13px;color:#EDF0F7">${concentration.map(p=>`${p.symbol} is ${p.allocationPct.toFixed(1)}% of the portfolio — a lot of eggs in one basket.`).join(" ")}</p></div>` : "",
    `<div style="background:#1A1E2A;border-left:4px solid #F59E0B;border-radius:0 10px 10px 0;padding:12px;margin-bottom:10px"><strong style="color:#F59E0B">💱 Currency risk</strong><p style="margin:6px 0 0;font-size:13px;color:#EDF0F7">The portfolio holds funds in EUR, GBP and USD. When these currencies move against each other, it affects the total value — even if nothing else changes.</p></div>`,
    `<div style="background:#1A1E2A;border-left:4px solid #4A9EFF;border-radius:0 10px 10px 0;padding:12px"><strong style="color:#4A9EFF">📊 Normal market swings</strong><p style="margin:6px 0 0;font-size:13px;color:#EDF0F7">Short-term ups and downs are completely normal. This portfolio is spread across thousands of companies worldwide, which helps smooth things out over time. No need to panic on red days!</p></div>`,
  ].join("");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0D0F14;font-family:Inter,Arial,sans-serif;color:#EDF0F7">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">

  <div style="background:#13161E;border:1px solid #252A38;border-radius:16px;padding:24px;margin-bottom:20px;text-align:center">
    <div style="font-size:32px;margin-bottom:8px">📊</div>
    <h1 style="margin:0;font-size:22px;color:#E8C87A;font-weight:700">Your Morning Portfolio Report</h1>
    <p style="margin:8px 0 0;color:#5A6280;font-size:14px">${new Date().toLocaleDateString("en-GB",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}</p>
  </div>

  <div style="background:#1A1E2A;border-left:4px solid #C9A84C;border-radius:0 12px 12px 0;padding:14px 16px;margin-bottom:20px">
    <p style="margin:0;font-size:14px;color:#EDF0F7;line-height:1.6">👋 <strong>Good morning!</strong> Here's your daily portfolio health check. We'll cover what's happening in the world, how your money is doing, and anything worth keeping an eye on.</p>
  </div>

  <!-- 1. Market News -->
  <div style="background:#13161E;border:1px solid #252A38;border-radius:16px;padding:20px;margin-bottom:20px">
    <h2 style="margin:0 0 6px;font-size:16px;color:#E8C87A">🌍 1. Market News Overview</h2>
    <p style="margin:0 0 14px;font-size:12px;color:#5A6280">Top stories that could affect financial markets today:</p>
    <ul style="margin:0;padding-left:18px">${headlinesHtml}</ul>
  </div>

  <!-- 2. Portfolio Overview -->
  <div style="background:#13161E;border:1px solid #252A38;border-radius:16px;padding:20px;margin-bottom:20px">
    <h2 style="margin:0 0 6px;font-size:16px;color:#E8C87A">💼 2. Portfolio Overview</h2>
    <p style="margin:0 0 14px;font-size:12px;color:#5A6280">You own shares in investment funds spread across two accounts. Think of each fund as a basket of many company shares.</p>
    <div style="background:#1A1E2A;border-radius:12px;padding:16px;margin-bottom:16px;text-align:center">
      <div style="font-size:11px;color:#5A6280;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Total Value of Your Portfolio</div>
      <div style="font-size:34px;font-weight:700;color:#E8C87A;font-family:monospace">${nlv}</div>
      <div style="font-size:13px;color:${twrCol};margin-top:6px">12-month return: ${twr>=0?"+":""}${twr}% ${twr>=0?"📈":"📉"}</div>
    </div>
    <div style="font-size:11px;color:#5A6280;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px">How your money is split:</div>
    <table style="width:100%">${allocBars}</table>
    <p style="font-size:11px;color:#5A6280;margin:10px 0 0">Each bar = percentage of your total money. Bigger bar = more money there.</p>
  </div>

  <!-- 3. Market Snapshot -->
  <div style="background:#13161E;border:1px solid #252A38;border-radius:16px;padding:20px;margin-bottom:20px">
    <h2 style="margin:0 0 6px;font-size:16px;color:#E8C87A">📈 Markets at a glance</h2>
    <p style="margin:0 0 14px;font-size:12px;color:#5A6280">Like a weather forecast for different types of investments:</p>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid #252A38"><th style="padding:6px 8px;text-align:left;color:#5A6280;font-size:11px;text-transform:uppercase">Market</th><th style="padding:6px 8px;text-align:left;color:#5A6280;font-size:11px">Price</th><th style="padding:6px 8px;text-align:left;color:#5A6280;font-size:11px">Today</th></tr></thead>
      <tbody>${macroRows||"<tr><td colspan='3' style='padding:8px;color:#5A6280;font-size:13px'>No data available</td></tr>"}</tbody>
    </table>
  </div>

  <!-- 4. PnL -->
  <div style="background:#13161E;border:1px solid #252A38;border-radius:16px;padding:20px;margin-bottom:20px">
    <h2 style="margin:0 0 6px;font-size:16px;color:#E8C87A">💰 3. P&amp;L and Performance Summary</h2>
    <p style="margin:0 0 14px;font-size:12px;color:#5A6280">The difference between what your investments are worth now vs what was paid for them:</p>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div style="flex:1;min-width:130px;background:#1A1E2A;border-radius:12px;padding:14px;text-align:center">
        <div style="font-size:10px;color:#5A6280;text-transform:uppercase;margin-bottom:6px">Unrealised Gain/Loss</div>
        <div style="font-size:20px;font-weight:700;color:${unrealCol};font-family:monospace">${unrealStr}</div>
        <div style="font-size:10px;color:#5A6280;margin-top:4px">On paper — not cashed in</div>
      </div>
      ${metrics?`<div style="flex:1;min-width:130px;background:#1A1E2A;border-radius:12px;padding:14px;text-align:center"><div style="font-size:10px;color:#5A6280;text-transform:uppercase;margin-bottom:6px">Sharpe Ratio</div><div style="font-size:20px;font-weight:700;color:${(metrics.sharpe||0)>0.5?"#2ECC71":"#F59E0B"};font-family:monospace">${(metrics.sharpe||0).toFixed(2)}</div><div style="font-size:10px;color:#5A6280;margin-top:4px">Return quality (>0.5 = good)</div></div>`:""}
      ${metrics?`<div style="flex:1;min-width:130px;background:#1A1E2A;border-radius:12px;padding:14px;text-align:center"><div style="font-size:10px;color:#5A6280;text-transform:uppercase;margin-bottom:6px">Max Drawdown</div><div style="font-size:20px;font-weight:700;color:#E74C3C;font-family:monospace">${(metrics.maxDrawdownPct||0).toFixed(1)}%</div><div style="font-size:10px;color:#5A6280;margin-top:4px">Worst dip from peak</div></div>`:""}
    </div>
    ${metrics?`<div style="background:#1A1E2A;border-radius:10px;padding:12px"><p style="margin:0;font-size:13px;color:#EDF0F7;line-height:1.6">📖 <strong>In plain English:</strong> Over the past year, the portfolio returned <strong style="color:${(metrics.annualizedReturnPct||0)>=0?"#2ECC71":"#E74C3C"}">${(metrics.annualizedReturnPct||0).toFixed(1)}%</strong>. The typical daily up/down was about <strong style="color:#EDF0F7">${(metrics.annualizedVolPct||0).toFixed(1)}%</strong> when annualised. The worst stretch was a <strong style="color:#E74C3C">${(metrics.maxDrawdownPct||0).toFixed(1)}%</strong> drop from the highest point.</p></div>`:""}
  </div>

  <!-- 5. Risks -->
  <div style="background:#13161E;border:1px solid #252A38;border-radius:16px;padding:20px;margin-bottom:20px">
    <h2 style="margin:0 0 6px;font-size:16px;color:#E8C87A">⚠️ 4. Risks to be Watched</h2>
    <p style="margin:0 0 14px;font-size:12px;color:#5A6280">Not reasons to panic — just things worth being aware of:</p>
    ${risks}
  </div>

  <div style="text-align:center;padding:16px;color:#5A6280;font-size:11px">
    <p style="margin:0">Generated by IBKR Agent · ${new Date().toISOString().slice(0,16).replace("T"," ")} UTC</p>
    <p style="margin:6px 0 0">Data: IBKR Flex + Yahoo Finance. Not financial advice.</p>
  </div>
</div></body></html>`;

  return sendEmail(to, `📊 Morning Portfolio Report — ${new Date().toLocaleDateString("en-GB")}`, html);
}


// ─── Tool executor ────────────────────────────────────────────────
async function executeTool(name, input) {
  switch (name) {

    case "get_portfolio":   return buildPortfolio(input?.refresh || false);
    case "refresh_data":    { _cache = null; const p = await buildPortfolio(true); return { ok: true, accounts: p.accounts.map(a => a.accountId) }; }

    case "get_trades": {
      const all = await getStatements();
      const stmts = latestPerAccount(all);
      const trades = stmts.flatMap(s => toArr(s?.Trades?.Trade).map(t => ({
        accountId: s.accountId, symbol: t.symbol, description: t.description, dateTime: t.dateTime,
        side: t.buySell, quantity: n(t.quantity), price: n(t.tradePrice), currency: t.currency,
        proceeds: n(t.proceeds), commission: n(t.ibCommission), realizedPnl: n(t.fifoPnlRealized),
      })));
      const filtered = input?.symbol ? trades.filter(t => t.symbol?.toUpperCase() === input.symbol.toUpperCase()) : trades;
      filtered.sort((a, b) => (b.dateTime || "").localeCompare(a.dateTime || ""));
      return { count: filtered.length, trades: filtered.slice(0, 100) };
    }

    case "get_pnl": {
      const p = await buildPortfolio();
      const sorted = [...p.combined.positions].sort((a, b) => b.totalUnrealEUR - a.totalUnrealEUR);
      return {
        combined: { totalUnrealizedPnlEUR: p.combined.totalUnrealizedPnlEUR, totalCommissions: p.combined.totalCommissions, totalDividends: p.combined.totalDividends,
          bestPositions: sorted.slice(0, 5).map(x => ({ symbol: x.symbol, unrealizedPnlEUR: x.totalUnrealEUR, allocationPct: +x.allocationPct.toFixed(2) })),
          worstPositions: sorted.slice(-5).reverse().map(x => ({ symbol: x.symbol, unrealizedPnlEUR: x.totalUnrealEUR, allocationPct: +x.allocationPct.toFixed(2) })) },
        perAccount: p.accounts.map(a => ({ accountId: a.accountId, baseCurrency: a.baseCurrency, unrealizedPnl: a.positions.reduce((s, x) => s + x.unrealizedPnl, 0).toFixed(2), commissions: a.commissions.toFixed(2), dividends: a.dividends.toFixed(2) })),
      };
    }

    case "get_allocation": {
      const p = await buildPortfolio();
      return { totalNLV_EUR: p.combined.totalNetLiquidation, allocations: p.combined.positions.map(x => ({ symbol: x.symbol, description: x.description, valueEUR: x.totalValueEUR, allocationPct: +x.allocationPct.toFixed(2), unrealizedPnlEUR: x.totalUnrealEUR, legs: x.legs })) };
    }

    case "get_portfolio_analytics": {
      const p = await buildPortfolio(input?.refresh || false);
      const m = p.combined.metrics1Y;
      if (!m) return { error: "Portfolio analytics unavailable" };
      return {
        method: m.method,
        metrics: {
          totalReturnPct: m.totalReturnPct,
          annualizedReturnPct: m.annualizedReturnPct,
          annualizedVolPct: m.annualizedVolPct,
          sharpe: m.sharpe,
          maxDrawdownPct: m.maxDrawdownPct,
          var95Pct: m.var95Pct,
          cvar95Pct: m.cvar95Pct,
          informationRatioVsSPX: m.informationRatioVsSPX,
          calmar: m.calmar,
          averageDailyReturnPct: m.averageDailyReturnPct
        },
        weights: m.weights,
        correlationMatrix: m.correlationMatrix,
        chartTag: "@@PORTFOLIO:1y@@",
        rollingSharpeTag: "@@QUANT:PORTFOLIO:rollingSharpe30:1y:Portfolio Rolling Sharpe (30d)@@"
      };
    }

    case "get_market_data": {
      const sym = input.symbol.toUpperCase();
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) return { error: `No data for ${sym}` };
      return { symbol: meta.symbol, shortName: meta.shortName, currency: meta.currency, exchange: meta.exchangeName,
        regularMarketPrice: meta.regularMarketPrice, previousClose: meta.chartPreviousClose,
        change: +(meta.regularMarketPrice - meta.chartPreviousClose).toFixed(4),
        changePct: +(((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100).toFixed(2),
        regularMarketDayHigh: meta.regularMarketDayHigh, regularMarketDayLow: meta.regularMarketDayLow,
        regularMarketVolume: meta.regularMarketVolume, fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh, fiftyTwoWeekLow: meta.fiftyTwoWeekLow };
    }

    case "get_historical_data": {
      const sym      = input.symbol.toUpperCase();
      const range    = input.range    || "1y";
      const interval = input.interval || "1d";
      const res  = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) return { error: `No data for ${sym}` };
      const { timestamp, indicators } = result;
      const q = indicators?.quote?.[0] || {};
      const bars = (timestamp || []).map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), open: q.open?.[i] ? +q.open[i].toFixed(4) : null, high: q.high?.[i] ? +q.high[i].toFixed(4) : null, low: q.low?.[i] ? +q.low[i].toFixed(4) : null, close: q.close?.[i] ? +q.close[i].toFixed(4) : null, volume: q.volume?.[i] || null })).filter(b => b.close !== null);
      return { symbol: sym, currency: result.meta?.currency, range, interval, count: bars.length, bars };
    }

    case "get_multiple_quotes": {
      const symbols = (input.symbols || []).map(s => s.toUpperCase()).join(",");
      const res  = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await res.json();
      return (data?.quoteResponse?.result || []).map(q => ({ symbol: q.symbol, shortName: q.shortName, currency: q.currency,
        price: q.regularMarketPrice, change: +((q.regularMarketPrice - q.regularMarketPreviousClose) || 0).toFixed(4),
        changePct: q.regularMarketChangePercent ? +q.regularMarketChangePercent.toFixed(2) : 0,
        dayHigh: q.regularMarketDayHigh, dayLow: q.regularMarketDayLow, volume: q.regularMarketVolume,
        marketCap: q.marketCap, pe: q.trailingPE, week52High: q.fiftyTwoWeekHigh, week52Low: q.fiftyTwoWeekLow }));
    }

    case "search_symbol": {
      const res  = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(input.query)}&quotesCount=10&newsCount=0`, { headers: { "User-Agent": "Mozilla/5.0" } });
      const data = await res.json();
      return (data?.quotes || []).map(q => ({ symbol: q.symbol, shortName: q.shortname, longName: q.longname, exchange: q.exchange, type: q.quoteType }));
    }

    case "compute_analytics": {
      const sym    = input.symbol.toUpperCase();
      const range  = input.range   || "1y";
      const bench  = input.benchmark || "^GSPC";
      const win    = input.rolling_window || 30;

      const { bars, meta } = await fetchYahooCloses(sym, range);
      const dates  = bars.map(b => b.date);
      const closes = bars.map(b => b.close);
      const r      = rets(closes);

      // ── Rolling series ──────────────────────────────────────────
      // r = daily returns, length = closes.length - 1
      // All return-based series are padded by 1 null at front to align with dates[]

      // Z-score of returns, 252-day window (matches pandas rolling(252))
      const zs252raw = rollingFn(r, 252, arr => {
        const last = arr[arr.length - 1], m = mean(arr), s = std(arr);
        return s === 0 ? 0 : +((last - m) / s).toFixed(4);
      });
      const priceZscore = [null, ...zs252raw]; // align to dates[]

      // Z-score of returns, 30-day window
      const zs30raw = rollingFn(r, 30, arr => {
        const last = arr[arr.length - 1], m = mean(arr), s = std(arr);
        return s === 0 ? 0 : +((last - m) / s).toFixed(4);
      });
      const priceZscore30 = [null, ...zs30raw];

      // Rolling Sharpe: mean(r)/std(r) window=252, no annualisation (matches pandas)
      const rollingSharpeRaw = rollingFn(r, 252, arr => {
        const m = mean(arr), s = std(arr);
        return s === 0 ? 0 : +(m / s).toFixed(4);  // pandas: mean/std no annualisation
      });
      const rollingSharpe = [null, ...rollingSharpeRaw];

      // Rolling Vol: annualised std × √252, configurable window
      const rollingVolRaw = rollingFn(r, win, arr => +(std(arr) * Math.sqrt(252) * 100).toFixed(4));
      const rollingVol = [null, ...rollingVolRaw];

      // Rolling historical VaR: positive loss percentage, configurable window
      const rollingVaR95Raw = rollingFn(r, win, arr => { const v = histVaR(arr, 0.95); return v === null ? null : +(v * 100).toFixed(4); });
      const rollingVaR99Raw = rollingFn(r, win, arr => { const v = histVaR(arr, 0.99); return v === null ? null : +(v * 100).toFixed(4); });
      const rollingVaR95 = [null, ...rollingVaR95Raw];
      const rollingVaR99 = [null, ...rollingVaR99Raw];

      // Drawdown on closes
      const drawdownSeries = (() => {
        let peak = -Infinity;
        return closes.map(c => { if (c > peak) peak = c; return +((c - peak) / peak * 100).toFixed(4); });
      })();

      // Scalar beta/corr for summary only
      let betaVal = null, corrVal = null;
      try {
        const { bars: bb } = await fetchYahooCloses(bench, range);
        const br  = rets(bb.map(b => b.close));
        const len = Math.min(r.length, br.length);
        betaVal = betaFn(r.slice(-len), br.slice(-len));
        corrVal = corrFn(r.slice(-len), br.slice(-len));
      } catch {}

      const summary = {
        currentPrice:        closes[closes.length - 1],
        totalReturn:         +((closes[closes.length - 1] / closes[0] - 1) * 100).toFixed(2),
        annualizedVol:       +(std(r) * Math.sqrt(252) * 100).toFixed(2),
        meanDailyReturn:     +(mean(r) * 100).toFixed(4),
        sharpe:              std(r)===0 ? 0 : +(mean(r)/std(r)).toFixed(4),
        sortino:             +sortino(r).toFixed(4),
        maxDrawdown:         +maxDD(closes).toFixed(2),
        var95:               (() => { const v = histVaR(r, 0.95); return v === null ? null : +(v * 100).toFixed(2); })(),
        var99:               (() => { const v = histVaR(r, 0.99); return v === null ? null : +(v * 100).toFixed(2); })(),
        cvar95:              (() => { const v = histCVaR(r, 0.95); return v === null ? null : +(v * 100).toFixed(2); })(),
        cvar99:              (() => { const v = histCVaR(r, 0.99); return v === null ? null : +(v * 100).toFixed(2); })(),
        skewness:            +skewness(r).toFixed(4),
        kurtosis:            +kurtosis(r).toFixed(4),
        beta:                betaVal !== null ? +betaVal.toFixed(4) : null,
        correlation:         corrVal !== null ? +corrVal.toFixed(4) : null,
        currentReturnZscore: zs252raw[zs252raw.length - 1] ?? zs30raw[zs30raw.length - 1] ?? null,
        currentReturnZscore30: zs30raw[zs30raw.length - 1] ?? null,
      };

      const distribution = returnDistribution(r, input.bins || 20);
      const series = { dates, closes, returns: [null, ...r.map(v => +(v * 100).toFixed(4))], priceZscore, priceZscore30, rollingSharpe, rollingVol, rollingVaR95, rollingVaR99, drawdownSeries, distribution };

      // Cache for GET endpoint
      analyticsCache.set(`${sym}:${range}`, { ...series, summary, computedAt: Date.now() });

      return {
        symbol: sym, benchmark: bench, range, currency: meta?.currency, summary, series,
        chartTags: {
          price:         `@@CHART:${sym}:${range}@@`,
          zscore:        `@@QUANT:${sym}:priceZscore:${range}:Z-Score (${win}d rolling)@@`,
          rollingSharpe: `@@QUANT:${sym}:rollingSharpe:${range}:Rolling Sharpe (${win}d)@@`,
          returns:       `@@QUANT:${sym}:returns:${range}:Daily Returns %@@`,
          distribution:  `@@QUANT:${sym}:distribution:${range}:Return Distribution@@`,
          rollingVol:    `@@QUANT:${sym}:rollingVol:${range}:Rolling Vol % ann. (${win}d)@@`,
          rollingVaR95:  `@@QUANT:${sym}:rollingVaR95:${range}:Rolling VaR 95% (${win}d)@@`,
          rollingVaR99:  `@@QUANT:${sym}:rollingVaR99:${range}:Rolling VaR 99% (${win}d)@@`,
          drawdown:      `@@QUANT:${sym}:drawdownSeries:${range}:Drawdown %@@`,
        },
      };
    }

    case "compute_correlation_matrix": {
      const symbols = input.symbols || [];
      const range   = input.range || "1y";
      const seriesMap = {};
      for (const sym of symbols) {
        try { const { bars } = await fetchYahooCloses(sym, range); seriesMap[sym] = rets(bars.map(b => b.close)); } catch {}
      }
      const syms = Object.keys(seriesMap);
      const matrix = {};
      for (const a of syms) { matrix[a] = {}; for (const b of syms) { const len = Math.min(seriesMap[a].length, seriesMap[b].length); matrix[a][b] = a === b ? 1 : +(corrFn(seriesMap[a].slice(-len), seriesMap[b].slice(-len)) || 0).toFixed(3); } }
      return { symbols: syms, matrix, range };
    }

    case "get_market_news":
      return fetchMarketNews(input || {});

    case "get_macro_snapshot":
      return marketSnapshot();

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// Analytics cache
const analyticsCache = new Map();

// ─── Claude agent ─────────────────────────────────────────────────
const TOOLS = [
  { name: "get_portfolio",   description: "Get complete portfolio across BOTH IBKR accounts with combined positions, allocation %, unrealized P&L, 1Y return.", input_schema: { type: "object", properties: { refresh: { type: "boolean" } }, required: [] } },
  { name: "get_trades",      description: "Get trade history across both accounts. Filter by symbol optionally.", input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: [] } },
  { name: "get_pnl",         description: "Get P&L summary: unrealized P&L, best/worst positions, commissions, dividends.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_allocation",  description: "Get portfolio allocation by symbol, all in EUR with correct combined percentages.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_portfolio_analytics", description: "Reconstruct the current-weight portfolio from 1Y Yahoo returns, return risk metrics, weights, correlation matrix, and inline portfolio chart tag. Use for Combined Portfolio Overview and VaR & Risk report.", input_schema: { type: "object", properties: { refresh: { type: "boolean" } }, required: [] } },
  { name: "refresh_data",    description: "Force fresh data pull from IBKR.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_market_data", description: "Real-time quote for any stock/ETF worldwide.", input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } },
  { name: "get_historical_data", description: "OHLCV history for charting. range: 1mo,3mo,6mo,1y,2y,5y,ytd. interval: 1d,1wk,1mo.", input_schema: { type: "object", properties: { symbol: { type: "string" }, range: { type: "string" }, interval: { type: "string" } }, required: ["symbol"] } },
  { name: "get_multiple_quotes", description: "Live quotes for multiple symbols at once.", input_schema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } } }, required: ["symbols"] } },
  { name: "search_symbol",   description: "Search for a ticker by company name.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "compute_analytics", description: "Compute quant analytics: returns, return distribution, historical VaR 95/99, CVaR 95/99, skewness, kurtosis, rolling VaR, Z-score, rolling Sharpe, rolling vol, beta, correlation and drawdown. Returns series data + chart tags. Use for ANY quant, risk, distribution, VaR/CVaR, skew/kurtosis, or chart request.", input_schema: { type: "object", properties: { symbol: { type: "string" }, range: { type: "string", description: "1mo,3mo,6mo,1y,2y,5y,ytd" }, benchmark: { type: "string", description: "Default ^GSPC" }, rolling_window: { type: "number", description: "Default 30" }, bins: { type: "number", description: "Histogram bins for return distribution, default 20" } }, required: ["symbol"] } },
  { name: "compute_correlation_matrix", description: "Pairwise correlation matrix for multiple symbols.", input_schema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } }, range: { type: "string" } }, required: ["symbols"] } },
  { name: "get_market_news", description: "Get current market news headlines from finance RSS feeds. Use for morning, midday, end-of-day briefs and any latest-news request.", input_schema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } }, limit: { type: "number" } }, required: [] } },
  { name: "get_macro_snapshot", description: "Get current movement snapshot for main indices, rates, FX, commodities, crypto and major asset classes.", input_schema: { type: "object", properties: {}, required: [] } },
];

const SYSTEM = `You are a professional finance AI agent managing TWO Interactive Brokers accounts:
- U11354150: EUR-denominated (main)
- U9733561: GBP-denominated (ISA)

Data is read-only via IBKR Flex Web Service. All combined figures are in EUR.

Portfolio: CSNDX, CSPX, CSSX5E, IEEM, IUSE, NQSE, SPCX, VUAG, VWRL, VFEM.
Yahoo Finance symbols: CSPX→CSPX.L, CSNDX→CNDX.L (Nasdaq 100 UCITS ETF proxy that works on Yahoo), CSSX5E→CSSX5E.SW, IEEM→IEEM.L, IUSE→IUSE.L, NQSE→NQSE.DE, SPCX→SPCX.L, VUAG→VUAG.L, VWRL→VWRL.L, VFEM→VFEM.L.

CHART TAGS — embed in responses to render charts inline:
Price chart:  @@CHART:SYMBOL:RANGE@@
Quant chart:  @@QUANT:SYMBOL:METRIC:RANGE:LABEL@@
Metrics: returns | distribution | priceZscore | priceZscore30 | rollingSharpe | rollingVol | rollingVaR95 | rollingVaR99 | drawdownSeries

QUANT WORKFLOW: call compute_analytics first, then paste the chartTags from result into your reply.
PORTFOLIO ANALYTICS WORKFLOW: call get_portfolio_analytics for portfolio overview, risk, VaR, matrices, weights, or reconstructed portfolio chart requests. Show weights/correlation matrices as markdown tables, not JSON. Include @@PORTFOLIO:1y@@ when the user asks for portfolio reconstruction or a single portfolio chart.
Example: "Sharpe: 1.24 | Vol: 12% | VaR95: 1.8% | CVaR95: 2.4% @@CHART:CSPX.L:1y@@ @@QUANT:CSPX.L:rollingSharpe:1y:Rolling Sharpe (30d)@@ @@QUANT:CSPX.L:rollingVaR95:1y:Rolling VaR 95% (30d)@@"

MARKET NEWS WORKFLOW: for morning, midday, end-of-day, latest news, headlines, asset-class moves, or scheduled briefings, call get_market_news and get_macro_snapshot, then combine with portfolio data.

Always use combined portfolio percentages, not per-account NAV%. Format matrices and tabular data as markdown tables with concise columns; never dump raw JSON objects into the chat.
1Y return = time-weighted return over last 365 days (label as "1Y Return", not YTD).
Format: EUR=€, GBP=£, USD=$, 2 decimal places. Today: ${new Date().toDateString()}.`;

async function runAgent(prompt, history = []) {
  const messages = [...history, { role: "user", content: prompt }];
  let response = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 2000, system: SYSTEM, tools: TOOLS, messages });
  let loop = [...messages], i = 0;
  while (response.stop_reason === "tool_use" && i++ < 10) {
    loop.push({ role: "assistant", content: response.content });
    const results = await Promise.all(response.content.filter(b => b.type === "tool_use").map(async b => {
      let result; try { result = await executeTool(b.name, b.input); } catch (e) { result = { error: e.message }; }
      return { type: "tool_result", tool_use_id: b.id, content: JSON.stringify(result) };
    }));
    loop.push({ role: "user", content: results });
    response = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 2000, system: SYSTEM, tools: TOOLS, messages: loop });
  }
  return response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

// ─── Push ─────────────────────────────────────────────────────────
const pushSubs = new Map();
async function sendPush(title, body, icon = "📈") {
  console.log(`🔔 sendPush: "${title}" | subs=${pushSubs.size} | vapid=${!!VAPID_PUBLIC&&!!VAPID_PRIVATE}`);
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !pushSubs.size) return;
  const payload = JSON.stringify({ title, body, icon, timestamp: Date.now() });
  const expired = [];
  for (const [id, sub] of pushSubs.entries()) {
    try { await webpush.sendNotification(sub, payload); }
    catch (e) { if (e.statusCode === 410 || e.statusCode === 404) expired.push(id); }
  }
  expired.forEach(id => pushSubs.delete(id));
}

// ─── Scheduled tasks ──────────────────────────────────────────────
const TASKS = [
  { id: "morning", label: "Morning briefing",   icon: "🌅", cron: "30 7 * * 1-5", cronDisplay: "8:30 AM London",
    prompt: "Morning briefing: get market news, macro snapshot, portfolio and allocation. Cover main overnight headlines, movements in indices/rates/FX/commodities, combined NLV, top 5 positions by %, combined unrealized P&L, and key portfolio risks. Concise." },
  { id: "midday",  label: "Midday check",        icon: "☀️", cron: "0 11 * * 1-5",  cronDisplay: "12:00 PM London",
    prompt: "Midday check: get market news, macro snapshot and portfolio. Mention any new market news since the morning, asset-class/index movements, combined NLV and unrealized P&L. Under 150 words." },
  { id: "eod",     label: "End-of-day summary",  icon: "🌆", cron: "0 16 * * 1-5",  cronDisplay: "5:00 PM London",
    prompt: "End of day: get market news, macro snapshot, portfolio and trades. Summarize today's key headlines, asset-class/index movements, portfolio movement, combined NLV, unrealized P&L, trades today, and biggest movers." },
  { id: "weekly",  label: "Weekly review",       icon: "⚖️", cron: "30 15 * * 5",   cronDisplay: "4:30 PM London (Fri)",
    prompt: "Weekly review: get market news, macro snapshot, portfolio, allocation, P&L and trades. Include weekly market headlines, asset-class/index movements, combined NLV, full allocation breakdown, unrealized P&L, trades this week, commissions, concentration risk, and 1Y portfolio metrics." },
];
const taskState = {};
TASKS.forEach(t => { taskState[t.id] = { enabled: true, lastRun: null, lastResult: null, running: false }; });
const taskLog = [];

TASKS.forEach(task => {
  cron.schedule(task.cron, async () => {
    if (!taskState[task.id].enabled || taskState[task.id].running) return;
    taskState[task.id].running = true;
    taskLog.unshift({ task: task.label, status: "running", time: new Date().toISOString() });
    await sendPush(`${task.icon} ${task.label}`, "Running now…", task.icon);
    try {
      const result = await runAgent(task.prompt);
      taskState[task.id] = { ...taskState[task.id], running: false, lastRun: new Date().toISOString(), lastResult: result };
      taskLog[0] = { task: task.label, status: "done", time: taskState[task.id].lastRun, result };
      await sendPush(`${task.icon} ${task.label} done`, result.slice(0, 140), task.icon);
      // Send email for morning briefing
      if (task.id === "morning") {
        buildAndSendReport(REPORT_TO).catch(e => console.error("Morning email failed:", e.message));
      }
    } catch (e) {
      taskState[task.id].running = false;
      taskLog[0] = { task: task.label, status: "error", time: new Date().toISOString(), result: e.message };
      await sendPush(`❌ ${task.label} failed`, e.message.slice(0, 120), "❌");
    }
  });
});

// ─── Routes ───────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  try { res.json({ reply: await runAgent(message, history) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/account", async (req, res) => {
  try { res.json(await buildPortfolio()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/tasks", (req, res) => res.json(TASKS.map(t => ({ ...t, ...taskState[t.id] }))));
app.patch("/api/tasks/:id", (req, res) => { if (!taskState[req.params.id]) return res.status(404).json({ error: "Not found" }); taskState[req.params.id].enabled = req.body.enabled; res.json({ ok: true }); });
app.post("/api/tasks/:id/run", async (req, res) => {
  const task = TASKS.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Not found" });
  if (taskState[task.id].running) return res.status(409).json({ error: "Already running" });
  taskState[task.id].running = true;
  taskLog.unshift({ task: task.label, status: "running", time: new Date().toISOString() });
  res.json({ ok: true });
  try {
    const result = await runAgent(task.prompt);
    taskState[task.id] = { ...taskState[task.id], running: false, lastRun: new Date().toISOString(), lastResult: result };
    taskLog[0] = { task: task.label, status: "done", time: taskState[task.id].lastRun, result };
    await sendPush(`${task.icon} ${task.label} done`, result.slice(0, 140), task.icon);
    if (task.id === "morning") {
      buildAndSendReport(REPORT_TO).catch(e => console.error("Email failed:", e.message));
    }
  } catch (e) { taskState[task.id].running = false; taskLog[0] = { task: task.label, status: "error", time: new Date().toISOString(), result: e.message }; }
});

app.get("/api/log", (req, res) => res.json(taskLog.slice(0, 50)));

// Symbol news for chart tab headlines
app.get("/api/news/symbol/:symbol", async (req, res) => {
  try {
    const news = await fetchSymbolNews(req.params.symbol, +(req.query.limit||5));
    res.json({ news });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send email report on demand
app.post("/api/email/report", async (req, res) => {
  try {
    const to = req.body?.to || REPORT_TO;
    const result = await buildAndSendReport(to);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/news", async (req, res) => {
  try { res.json(await fetchMarketNews({ symbols: (req.query.symbols || "").split(",").filter(Boolean), limit: +(req.query.limit || 12) })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/market-snapshot", async (req, res) => {
  try { res.json(await marketSnapshot()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Market data
app.get("/api/chart/:symbol", async (req, res) => {
  try { res.json(await executeTool("get_historical_data", { symbol: req.params.symbol, range: req.query.range || "1y", interval: req.query.interval || "1d" })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/quote/:symbol", async (req, res) => {
  try { res.json(await executeTool("get_market_data", { symbol: req.params.symbol })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/quotes", async (req, res) => {
  try { res.json(await executeTool("get_multiple_quotes", { symbols: (req.query.symbols || "").split(",").filter(Boolean) })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});


app.get("/api/portfolio/analytics", async (req, res) => {
  try {
    const p = await buildPortfolio(req.query.refresh === "true");
    const m = p.combined.metrics1Y;
    if (!m) return res.status(404).json({ error: "Portfolio analytics unavailable" });
    res.json(m);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Analytics — compute and return series immediately
app.post("/api/analytics/compute", async (req, res) => {
  try {
    const { symbol, range = "1y", benchmark = "^GSPC", rolling_window = 30 } = req.body;
    if (!symbol) return res.status(400).json({ error: "symbol required" });
    const result = await executeTool("compute_analytics", { symbol, range, benchmark, rolling_window });
    if (result.error) return res.status(500).json(result);
    // Return series fields at top level for easy frontend consumption
    res.json({ ...result.series, summary: result.summary, symbol: result.symbol, range, currency: result.currency, chartTags: result.chartTags });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/analytics/:symbol", (req, res) => {
  const key    = `${req.params.symbol.toUpperCase()}:${req.query.range || "1y"}`;
  const cached = analyticsCache.get(key);
  if (!cached) return res.status(404).json({ error: "Not cached yet" });
  res.json(cached);
});

// Push
app.get("/api/push/vapid-key",    (req, res) => res.json({ publicKey: VAPID_PUBLIC }));
app.post("/api/push/subscribe",   (req, res) => { const sub = req.body; if (!sub?.endpoint) return res.status(400).json({ error: "Invalid" }); const id=Buffer.from(sub.endpoint).toString("base64").slice(0,32); pushSubs.set(id,sub); console.log(`📱 Push registered id=${id.slice(0,8)} total=${pushSubs.size}`); res.json({ ok: true }); });
app.post("/api/push/unsubscribe", (req, res) => { pushSubs.delete(Buffer.from(req.body.endpoint || "").toString("base64").slice(0, 32)); res.json({ ok: true }); });
app.post("/api/push/test",        async (req, res) => { await sendPush("✅ Test", "Push notifications working!", "✅"); res.json({ ok: true }); });

app.get("/api/ibkr/status", async (req, res) => {
  try { const p = await buildPortfolio(); res.json({ authenticated: true, mode: "flex_web_service", accounts: p.accounts.map(a => ({ id: a.accountId, currency: a.baseCurrency, nlv: a.netLiquidation })), combinedNLV_EUR: p.combined.totalNetLiquidation }); }
  catch (e) { res.status(503).json({ authenticated: false, error: e.message }); }
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString(), pushSubscribers: pushSubs.size }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 IBKR Agent on port ${PORT}`));
