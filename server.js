import express from "express";
import cors from "cors";
import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";
import webpush from "web-push";
import { XMLParser } from "fast-xml-parser";
import fs from "fs";

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

const RESEND_KEY  = process.env.RESEND_API_KEY  || "";
const REPORT_TO   = process.env.REPORT_EMAIL_TO || "luca-ciampiruiz@hotmail.com";  // must match Resend account email

// Risk-free rate (SOFR, annualised %) used in Sharpe, Sortino, and Fama-French alpha.
// FRED now requires an API key for programmatic access, so this is set manually —
// update periodically from https://www.newyorkfed.org/markets/reference-rates/sofr
// Last updated: 2026-06-25, SOFR = 3.64%
const RISK_FREE_RATE_PCT = +(process.env.RISK_FREE_RATE_PCT || 3.64); // annualised %
const RISK_FREE_RATE_DAILY = RISK_FREE_RATE_PCT / 100 / 252; // daily decimal, simple division (252 trading days)
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const parser    = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

// ── Push subscription persistence ─────────────────────────────────
const PUSH_SUBS_FILE = "/tmp/push-subs.json";
const pushSubs = new Map();
function loadPushSubs() {
  try {
    if (fs.existsSync(PUSH_SUBS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, "utf8"));
      Object.entries(data).forEach(([id, sub]) => pushSubs.set(id, sub));
      console.log(`📱 Loaded ${pushSubs.size} push subscriptions`);
    }
  } catch (e) { console.error("Failed to load push subs:", e.message); }
}
function savePushSubs() {
  try { fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(Object.fromEntries(pushSubs))); }
  catch (e) { console.error("Failed to save push subs:", e.message); }
}
loadPushSubs();
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
    // Explicitly pick the row with the MAX reportDate (don't trust array order)
    const equity = equityRows.length
      ? equityRows.reduce((latest, r) => (!latest || (r.reportDate||"") > (latest.reportDate||"")) ? r : latest, null)
      : {};
    // Full historical NLV series (real broker-reported, not Yahoo-reconstructed) — sorted ascending by date
    const nlvHistory = equityRows
      .map(r => ({ date: r.reportDate, nlv: n(r.total) }))
      .filter(r => r.date && r.nlv > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
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
      dividendAccruals:   n(equity.dividendAccruals),
      // NLV breakdown for debugging
      nlvCash:            n(equity.cash),
      nlvStock:           n(equity.stock),
      nlvDividendAccruals: n(equity.dividendAccruals),
      // equity.total = cash + stock + dividendAccruals + other accruals
      // IBKR portal shows same figure so gap is likely FX timing
      acctFxToEUR,
      // Real broker-reported NLV history (EUR-converted), for true drawdown calculation
      nlvHistoryEUR: nlvHistory.map(r => ({ date: r.date, nlvEUR: r.nlv * acctFxToEUR })),
      ytdReturn:     n(changeInNAV.twr),
      startingValue: n(changeInNAV.startingValue) * acctFxToEUR,
      endingValue:   n(changeInNAV.endingValue)   * acctFxToEUR,
      // ytdGainEUR = investment gain only (twr-based), excludes deposits/withdrawals
      ytdGainEUR:    n(changeInNAV.startingValue) * (n(changeInNAV.twr) / 100) * acctFxToEUR,
      commissions:   n(baseCash.commissions),
      deposits:      n(baseCash.deposits),
      withdrawals:   n(baseCash.withdrawals),
      netDeposits:   n(baseCash.deposits) + n(baseCash.withdrawals), // withdrawals are negative in Flex
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
      // NLV-weighted average TWR across accounts
      avgYtdReturnPct: +(accounts.reduce((s,a)=>s+(a.ytdReturn||0)*a.netLiquidationEUR,0) / Math.max(totalNLV,1)).toFixed(2),
      totalCommissions:      +accounts.reduce((s, a) => s + a.commissions, 0).toFixed(2),
      totalDividends:        +accounts.reduce((s, a) => s + a.dividends, 0).toFixed(2),
      totalBrokerInterest:   +accounts.reduce((s, a) => s + a.brokerInterest, 0).toFixed(2),
      totalNetDeposits:      +accounts.reduce((s, a) => s + (a.netDeposits || 0), 0).toFixed(2),
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
function sortino(r, period = 252) { const m = mean(r) - RISK_FREE_RATE_DAILY; const neg = r.filter(v => v < 0); const ds = neg.length ? Math.sqrt(neg.reduce((s, v) => s + v * v, 0) / neg.length) : 0; return ds === 0 ? 0 : (m / ds) * Math.sqrt(period); }
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
// convertToEUR=true converts local-currency returns to EUR using daily FX rates.
// Default true for portfolio analytics; pass false only for raw-currency analysis (e.g. single-symbol charts).
async function fetchYahooReturnSeries(symbol, range = "1y", convertToEUR = true) {
  const ySym = yfSymbol(symbol);
  const { bars, meta } = await fetchYahooCloses(ySym, range);
  const out = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]?.close;
    const cur = bars[i]?.close;
    if (prev && cur && Number.isFinite(prev) && Number.isFinite(cur)) out.push({ date: bars[i].date, ret: (cur - prev) / prev });
  }
  // Use explicit override if known (e.g. CSSX5E.SW is EUR despite SIX listing)
  const currency = CURRENCY_OVERRIDE[ySym] || meta?.currency || "EUR";
  if (convertToEUR && currency !== "EUR") {
    return convertReturnsToEUR(out, currency, range);
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


// ─── PCA via Jacobi eigenvalue algorithm ──────────────────────────
// Symmetric matrix eigendecomposition — no external libs needed
function jacobiEigen(matrix, maxIter = 100, tol = 1e-9) {
  const n = matrix.length;
  let A = matrix.map(r => [...r]);
  let V = Array.from({length:n}, (_,i) => Array.from({length:n}, (_,j) => i===j?1:0));

  for (let iter = 0; iter < maxIter; iter++) {
    // Find largest off-diagonal element
    let p = 0, q = 1, maxOff = 0;
    for (let i = 0; i < n; i++)
      for (let j = i+1; j < n; j++)
        if (Math.abs(A[i][j]) > maxOff) { maxOff = Math.abs(A[i][j]); p = i; q = j; }

    if (maxOff < tol) break;

    const app = A[p][p], aqq = A[q][q], apq = A[p][q];
    const theta = (aqq - app) / (2 * apq);
    const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta*theta + 1));
    const c = 1 / Math.sqrt(t*t + 1);
    const s = t * c;

    // Rotate A
    const newApp = app - t*apq, newAqq = aqq + t*apq;
    A[p][p] = newApp; A[q][q] = newAqq; A[p][q] = 0; A[q][p] = 0;
    for (let i = 0; i < n; i++) {
      if (i !== p && i !== q) {
        const aip = A[i][p], aiq = A[i][q];
        A[i][p] = c*aip - s*aiq; A[p][i] = A[i][p];
        A[i][q] = s*aip + c*aiq; A[q][i] = A[i][q];
      }
    }
    // Rotate V (eigenvectors)
    for (let i = 0; i < n; i++) {
      const vip = V[i][p], viq = V[i][q];
      V[i][p] = c*vip - s*viq;
      V[i][q] = s*vip + c*viq;
    }
  }

  const eigenvalues = A.map((row,i) => row[i]);
  // Sort descending by eigenvalue
  const idx = eigenvalues.map((v,i) => i).sort((a,b) => eigenvalues[b] - eigenvalues[a]);
  return {
    eigenvalues: idx.map(i => eigenvalues[i]),
    eigenvectors: idx.map(i => V.map(row => row[i])), // each row = one PC's loadings across assets
  };
}

function computePCA(items, weights) {
  const n = items.length;
  if (n < 2) return null;

  // Correlation matrix (standardised PCA — recommended when assets have different vol)
  const corrMat = Array.from({length:n}, (_,i) => Array.from({length:n}, (_,j) => corrFn(items[i].returns, items[j].returns) || 0));

  const { eigenvalues, eigenvectors } = jacobiEigen(corrMat);
  const totalVar = eigenvalues.reduce((a,b) => a+b, 0);

  // Cumulative variance explained
  let cumVar = 0;
  const components = [];
  for (let k = 0; k < eigenvalues.length; k++) {
    const varExplained = eigenvalues[k] / totalVar;
    cumVar += varExplained;
    components.push({
      pc: k+1,
      eigenvalue: +eigenvalues[k].toFixed(4),
      varExplainedPct: +(varExplained*100).toFixed(2),
      cumVarExplainedPct: +(cumVar*100).toFixed(2),
      loadings: items.map((it,i) => ({ symbol: it.symbol, loading: +eigenvectors[k][i].toFixed(4) })),
    });
    if (cumVar >= 0.80) break; // stop once we hit 80% explained variance
  }

  return {
    nAssets: n,
    nComponents: components.length,
    totalVarianceExplainedPct: +(cumVar*100).toFixed(2),
    components,
  };
}

// ─── Fama-French 5-factor regression (ETF proxies) ────────────────
// Mkt-RF: URTH (iShares MSCI World) — GLOBAL market, not just US
// SMB (Size): IWM (small cap) minus URTH (global market)
// HML (Value): IWD (Russell 1000 Value) minus IWF (Russell 1000 Growth)
// USD (Dollar strength): UUP (Invesco DB US Dollar Index Bullish Fund, tracks DXY) minus URTH
// EM (Emerging Markets): EEM minus URTH — captures IEEM/VFEM exposure
async function computeFamaFrenchRegression(portfolioReturns, dates) {
  try {
    // Factors kept in LOCAL currency (USD) — no EUR conversion.
    // Portfolio returns are EUR-converted; factors stay USD so the regression
    // correctly captures cross-currency exposure without FX timing noise.
    const [urthData, iwmData, iwdData, iwfData, uupData, eemData] = await Promise.all([
      fetchYahooReturnSeries("URTH", "1y", false), // iShares MSCI World — USD, no conversion
      fetchYahooReturnSeries("IWM",  "1y", false),
      fetchYahooReturnSeries("IWD",  "1y", false),  // Russell 1000 Value
      fetchYahooReturnSeries("IWF",  "1y", false),  // Russell 1000 Growth
      fetchYahooReturnSeries("UUP",  "1y", false),  // US Dollar Index (DXY) bullish ETF
      fetchYahooReturnSeries("EEM",  "1y", false),  // MSCI Emerging Markets
    ]);
    // Fill each factor onto the portfolio's own trading calendar (trimmedDates from caller).
    // On a day a factor's exchange was closed, its TRUE return is 0% (no trading = no price
    // change), not a repeat of the previous day's move. Recovers days where European holdings
    // traded but a US-listed ETF didn't (rare US-only holidays).
    const factorMaps = [urthData, iwmData, iwdData, iwfData, uupData, eemData].map(s => new Map(s.map(r => [r.date, r.ret])));
    let started = [false, false, false, false, false, false];
    const rows = [];
    dates.forEach((d, i) => {
      const vals = factorMaps.map((m, idx) => {
        if (m.has(d)) { started[idx] = true; return m.get(d); }
        return started[idx] ? 0 : null; // 0% on holiday gap, null only before first trading day
      });
      const [mkt, iwm, iwd, iwf, uup, eem] = vals;
      if (vals.every(v => v !== null) && Number.isFinite(portfolioReturns[i])) {
        rows.push({
          y: portfolioReturns[i],
          mkt,
          smb: iwm - mkt,   // Small Minus Big: Russell 2000 (small) − MSCI World (global market)
          hml: iwd - iwf,   // High Minus Low: Russell 1000 Value − Russell 1000 Growth
          usd: uup - mkt,   // Dollar strength: DXY bullish ETF − MSCI World (replaces developed-ex-US factor)
          em:  eem - mkt,   // Emerging Markets: MSCI EM − MSCI World
        });
      }
    });

    if (rows.length < 60) return null;

    // y = alpha + b1*mkt + b2*smb + b3*hml + b4*usd + b5*em + error
    const X = rows.map(r => [1, r.mkt, r.smb, r.hml, r.usd, r.em]);
    const y = rows.map(r => r.y);
    const k = 6; // params: alpha, beta_mkt, beta_smb, beta_hml, beta_usd, beta_em

    const XtX = Array.from({length:k}, (_,i) => Array.from({length:k}, (_,j) =>
      X.reduce((s,row) => s + row[i]*row[j], 0)
    ));
    const Xty = Array.from({length:k}, (_,i) => X.reduce((s,row,t) => s + row[i]*y[t], 0));

    const beta = solveLinearSystem(XtX, Xty);
    if (!beta) return null;

    const [alpha, betaMkt, betaSmb, betaHml, betaUsd, betaEm] = beta;

    const yMean = mean(y);
    const yPred = X.map(row => row[0]*alpha + row[1]*betaMkt + row[2]*betaSmb + row[3]*betaHml + row[4]*betaUsd + row[5]*betaEm);
    const ssRes = y.reduce((s,v,i) => s + (v-yPred[i])**2, 0);
    const ssTot = y.reduce((s,v) => s + (v-yMean)**2, 0);
    const r2 = ssTot > 0 ? 1 - ssRes/ssTot : 0;

    return {
      n: rows.length,
      alpha: +(((1+alpha)**252 - 1)*100).toFixed(3),  // geometric annualisation, not linear ×252
      alphaDailyPct: +(alpha*100).toFixed(4),
      betaMarket:     +betaMkt.toFixed(3),  // beta to MSCI World (global equity market)
      betaSize:       +betaSmb.toFixed(3),
      betaValue:      +betaHml.toFixed(3),
      betaUSDStrength: +betaUsd.toFixed(3), // positive = portfolio benefits when USD strengthens (DXY up)
      betaEmergingMkts: +betaEm.toFixed(3), // positive = tilted EM, negative = tilted developed
      rSquared:       +r2.toFixed(3),
      method: "OLS regression: portfolio daily EUR returns ~ Mkt(URTH) + SMB(IWM-URTH) + HML(IWD-IWF) + USD(UUP-URTH) + EM(EEM-URTH); portfolio EUR-converted, factors in local USD (no FX conversion on factors)",
    };
  } catch (e) {
    console.error("Fama-French error:", e.message);
    return null;
  }
}

