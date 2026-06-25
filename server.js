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

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY  || "";
const FLEX_TOKEN    = process.env.IBKR_FLEX_TOKEN    || "";
const FLEX_QUERY_ID = process.env.IBKR_FLEX_QUERY_ID || "";
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY   || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY  || "";
const VAPID_EMAIL   = process.env.VAPID_EMAIL        || "mailto:you@example.com";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const parser    = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

if (VAPID_PUBLIC && VAPID_PRIVATE) webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

// ─── Helpers ──────────────────────────────────────────────────────
const toArr = v  => Array.isArray(v) ? v : v ? [v] : [];
const n     = v  => parseFloat(v || 0);
const fmt   = v  => n(v).toFixed(2);

// ─── Flex Web Service ─────────────────────────────────────────────
const FLEX_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";

async function fetchFlex() {
  if (!FLEX_TOKEN || !FLEX_QUERY_ID) throw new Error("Missing IBKR_FLEX_TOKEN or IBKR_FLEX_QUERY_ID");

  // Step 1 — request report generation
  const sendRes  = await fetch(`${FLEX_BASE}/SendRequest?t=${FLEX_TOKEN}&q=${FLEX_QUERY_ID}&v=3`, { headers: { "User-Agent": "Node/18" } });
  const sendData = parser.parse(await sendRes.text());
  if (sendData?.FlexStatementResponse?.Status !== "Success")
    throw new Error(`Flex SendRequest failed: ${JSON.stringify(sendData)}`);

  const refCode = sendData.FlexStatementResponse.ReferenceCode;
  const url     = sendData.FlexStatementResponse.Url;

  // Step 2 — retrieve report (wait for IBKR to generate it)
  await new Promise(r => setTimeout(r, 8000));
  for (let i = 0; i < 10; i++) {
    const res     = await fetch(`${url}?t=${FLEX_TOKEN}&q=${refCode}&v=3`, { headers: { "User-Agent": "Node/18" } });
    const getData = parser.parse(await res.text());
    const raw     = getData?.FlexQueryResponse?.FlexStatements?.FlexStatement
                 ?? getData?.FlexStatementResponse?.FlexStatements?.FlexStatement;
    if (raw) return Array.isArray(raw) ? raw : [raw];
    await new Promise(r => setTimeout(r, 3000 + i * 1000));
  }
  throw new Error("Flex report never became available after retries");
}

// Cache 15 min
let _cache = null, _cacheTime = 0;
async function getStatements(force = false) {
  if (!force && _cache && Date.now() - _cacheTime < 15 * 60 * 1000) return _cache;
  _cache     = await fetchFlex();
  _cacheTime = Date.now();
  return _cache;
}

// ─── Data layer ───────────────────────────────────────────────────
// Deduplicate statements: IBKR returns one FlexStatement per day per account.
// We want only the LATEST statement per account.
function latestPerAccount(stmts) {
  const map = {};
  for (const s of stmts) {
    const id = s.accountId;
    if (!map[id] || (s.whenGenerated || "") > (map[id].whenGenerated || "")) map[id] = s;
  }
  return Object.values(map);
}

// Get FX rates from statements (currency → rate to base EUR)
function getFxRates(stmt) {
  const rates = { EUR: 1 };
  toArr(stmt?.ConversionRates?.ConversionRate).forEach(r => {
    rates[r.fromCurrency] = n(r.rate);
  });
  return rates;
}

// Convert value to EUR using fx rates
function toEUR(value, currency, fxRates) {
  const rate = fxRates[currency] ?? 1;
  return n(value) * rate;
}

