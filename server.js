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

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const parser    = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
if (VAPID_PUBLIC && VAPID_PRIVATE) webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

// ─── Helpers ──────────────────────────────────────────────────────
const toArr = v => Array.isArray(v) ? v : v ? [v] : [];
const n     = v => parseFloat(v || 0);
const fmt   = v => n(v).toFixed(2);

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
    },
  };
}

// ─── Quant Analytics Engine ───────────────────────────────────────
function rets(closes)    { return closes.slice(1).map((v, i) => (v - closes[i]) / closes[i]); }
function mean(arr)       { return arr.reduce((s, v) => s + v, 0) / arr.length; }
function std(arr)        { const m = mean(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length); }
function rollingFn(arr, w, fn) { const out = new Array(w - 1).fill(null); for (let i = w - 1; i < arr.length; i++) out.push(fn(arr.slice(i - w + 1, i + 1))); return out; }
function sharpe(r, period = 252) { const m = mean(r), s = std(r); return s === 0 ? 0 : (m / s) * Math.sqrt(period); }
function sortino(r, period = 252) { const m = mean(r); const neg = r.filter(v => v < 0); const ds = neg.length ? Math.sqrt(neg.reduce((s, v) => s + v * v, 0) / neg.length) : 0; return ds === 0 ? 0 : (m / ds) * Math.sqrt(period); }
function maxDD(closes)   { let peak = -Infinity, dd = 0; for (const c of closes) { if (c > peak) peak = c; const d = (c - peak) / peak * 100; if (d < dd) dd = d; } return dd; }
function betaFn(a, b)    { if (!a.length || a.length !== b.length) return null; const ma = mean(a), mb = mean(b); const cov = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / a.length; const vb = b.reduce((s, v) => s + (v - mb) ** 2, 0) / b.length; return vb === 0 ? null : cov / vb; }
function corrFn(a, b)    { if (!a.length || a.length !== b.length) return null; const ma = mean(a), mb = mean(b), sa = std(a), sb = std(b); if (sa === 0 || sb === 0) return null; return a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / (a.length * sa * sb); }

async function fetchYahooCloses(symbol, range = "1y") {
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
        return s === 0 ? 0 : +(m / s).toFixed(4);
      });
      const rollingSharpe = [null, ...rollingSharpeRaw];

      // Rolling Vol: annualised std × √252, window=30
      const rollingVolRaw = rollingFn(r, 30, arr => +(std(arr) * Math.sqrt(252) * 100).toFixed(4));
      const rollingVol = [null, ...rollingVolRaw];

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
        sharpe:              std(r) === 0 ? 0 : +(mean(r) / std(r)).toFixed(4),
        sortino:             +sortino(r).toFixed(4),
        maxDrawdown:         +maxDD(closes).toFixed(2),
        beta:                betaVal !== null ? +betaVal.toFixed(4) : null,
        correlation:         corrVal !== null ? +corrVal.toFixed(4) : null,
        currentReturnZscore: zs252raw[zs252raw.length - 1],
      };

      const series = { dates, closes, priceZscore, priceZscore30, rollingSharpe, rollingVol, drawdownSeries };

      // Cache for GET endpoint
      analyticsCache.set(`${sym}:${range}`, { ...series, summary, computedAt: Date.now() });

      return {
        symbol: sym, benchmark: bench, range, currency: meta?.currency, summary, series,
        chartTags: {
          price:         `@@CHART:${sym}:${range}@@`,
          zscore:        `@@QUANT:${sym}:priceZscore:${range}:Z-Score (${win}d rolling)@@`,
          rollingSharpe: `@@QUANT:${sym}:rollingSharpe:${range}:Rolling Sharpe (${win}d)@@`,
          rollingVol:    `@@QUANT:${sym}:rollingVol:${range}:Rolling Vol % ann. (${win}d)@@`,
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
  { name: "refresh_data",    description: "Force fresh data pull from IBKR.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_market_data", description: "Real-time quote for any stock/ETF worldwide.", input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] } },
  { name: "get_historical_data", description: "OHLCV history for charting. range: 1mo,3mo,6mo,1y,2y,5y,ytd. interval: 1d,1wk,1mo.", input_schema: { type: "object", properties: { symbol: { type: "string" }, range: { type: "string" }, interval: { type: "string" } }, required: ["symbol"] } },
  { name: "get_multiple_quotes", description: "Live quotes for multiple symbols at once.", input_schema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } } }, required: ["symbols"] } },
  { name: "search_symbol",   description: "Search for a ticker by company name.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "compute_analytics", description: "Compute quant analytics: Z-score, rolling Sharpe, rolling vol, beta, correlation, drawdown, CAGR, Sortino. Returns series data + chart tags. Use for ANY quant metric request.", input_schema: { type: "object", properties: { symbol: { type: "string" }, range: { type: "string", description: "1mo,3mo,6mo,1y,2y,5y,ytd" }, benchmark: { type: "string", description: "Default ^GSPC" }, rolling_window: { type: "number", description: "Default 30" } }, required: ["symbol"] } },
  { name: "compute_correlation_matrix", description: "Pairwise correlation matrix for multiple symbols.", input_schema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } }, range: { type: "string" } }, required: ["symbols"] } },
];