function solveLinearSystem(A, b) {
  const n = A.length;
  const M = A.map((row,i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col+1; row < n; row++) if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    if (Math.abs(M[pivot][col]) < 1e-10) return null; // singular
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= div;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col];
      for (let j = col; j <= n; j++) M[row][j] -= factor * M[col][j];
    }
  }
  return M.map(row => row[n]);
}


// Build a master trading-day calendar (union of all series' dates) and forward-fill
// each series onto it. This recovers days lost to single-exchange holidays (e.g. a
// Swiss holiday shouldn't drop a US trading day from the whole regression).
function alignWithForwardFill(seriesList) {
  // seriesList: array of [{date, ret}], one per asset/factor.
  // On a day this asset's exchange was closed (holiday), its TRUE return is 0%
  // (price didn't change because it didn't trade) — NOT a repeat of the prior
  // day's % move. We only need to know "has this asset started trading yet"
  // to decide whether to emit 0 or null (pre-IPO / no data yet).
  const allDates = [...new Set(seriesList.flatMap(s => s.map(r => r.date)))].sort();
  return seriesList.map(series => {
    const byDate = new Map(series.map(r => [r.date, r.ret]));
    let hasStarted = false;
    return allDates.map(d => {
      if (byDate.has(d)) { hasStarted = true; return byDate.get(d); }
      return hasStarted ? 0 : null; // 0% on holiday gaps; null only before first trading day
    });
  }).map((filled, i) => ({ values: filled, dates: allDates }));
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

    // Align all ETF daily returns on a master calendar (union of dates), forward-filling
    // any single-exchange holiday gaps instead of dropping the whole day from every asset.
    // This recovers ~70+ extra trading days vs strict intersection (was 184/252 days, now ~240+).
    const aligned = alignWithForwardFill(rawItems.map(x => x.series));
    const dates = aligned[0]?.dates || [];
    if (dates.length < 30) return null;
    const items = rawItems.map((x, i) => ({ ...x, returns: aligned[i].values }))
      .filter(x => x.returns.every(v => v !== null)); // drop assets that never had a first value to forward-fill from
    if (!items.length) return null;
    // Recompute dates to only the range where ALL items have non-null forward-filled values
    const firstValidIdx = Math.max(...items.map(x => x.returns.findIndex(v => v !== null)));
    const trimmedDates = dates.slice(firstValidIdx);
    items.forEach(x => { x.returns = x.returns.slice(firstValidIdx); });

    const investedWeight = items.reduce((s, x) => s + x.weight, 0);
    const weights = items.map(x => x.weight / investedWeight);
    const returnMatrix = items.map(x => x.returns);
    const cov = covarianceMatrix(returnMatrix);
    const corr = correlationMatrixFromReturns(items);

    const pr = trimmedDates.map((_, t) => items.reduce((s, x, i) => s + weights[i] * x.returns[t], 0));
    const totalReturn = pr.reduce((s, v) => s * (1 + v), 1) - 1;
    const annRet = annualizedReturn(pr);
    const dailyVol = Math.sqrt(weights.reduce((rowSum, wi, i) => rowSum + weights.reduce((colSum, wj, j) => colSum + wi * wj * cov[i][j], 0), 0));
    const annVol = dailyVol * Math.sqrt(252);

    let br = [];
    try {
      const bench = await fetchYahooReturnSeries("^GSPC", "1y");
      const bmap = new Map(bench.map(r => [r.date, r.ret]));
      br = trimmedDates.map(d => bmap.get(d)).filter(Number.isFinite);
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

    // PCA on correlation matrix of holdings' 1Y daily returns
    const pca = computePCA(items, weights);

    // Fama-French 3-factor regression on weighted portfolio returns
    const famaFrench = await computeFamaFrenchRegression(pr, trimmedDates);

    // Mean-Variance Optimisation — find max Sharpe portfolio
    // Uses the same covariance matrix already computed above
    const mvo = (() => {
      try {
        const nAssets = items.length;
        const syms    = items.map(x => x.symbol);
        const annRets = items.map(x => {
          const r = x.returns.filter(Number.isFinite);
          return r.length ? (Math.pow(r.reduce((a,b)=>a*(1+b),1), 252/r.length)-1) : 0;
        });
        const RF = RISK_FREE_RATE_PCT / 100;

        // Random-portfolio Monte Carlo: 50k portfolios, find max Sharpe + min Vol frontier
        const N_SIM = 50000;
        let maxSharpe = -Infinity, maxSharpeW = null;
        let minVol    = Infinity,  minVolW    = null;
        const frontier = []; // store subset for efficient frontier chart

        for (let s = 0; s < N_SIM; s++) {
          // Random Dirichlet weights
          const raw = Array.from({length:nAssets}, ()=>-Math.log(Math.random()+1e-10));
          const sum = raw.reduce((a,b)=>a+b,0);
          const w   = raw.map(v=>v/sum);

          // Portfolio return
          const pRet = annRets.reduce((a,r,i)=>a+w[i]*r, 0);

          // Portfolio variance w'Σw
          const pVar = weights.reduce((rowSum, _, i) => rowSum + weights.reduce((colSum, _, j) =>
            colSum + w[i]*w[j]*cov[i][j], 0), 0);
          const pVol = Math.sqrt(Math.max(pVar,0)) * Math.sqrt(252);

          const sharpeP = pVol===0 ? 0 : (pRet - RF) / pVol;

          if (sharpeP > maxSharpe) { maxSharpe = sharpeP; maxSharpeW = w; }
          if (pVol < minVol)       { minVol    = pVol;    minVolW    = w; }

          // Keep a sample for frontier chart (every 50th)
          if (s % 50 === 0) frontier.push({ vol: +(pVol*100).toFixed(3), ret: +(pRet*100).toFixed(3), sharpe: +sharpeP.toFixed(3) });
        }

        const fmtW = (w) => syms.map((sym,i)=>({ symbol:sym, weightPct: +(w[i]*100).toFixed(1) }));

        // Current portfolio stats for comparison
        const curRet  = annRets.reduce((a,r,i)=>a+weights[i]*r,0);
        const curVar  = weights.reduce((rs,_,i)=>rs+weights.reduce((cs,_,j)=>cs+weights[i]*weights[j]*cov[i][j],0),0);
        const curVol  = Math.sqrt(Math.max(curVar,0))*Math.sqrt(252);
        const curSharpe = curVol===0?0:(curRet-RF)/curVol;

        return {
          currentPortfolio: {
            weights: fmtW(weights),
            annRetPct:  +(curRet*100).toFixed(2),
            annVolPct:  +(curVol*100).toFixed(2),
            sharpe:     +curSharpe.toFixed(3),
          },
          maxSharpePortfolio: {
            weights:    fmtW(maxSharpeW),
            annRetPct:  +(annRets.reduce((a,r,i)=>a+maxSharpeW[i]*r,0)*100).toFixed(2),
            annVolPct:  +(Math.sqrt(Math.max(weights.reduce((rs,_,i)=>rs+weights.reduce((cs,_,j)=>cs+maxSharpeW[i]*maxSharpeW[j]*cov[i][j],0),0),0))*Math.sqrt(252)*100).toFixed(2),
            sharpe:     +maxSharpe.toFixed(3),
          },
          minVolPortfolio: {
            weights:    fmtW(minVolW),
            annRetPct:  +(annRets.reduce((a,r,i)=>a+minVolW[i]*r,0)*100).toFixed(2),
            annVolPct:  +(minVol*100).toFixed(2),
            sharpe:     +(minVol===0?0:(annRets.reduce((a,r,i)=>a+minVolW[i]*r,0)-RF)/minVol).toFixed(3),
          },
          frontier: frontier.sort((a,b)=>a.vol-b.vol),
          method: "Monte Carlo 50,000 random portfolios (Dirichlet weights), 1Y EUR-converted daily returns, SOFR risk-free rate",
        };
      } catch(e) { console.error("MVO error:", e.message); return null; }
    })();

    return {
      period: "1y",
      days: pr.length,
      investedWeightPct: +(investedWeight * 100).toFixed(2),
      totalReturnPct: +(totalReturn * 100).toFixed(2),
      annualizedReturnPct: +(annRet * 100).toFixed(2),
      averageDailyReturnPct: +(mean(pr) * 100).toFixed(4),
      annualizedVolPct: +(annVol * 100).toFixed(2),
      sharpe: annVol === 0 ? null : +((annRet - RISK_FREE_RATE_PCT/100) / annVol).toFixed(3),  // (annRet - Rf)/sqrt(w'Σw)sqrt(252)
      sortino: downsideVol === 0 ? null : +((annRet - RISK_FREE_RATE_PCT/100) / downsideVol).toFixed(3),
      riskFreeRatePct: RISK_FREE_RATE_PCT,  // SOFR, used in Sharpe/Sortino above
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
      dates: trimmedDates,
      portfolioReturnsPct: pr.map(v => +(v * 100).toFixed(4)),
      portfolioIndex: cumulativeFromReturns(pr).map(v => +(v * 100).toFixed(3)),
      drawdownSeries: (() => { let peak=-Infinity; return cumulativeFromReturns(pr).map(v=>{ if(v>peak)peak=v; return +((v-peak)/peak*100).toFixed(3); }); })(),
      weights: items.map((x, i) => ({ symbol: x.symbol, yahooSymbol: x.yahooSymbol, weightPct: +(weights[i] * 100).toFixed(2) })),
      correlationMatrix: corr,
      covarianceMethod: "1Y daily Yahoo returns, date-aligned; annual vol = sqrt(w'Σw) × sqrt(252)",
      method: "current portfolio weights × 1Y Yahoo daily-return correlation/covariance matrix (EUR-converted, forward-filled across single-exchange holidays for ~252 trading days); Sharpe = annualized return / covariance-based annualized volatility",
      pca,
      famaFrench,
      mvo,
    };
  } catch { return null; }
}