// ─── Build portfolio object ───────────────────────────────────────
async function buildPortfolio(force = false) {
  const all   = await getStatements(force);
  const stmts = latestPerAccount(all);

  // Per-account data
  // Build master EUR-based FX rates from the EUR account (most reliable)
  const eurStmt    = stmts.find(s => (s?.AccountInformation?.currency || "EUR") === "EUR") || stmts[0];
  const masterFxRates = getFxRates(eurStmt); // EUR-based: GBP=1.1601, USD=0.87861, etc.

  const accounts = stmts.map(stmt => {
    const info      = stmt?.AccountInformation || {};
    const fxRates   = getFxRates(stmt);
    const equityRows = toArr(stmt?.EquitySummaryInBase?.EquitySummaryByReportDateInBase);
    const equity    = equityRows[equityRows.length - 1] || {};
    const positions = toArr(stmt?.OpenPositions?.OpenPosition)
      .filter(p => p.levelOfDetail === "SUMMARY" || !p.levelOfDetail);

    // MTM Performance Summary — has priorOpenMtm (unrealized P&L) per symbol
    const mtmBySymbol = {};
    toArr(stmt?.MTMPerformanceSummaryInBase?.MTMPerformanceSummaryUnderlying)
      .filter(p => p.symbol).forEach(p => { mtmBySymbol[p.symbol] = p; });

    // MTD/YTD Performance Summary
    const ytdBySymbol = {};
    toArr(stmt?.MTDYTDPerformanceSummary?.MTDYTDPerformanceSummaryUnderlying)
      .filter(p => p.symbol).forEach(p => { ytdBySymbol[p.symbol] = p; });

    // Change in NAV — account-level YTD return
    const changeInNAV = stmt?.ChangeInNAV || {};

    const cashRows  = toArr(stmt?.CashReport?.CashReportCurrency);
    const baseCash  = cashRows.find(c => c.currency === "BASE_SUMMARY") || cashRows[0] || {};

    // Convert account base currency to EUR using master (EUR-based) FX rates
    // e.g. U9733561 is GBP — masterFxRates["GBP"] = 1.1601 meaning 1 GBP = 1.1601 EUR
    const baseCurrency = info.currency || "EUR";
    const acctFxToEUR  = baseCurrency === "EUR" ? 1 : (masterFxRates[baseCurrency] || 1);

    return {
      accountId:    stmt.accountId,
      accountName:  info.name || "",
      baseCurrency,
      // Balances in account base currency
      netLiquidation:    n(equity.total),
      netLiquidationEUR: n(equity.total) * acctFxToEUR,
      cash:              n(equity.cash),
      cashEUR:           n(equity.cash) * acctFxToEUR,
      stockValue:        n(equity.stock),
      stockValueEUR:     n(equity.stock) * acctFxToEUR,
      dividendAccruals:  n(equity.dividendAccruals),
      acctFxToEUR,
      // Account-level performance from ChangeInNAV
      ytdReturn:      n(changeInNAV.twr),          // time-weighted return %
      startingValue:  n(changeInNAV.startingValue) * acctFxToEUR,
      endingValue:    n(changeInNAV.endingValue)   * acctFxToEUR,
      ytdGainEUR:     (n(changeInNAV.endingValue) - n(changeInNAV.startingValue)) * acctFxToEUR,
      // Cash report
      commissions:  n(baseCash.commissions),
      deposits:     n(baseCash.deposits),
      withdrawals:  n(baseCash.withdrawals),
      dividends:    n(baseCash.dividends),
      brokerInterest: n(baseCash.brokerInterest),
      // Positions
      positions: positions.map(p => {
        const fxRate    = n(p.fxRateToBase) || fxRates[p.currency] || 1;
        const mtm       = mtmBySymbol[p.symbol] || {};
        const ytd       = ytdBySymbol[p.symbol] || {};
        const valueEUR  = n(p.positionValue) * fxRate;
        // priorOpenMtm = unrealized P&L on open positions (mark-to-market)
        // It is in base currency (EUR for U11354150)
        const unrealEUR = n(mtm.priorOpenMtm);
        const unrealRaw = fxRate > 0 ? unrealEUR / fxRate : unrealEUR;
        const realRaw   = 0; // realized P&L not available in Flex for this account
        const costMoney = n(p.costBasisMoney);
        const costEUR   = costMoney * fxRate;
        return {
          symbol:             p.symbol,
          description:        p.description,
          assetCategory:      p.assetCategory,
          currency:           p.currency,
          quantity:           n(p.position),
          markPrice:          n(p.markPrice),
          costBasisPrice:     n(p.costBasisPrice),
          positionValue:      n(p.positionValue),
          positionValueEUR:   valueEUR,
          unrealizedPnl:      unrealRaw,
          unrealizedPnlEUR:   unrealEUR,
          realizedPnl:        realRaw,
          costBasisMoneyEUR:  costEUR,
          returnPct:          costMoney > 0 ? ((n(p.positionValue) - costMoney) / costMoney) * 100 : 0,
          percentOfAccountNAV: n(p.percentOfNAV),
          fxRateToBase:       fxRate,
          // YTD performance
          ytdPnl:             n(ytd.markToMarketYTD),
          mtdPnl:             n(ytd.markToMarketMTD),
          realizedYTD:        n(ytd.realizedPLYTD),
          realizedMTD:        n(ytd.realizedPLMTD),
        };
      }),
      fxRates,
    };
  });

  // Combined portfolio — aggregate across accounts in EUR
  const totalNLV = accounts.reduce((s, a) => s + a.netLiquidationEUR, 0);

  // Merge positions by symbol across accounts
  const symbolMap = {};
  for (const acct of accounts) {
    for (const p of acct.positions) {
      if (!symbolMap[p.symbol]) {
        symbolMap[p.symbol] = {
          symbol:          p.symbol,
          description:     p.description,
          assetCategory:   p.assetCategory,
          totalValueEUR:   0,
          totalUnrealEUR:  0,
          totalRealEUR:    0,
          totalCostEUR:    0,
          totalYtdPnl:     0,
          totalMtdPnl:     0,
          legs: [],
        };
      }
      symbolMap[p.symbol].totalValueEUR  += p.positionValueEUR;
      symbolMap[p.symbol].totalUnrealEUR += p.unrealizedPnlEUR;
      symbolMap[p.symbol].totalCostEUR   += p.costBasisMoneyEUR;
      symbolMap[p.symbol].legs.push({
        accountId:     acct.accountId,
        currency:      p.currency,
        quantity:      p.quantity,
        markPrice:     p.markPrice,
        positionValue: p.positionValue,
        unrealizedPnl: p.unrealizedPnl,
        costBasisPrice: p.costBasisPrice,
      });
    }
  }

  const combinedPositions = Object.values(symbolMap)
    .sort((a, b) => b.totalValueEUR - a.totalValueEUR)
    .map(s => ({
      ...s,
      allocationPct: totalNLV > 0 ? (s.totalValueEUR / totalNLV) * 100 : 0,
      totalValueEUR:  +s.totalValueEUR.toFixed(2),
      totalUnrealEUR: +s.totalUnrealEUR.toFixed(2),
      totalCostEUR:   +s.totalCostEUR.toFixed(2),
      returnPct: s.totalCostEUR > 0 ? ((s.totalValueEUR - s.totalCostEUR) / s.totalCostEUR) * 100 : 0,
    }));

  const totalUnrealEUR = +combinedPositions.reduce((s, p) => s + p.totalUnrealEUR, 0).toFixed(2);
  const totalRealEUR   = +combinedPositions.reduce((s, p) => s + p.totalRealEUR, 0).toFixed(2);
  const totalYtdPnl    = +combinedPositions.reduce((s, p) => s + p.totalYtdPnl, 0).toFixed(2);
  const totalMtdPnl    = +combinedPositions.reduce((s, p) => s + p.totalMtdPnl, 0).toFixed(2);

  return {
    accounts,
    combined: {
      totalNetLiquidation:   +totalNLV.toFixed(2),
      totalCash:             +accounts.reduce((s, a) => s + a.cashEUR, 0).toFixed(2),
      totalStockValue:       +accounts.reduce((s, a) => s + a.stockValueEUR, 0).toFixed(2),
      totalUnrealizedPnlEUR: totalUnrealEUR,
      totalRealizedPnlEUR:   totalRealEUR,
      totalPnlEUR:           +(totalUnrealEUR + totalRealEUR).toFixed(2),
      totalYtdPnlEUR:        totalYtdPnl,
      totalMtdPnlEUR:        totalMtdPnl,
      totalCommissions:      +accounts.reduce((s, a) => s + a.commissions, 0).toFixed(2),
      totalDividends:        +accounts.reduce((s, a) => s + a.dividends, 0).toFixed(2),
      totalBrokerInterest:   +accounts.reduce((s, a) => s + a.brokerInterest, 0).toFixed(2),
      totalYtdGainEUR:       +accounts.reduce((s, a) => s + (a.ytdGainEUR || 0), 0).toFixed(2),
      avgYtdReturnPct:       +(accounts.reduce((s, a) => s + (a.ytdReturn || 0), 0) / accounts.length).toFixed(2),
      positionCount:         combinedPositions.length,
      positions:             combinedPositions,
    },
  };
}