const SYSTEM = `You are a professional finance AI agent managing TWO Interactive Brokers accounts:
- U11354150: EUR-denominated (main)
- U9733561: GBP-denominated (ISA)

Data is read-only via IBKR Flex Web Service. All combined figures are in EUR.

Portfolio: CSNDX, CSPX, CSSX5E, IEEM, IUSE, NQSE, SPCX, VUAG, VWRL, VFEM.
Yahoo Finance symbols: CSPX→CSPX.L, CSNDX→CNDX.SW, CSSX5E→CSSX5E.SW, IEEM→IEEM.L, IUSE→IUSE.L, NQSE→NQSE.DE, VUAG→VUAG.L, VWRL→VWRL.L, VFEM→VFEM.L.

CHART TAGS — embed in responses to render charts inline:
Price chart:  @@CHART:SYMBOL:RANGE@@
Quant chart:  @@QUANT:SYMBOL:METRIC:RANGE:LABEL@@
Metrics: priceZscore | rollingSharpe | rollingVol | drawdownSeries

QUANT WORKFLOW: call compute_analytics first, then paste the chartTags from result into your reply.
Example: "Sharpe: 1.24 | Vol: 12% @@CHART:CSPX.L:1y@@ @@QUANT:CSPX.L:rollingSharpe:1y:Rolling Sharpe (30d)@@"

Always use combined portfolio percentages, not per-account NAV%.
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
    prompt: "Morning briefing: get portfolio then allocation. Show combined NLV, top 5 positions by %, combined unrealized P&L. Concise." },
  { id: "midday",  label: "Midday check",        icon: "☀️", cron: "0 11 * * 1-5",  cronDisplay: "12:00 PM London",
    prompt: "Midday check: get portfolio. Combined NLV and unrealized P&L. Under 100 words." },
  { id: "eod",     label: "End-of-day summary",  icon: "🌆", cron: "0 16 * * 1-5",  cronDisplay: "5:00 PM London",
    prompt: "End of day: get portfolio and trades. Combined NLV, unrealized P&L, trades today, biggest movers." },
  { id: "weekly",  label: "Weekly review",       icon: "⚖️", cron: "30 15 * * 5",   cronDisplay: "4:30 PM London (Fri)",
    prompt: "Weekly review: get portfolio, allocation, P&L, trades. Combined NLV, full allocation breakdown, unrealized P&L, trades this week, commissions, concentration risk." },
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
  } catch (e) { taskState[task.id].running = false; taskLog[0] = { task: task.label, status: "error", time: new Date().toISOString(), result: e.message }; }
});

app.get("/api/log", (req, res) => res.json(taskLog.slice(0, 50)));

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

// Analytics — compute and return series immediately
app.post("/api/analytics/compute", async (req, res) => {
  try {
    const { symbol, range = "1y", benchmark = "^GSPC", rolling_window = 30 } = req.body;
    if (!symbol) return res.status(400).json({ error: "symbol required" });
    const result = await executeTool("compute_analytics", { symbol, range, benchmark, rolling_window });
    if (result.error) return res.status(500).json(result);
    // Return series fields at top level for easy frontend consumption
    res.json({ ...result.series, summary: result.summary, symbol: result.symbol, range, currency: result.currency });
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
app.post("/api/push/subscribe",   (req, res) => { const sub = req.body; if (!sub?.endpoint) return res.status(400).json({ error: "Invalid" }); pushSubs.set(Buffer.from(sub.endpoint).toString("base64").slice(0, 32), sub); res.json({ ok: true }); });
app.post("/api/push/unsubscribe", (req, res) => { pushSubs.delete(Buffer.from(req.body.endpoint || "").toString("base64").slice(0, 32)); res.json({ ok: true }); });
app.post("/api/push/test",        async (req, res) => { await sendPush("✅ Test", "Push notifications working!", "✅"); res.json({ ok: true }); });

app.get("/api/ibkr/status", async (req, res) => {
  try { const p = await buildPortfolio(); res.json({ authenticated: true, mode: "flex_web_service", accounts: p.accounts.map(a => ({ id: a.accountId, currency: a.baseCurrency, nlv: a.netLiquidation })), combinedNLV_EUR: p.combined.totalNetLiquidation }); }
  catch (e) { res.status(503).json({ authenticated: false, error: e.message }); }
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString(), pushSubscribers: pushSubs.size }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 IBKR Agent on port ${PORT}`));