async function fetchMarketNews(input = {}) {
  const limit = input.limit || 12;
  const items = [];

  // Yahoo Finance RSS — general market news (no symbol filter = broader coverage)
  const feeds = [
    "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC,^IXIC,^DJI,^STOXX50E&region=US&lang=en-US",
    "https://feeds.finance.yahoo.com/rss/2.0/headline?s=EURUSD=X,GC=F,CL=F,^TNX&region=US&lang=en-US",
    "https://www.investing.com/rss/news_25.rss",
    "https://www.investing.com/rss/news_285.rss",
    "https://feeds.reuters.com/reuters/businessNews",
  ];
  for (const url of feeds) {
    try {
      const xml  = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/rss+xml,application/xml" } })).text();
      const data = parser.parse(xml);
      const rows = toArr(data?.rss?.channel?.item || data?.feed?.entry).slice(0, 20);
      rows.forEach(x => {
        const title = x.title?.["#text"] || x.title;
        const link  = x.link?.href || x.link;
        const pub   = x.pubDate || x.published || x["dc:date"];
        if (title) items.push({ title, link, published: pub, publisher: data?.rss?.channel?.title || data?.feed?.title?.["#text"] || "Market news" });
      });
    } catch {}
  }

  // Also fetch via Yahoo Finance search for broader week coverage
  try {
    const res  = await fetch("https://query1.finance.yahoo.com/v1/finance/search?q=market+stocks+economy&newsCount=20&quotesCount=0", { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await res.json();
    (data?.news || []).forEach(n => {
      if (n.title) items.push({ title: n.title, link: n.link, published: n.providerPublishTime ? new Date(n.providerPublishTime*1000).toISOString() : null, publisher: n.publisher });
    });
  } catch {}

  const seen = new Set();
  const deduped = items.filter(x => x.title && !seen.has(x.title) && seen.add(x.title));
  // Sort by date descending, keep last 7 days
  const weekAgo = Date.now() - 7*24*60*60*1000;
  const recent = deduped.filter(x => {
    if (!x.published) return true; // keep if no date
    const d = new Date(x.published).getTime();
    return isNaN(d) || d >= weekAgo;
  });
  return { count: recent.length, headlines: recent.slice(0, limit) };
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
    return (d?.news || []).slice(0, limit).map(n => ({
      title: n.title, publisher: n.publisher,
      published: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
      link: n.link,
    }));
  } catch { return []; }
}

// ─── Email ────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  console.log(`📧 Sending email to: ${to} from: onboarding@resend.dev`);
  if (!RESEND_KEY) {
    console.log("📧 No RESEND_API_KEY — skipped:", subject);
    throw new Error("Email not sent: RESEND_API_KEY not configured in Railway environment variables.");
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "IBKR Agent <onboarding@resend.dev>", to, subject, html }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Resend: ${JSON.stringify(data)}`);
  console.log("📧 Email sent to", to);
  return { ok: true, id: data.id };
}

async function buildAndSendReport(to) {
  const [portfolio, newsData, macro, weeklyData] = await Promise.all([
    buildPortfolio().catch(() => null),
    fetchMarketNews({ limit: 10 }).catch(() => ({ headlines: [] })),
    marketSnapshot().catch(() => ({ quotes: [] })),
    // Fetch 5-day history for 3 key indices to get weekly % change
    Promise.all(["^GSPC","^IXIC","^STOXX50E"].map(sym =>
      fetchYahooCloses(sym, "5d").then(d => {
        const bars = d.bars.filter(b => b.close);
        if (bars.length < 2) return { sym, weekChg: 0, bars: [] };
        const first = bars[0].close, last = bars[bars.length-1].close;
        return { sym, weekChg: +((last-first)/first*100).toFixed(2), bars };
      }).catch(() => ({ sym, weekChg: 0, bars: [] }))
    )).catch(() => []),
  ]);
  const weeklyMap = {};
  (weeklyData || []).forEach(w => { weeklyMap[w.sym] = w; });
  const combined  = portfolio?.combined || {};
  const positions = combined.positions || [];
  const metrics   = combined.metrics1Y;

  // ── Helpers ──────────────────────────────────────────────────────
  const nlv      = `€${(combined.totalNetLiquidation||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const unrealPnl = combined.totalUnrealizedPnlEUR || 0;
  const unrealCol = unrealPnl >= 0 ? "#2ECC71" : "#E74C3C";
  const unrealStr = `${unrealPnl>=0?"+":""}€${Math.abs(unrealPnl).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const twr      = combined.avgYtdReturnPct || 0;
  const twrCol   = twr >= 0 ? "#2ECC71" : "#E74C3C";
  const fmt2     = v => (v||0).toFixed(2);
  const fmtPct   = v => `${v>=0?"+":""}${(v||0).toFixed(1)}%`;

  // ── 1. Market News — top 5 headlines ─────────────────────────────
  const headlines = (newsData?.headlines||[]).slice(0,5);
  const headlinesHtml = headlines.map((h,i) =>
    `<div style="padding:14px 0;border-bottom:1px solid #252A38">
      <div style="font-size:12px;color:#C9A84C;font-weight:700;margin-bottom:4px">${i+1}.</div>
      <a href="${h.link||"#"}" style="color:#EDF0F7;text-decoration:none;font-size:14px;font-weight:600;line-height:1.5;display:block">${h.title}</a>
      <div style="font-size:11px;color:#5A6280;margin-top:5px">${h.publisher||""} ${h.published?`· ${new Date(h.published).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}`:""}}</div>
    </div>`
  ).join("") || `<div style="color:#5A6280;padding:12px 0">No headlines available</div>`;

  // ── 2. Portfolio allocation bars ──────────────────────────────────
  const maxPct   = Math.max(...positions.map(p=>p.allocationPct||0), 1);
  const allocBars = positions.slice(0,8).map(p => {
    const w   = Math.round((p.allocationPct/maxPct)*200);
    const col = p.allocationPct > 20 ? "#C9A84C" : "#4A9EFF";
    return `<tr>
      <td style="padding:5px 10px 5px 0;font-family:monospace;font-size:12px;color:#EDF0F7;white-space:nowrap;width:80px">${p.symbol}</td>
      <td style="padding:5px 0"><div style="background:${col};height:14px;width:${w}px;border-radius:3px;display:inline-block"></div></td>
      <td style="padding:5px 0 5px 10px;font-family:monospace;font-size:12px;color:#C9A84C;white-space:nowrap">${p.allocationPct.toFixed(1)}%</td>
      <td style="padding:5px 0 5px 8px;font-family:monospace;font-size:12px;color:#EDF0F7">€${(p.totalValueEUR||0).toLocaleString("en-US",{maximumFractionDigits:0})}</td>
    </tr>`;
  }).join("");

  // ── 2b. Portfolio metrics with plain-English explanations ─────────
  const maxDD      = metrics?.maxDrawdownPct || 0;
  const curDD      = metrics?.drawdownSeries ? (() => { const d=metrics.drawdownSeries; return d[d.length-1]||0; })() : 0;
  const sharpe     = metrics?.sharpe || 0;
  const annVol     = metrics?.annualizedVolPct || 0;
  const annRet     = metrics?.annualizedReturnPct || 0;
  const sortino    = metrics?.sortino || 0;
  const var95      = metrics?.var95Pct || 0;
  const calmar     = metrics?.calmar || 0;

  const metricRows = [
    { icon:"📈", label:"1-Year Return", val:`${fmtPct(annRet)}`,
      col: annRet>=0?"#2ECC71":"#E74C3C",
      explain:"How much the portfolio grew over the past 12 months. Think of it like the interest rate your money earned." },
    { icon:"🎢", label:"Annual Volatility", val:`${fmt2(annVol)}%`,
      col:"#EDF0F7",
      explain:"How much the portfolio bounces up and down in a typical year. Higher = more dramatic swings, but not necessarily bad." },
    { icon:"🏔️", label:"Max Drawdown", val:`${fmt2(maxDD)}%`,
      col:"#E74C3C",
      explain:"The biggest drop from a peak to a trough over the past year. Like the worst dip you would have seen if you were watching every day." },
    { icon:"📍", label:"Current Drawdown", val:`${fmt2(curDD)}%`,
      col: curDD < -5 ? "#E74C3C" : curDD < -2 ? "#F59E0B" : "#2ECC71",
      explain:"How far the portfolio is right now from its all-time high. 0% means we're at the top." },
    { icon:"⚖️", label:"Sharpe Ratio", val:`${fmt2(sharpe)}`,
      col: sharpe>=1?"#2ECC71": sharpe>=0.5?"#F59E0B":"#E74C3C",
      explain:"A score for how well the portfolio is rewarded for the risk it takes. Above 1 is good, above 2 is excellent, below 0 means you're taking risk for nothing." },
    { icon:"🎯", label:"Sortino Ratio", val:`${fmt2(sortino)}`,
      col: sortino>=1?"#2ECC71":"#F59E0B",
      explain:"Similar to Sharpe, but only penalises for bad days (drops), not good days. A more forgiving measure of risk-adjusted performance." },
    { icon:"🛡️", label:"VaR 95% (daily)", val:`${fmt2(var95)}%`,
      col:"#F59E0B",
      explain:"On the worst 5% of days historically, the portfolio lost at least this much. Think of it as the 'bad day' benchmark." },
    { icon:"⛰️", label:"Calmar Ratio", val:`${fmt2(calmar)}`,
      col: calmar>=1?"#2ECC71":"#F59E0B",
      explain:"How much return you get per unit of maximum drawdown. Higher is better — it means you earn a lot relative to your worst drop." },
  ].map(m => `
    <tr style="border-bottom:1px solid #252A38">
      <td style="padding:10px 12px 10px 0;vertical-align:top;width:36px;font-size:18px">${m.icon}</td>
      <td style="padding:10px 12px 10px 0;vertical-align:top;width:140px">
        <div style="font-size:12px;font-weight:700;color:#EDF0F7">${m.label}</div>
        <div style="font-size:18px;font-weight:800;color:${m.col};font-family:monospace;margin-top:2px">${m.val}</div>
      </td>
      <td style="padding:10px 0;vertical-align:top">
        <div style="font-size:12px;color:#8A9AC0;line-height:1.5">${m.explain}</div>
      </td>
    </tr>`
  ).join("");

  // ── 3. Markets — SPX, NDX, SX5E weekly perf as SVG sparklines ────
  const indexMap = {};
  (macro?.quotes||[]).forEach(q => { indexMap[q.symbol] = q; });

  function sparklineSVG(changePct, label, desc, region, realBars=[]) {
    const col   = changePct >= 0 ? "#2ECC71" : "#E74C3C";
    const arrow = changePct >= 0 ? "▲" : "▼";
    // Use real price bars if available, otherwise simulate
    const path = realBars.length >= 2
      ? realBars.map(b => b.close)
      : Array.from({length:10}, (_,i) => {
          const progress = i/9, noise = Math.sin(i*1.3)*0.3;
          return 50 + (changePct * progress * 2.5) + noise;
        });
    const minV = Math.min(...path), maxV = Math.max(...path), range = maxV-minV||1;
    const W=180, H=50;
    const pts = path.map((v,i) => `${Math.round(i/Math.max(path.length-1,1)*W)},${Math.round(H - ((v-minV)/range)*(H-6) - 3)}`).join(" ");
    return `
    <td style="padding:8px;background:#1A1E2A;border-radius:12px;text-align:center;vertical-align:top;width:33%">
      <div style="font-size:12px;font-weight:800;color:#EDF0F7;margin-bottom:2px">${label}</div>
      <div style="font-size:10px;color:#5A6280;margin-bottom:8px">${region}</div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:40px" preserveAspectRatio="none">
        <defs><linearGradient id="g_${label.replace(/\s/g,'')}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${col}" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="${col}" stop-opacity="0"/>
        </linearGradient></defs>
        <polygon points="0,${H} ${pts} ${W},${H}" fill="url(#g_${label.replace(/\s/g,'')})"/>
        <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2"/>
      </svg>
      <div style="font-size:18px;font-weight:800;color:${col};font-family:monospace;margin-top:4px">${arrow} ${Math.abs(changePct).toFixed(2)}%</div>
      <div style="font-size:10px;color:#5A6280;margin-top:3px;line-height:1.4">${desc}</div>
    </td>`;
  }

  const spxChg  = weeklyMap["^GSPC"]?.weekChg  || 0;
  const ndxChg  = weeklyMap["^IXIC"]?.weekChg  || 0;
  const sx5eChg = weeklyMap["^STOXX50E"]?.weekChg || 0;
  // Use real price bars for sparkline if available
  const spxBars  = weeklyMap["^GSPC"]?.bars  || [];
  const ndxBars  = weeklyMap["^IXIC"]?.bars  || [];
  const sx5eBars = weeklyMap["^STOXX50E"]?.bars || [];

  const marketsHtml = `
  <table style="width:100%;border-collapse:separate;border-spacing:8px">
    <tr>
      ${sparklineSVG(spxChg,  "S&P 500",   "500 largest US companies — the main US stock market benchmark", "🇺🇸 United States", spxBars)}
      ${sparklineSVG(ndxChg,  "Nasdaq 100","100 largest tech & growth companies — Apple, Microsoft, Nvidia…", "🇺🇸 Technology", ndxBars)}
      ${sparklineSVG(sx5eChg, "Euro Stoxx 50","50 biggest European companies — the European equivalent of the S&P 500", "🇪🇺 Europe", sx5eBars)}
    </tr>
  </table>
  <p style="font-size:11px;color:#5A6280;margin:10px 0 0;line-height:1.5">
    These 3 indices together cover most of your portfolio. Your funds (CSPX, CSNDX, NQSE) track the US indices, while CSSX5E tracks the European one.
  </p>`;

  // ── 4. Risks to Watch ─────────────────────────────────────────────
  const concentration   = positions.filter(p=>p.allocationPct>25);
  // Find most impactful headline for portfolio context
  const portfolioTopics = ["rate","inflation","fed","ecb","market","tech","europe","nasdaq","s&p","etf","bond","yield","stock"];
  const relevantNews    = headlines.find(h => portfolioTopics.some(t => h.title?.toLowerCase().includes(t)));
  const newsRisk        = relevantNews
    ? `<div style="background:#1A2A1A;border-left:4px solid #2ECC71;border-radius:0 10px 10px 0;padding:12px;margin-bottom:10px">
        <strong style="color:#2ECC71">📰 Market news to watch</strong>
        <p style="margin:6px 0 0;font-size:13px;color:#EDF0F7;line-height:1.5">"${relevantNews.title}" — this could be relevant to your portfolio because your funds are exposed to global equity markets. Keep an eye on how this develops.</p>
       </div>`
    : "";

  const risksHtml = [
    newsRisk,
    concentration.length ? `<div style="background:#2A1A1A;border-left:4px solid #E74C3C;border-radius:0 10px 10px 0;padding:12px;margin-bottom:10px">
      <strong style="color:#E74C3C">⚠️ Concentration risk</strong>
      <p style="margin:6px 0 0;font-size:13px;color:#EDF0F7">${concentration.map(p=>`<strong>${p.symbol}</strong> is ${p.allocationPct.toFixed(1)}% of the portfolio`).join(", ")}. That's a lot of eggs in one basket — if that fund drops a lot, it will have a big impact.</p>
    </div>` : "",
    `<div style="background:#1A1E2A;border-left:4px solid #F59E0B;border-radius:0 10px 10px 0;padding:12px;margin-bottom:10px">
      <strong style="color:#F59E0B">💱 Currency risk</strong>
      <p style="margin:6px 0 0;font-size:13px;color:#EDF0F7">The portfolio holds funds in <strong>EUR</strong>, <strong>GBP</strong> and <strong>USD</strong>. When these currencies move against each other, it affects the total value — even if the underlying stocks don't move. Nothing to do about it, just good to know.</p>
    </div>`,
  ].join("");

  // ── HTML email ────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:0;background:#0D0F14;font-family:Inter,Arial,sans-serif;color:#EDF0F7} a{color:#4A9EFF} @media(max-width:600px){.index-table td{display:block;width:100%!important;margin-bottom:8px}}</style>
</head>
<body style="background:#0D0F14">
<div style="max-width:600px;margin:0 auto;padding:20px 16px">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#13161E,#1A1E2A);border:1px solid #252A38;border-radius:16px;padding:24px;margin-bottom:20px;text-align:center">
    <div style="font-size:36px;margin-bottom:8px">📊</div>
    <h1 style="margin:0;font-size:22px;color:#E8C87A;font-weight:800">Your Weekly Portfolio Report</h1>
    <p style="margin:8px 0 0;color:#5A6280;font-size:13px">${new Date().toLocaleDateString("en-GB",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}</p>
    <div style="margin-top:16px;padding:12px;background:#0D0F14;border-radius:10px">
      <div style="font-size:11px;color:#5A6280;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Total Portfolio Value</div>
      <div style="font-size:32px;font-weight:800;color:#E8C87A;font-family:monospace">${nlv}</div>
      <div style="font-size:13px;color:${twrCol};margin-top:4px">1-year return: ${twr>=0?"+":""}${twr}%</div>
    </div>
  </div>

  <!-- 1. Market News -->
  <div style="background:#13161E;border:1px solid #252A38;border-radius:16px;padding:20px;margin-bottom:20px">
    <h2 style="margin:0 0 4px;font-size:16px;color:#E8C87A;font-weight:700">🌍 1. Market News This Week</h2>
    <p style="margin:0 0 14px;font-size:12px;color:#5A6280">The top stories moving financial markets:</p>
    ${headlinesHtml}
  </div>

  <!-- 2. Portfolio Overview -->
  <div style="background:#13161E;border:1px solid #252A38;border-radius:16px;padding:20px;margin-bottom:20px">
    <h2 style="margin:0 0 4px;font-size:16px;color:#E8C87A;font-weight:700">💼 2. Your Portfolio</h2>
    <p style="margin:0 0 14px;font-size:12px;color:#5A6280">How your money is spread across funds:</p>
    <table style="width:100%;margin-bottom:16px">${allocBars}</table>
    <p style="font-size:11px;color:#5A6280;margin:0 0 16px">Each bar shows the share of your total money in that fund. Gold = large positions, blue = smaller ones.</p>

    <!-- Metrics -->
    <div style="background:#0D0F14;border-radius:12px;padding:4px 12px">
      <div style="font-size:12px;font-weight:700;color:#5A6280;text-transform:uppercase;letter-spacing:0.06em;padding:10px 0 6px">Portfolio health metrics</div>
      <table style="width:100%;border-collapse:collapse">${metricRows}</table>
    </div>

    <!-- Unrealised PnL -->
    <div style="background:#1A1E2A;border-radius:10px;padding:14px;margin-top:14px;text-align:center">
      <div style="font-size:11px;color:#5A6280;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Unrealised Gain / Loss</div>
      <div style="font-size:24px;font-weight:800;color:${unrealCol};font-family:monospace">${unrealStr}</div>
      <div style="font-size:11px;color:#5A6280;margin-top:4px">The paper gain/loss on open positions — not cashed in yet</div>
    </div>
  </div>

  <!-- 3. Markets -->
  <div style="background:#13161E;border:1px solid #252A38;border-radius:16px;padding:20px;margin-bottom:20px">
    <h2 style="margin:0 0 4px;font-size:16px;color:#E8C87A;font-weight:700">📈 3. How Markets Did</h2>
    <p style="margin:0 0 14px;font-size:12px;color:#5A6280">The three main stock market regions your portfolio is exposed to:</p>
    ${marketsHtml}
  </div>

  <!-- 4. Risks -->
  <div style="background:#13161E;border:1px solid #252A38;border-radius:16px;padding:20px;margin-bottom:20px">
    <h2 style="margin:0 0 4px;font-size:16px;color:#E8C87A;font-weight:700">⚠️ 4. Risks to Watch</h2>
    <p style="margin:0 0 14px;font-size:12px;color:#5A6280">Not reasons to panic — just things worth being aware of this week:</p>
    ${risksHtml}
  </div>

  <!-- Footer -->
  <div style="text-align:center;padding:16px;color:#5A6280;font-size:11px;line-height:1.6">
    <p style="margin:0">Generated by your IBKR Agent · ${new Date().toISOString().slice(0,16).replace("T"," ")} UTC</p>
    <p style="margin:4px 0 0">Data: IBKR Flex + Yahoo Finance · Not financial advice</p>
  </div>

</div></body></html>`;

  return sendEmail(to, `📊 Portfolio Report — ${new Date().toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}`, html);
}

// ─── HMM Regime Detection Engine — Diagonal Covariance ───────────
// Diagonal covariance = numerically stable, no matrix inversion needed
// Equivalent to GaussianHMM(covariance_type='diag') in sklearn

// Log-likelihood of obs under diagonal Gaussian (state s)
function diagLogB(x, mu, sigSq) {
  // sigSq: per-feature variance array
  let ll = 0;
  for (let d = 0; d < x.length; d++) {
    const v = sigSq[d] > 0 ? sigSq[d] : 1e-6;
    ll += -0.5 * (Math.log(2 * Math.PI * v) + (x[d] - mu[d]) ** 2 / v);
  }
  return ll;
}

// Forward algorithm (log-space, scaled) — returns alpha, scales, logP
function forward(obs, logPi, logA, mu, sigSq, K) {
  const T = obs.length;
  const logAlpha = [];
  // t=0
  let row0 = Array.from({length:K}, (_,s) => logPi[s] + diagLogB(obs[0], mu[s], sigSq[s]));
  const max0 = Math.max(...row0);
  const scaled0 = row0.map(v => Math.exp(v - max0));
  const sc0 = scaled0.reduce((a,b)=>a+b, 0);
  logAlpha.push(scaled0.map(v => Math.log(v/sc0 + 1e-300) + max0));

  for (let t = 1; t < T; t++) {
    const logB = Array.from({length:K}, (_,s) => diagLogB(obs[t], mu[s], sigSq[s]));
    const row = Array.from({length:K}, (_,s) => {
      const vals = Array.from({length:K}, (_,p) => logAlpha[t-1][p] + logA[p][s]);
      const mx = Math.max(...vals);
      return mx + Math.log(vals.reduce((a,v) => a + Math.exp(v-mx), 0) + 1e-300) + logB[s];
    });
    logAlpha.push(row);
  }
  return logAlpha;
}

// Backward algorithm (log-space)
function backward(obs, logA, mu, sigSq, K) {
  const T = obs.length;
  const logBeta = new Array(T);
  logBeta[T-1] = new Array(K).fill(0);
  for (let t = T-2; t >= 0; t--) {
    const logB_next = Array.from({length:K}, (_,s) => diagLogB(obs[t+1], mu[s], sigSq[s]));
    logBeta[t] = Array.from({length:K}, (_,s) => {
      const vals = Array.from({length:K}, (_,s2) => logA[s][s2] + logB_next[s2] + logBeta[t+1][s2]);
      const mx = Math.max(...vals);
      return mx + Math.log(vals.reduce((a,v) => a + Math.exp(v-mx), 0) + 1e-300);
    });
  }
  return logBeta;
}

// Gamma and Xi from forward-backward
function gammaXi(logAlpha, logBeta, obs, logA, mu, sigSq, K) {
  const T = obs.length;
  // Gamma
  const gamma = logAlpha.map((la, t) => {
    const raw = la.map((v, s) => v + logBeta[t][s]);
    const mx = Math.max(...raw);
    const ex = raw.map(v => Math.exp(v - mx));
    const sm = ex.reduce((a,b) => a+b, 0) || 1;
    return ex.map(v => v/sm);
  });
  // Xi (T-1 x K x K)
  const xi = [];
  for (let t = 0; t < T-1; t++) {
    const logB_next = Array.from({length:K}, (_,s) => diagLogB(obs[t+1], mu[s], sigSq[s]));
    const raw = Array.from({length:K}, (_,s) =>
      Array.from({length:K}, (_,s2) =>
        logAlpha[t][s] + logA[s][s2] + logB_next[s2] + logBeta[t+1][s2]
      )
    );
    const flat = raw.flat();
    const mx = Math.max(...flat);
    const ex = raw.map(row => row.map(v => Math.exp(v-mx)));
    const sm = ex.reduce((rs,row) => rs + row.reduce((a,b)=>a+b,0), 0) || 1;
    xi.push(ex.map(row => row.map(v => v/sm)));
  }
  const logLik = (() => {
    const last = logAlpha[T-1];
    const mx = Math.max(...last);
    return mx + Math.log(last.reduce((a,v) => a + Math.exp(v-mx), 0) + 1e-300);
  })();
  return { gamma, xi, logLik };
}

function fitHMM(obs, K, maxIter=100) {
  const T = obs.length, D = obs[0].length;
  if (T < K * 5) return null;

  // Init: split on first feature (VIX) — low half = state 0, high half = state 1
  const sorted = [...obs.map(o=>o[0])].sort((a,b)=>a-b);
  const median = sorted[Math.floor(T/2)];
  let gamma = obs.map(x => {
    const p = x[0] > median ? 0.85 : 0.15;  // soft assignment
    return [1-p, p];  // state 0 = low VIX (normal), state 1 = high VIX (stress)
  });

  // Init params
  let pi = [0.8, 0.2];  // most time in normal
  let logA = [
    [Math.log(0.97), Math.log(0.03)],   // normal → normal 97%
    [Math.log(0.05), Math.log(0.95)],   // stress → stress 95%
  ];
  let mu = Array.from({length:K}, (_,s) => {
    const wts = gamma.map(g => g[s]);
    const wSum = wts.reduce((a,b)=>a+b, 0) || 1;
    return Array.from({length:D}, (_,d) => obs.reduce((s2,x,t) => s2+wts[t]*x[d], 0)/wSum);
  });
  let sigSq = Array.from({length:K}, (_,s) => {
    const wts = gamma.map(g => g[s]);
    const wSum = wts.reduce((a,b)=>a+b, 0) || 1;
    return Array.from({length:D}, (_,d) => {
      const v = obs.reduce((s2,x,t) => s2+wts[t]*(x[d]-mu[s][d])**2, 0)/wSum;
      return Math.max(v, 0.01);  // minimum variance floor
    });
  });

  let prevLL = -Infinity;
  for (let iter = 0; iter < maxIter; iter++) {
    const logPi = pi.map(v => Math.log(v + 1e-300));
    const logAlpha = forward(obs, logPi, logA, mu, sigSq, K);
    const logBeta  = backward(obs, logA, mu, sigSq, K);
    const { gamma: ng, xi, logLik } = gammaXi(logAlpha, logBeta, obs, logA, mu, sigSq, K);
    gamma = ng;

    // M-step pi
    pi = gamma[0].slice();
    const piS = pi.reduce((a,b)=>a+b,0) || 1;
    pi = pi.map(v => v/piS);

    // M-step A — with Dirichlet prior to prevent extreme transitions
    const PRIOR = 5.0;  // asymmetric-ish prior — more persistence, fewer spurious switches
    logA = Array.from({length:K}, (_,s) => {
      const row = Array.from({length:K}, (_,s2) =>
        xi.reduce((sm,xit) => sm+xit[s][s2], 0) + PRIOR
      );
      const rs = row.reduce((a,b)=>a+b,0) || 1;
      return row.map(v => Math.log(v/rs + 1e-300));
    });

    // M-step mu and sigSq
    mu = Array.from({length:K}, (_,s) => {
      const wts = gamma.map(g => g[s]);
      const wSum = wts.reduce((a,b)=>a+b,0) || 1;
      return Array.from({length:D}, (_,d) => obs.reduce((sm,x,t) => sm+wts[t]*x[d],0)/wSum);
    });
    sigSq = Array.from({length:K}, (_,s) => {
      const wts = gamma.map(g => g[s]);
      const wSum = wts.reduce((a,b)=>a+b,0) || 1;
      return Array.from({length:D}, (_,d) => {
        const v = obs.reduce((sm,x,t) => sm+wts[t]*(x[d]-mu[s][d])**2,0)/wSum;
        return Math.max(v, 0.01);
      });
    });

    if (Math.abs(logLik - prevLL) < 1e-3 && iter > 5) break;
    prevLL = logLik;
  }

  return { pi, logA, mu, sigSq, gamma };
}

function viterbi(obs, pi, logA, mu, sigSq, K) {
  const T = obs.length;
  const logPi = pi.map(v => Math.log(v + 1e-300));
  const delta = [], psi = [];
  delta.push(Array.from({length:K}, (_,s) => logPi[s] + diagLogB(obs[0], mu[s], sigSq[s])));
  psi.push(new Array(K).fill(0));
  for (let t = 1; t < T; t++) {
    const dt = [], pt = [];
    for (let s = 0; s < K; s++) {
      let best = -Infinity, bestP = 0;
      for (let p = 0; p < K; p++) {
        const v = delta[t-1][p] + logA[p][s];
        if (v > best) { best = v; bestP = p; }
      }
      dt.push(best + diagLogB(obs[t], mu[s], sigSq[s]));
      pt.push(bestP);
    }
    delta.push(dt); psi.push(pt);
  }
  const states = new Array(T);
  states[T-1] = delta[T-1].indexOf(Math.max(...delta[T-1]));
  for (let t = T-2; t >= 0; t--) states[t] = psi[t+1][states[t+1]];
  return states;
}
function standardize(series) {
  const D=series[0].length;
  const stats=Array.from({length:D},(_,d)=>{const vals=series.map(s=>s[d]).filter(Number.isFinite);const mu=vals.reduce((a,b)=>a+b,0)/vals.length;const sigma=Math.sqrt(vals.reduce((a,b)=>a+(b-mu)**2,0)/vals.length)||1;return{mu,sigma};});
  return{scaled:series.map(s=>s.map((v,d)=>Number.isFinite(v)?(v-stats[d].mu)/stats[d].sigma:0)),stats};
}
async function computeRegimeModel(portfolioRetMap) {
  // Features: VIX + MOVE + DXST.DE 30d ann. vol — full-sample fit
  const [vixData, moveData, dxstData] = await Promise.all([
    fetchYahooCloses("^VIX",   "5y"),
    fetchYahooCloses("^MOVE",  "5y"),
    fetchYahooCloses("DXST.DE","5y"),
  ]);

  const vixMap  = new Map(vixData.bars.map(b => [b.date, b.close]));
  const moveMap = new Map(moveData.bars.map(b => [b.date, b.close]));

  const dxstBars = dxstData.bars;
  const dxstVolMap = new Map();
  const WIN_VOL = 30;
  for (let i = 1; i < dxstBars.length; i++) dxstBars[i]._ret = (dxstBars[i].close - dxstBars[i-1].close) / dxstBars[i-1].close;
  for (let i = WIN_VOL; i < dxstBars.length; i++) {
    const slice = dxstBars.slice(i - WIN_VOL + 1, i + 1).map(b => b._ret).filter(v => v !== undefined);
    if (slice.length < 5) continue;
    const m = slice.reduce((a,b)=>a+b,0)/slice.length;
    const v = Math.sqrt(slice.reduce((a,b)=>a+(b-m)**2,0)/slice.length) * Math.sqrt(252) * 100;
    dxstVolMap.set(dxstBars[i].date, v);
  }

  const allDates = [...vixMap.keys()].filter(d => moveMap.has(d) && dxstVolMap.has(d)).sort();
  if (allDates.length < 252) throw new Error("Need at least 1Y of data");

  const rawFeatures = allDates.map(d => [vixMap.get(d), moveMap.get(d), dxstVolMap.get(d)]);
  const { scaled } = standardize(rawFeatures);

  const model = fitHMM(scaled, 2, 100);
  if (!model) throw new Error("HMM fitting failed");

  const { pi, logA, mu, sigSq, gamma } = model;
  const states      = viterbi(scaled, pi, logA, mu, sigSq, 2);
  const stressState = mu[0][0] > mu[1][0] ? 0 : 1;
  const regimes     = states.map(s => s === stressState ? 1 : 0);
  const stressProbs = gamma.map(g => +Math.max(0, Math.min(1, g[stressState])).toFixed(4));

  const cutoff1Y = new Date(); cutoff1Y.setDate(cutoff1Y.getDate() - 365);
  const cutoffStr = cutoff1Y.toISOString().slice(0, 10);

  const portRets   = allDates.map(d => portfolioRetMap?.get(d) ?? null);
  const normalRets = portRets.filter((r,i) => r!==null && regimes[i]===0 && allDates[i]>=cutoffStr);
  const stressRets = portRets.filter((r,i) => r!==null && regimes[i]===1 && allDates[i]>=cutoffStr);

  function regimeStats(rets) {
    if (!rets.length) return null;
    const s = std(rets), annVol = s*Math.sqrt(252)*100, annRet = mean(rets)*252*100;
    const var95 = histVaR(rets,0.95), cvar95 = histCVaR(rets,0.95);
    let peak=1, cum=1, sumDD=0, ddN=0;
    rets.forEach(r => { cum*=(1+r); if(cum>peak)peak=cum; const dd=(cum-peak)/peak; if(dd<0){sumDD+=dd;ddN++;} });
    return { count:rets.length, annualizedRetPct:+annRet.toFixed(2), annualizedVolPct:+annVol.toFixed(2),
      dailyVolPct:+(s*100).toFixed(3), sharpe:annVol===0?null:+(annRet/annVol).toFixed(3),
      var95Pct:var95!==null?+(var95*100).toFixed(2):null, cvar95Pct:cvar95!==null?+(cvar95*100).toFixed(2):null,
      avgDrawdownPct:ddN?+(sumDD/ddN*100).toFixed(2):0, maxDrawdownPct:+maxDDFromReturns(rets).toFixed(2) };
  }

  let cumVal = 100;
  const portfolioIndex = allDates.map((d,i)=>({d,i}))
    .filter(({d})=>d>=cutoffStr)
    .map(({d,i})=>{ if(portRets[i]!==null) cumVal*=(1+portRets[i]); return{date:d,value:+cumVal.toFixed(3),regime:regimes[i]}; });

  const stressProbFull = allDates.map((d,i)=>({date:d,prob:stressProbs[i],regime:regimes[i]}))
    .filter(x=>x.date>=cutoffStr);

  const featureNames = ["VIX","MOVE","DXST_ann_vol(iTraxx)"];
  const stateMeans = [0,1].map(r=>{
    const obj={};
    featureNames.forEach((f,d)=>{
      const pts=rawFeatures.filter((_,i)=>regimes[i]===r).map(x=>x[d]);
      obj[f]=pts.length?+(pts.reduce((a,b)=>a+b,0)/pts.length).toFixed(2):null;
    });
    return obj;
  });

  const lastI = allDates.length-1;
  return {
    dates:allDates, regimes, stressProbs, stressProbFull, portfolioIndex,
    normalStats:regimeStats(normalRets), stressStats:regimeStats(stressRets),
    normalDist:returnDistribution(normalRets,20), stressDist:returnDistribution(stressRets,20),
    currentRegime:regimes[lastI], currentStressProb:stressProbs[lastI],
    currentVix:rawFeatures[lastI]?.[0]??null,
    currentMove:rawFeatures[lastI]?.[1]??null,
    currentDxstVol:rawFeatures[lastI]?.[2]??null,
    normalDays:normalRets.length, stressDays:stressRets.length, featureDays:allDates.length,
    stateMeans,
    method:"Full-sample 2-state HMM (VIX + MOVE + DXST vol, diag cov, prior=5, 100 EM iters) on 5Y — chart & stats: last 1Y",
  };
}



// ─── FX conversion: bring any local-currency return series to EUR ─
// Uses daily EURUSD=X, EURGBP=X, EURCHF=X rates (Yahoo) so all portfolio
// analytics (Sharpe, Calmar, PCA, Fama-French) use true EUR returns.
// Yahoo Finance sometimes reports UK-listed instruments as "GBp" (pence, lowercase p)
// instead of "GBP" (pounds). GBp is NOT a different currency — it's the same GBP, just
// quoted ×100. We normalise it to GBP here so FX lookup never silently fails.
const FX_PAIR_FOR = { USD: "EURUSD=X", GBP: "EURGBP=X", GBp: "EURGBP=X", EUR: null };
// CHF removed: CSSX5E.SW is listed on SIX but is EUR-denominated (Euro Stoxx 50 ETF).
// Yahoo may report "CHF" for it — we override that explicitly below.

// Explicit currency overrides for tickers Yahoo misreports.
// These take priority over meta.currency from Yahoo.
const CURRENCY_OVERRIDE = {
  "CSSX5E.SW": "EUR",  // Euro Stoxx 50 ETF — EUR-denominated despite SIX listing
};
const _fxCache = new Map(); // currency -> Map(date -> EURXXX rate)

async function getFxRateSeries(currency, range = "1y") {
  if (currency === "EUR") return null; // no conversion needed
  const pair = FX_PAIR_FOR[currency];
  if (!pair) { console.warn(`No FX pair configured for currency ${currency} — returns NOT converted to EUR`); return null; }
  const cacheKey = `${pair}:${range}`;
  if (_fxCache.has(cacheKey)) return _fxCache.get(cacheKey);
  try {
    const { bars } = await fetchYahooCloses(pair, range);
    // EURUSD=X gives "USD per 1 EUR". We need "EUR per 1 USD" = 1/rate to convert USD->EUR.
    const map = new Map(bars.map(b => [b.date, 1 / b.close]));
    _fxCache.set(cacheKey, map);
    return map;
  } catch (e) {
    console.error(`FX fetch failed for ${pair}:`, e.message);
    return null;
  }
}

// Convert a local-currency daily return series to EUR daily returns.
// series: [{date, ret}], currency: "USD"|"GBP"|"CHF"|"EUR"
//
// CRITICAL: every entry in `series` MUST get an output entry on the SAME date.
// Never skip a date — skipping shifts the array and lets a local return on day X
// get matched against the FX move from a different day, fabricating a systematic
// (non-random) bias in the EUR-converted return that looks like fake alpha.
async function convertReturnsToEUR(series, currency, range = "1y") {
  if (currency === "EUR" || !series.length) return series;
  const fxMap = await getFxRateSeries(currency, range);
  if (!fxMap) return series; // no FX data at all — leave unconverted (logged in getFxRateSeries)

  // Build a sorted list of all FX dates so we can forward-fill (and back-fill for the
  // very first day) the FX rate for any date the asset traded but FX data is missing
  // (rare: FX markets trade ~24/5, asset-side gaps are the asset's own exchange holidays).
  const fxDatesSorted = [...fxMap.keys()].sort();
  function fxRateOnOrBefore(date) {
    // Find the latest FX date <= `date`. fxDatesSorted is sorted ascending.
    let lo = 0, hi = fxDatesSorted.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fxDatesSorted[mid] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 ? fxMap.get(fxDatesSorted[ans]) : (fxDatesSorted.length ? fxMap.get(fxDatesSorted[0]) : null);
  }

  const out = [];
  let prevFx = null;
  for (const { date, ret } of series) {
    const fx = fxRateOnOrBefore(date); // SAME-DATE or most-recent-prior FX rate — never skips/shifts
    if (fx === null) { out.push({ date, ret }); continue; } // no FX data anywhere yet — pass through unconverted for this one day
    if (prevFx === null) {
      // First convertible day: no prior FX rate to diff against, so just pass the local
      // return through unchanged (no FX move can be computed for day 1 of the series).
      out.push({ date, ret });
    } else {
      const fxChange = (fx - prevFx) / prevFx;
      const eurRet = (1 + ret) * (1 + fxChange) - 1;
      out.push({ date, ret: eurRet }); // ALWAYS pushed on the same date as the input
    }
    prevFx = fx;
  }
  return out;
}



// ═══════════════════════════════════════════════════════════════════
// SIGNAL LIBRARY — primitives Claude can compose freely
// All functions operate on arrays of numbers (returns or prices)
// ═══════════════════════════════════════════════════════════════════

// Fetch price array for a symbol aligned to a date array
async function fetchAlignedPrices(sym, dates, range) {
  try {
    const raw = await fetchYahooCloses(yfSymbol(sym), range);
    const byDate = new Map(raw.bars.map(b=>[b.date, b.close]));
    let last = null;
    return dates.map(d => { if(byDate.has(d)) last=byDate.get(d); return last??0; });
  } catch(e) { return new Array(dates.length).fill(0); }
}

async function fetchAlignedReturns(sym, dates, range, convertToEUR=true) {
  try {
    const s = await fetchYahooReturnSeries(yfSymbol(sym), range, convertToEUR);
    const byDate = new Map(s.map(r=>[r.date, r.ret]));
    let started=false;
    return dates.map(d => { if(byDate.has(d)) started=true; return started?(byDate.get(d)??0):0; });
  } catch(e) { return new Array(dates.length).fill(0); }
}

async function runBacktest(input) {
  const {
    symbols, weights, range="5y",
    signal_type="buy_hold",
    signal_params={},
    signal_direction="momentum",
    entry_threshold=1.0,
    exit_signal_type=null,
    exit_signal_params={},
    exit_signal_direction=null,
    exit_threshold=0.0,
    hold_days=null,
    trailing_stop_pct=null,
    take_profit_pct=null,
    stop_loss_pct=null,
    regime_signal_type=null,
    regime_signal_params={},
    regime_threshold=0.0,
    label="Backtest",
  } = input;

  if (!symbols?.length) return { error:"symbols required" };

  // ── Fetch portfolio returns (EUR-converted) ────────────────────
  const seriesArr = await Promise.all(symbols.map(async sym => {
    try { return { sym, series: await fetchYahooReturnSeries(yfSymbol(sym), range, true) }; }
    catch(e) { return { sym, series:[] }; }
  }));

  const allDates = [...new Set(seriesArr.flatMap(x=>x.series.map(r=>r.date)))].sort();
  if (allDates.length < 60) return { error:`Insufficient data: ${allDates.length} days` };

  const n = symbols.length;
  const w = (weights?.length===n) ? weights.map(v=>v/weights.reduce((a,b)=>a+b,0)) : symbols.map(()=>1/n);

  const retMatrix = seriesArr.map(({series}) => {
    const byDate = new Map(series.map(r=>[r.date,r.ret]));
    let started=false;
    return allDates.map(d => { if(byDate.has(d)) started=true; return started?(byDate.get(d)??0):0; });
  });
  const portRets = allDates.map((_,t) => retMatrix.reduce((s,row,i)=>s+w[i]*row[t],0));

  // ── Compute signal ─────────────────────────────────────────────
  async function computeSignal(sType, sParams, dates) {
    if (sType==="buy_hold") return new Array(dates.length).fill(1);
    const sp = sParams||{};
    const sym = sp.symbol || symbols[0];
    const win = sp.window||30, win2 = sp.window2||60;
    const prices = await fetchAlignedPrices(sym, dates, range);
    const rets   = await fetchAlignedReturns(sym, dates, range, false); // keep USD for factors
    let sym2Prices = sp.symbol2 ? await fetchAlignedPrices(sp.symbol2, dates, range) : null;
    let sym2Rets   = sp.symbol2 ? await fetchAlignedReturns(sp.symbol2, dates, range, false) : null;
    switch(sType) {
      case "zscore":       return SIG.zscore(rets, win);
      case "momentum":     return SIG.momentum(prices, win);
      case "rsi":          return SIG.rsi(prices, win);
      case "bb_pct":       return SIG.bb_pct(prices, win, sp.nstd||2).map(v=>v-0.5);
      case "corr":         return sym2Rets ? SIG.corr(rets, sym2Rets, win) : SIG.zscore(rets,win);
      case "vol_ratio":    return SIG.vol_ratio(rets, win, win2).map(v=>v-1);
      case "drawdown":     return SIG.drawdown(prices, win).map(v=>v*10);
      case "var_breach":   return SIG.var_breach(rets, win, sp.pct||0.05);
      case "macd":         return SIG.macd(prices, win, win2);
      case "vol_zscore":   return SIG.zscore(rets.map(r=>r*r), win);
      case "port_zscore":  return SIG.zscore(portRets, win);
      case "spread":       return sym2Prices ? SIG.zscore(prices.map((v,i)=>sym2Prices[i]===0?0:(v-sym2Prices[i])/sym2Prices[i]),win) : SIG.zscore(rets,win);
      default:             return SIG.zscore(rets, win);
    }
  }

  const signalArr   = await computeSignal(signal_type, signal_params, allDates);
  const exitSigArr  = exit_signal_type ? await computeSignal(exit_signal_type, exit_signal_params, allDates) : null;
  let regimeArr     = null;
  if (regime_signal_type) {
    regimeArr = await computeSignal(regime_signal_type, regime_signal_params, allDates);
  }

  // ── Generate positions ─────────────────────────────────────────
  let pos=0, entryIdx=-1, peakSinceEntry=0;
  const positions = allDates.map((d,i) => {
    if (signal_type==="buy_hold") return 1;
    // Regime gate
    if (regimeArr && regimeArr[i] < regime_threshold) { if(pos===1) pos=0; return pos; }
    const sig = signalArr[i]??0;
    if (pos===0) {
      if (signal_direction==="momentum"       && sig >  entry_threshold) { pos=1; entryIdx=i; peakSinceEntry=0; }
      if (signal_direction==="mean_reversion" && sig < -entry_threshold) { pos=1; entryIdx=i; peakSinceEntry=0; }
    } else {
      // Primary exit: separate exit signal or entry signal reversal
      if (exitSigArr) {
        const eSig = exitSigArr[i]??0;
        const eDir = exit_signal_direction||(signal_direction==="momentum"?"mean_reversion":"momentum");
        if (eDir==="momentum"       && eSig >  exit_threshold) pos=0;
        if (eDir==="mean_reversion" && eSig < -exit_threshold) pos=0;
      } else {
        if (signal_direction==="momentum"       && sig <= exit_threshold) pos=0;
        if (signal_direction==="mean_reversion" && sig >= exit_threshold) pos=0;
      }
      // Overlay stops
      if (pos===1 && entryIdx>=0) {
        const tradeRet = portRets.slice(entryIdx+1,i+1).reduce((a,r)=>a*(1+r),1)-1;
        if (tradeRet>peakSinceEntry) peakSinceEntry=tradeRet;
        if (hold_days           && (i-entryIdx)>=hold_days)                    pos=0;
        if (take_profit_pct!=null && tradeRet>=take_profit_pct/100)            pos=0;
        if (stop_loss_pct!=null   && tradeRet<=stop_loss_pct/100)              pos=0;
        if (trailing_stop_pct!=null) { const dd=(tradeRet-peakSinceEntry)/(1+peakSinceEntry); if(dd<=-trailing_stop_pct/100) pos=0; }
      }
      if (pos===0) { entryIdx=-1; peakSinceEntry=0; }
    }
    return pos;
  });

  // ── Trades ────────────────────────────────────────────────────
  const trades=[];
  let tEntry=null, tRets=[];
  positions.forEach((p,i)=>{
    const prev=i>0?positions[i-1]:0;
    if(p===1&&prev===0){tEntry=allDates[i];tRets=[];}
    if(p===1) tRets.push(portRets[i]);
    if(p===0&&prev===1&&tEntry){
      const r=tRets.reduce((a,b)=>a*(1+b),1)-1;
      trades.push({entryDate:tEntry,exitDate:allDates[i],durationDays:tRets.length,returnPct:+(r*100).toFixed(3),profitable:r>0});
      tEntry=null;tRets=[];
    }
  });
  if(tEntry){const r=tRets.reduce((a,b)=>a*(1+b),1)-1;trades.push({entryDate:tEntry,exitDate:allDates[allDates.length-1],durationDays:tRets.length,returnPct:+(r*100).toFixed(3),profitable:r>0,open:true});}

  // ── Equity curve + drawdown ────────────────────────────────────
  let eq=100,peak=100,maxDD=0;
  const equityCurve=[],drawdownCurve=[],dailyRets=[];
  allDates.forEach((d,i)=>{
    const ret=positions[i]*portRets[i];
    eq*=(1+ret);
    if(eq>peak) peak=eq;
    const dd=(eq-peak)/peak*100;
    if(dd<maxDD) maxDD=dd;
    equityCurve.push({date:d,value:+eq.toFixed(4)});
    drawdownCurve.push({date:d,value:+dd.toFixed(4)});
    dailyRets.push(ret);
  });

  // ── Trigger dates (server-computed, authoritative) ─────────────
  const triggerDates = allDates.map((d,i)=>{
    const prev=i>0?positions[i-1]:0;
    if(positions[i]===1&&prev===0) return {date:d,type:"ENTRY",signal:+(signalArr[i]??0).toFixed(4)};
    if(positions[i]===0&&prev===1) return {date:d,type:"EXIT", signal:+(signalArr[i]??0).toFixed(4)};
    return null;
  }).filter(Boolean);

  // All dates where signal was in entry zone
  const signalBreachDates = allDates.map((d,i)=>{
    const sig=signalArr[i]??0;
    const inZone = signal_direction==="momentum"?sig>entry_threshold:sig<-entry_threshold;
    if(!inZone) return null;
    return {date:d, signal:+(sig).toFixed(4)};
  }).filter(Boolean);

  // ── Metrics ───────────────────────────────────────────────────
  const nT=trades.length,prof=trades.filter(t=>t.profitable),loss=trades.filter(t=>!t.profitable);
  const EV=nT?trades.reduce((a,t)=>a+t.returnPct,0)/nT:0;
  const avgW=prof.length?prof.reduce((a,t)=>a+t.returnPct,0)/prof.length:0;
  const avgL=loss.length?loss.reduce((a,t)=>a+t.returnPct,0)/loss.length:0;
  const retStd=nT?Math.sqrt(trades.reduce((a,t)=>a+(t.returnPct-EV)**2,0)/nT):0;
  const avgDur=nT?trades.reduce((a,t)=>a+t.durationDays,0)/nT:0;
  const totalRet=(eq/100-1)*100,nYears=allDates.length/252;
  const annRet=((eq/100)**(1/nYears)-1)*100;
  const mu=dailyRets.reduce((a,b)=>a+b,0)/dailyRets.length;
  const annVol=Math.sqrt(dailyRets.reduce((a,b)=>a+(b-mu)**2,0)/dailyRets.length)*Math.sqrt(252)*100;
  const RF=RISK_FREE_RATE_PCT/100;
  const sharpe=annVol===0?0:+((annRet/100-RF)/(annVol/100)).toFixed(3);
  const negR=dailyRets.filter(r=>r<0);
  const downVol=negR.length?Math.sqrt(negR.reduce((a,b)=>a+b*b,0)/negR.length)*Math.sqrt(252)*100:0;
  const sortino=downVol===0?0:+((annRet/100-RF)/(downVol/100)).toFixed(3);
  const calmar=maxDD===0?0:+(annRet/Math.abs(maxDD)).toFixed(3);
  const sorted=[...dailyRets].sort((a,b)=>a-b);
  const var95=+(sorted[Math.floor(sorted.length*0.05)]*100).toFixed(3);
  const pctInMkt=+(positions.filter(p=>p===1).length/positions.length*100).toFixed(1);

  return {
    label,symbols,weights:w,range,
    signal_type,signal_params,signal_direction,entry_threshold,
    exit_signal_type,exit_threshold,
    hold_days,trailing_stop_pct,take_profit_pct,stop_loss_pct,
    regime_signal_type,regime_threshold,
    dates:allDates,
    equityCurve,drawdownCurve,
    signalSeries:signalArr.map(v=>+v.toFixed(4)),
    exitSignalSeries:exitSigArr?exitSigArr.map(v=>+v.toFixed(4)):null,
    triggerDates,
    signalBreachDates,
    signalStats:{
      min:+Math.min(...signalArr).toFixed(4),
      max:+Math.max(...signalArr).toFixed(4),
      mean:+(signalArr.reduce((a,b)=>a+b,0)/signalArr.length).toFixed(4),
      nBreaches:signalBreachDates.length,
    },
    trades:trades.slice(0,500),
    metrics:{
      totalReturnPct:+totalRet.toFixed(2),annualizedRetPct:+annRet.toFixed(2),
      annualizedVolPct:+annVol.toFixed(2),maxDrawdownPct:+maxDD.toFixed(2),
      sharpe,sortino,calmar,var95DailyPct:var95,
      nDays:allDates.length,nYears:+nYears.toFixed(1),pctTimeInMarket:pctInMkt,
      nTrades:nT,nProfitable:prof.length,nLosing:loss.length,
      winRatePct:+(prof.length/Math.max(nT,1)*100).toFixed(1),
      evPerTradePct:+EV.toFixed(3),condEvWinPct:+avgW.toFixed(3),condEvLossPct:+avgL.toFixed(3),
      tradeRetStdPct:+retStd.toFixed(3),avgDurationDays:+avgDur.toFixed(1),
      profitFactor:avgL===0?null:+Math.abs(avgW/avgL).toFixed(2),
    },
  };
}


// ── Send push notification ────────────────────────────────────────
async function sendPush(title, body, icon = "📊") {
  if (!pushSubs.size) return;
  const payload = JSON.stringify({ title, body, icon });
  const expired = [];
  for (const [id, sub] of pushSubs.entries()) {
    try { await webpush.sendNotification(sub, payload); }
    catch (e) { if (e.statusCode === 410 || e.statusCode === 404) expired.push(id); }
  }
  if (expired.length) { expired.forEach(id => pushSubs.delete(id)); savePushSubs(); }
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
        sharpe:              std(r)===0 ? 0 : +(((mean(r)-RISK_FREE_RATE_DAILY)/std(r))*Math.sqrt(252)).toFixed(3),
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
      const series = { dates, closes, returns: [null, ...r.map(v => +(v * 100).toFixed(4))], priceZscore, priceZscore30, rollingVol, rollingVaR95, rollingVaR99, drawdownSeries, distribution };

      // Cache for GET endpoint
      analyticsCache.set(`${sym}:${range}`, { ...series, summary, computedAt: Date.now() });

      return {
        symbol: sym, benchmark: bench, range, currency: meta?.currency, summary, series,
        chartTags: {
          price:         `@@CHART:${sym}:${range}@@`,
          zscore:        `@@QUANT:${sym}:priceZscore:${range}:Z-Score (${win}d rolling)@@`,
          // rollingSharpe chart tag removed
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

    case "run_backtest":
      return runBacktest(input);

    case "send_email": {
      // Convert markdown-ish body to HTML
      let html = input.body || "";
      html = html
        .replace(/^### (.+)$/gm, '<h3 style="color:#E8C87A;margin:16px 0 6px">$1</h3>')
        .replace(/^## (.+)$/gm,  '<h2 style="color:#E8C87A;margin:18px 0 8px">$1</h2>')
        .replace(/^# (.+)$/gm,   '<h1 style="color:#C9A84C;margin:20px 0 10px">$1</h1>')
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/^\- (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul style="margin:6px 0 10px;padding-left:20px">$1</ul>')
        .replace(/\n\n/g, '</p><p style="margin:8px 0">')
        .replace(/\n/g, '<br/>');

      // Generate Python audit script if data was provided
      const pyData   = input.python_data   || null;   // raw dict/array from tool results
      const pyCode   = input.python_code   || null;   // computation logic as string
      const pyScript = (pyData || pyCode) ? buildPythonAuditScript({
        subject: input.subject,
        data: pyData,
        code: pyCode,
        body: input.body,
      }) : null;

      const wrapped = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="background:#0D0F14;font-family:Inter,Arial,sans-serif;color:#EDF0F7;padding:24px;line-height:1.55">
<div style="max-width:640px;margin:0 auto">
<p style="color:#5A6280;font-size:12px;margin-bottom:20px">🤖 IBKR Agent · ${new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}</p>
<p style="margin:8px 0">${html}</p>
${pyScript ? `<hr style="border-color:#252A38;margin:24px 0"/>
<h3 style="color:#E8C87A;margin:0 0 8px">🐍 Python Audit Script</h3>
<p style="color:#5A6280;font-size:12px;margin:0 0 12px">Copy the script below into your IDE to reproduce all calculations with real data.</p>
<pre style="background:#0A0C12;border:1px solid #252A38;border-radius:8px;padding:14px;font-family:monospace;font-size:11px;color:#EDF0F7;white-space:pre-wrap;word-break:break-all;overflow:auto;max-height:600px">${pyScript.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>` : ''}
</div></body></html>`;

      return await sendEmail(REPORT_TO, input.subject || "📊 Analysis from IBKR Agent", wrapped);
    }

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
  {
    name: "send_email",
    description: "Send an email to the user with any content. ALWAYS call immediately when asked. ALWAYS populate python_data with the raw fetched data and python_code with the computation logic — this generates a Python audit script in the email body so the user can reproduce everything locally.",
    input_schema: {
      type: "object",
      properties: {
        subject:     { type: "string", description: "Email subject line." },
        body:        { type: "string", description: "Email body in markdown. Write a full, detailed analysis." },
        python_data: { type: "object", description: "REQUIRED: raw data object containing all fetched prices, returns, VIX levels, etc. used in the analysis. E.g. { spx_prices: [...], vix_levels: [...], dates: [...] }. This is embedded as JSON in the Python audit script." },
        python_code: { type: "string", description: "REQUIRED: Python code that reproduces all computations from python_data. Should be complete and runnable. E.g. Black-Scholes formula, backtest logic, correlation calculations, etc. The code can reference DATA variable which will contain python_data." }
      },
      required: ["subject", "body"]
    }
  },
  {
    name: "run_backtest",
    description: "Run a signal-based portfolio backtest. Server computes everything — Claude must NOT reproduce any numbers from the result in text. After calling this, say 'Backtest complete — results rendered below.' then give qualitative interpretation ONLY. ALWAYS use range=5y. Signals: buy_hold | zscore | momentum | rsi | bb_pct | corr | vol_ratio | drawdown | var_breach | macd | vol_zscore | port_zscore | spread.",
    input_schema: {
      type: "object",
      properties: {
        symbols:              { type: "array",  items:{type:"string"}, description: "Yahoo symbols. Portfolio: CSPX.L CNDX.L CSSX5E.SW IEEM.L VUAG.L VWRL.L NQSE.DE VFEM.L" },
        weights:              { type: "array",  items:{type:"number"}, description: "Weights summing to 1. Omit for equal weight." },
        range:                { type: "string", description: "ALWAYS 5y unless specified. Options: 1y 2y 5y 10y max." },
        label:                { type: "string", description: "Strategy name." },
        signal_type:          { type: "string", description: "buy_hold | zscore | momentum | rsi | bb_pct | corr | vol_ratio | drawdown | var_breach | macd | vol_zscore | port_zscore | spread" },
        signal_params:        { type: "object", description: "{ symbol, symbol2, window (default 30), window2 (default 60), nstd, pct }" },
        signal_direction:     { type: "string", description: "momentum or mean_reversion" },
        entry_threshold:      { type: "number", description: "Entry threshold. Default 1.0." },
        exit_signal_type:     { type: "string", description: "Optional separate exit signal." },
        exit_signal_params:   { type: "object" },
        exit_signal_direction:{ type: "string" },
        exit_threshold:       { type: "number", description: "Exit threshold. Default 0." },
        hold_days:            { type: "number", description: "Time stop in days." },
        trailing_stop_pct:    { type: "number", description: "Trailing stop %." },
        take_profit_pct:      { type: "number", description: "Take profit %." },
        stop_loss_pct:        { type: "number", description: "Stop loss % (negative)." },
        regime_signal_type:   { type: "string", description: "Regime filter signal type." },
        regime_signal_params: { type: "object" },
        regime_threshold:     { type: "number", description: "Regime threshold. Default 0." }
      },
      required: ["symbols"]
    }
  }
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
Metrics: returns | distribution | priceZscore | priceZscore30 | rollingVol | rollingVaR95 | rollingVaR99 | drawdownSeries

QUANT WORKFLOW: call compute_analytics first, then paste the chartTags from result into your reply.
PORTFOLIO ANALYTICS WORKFLOW: call get_portfolio_analytics for portfolio overview, risk, VaR, matrices, weights, or reconstructed portfolio chart requests. Show weights/correlation matrices as markdown tables, not JSON. Include @@PORTFOLIO:1y@@ when the user asks for portfolio reconstruction or a single portfolio chart.
Example: "Sharpe: 1.24 | Vol: 12% | VaR95: 1.8% | CVaR95: 2.4% @@CHART:CSPX.L:1y@@ @@QUANT:CSPX.L:rollingSharpe:1y:Rolling Sharpe (30d)@@ @@QUANT:CSPX.L:rollingVaR95:1y:Rolling VaR 95% (30d)@@"

MARKET NEWS WORKFLOW: for morning, midday, end-of-day, latest news, headlines, asset-class moves, or scheduled briefings, call get_market_news and get_macro_snapshot, then combine with portfolio data.

Always use combined portfolio percentages, not per-account NAV%. Format matrices and tabular data as markdown tables with concise columns; never dump raw JSON objects into the chat.
1Y return = time-weighted return over last 365 days (label as "1Y Return", not YTD).
Format: EUR=€, GBP=£, USD=$, 2 decimal places. Today: ${new Date().toDateString()}.

BACKTEST RULES:
- Call run_backtest immediately when asked. ALWAYS use range=5y unless specified. For "my portfolio" use: CSPX.L CNDX.L CSSX5E.SW IEEM.L VUAG.L VWRL.L NQSE.DE VFEM.L.
- After the tool returns, write exactly: "Backtest complete — results rendered below." Then give qualitative commentary only.
- NEVER write dates, z-scores, trade returns, signal values or any numbers from the result in your text. The UI renders all computed data directly. Zero numerical output in text after a backtest.

EMAIL RULE:
- When asked to email anything: call the tools needed to get the data, then call send_email in the same response. Do it immediately without asking for confirmation.

DATA RULE:
- Never invent market data. Always fetch via tools first.
- Mathematical models (Black-Scholes, Kelly, etc.) are fine to apply to real fetched data.
`;


async function runAgent(prompt, history = []) {
  const cleanHistory = history
    .filter(m => m.role && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content }));

  const messages = [...cleanHistory, { role: "user", content: prompt }];
  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4000,  // keep tight so Claude is forced to conclude
    system: SYSTEM,
    tools: TOOLS,
    messages,
  });

  let loop = [...messages];
  let toolCallCount = 0;
  let backtestData = null;
  const MAX_TOOL_CALLS = 8;

  while (response.stop_reason === "tool_use" && toolCallCount < MAX_TOOL_CALLS) {
    loop.push({ role: "assistant", content: response.content });
    const toolBlocks = response.content.filter(b => b.type === "tool_use");

    const toolResults = await Promise.all(toolBlocks.map(async b => {
      let result;
      try { result = await executeTool(b.name, b.input); } catch(e) { result = { error: e.message }; }
      if (b.name === "run_backtest" && result?.equityCurve) backtestData = result;
      toolCallCount++;
      console.log(`🔧 Tool ${b.name} (${toolCallCount}/${MAX_TOOL_CALLS})`);
      return { type: "tool_result", tool_use_id: b.id, content: JSON.stringify(result) };
    }));

    loop.push({ role: "user", content: toolResults });

    try {
      response = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 4000, system: SYSTEM, tools: TOOLS, messages: loop });
    } catch(e) {
      console.error("API error:", e.message);
      return `Error: ${e.message}`;
    }
  }

  const reply = response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  if (backtestData) return { reply, backtestData };
  return reply;
}

app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    const result = await runAgent(message, history);
    if (typeof result === "object" && result.backtestData) {
      res.json({ reply: result.reply, backtestData: result.backtestData });
    } else {
      res.json({ reply: result });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/account", async (req, res) => {
  try { res.json(await buildPortfolio()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// SCHEDULED TASKS — morning brief, midday check, end-of-day report
// ═══════════════════════════════════════════════════════════════════
const TASKS = [
  {
    id: "morning",
    label: "Morning Brief",
    icon: "🌅",
    cron: "30 7 * * 1-5",   // 07:30 UTC weekdays (~08:30 London BST)
    prompt: "Summarise the pre-market state: overnight moves in ^GSPC, ^IXIC, ^STOXX50E, ^N225, ^HSI. Note any major macro events, top market news, and 1-2 key risks to watch today. Keep it under 200 words. End with 'FULL REPORT ATTACHED' if morning report email was sent."
  },
  {
    id: "midday",
    label: "Midday Check",
    icon: "🕛",
    cron: "0 11 * * 1-5",   // 11:00 UTC weekdays (~12:00 London BST)
    prompt: "Give a concise midday market update: how are US futures / European markets doing vs open? Note any breaking news that could affect my portfolio (CSPX, CNDX, IEEM, VUAG, VWRL, NQSE, VFEM, CSSX5E). Keep under 150 words."
  },
  {
    id: "eod",
    label: "End of Day",
    icon: "🌆",
    cron: "0 16 * * 1-5",   // 16:00 UTC weekdays (~17:00 London BST, close of European markets)
    prompt: "Summarise today's close: what moved in US and European markets, best/worst sectors, notable news from the day. Then check my portfolio holdings (CSPX.L, CNDX.L, CSSX5E.SW, IEEM.L, VUAG.L, VWRL.L, NQSE.DE, VFEM.L) and highlight the biggest daily movers. Keep under 200 words."
  },
  {
    id: "weekly",
    label: "Weekly Review",
    icon: "📅",
    cron: "30 15 * * 5",    // 15:30 UTC Friday (~16:30 London)
    prompt: "Weekly review: how did my portfolio perform this week? Note the biggest movers among CSPX.L, CNDX.L, CSSX5E.SW, IEEM.L, VUAG.L, VWRL.L, NQSE.DE, VFEM.L, look at week-over-week PnL, and flag anything to watch next week. Keep under 250 words."
  },
];

// In-memory state — persisted state would need Redis/DB
const taskState = {};
TASKS.forEach(t => { taskState[t.id] = { enabled: true, running: false, lastRun: null, lastResult: null }; });
const taskLog = [];

// Register cron jobs
console.log(`⏰ Registering cron tasks: ${TASKS.map(t => t.cron).join(", ")}`);
TASKS.forEach(task => {
  cron.schedule(task.cron, async () => {
    if (!taskState[task.id].enabled) return;
    if (taskState[task.id].running) return;
    taskState[task.id].running = true;
    taskLog.unshift({ task: task.label, status: "running", time: new Date().toISOString() });
    try {
      const result = await runAgent(task.prompt);
      const resultStr = typeof result === "string" ? result : (result?.reply || JSON.stringify(result));
      taskState[task.id] = { ...taskState[task.id], running: false, lastRun: new Date().toISOString(), lastResult: resultStr };
      taskLog[0] = { task: task.label, status: "done", time: taskState[task.id].lastRun, result: resultStr };
      await sendPush(`${task.icon} ${task.label}`, resultStr.slice(0, 140), task.icon);
      if (task.id === "morning") buildAndSendReport(REPORT_TO).catch(e => console.error("Email:", e.message));
    } catch (e) {
      taskState[task.id].running = false;
      taskLog[0] = { task: task.label, status: "error", time: new Date().toISOString(), result: e.message };
      console.error(`Task ${task.id} failed:`, e.message);
    }
  }, { timezone: "UTC" });
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
    const resultStr = typeof result === "string" ? result : (result?.reply || JSON.stringify(result));
    taskState[task.id] = { ...taskState[task.id], running: false, lastRun: new Date().toISOString(), lastResult: resultStr };
    taskLog[0] = { task: task.label, status: "done", time: taskState[task.id].lastRun, result: resultStr };
    await sendPush(`${task.icon} ${task.label} done`, resultStr.slice(0, 140), task.icon);
    if (task.id === "morning") buildAndSendReport(REPORT_TO).catch(e=>console.error("Email:",e.message));
  } catch (e) { taskState[task.id].running = false; taskLog[0] = { task: task.label, status: "error", time: new Date().toISOString(), result: e.message }; }
});

app.get("/api/log", (req, res) => res.json(taskLog.slice(0, 50)));

app.get("/api/news/symbol/:symbol", async (req, res) => {
  try { res.json({ news: await fetchSymbolNews(req.params.symbol, +(req.query.limit||5)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/email/report", async (req, res) => {
  try { res.json(await buildAndSendReport(req.body?.to || REPORT_TO)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/regime", async (req, res) => {
  try {
    const portfolioRetMap = new Map();
    try {
      const p = await buildPortfolio();
      const m = p?.combined?.metrics1Y;
      if (m?.dates && m?.portfolioReturnsPct) m.dates.forEach((d,i)=>{ if(Number.isFinite(m.portfolioReturnsPct[i])) portfolioRetMap.set(d, m.portfolioReturnsPct[i]/100); });
    } catch {}
    res.json(await computeRegimeModel(portfolioRetMap.size>0?portfolioRetMap:null));
  } catch (e) { console.error("Regime error:",e.message); res.status(500).json({ error: e.message }); }
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
app.post("/api/push/subscribe",   (req, res) => { const sub = req.body; if (!sub?.endpoint) return res.status(400).json({ error: "Invalid" }); const id=Buffer.from(sub.endpoint).toString("base64").slice(0,32); pushSubs.set(id,sub); savePushSubs(); console.log(`📱 Push registered total=${pushSubs.size}`); res.json({ ok: true }); });
app.post("/api/push/unsubscribe", (req, res) => { pushSubs.delete(Buffer.from(req.body.endpoint || "").toString("base64").slice(0, 32)); savePushSubs(); res.json({ ok: true }); });
app.post("/api/push/test",        async (req, res) => { await sendPush("✅ Test", "Push notifications working!", "✅"); res.json({ ok: true }); });

app.get("/api/ibkr/status", async (req, res) => {
  try { const p = await buildPortfolio(); res.json({ authenticated: true, mode: "flex_web_service", accounts: p.accounts.map(a => ({ id: a.accountId, currency: a.baseCurrency, nlv: a.netLiquidation })), combinedNLV_EUR: p.combined.totalNetLiquidation }); }
  catch (e) { res.status(503).json({ authenticated: false, error: e.message }); }
});

// Debug endpoint: dump raw FX-conversion pipeline for one symbol so we can
// verify by hand that currency detection, FX rate direction, and the daily
// return conversion are all correct. Returns first/last 5 rows of each stage.
app.get("/api/debug/fx/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const range = req.query.range || "1y";
    const ySym = yfSymbol(symbol);
    const { bars, meta } = await fetchYahooCloses(ySym, range);
    const currency = CURRENCY_OVERRIDE[ySym] || meta?.currency || "EUR";

    // Raw local-currency returns (before any EUR conversion)
    const localReturns = [];
    for (let i = 1; i < bars.length; i++) {
      const prev = bars[i-1]?.close, cur = bars[i]?.close;
      if (prev && cur) localReturns.push({ date: bars[i].date, localClose: cur, localRet: (cur-prev)/prev });
    }

    let fxMeta = null, coverage = null;
    if (currency !== "EUR") {
      const pair = FX_PAIR_FOR[currency];
      const fxResult = await fetchYahooCloses(pair, range);
      const fxDateSet = new Set(fxResult.bars.map(b => b.date));

      // Coverage: what % of the asset's trading dates have a SAME-DAY FX bar?
      const assetDates = localReturns.map(r => r.date);
      const sameDayHits = assetDates.filter(d => fxDateSet.has(d)).length;
      const missingDates = assetDates.filter(d => !fxDateSet.has(d));

      fxMeta = {
        pair, fxBarCount: fxResult.bars.length, assetBarCount: assetDates.length,
        sameDayCoveragePct: +((sameDayHits / assetDates.length) * 100).toFixed(1),
        missingDatesCount: missingDates.length,
        missingDatesSample: missingDates.slice(0, 10), // first 10 gaps, to spot patterns (e.g. always weekends)
        sampleRaw: fxResult.bars.slice(-5).map(b => ({ date: b.date, rawClose: b.close, eurPerUnit: +(1/b.close).toFixed(6) })),
      };
    }

    // Final EUR-converted returns (what the app actually uses)
    const eurReturns = await fetchYahooReturnSeries(symbol, range, true);

    // Bias check: sum of (eurRet - localRet) across the WHOLE period.
    // If forward-fill / conversion is unbiased, this should be small and roughly
    // centered around the asset's actual currency drift vs EUR over the period —
    // NOT a large one-directional number disconnected from real FX moves.
    const localMap = new Map(localReturns.map(r => [r.date, r.localRet]));
    let sumDiff = 0, nDiff = 0, sumLocal = 0, sumEur = 0;
    eurReturns.forEach(r => {
      const lr = localMap.get(r.date);
      if (Number.isFinite(lr)) { sumDiff += (r.ret - lr); nDiff++; sumLocal += lr; sumEur += r.ret; }
    });
    const cumLocal = localReturns.reduce((acc,r) => acc*(1+r.localRet), 1) - 1;
    const cumEur   = eurReturns.reduce((acc,r) => acc*(1+r.ret), 1) - 1;

    res.json({
      symbol, yahooSymbol: ySym, detectedCurrency: currency, range,
      localCloses_last5: bars.slice(-5),
      localReturns_last5: localReturns.slice(-5),
      fxConversion: fxMeta,
      eurReturns_last5: eurReturns.slice(-5),
      biasCheck: currency === "EUR" ? null : {
        nDaysCompared: nDiff,
        cumulativeLocalReturnPct: +(cumLocal*100).toFixed(2),
        cumulativeEURReturnPct: +(cumEur*100).toFixed(2),
        impliedFXMovePct: +((cumEur - cumLocal)*100/(1+cumLocal)).toFixed(2), // approx FX drift implied by the conversion
        avgDailyDiffBps: +((sumDiff/nDiff)*10000).toFixed(3), // avg (eurRet-localRet) per day in basis points
        note: "cumulativeEURReturnPct minus cumulativeLocalReturnPct should roughly match the REAL EURUSD/EURGBP/EURCHF move over the period (check against a live FX chart). If it's wildly different, conversion is biased.",
      },
      sanityCheck: currency === "EUR"
        ? "No conversion needed (already EUR) — localReturns should equal eurReturns exactly"
        : `Converted ${currency}->EUR over ${range}. Check fxConversion.sameDayCoveragePct (should be >90%) and biasCheck.impliedFXMovePct (compare to real ${currency}/EUR move over the period).`,
    });
  } catch (e) { res.status(500).json({ error: e.message, stack: e.stack }); }
});

// Backtest email export
app.post("/api/backtest/email", async (req, res) => {
  const { backtestResult: bt } = req.body;
  if (!bt) return res.status(400).json({ error: "backtestResult required" });
  const m = bt.metrics||{};
  const pyScript = `#!/usr/bin/env python3
"""Backtest Audit Script — ${bt.label||"Strategy"}
Generated by IBKR Agent. pip install pandas numpy matplotlib
"""
import pandas as pd, numpy as np, json, matplotlib.pyplot as plt

DATA = json.loads("""${JSON.stringify({
  label: bt.label, symbols: bt.symbols, weights: bt.weights, range: bt.range,
  signal_type: bt.signal_type, signal_params: bt.signal_params,
  signal_direction: bt.signal_direction, entry_threshold: bt.entry_threshold,
  dates: bt.dates, equity_curve: bt.equityCurve?.map(p=>p.value),
  drawdown: bt.drawdownCurve?.map(p=>p.value), signal_series: bt.signalSeries,
  trigger_dates: bt.triggerDates, trades: bt.trades, metrics: m,
})}""")

dates = pd.to_datetime(DATA['dates'])
equity = pd.Series(DATA['equity_curve'], index=dates)
drawdown = pd.Series(DATA['drawdown'], index=dates)
signal = pd.Series(DATA['signal_series'], index=dates)

fig, axes = plt.subplots(3, 1, figsize=(14,10), sharex=True)
equity.plot(ax=axes[0], color='#2ECC71' if equity.iloc[-1]>=100 else '#E74C3C', title=DATA['label'])
axes[0].axhline(100, color='gray', linestyle='--', linewidth=0.8); axes[0].set_ylabel('Equity (base 100)')
drawdown.plot(ax=axes[1], color='#E74C3C'); axes[1].fill_between(dates, drawdown, 0, color='#E74C3C', alpha=0.2); axes[1].set_ylabel('Drawdown %')
signal.plot(ax=axes[2], color='#4A9EFF'); axes[2].axhline(DATA['entry_threshold'], color='green', linestyle='--'); axes[2].axhline(0, color='gray', linestyle='-', linewidth=0.5); axes[2].set_ylabel('Signal')
plt.tight_layout(); plt.savefig('backtest_audit.png', dpi=150); plt.show()

print("\n=== METRICS ===")
for k,v in DATA['metrics'].items(): print(f"  {k}: {v}")
print("\n=== TRIGGER DATES ===")
for t in DATA['trigger_dates']: print(f"  {t['date']}  {t['type']:5s}  signal={t['signal']:.4f}")
print("\n=== TRADES ===")
print(pd.DataFrame(DATA['trades']).to_string())
`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="background:#0D0F14;font-family:Inter,sans-serif;color:#EDF0F7;padding:24px">
<h2 style="color:#C9A84C">📊 ${bt.label||"Backtest"}</h2>
<p style="color:#5A6280">${new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}</p>
<h3 style="color:#E8C87A">Strategy</h3>
<pre style="background:#13161E;padding:12px;border-radius:8px;font-size:12px">${JSON.stringify({symbols:bt.symbols,range:bt.range,signal_type:bt.signal_type,signal_params:bt.signal_params,signal_direction:bt.signal_direction,entry_threshold:bt.entry_threshold},null,2)}</pre>
<h3 style="color:#E8C87A">Metrics</h3>
<table style="border-collapse:collapse;width:100%;max-width:480px">
${Object.entries(m).map(([k,v])=>`<tr style="border-bottom:1px solid #252A38"><td style="padding:6px 10px 6px 0;color:#8A9AC0;font-size:13px">${k}</td><td style="padding:6px 0;font-family:monospace;font-size:13px;color:#EDF0F7">${v}</td></tr>`).join("")}
</table>
<h3 style="color:#E8C87A">Trigger Dates</h3>
<table style="border-collapse:collapse;font-size:12px;font-family:monospace">
<tr><th style="padding:4px 10px 4px 0;color:#5A6280">Date</th><th style="padding:4px 10px;color:#5A6280">Type</th><th style="padding:4px 10px;color:#5A6280">Signal</th></tr>
${(bt.triggerDates||[]).map(t=>`<tr><td style="padding:3px 10px 3px 0">${t.date}</td><td style="padding:3px 10px;color:${t.type==="ENTRY"?"#2ECC71":"#E74C3C"}">${t.type}</td><td style="padding:3px 10px">${t.signal?.toFixed(4)}</td></tr>`).join("")}
</table>
<h3 style="color:#E8C87A">All Signal Breach Dates</h3>
<table style="border-collapse:collapse;font-size:12px;font-family:monospace">
<tr><th style="padding:4px 10px 4px 0;color:#5A6280">Date</th><th style="padding:4px 10px;color:#5A6280">Signal</th></tr>
${(bt.signalBreachDates||[]).map(t=>`<tr><td style="padding:3px 10px 3px 0">${t.date}</td><td style="padding:3px 10px;color:#E74C3C">${t.signal?.toFixed(4)}</td></tr>`).join("")}
</table>
<hr style="border-color:#252A38;margin:24px 0"/>
<h3 style="color:#E8C87A">🐍 Python Audit Script</h3>
<pre style="background:#0A0C12;border:1px solid #252A38;border-radius:8px;padding:14px;font-family:monospace;font-size:11px;white-space:pre-wrap;max-height:800px;overflow:auto">${pyScript.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</pre>
</body></html>`;
  try { res.json(await sendEmail(REPORT_TO, `📊 Backtest: ${bt.label||"Strategy"}`, html)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString(), pushSubscribers: pushSubs.size }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 IBKR Agent on port ${PORT}`));