// ─── Tool executor ────────────────────────────────────────────────
async function executeTool(name, input) {
  switch (name) {

    case "get_portfolio": {
      return buildPortfolio(input?.refresh || false);
    }

    case "get_trades": {
      const all   = await getStatements();
      const stmts = latestPerAccount(all);
      const trades = stmts.flatMap(s =>
        toArr(s?.Trades?.Trade).map(t => ({
          accountId:   s.accountId,
          symbol:      t.symbol,
          description: t.description,
          dateTime:    t.dateTime,
          side:        t.buySell,
          quantity:    n(t.quantity),
          price:       n(t.tradePrice),
          currency:    t.currency,
          proceeds:    n(t.proceeds),
          commission:  n(t.ibCommission),
          realizedPnl: n(t.fifoPnlRealized),
          exchange:    t.exchange,
        }))
      );
      const filtered = input?.symbol
        ? trades.filter(t => t.symbol?.toUpperCase() === input.symbol.toUpperCase())
        : trades;
      // Sort by date descending
      filtered.sort((a, b) => (b.dateTime || "").localeCompare(a.dateTime || ""));
      return { count: filtered.length, trades: filtered.slice(0, 100) };
    }

    case "get_pnl": {
      const portfolio = await buildPortfolio();
      const { combined, accounts } = portfolio;
      const sorted = [...combined.positions].sort((a, b) => b.totalUnrealEUR - a.totalUnrealEUR);
      return {
        combined: {
          totalUnrealizedPnlEUR: combined.totalUnrealizedPnlEUR,
          totalCommissions:      combined.totalCommissions,
          totalDividends:        combined.totalDividends,
          bestPositions:  sorted.slice(0, 5).map(p => ({ symbol: p.symbol, unrealizedPnlEUR: p.totalUnrealEUR, allocationPct: +p.allocationPct.toFixed(2) })),
          worstPositions: sorted.slice(-5).reverse().map(p => ({ symbol: p.symbol, unrealizedPnlEUR: p.totalUnrealEUR, allocationPct: +p.allocationPct.toFixed(2) })),
        },
        perAccount: accounts.map(a => ({
          accountId:    a.accountId,
          baseCurrency: a.baseCurrency,
          unrealizedPnl: a.positions.reduce((s, p) => s + p.unrealizedPnl, 0).toFixed(2),
          commissions:  a.commissions.toFixed(2),
          dividends:    a.dividends.toFixed(2),
          brokerInterest: a.brokerInterest.toFixed(2),
        })),
      };
    }

    case "get_allocation": {
      const portfolio = await buildPortfolio();
      return {
        totalNLV_EUR: portfolio.combined.totalNetLiquidation,
        allocations: portfolio.combined.positions.map(p => ({
          symbol:       p.symbol,
          description:  p.description,
          valueEUR:     p.totalValueEUR,
          allocationPct: +p.allocationPct.toFixed(2),
          unrealizedPnlEUR: p.totalUnrealEUR,
          returnPct:    +p.returnPct.toFixed(2),
          legs:         p.legs,
        })),
      };
    }

    case "refresh_data": {
      _cache = null;
      const portfolio = await buildPortfolio(true);
      return { ok: true, message: "Data refreshed from IBKR", accounts: portfolio.accounts.map(a => a.accountId) };
    }

    case "get_market_data": {
      // Yahoo Finance v8 quote endpoint — works for any global symbol
      const sym = input.symbol.toUpperCase();
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
        { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
      );
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) return { error: `No data found for ${sym}` };
      return {
        symbol:           meta.symbol,
        shortName:        meta.shortName,
        currency:         meta.currency,
        exchange:         meta.exchangeName,
        regularMarketPrice:     meta.regularMarketPrice,
        previousClose:          meta.chartPreviousClose,
        change:                 +(meta.regularMarketPrice - meta.chartPreviousClose).toFixed(4),
        changePct:              +(((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100).toFixed(2),
        regularMarketDayHigh:   meta.regularMarketDayHigh,
        regularMarketDayLow:    meta.regularMarketDayLow,
        regularMarketVolume:    meta.regularMarketVolume,
        fiftyTwoWeekHigh:       meta.fiftyTwoWeekHigh,
        fiftyTwoWeekLow:        meta.fiftyTwoWeekLow,
        marketCap:              meta.marketCap,
        timezone:               meta.timezone,
      };
    }

    case "get_historical_data": {
      // OHLCV history for any symbol — used for charting
      const sym      = input.symbol.toUpperCase();
      const range    = input.range    || "1y";   // 1d,5d,1mo,3mo,6mo,1y,2y,5y,10y,ytd,max
      const interval = input.interval || "1d";   // 1m,2m,5m,15m,30m,60m,90m,1h,1d,5d,1wk,1mo,3mo
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`,
        { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
      );
      const data   = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) return { error: `No historical data for ${sym}` };
      const { timestamp, indicators } = result;
      const q = indicators?.quote?.[0] || {};
      const bars = (timestamp || []).map((t, i) => ({
        date:   new Date(t * 1000).toISOString().slice(0, 10),
        open:   q.open?.[i]   ? +q.open[i].toFixed(4)   : null,
        high:   q.high?.[i]   ? +q.high[i].toFixed(4)   : null,
        low:    q.low?.[i]    ? +q.low[i].toFixed(4)     : null,
        close:  q.close?.[i]  ? +q.close[i].toFixed(4)  : null,
        volume: q.volume?.[i] || null,
      })).filter(b => b.close !== null);
      return {
        symbol:   sym,
        currency: result.meta?.currency,
        range,
        interval,
        count:    bars.length,
        bars,
      };
    }

    case "get_multiple_quotes": {
      // Batch quotes for multiple symbols
      const symbols = (input.symbols || []).map(s => s.toUpperCase()).join(",");
      const res = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`,
        { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
      );
      const data = await res.json();
      const quotes = data?.quoteResponse?.result || [];
      return quotes.map(q => ({
        symbol:       q.symbol,
        shortName:    q.shortName,
        currency:     q.currency,
        price:        q.regularMarketPrice,
        change:       +((q.regularMarketPrice - q.regularMarketPreviousClose) || 0).toFixed(4),
        changePct:    q.regularMarketChangePercent ? +q.regularMarketChangePercent.toFixed(2) : 0,
        dayHigh:      q.regularMarketDayHigh,
        dayLow:       q.regularMarketDayLow,
        volume:       q.regularMarketVolume,
        marketCap:    q.marketCap,
        pe:           q.trailingPE,
        week52High:   q.fiftyTwoWeekHigh,
        week52Low:    q.fiftyTwoWeekLow,
      }));
    }

    case "search_symbol": {
      // Search for a ticker symbol by name
      const res = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(input.query)}&quotesCount=10&newsCount=0`,
        { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
      );
      const data = await res.json();
      return (data?.quotes || []).map(q => ({
        symbol:   q.symbol,
        shortName: q.shortname,
        longName:  q.longname,
        exchange:  q.exchange,
        type:      q.quoteType,
      }));
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── Claude agent ─────────────────────────────────────────────────
const TOOLS = [
  {
    name: "get_portfolio",
    description: "Get complete portfolio across BOTH accounts (U11354150 EUR + U9733561 GBP). Returns per-account breakdown AND combined positions with correct EUR-converted values and true allocation percentages.",
    input_schema: { type: "object", properties: { refresh: { type: "boolean", description: "Force fresh data from IBKR" } }, required: [] },
  },
  {
    name: "get_trades",
    description: "Get trade history across both accounts. Optionally filter by symbol.",
    input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: [] },
  },
  {
    name: "get_pnl",
    description: "Get P&L summary across both accounts: unrealized P&L in EUR, best/worst positions, commissions, dividends.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_allocation",
    description: "Get true portfolio allocation by symbol across both accounts, all values converted to EUR with correct percentages of total portfolio.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "refresh_data",
    description: "Force fresh data pull from IBKR.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_market_data",
    description: "Get real-time quote for any stock or ETF worldwide (price, change, 52w high/low, volume, market cap). Works for any Yahoo Finance symbol e.g. AAPL, CSPX.L, CSSX5E.SW, BTC-USD.",
    input_schema: { type: "object", properties: { symbol: { type: "string", description: "Yahoo Finance ticker e.g. AAPL, CSPX.L, ^GSPC" } }, required: ["symbol"] },
  },
  {
    name: "get_historical_data",
    description: "Get OHLCV price history for any symbol for charting. Use range: 1d,5d,1mo,3mo,6mo,1y,2y,5y,ytd,max. Use interval: 1m,5m,1h,1d,1wk,1mo.",
    input_schema: {
      type: "object",
      properties: {
        symbol:   { type: "string" },
        range:    { type: "string", description: "Time range: 1d,5d,1mo,3mo,6mo,1y,2y,5y,ytd,max. Default: 1y" },
        interval: { type: "string", description: "Bar interval: 1m,5m,15m,1h,1d,1wk,1mo. Default: 1d" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "get_multiple_quotes",
    description: "Get live quotes for multiple symbols at once. Good for comparing portfolio holdings.",
    input_schema: {
      type: "object",
      properties: { symbols: { type: "array", items: { type: "string" }, description: "Array of Yahoo Finance tickers" } },
      required: ["symbols"],
    },
  },
  {
    name: "search_symbol",
    description: "Search for a ticker symbol by company or ETF name.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

const SYSTEM = `You are a professional finance AI agent managing TWO Interactive Brokers accounts:
- U11354150: EUR-denominated account (main)
- U9733561: GBP-denominated account (ISA/secondary)

Data is read-only via IBKR Flex Web Service. All combined figures are converted to EUR.

Portfolio holdings: CSNDX (Nasdaq 100 USD), CSPX (S&P 500 USD), CSSX5E (Euro Stoxx 50 EUR), IEEM (MSCI EM USD), IUSE (S&P 500 EUR-hedged), NQSE (Nasdaq 100 EUR-hedged), SPCX (SpaceX), VUAG (Vanguard S&P500 GBP), VWRL (Vanguard All-World GBP), VFEM (Vanguard EM GBP).

Yahoo Finance symbol mapping for your holdings:
CSPX → CSPX.L, CSNDX → IUSA.L (or use CNDX.SW), CSSX5E → CSSX5E.SW, IEEM → IEEM.L, IUSE → IUSE.L, NQSE → NQSE.DE, VUAG → VUAG.L, VWRL → VWRL.L, VFEM → VFEM.L, SPCX → use RKLB or SpaceX is private.

You can fetch market data and charts for ANY stock or ETF worldwide. When asked to show a chart, use get_historical_data and tell the user a chart will be displayed in the app. For portfolio-wide quotes use get_multiple_quotes with all holding symbols.

When showing allocations, ALWAYS use the combined portfolio percentages from get_allocation or get_portfolio combined.positions, NOT per-account percentOfNAV.

Unrealized P&L comes from MTM Performance Summary (priorOpenMtm field, in base EUR). 1-year return comes from ChangeInNAV twr field (time-weighted return over last 365 days, NOT calendar YTD). Always label it as "1Y Return" not "YTD". Always show these when available.

Format: EUR amounts with € sign, GBP with £, USD with $. 2 decimal places. Today: ${new Date().toDateString()}.`;

async function runAgent(prompt, history = []) {
  const messages = [...history, { role: "user", content: prompt }];
  let response = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 2000, system: SYSTEM, tools: TOOLS, messages });
  let loop = [...messages], i = 0;
  while (response.stop_reason === "tool_use" && i++ < 10) {
    loop.push({ role: "assistant", content: response.content });
    const results = await Promise.all(
      response.content.filter(b => b.type === "tool_use").map(async b => {
        let result;
        try { result = await executeTool(b.name, b.input); } catch (e) { result = { error: e.message }; }
        return { type: "tool_result", tool_use_id: b.id, content: JSON.stringify(result) };
      })
    );
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
  {
    id: "morning", label: "Morning briefing", icon: "🌅",
    // 8:30am London BST (UTC+1) = 7:30 UTC. Use UTC to avoid Railway timezone issues.
    cron: "30 7 * * 1-5",
    cronDisplay: "8:30 AM London",
    prompt: "Morning briefing across both accounts: get portfolio then get allocation. Show: combined NLV in EUR, top 5 positions by allocation %, combined unrealized P&L. Format clearly with sections.",
  },
  {
    id: "midday", label: "Midday check", icon: "☀️",
    // 12:00pm London BST = 11:00 UTC
    cron: "0 11 * * 1-5",
    cronDisplay: "12:00 PM London",
    prompt: "Midday check: get portfolio. Show combined NLV, unrealized P&L across both accounts, any notable moves. Keep under 150 words.",
  },
  {
    id: "eod", label: "End-of-day summary", icon: "🌆",
    // 5:00pm London BST = 16:00 UTC
    cron: "0 16 * * 1-5",
    cronDisplay: "5:00 PM London",
    prompt: "End of day: get portfolio and trades. Show combined NLV, unrealized P&L, trades executed today, biggest movers. Format as a daily report.",
  },
  {
    id: "weekly", label: "Weekly review", icon: "⚖️",
    // Friday 4:30pm London BST = 15:30 UTC
    cron: "30 15 * * 5",
    cronDisplay: "4:30 PM London (Fri)",
    prompt: "Weekly review: get portfolio, allocation, P&L, and trades. Show combined NLV, full allocation % breakdown, unrealized P&L, trades this week, commissions paid, any concentration risk.",
  },
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

// ─── API Routes ───────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  try { res.json({ reply: await runAgent(message, history) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/account", async (req, res) => {
  try { res.json(await buildPortfolio()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/tasks", (req, res) => res.json(TASKS.map(t => ({ ...t, ...taskState[t.id] }))));

app.patch("/api/tasks/:id", (req, res) => {
  if (!taskState[req.params.id]) return res.status(404).json({ error: "Not found" });
  taskState[req.params.id].enabled = req.body.enabled;
  res.json({ ok: true });
});

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
  } catch (e) {
    taskState[task.id].running = false;
    taskLog[0] = { task: task.label, status: "error", time: new Date().toISOString(), result: e.message };
  }
});

app.get("/api/log", (req, res) => res.json(taskLog.slice(0, 50)));

// Market data endpoints — used by frontend charts directly
app.get("/api/chart/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { range = "1y", interval = "1d" } = req.query;
    const data = await executeTool("get_historical_data", { symbol, range, interval });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/quote/:symbol", async (req, res) => {
  try {
    const data = await executeTool("get_market_data", { symbol: req.params.symbol });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/quotes", async (req, res) => {
  try {
    const symbols = (req.query.symbols || "").split(",").filter(Boolean);
    const data = await executeTool("get_multiple_quotes", { symbols });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/push/vapid-key", (req, res) => res.json({ publicKey: VAPID_PUBLIC }));
app.post("/api/push/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: "Invalid" });
  const id = Buffer.from(sub.endpoint).toString("base64").slice(0, 32);
  pushSubs.set(id, sub);
  res.json({ ok: true });
});
app.post("/api/push/unsubscribe", (req, res) => {
  const id = Buffer.from(req.body.endpoint || "").toString("base64").slice(0, 32);
  pushSubs.delete(id);
  res.json({ ok: true });
});
app.post("/api/push/test", async (req, res) => {
  await sendPush("✅ Test", "Push notifications working!", "✅");
  res.json({ ok: true, subscribers: pushSubs.size });
});

app.get("/api/ibkr/status", async (req, res) => {
  try {
    const portfolio = await buildPortfolio();
    res.json({
      authenticated: true,
      mode: "flex_web_service",
      accounts: portfolio.accounts.map(a => ({ id: a.accountId, currency: a.baseCurrency, nlv: a.netLiquidation })),
      combinedNLV_EUR: portfolio.combined.totalNetLiquidation,
    });
  } catch (e) {
    res.status(503).json({ authenticated: false, error: e.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString(), pushSubscribers: pushSubs.size }));

// Debug: show raw XML field names for first position and first FIFO row
app.get("/api/debug/fields", async (req, res) => {
  try {
    const all   = await getStatements();
    const stmts = latestPerAccount(all);
    const s     = stmts[0];
    const pos   = toArr(s?.OpenPositions?.OpenPosition)[0] || {};
    const fifo  = toArr(s?.FIFOPerformanceSummaryInBase?.FIFOPerformanceSummaryUnderlying)[0] || {};
    const mtd   = toArr(s?.MTDYTDPerformanceSummary?.MTDYTDPerformanceSummaryUnderlying)[0] || {};
    const nav   = s?.ChangeInNAV || {};
    const mtm   = toArr(s?.MTMPerformanceSummaryInBase?.MTMPerformanceSummaryUnderlying)[0] || {};
    // Show all top-level section keys available
    const allSections = Object.keys(s || {});
    res.json({
      allSections,
      openPositionFields:  Object.keys(pos),
      openPositionSample:  pos,
      fifoFields:          Object.keys(fifo),
      fifoSample:          fifo,
      mtdFields:           Object.keys(mtd),
      mtdSample:           mtd,
      changeInNAV:         nav,
      mtmFields:           Object.keys(mtm),
      mtmSample:           mtm,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 IBKR Agent on port ${PORT}`));
