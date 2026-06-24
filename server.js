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
  const accounts = stmts.map(stmt => {
    const info      = stmt?.AccountInformation || {};
    const fxRates   = getFxRates(stmt);
    const equityRows = toArr(stmt?.EquitySummaryInBase?.EquitySummaryByReportDateInBase);
    const equity    = equityRows[equityRows.length - 1] || {};
    const positions = toArr(stmt?.OpenPositions?.OpenPosition)
      .filter(p => p.levelOfDetail === "SUMMARY" || !p.levelOfDetail);

    // P&L by symbol from Realized & Unrealized Performance Summary
    const pnlBySymbol = {};
    toArr(stmt?.FIFOPerformanceSummaryInBase?.FIFOPerformanceSummaryUnderlying)
      .filter(p => p.symbol).forEach(p => { pnlBySymbol[p.symbol] = p; });

    // YTD by symbol from MTD/YTD Performance Summary
    const ytdBySymbol = {};
    toArr(stmt?.MTDYTDPerformanceSummary?.MTDYTDPerformanceSummaryUnderlying)
      .filter(p => p.symbol).forEach(p => { ytdBySymbol[p.symbol] = p; });

    const cashRows  = toArr(stmt?.CashReport?.CashReportCurrency);
    const baseCash  = cashRows.find(c => c.currency === "BASE_SUMMARY") || cashRows[0] || {};

    return {
      accountId:    stmt.accountId,
      accountName:  info.name || "",
      baseCurrency: info.currency || "EUR",
      // Balances (in account base currency, already converted by IBKR)
      netLiquidation: n(equity.total),
      cash:           n(equity.cash),
      stockValue:     n(equity.stock),
      dividendAccruals: n(equity.dividendAccruals),
      // Cash report
      commissions:  n(baseCash.commissions),
      deposits:     n(baseCash.deposits),
      withdrawals:  n(baseCash.withdrawals),
      dividends:    n(baseCash.dividends),
      brokerInterest: n(baseCash.brokerInterest),
      // Positions
      positions: positions.map(p => {
        const fxRate    = n(p.fxRateToBase) || fxRates[p.currency] || 1;
        const pnl       = pnlBySymbol[p.symbol] || {};
        const ytd       = ytdBySymbol[p.symbol] || {};
        const valueEUR  = n(p.positionValue) * fxRate;
        // Use P&L from performance summary (more reliable than OpenPositions)
        const unrealRaw = n(pnl.totalUnrealizedPnl) || n(p.fifoPnlUnrealized);
        const unrealEUR = unrealRaw * fxRate;
        const realRaw   = n(pnl.totalRealizedPnl);
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
  const totalNLV = accounts.reduce((s, a) => s + a.netLiquidation, 0);

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
      totalCash:             +accounts.reduce((s, a) => s + a.cash, 0).toFixed(2),
      totalStockValue:       +accounts.reduce((s, a) => s + a.stockValue, 0).toFixed(2),
      totalUnrealizedPnlEUR: totalUnrealEUR,
      totalRealizedPnlEUR:   totalRealEUR,
      totalPnlEUR:           +(totalUnrealEUR + totalRealEUR).toFixed(2),
      totalYtdPnlEUR:        totalYtdPnl,
      totalMtdPnlEUR:        totalMtdPnl,
      totalCommissions:      +accounts.reduce((s, a) => s + a.commissions, 0).toFixed(2),
      totalDividends:        +accounts.reduce((s, a) => s + a.dividends, 0).toFixed(2),
      totalBrokerInterest:   +accounts.reduce((s, a) => s + a.brokerInterest, 0).toFixed(2),
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
];

const SYSTEM = `You are a professional finance AI agent managing TWO Interactive Brokers accounts:
- U11354150: EUR-denominated account (main)
- U9733561: GBP-denominated account (ISA/secondary)

Data is read-only via IBKR Flex Web Service. All combined figures are converted to EUR.

Portfolio holdings: CSNDX (Nasdaq 100 USD), CSPX (S&P 500 USD), CSSX5E (Euro Stoxx 50 EUR), IEEM (MSCI EM USD), IUSE (S&P 500 EUR-hedged), NQSE (Nasdaq 100 EUR-hedged), SPCX (SpaceX), VUAG (Vanguard S&P500 GBP), VWRL (Vanguard All-World GBP), VFEM (Vanguard EM GBP).

When showing allocations, ALWAYS use the combined portfolio percentages from get_allocation or get_portfolio combined.positions, NOT per-account percentOfNAV.

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
    cron: "30 8 * * 1-5",
    prompt: "Morning briefing across both accounts: get portfolio. Show combined NLV in EUR, combined unrealized P&L, top 5 positions by allocation %, any position with unrealized loss > €500. Keep it concise.",
  },
  {
    id: "midday", label: "Midday check", icon: "☀️",
    cron: "0 12 * * 1-5",
    prompt: "Quick midday check: get P&L. Show combined unrealized P&L in EUR, best and worst performer today. 3 sentences.",
  },
  {
    id: "eod", label: "End-of-day summary", icon: "🌆",
    cron: "30 16 * * 1-5",
    prompt: "End of day report: get portfolio and trades. Show combined NLV, unrealized P&L, any trades executed today across both accounts, top movers.",
  },
  {
    id: "weekly", label: "Weekly review", icon: "⚖️",
    cron: "0 15 * * 5",
    prompt: "Weekly review: get portfolio, allocation, P&L, and trades. Show combined NLV, full allocation breakdown by symbol with %, total unrealized P&L, trades this week, commissions paid, and any concentration risk (any single position > 30%).",
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
      taskLog[0] = { task: task.label, status: "done", time: taskState[task.id].lastRun, result: result.slice(0, 300) };
      await sendPush(`${task.icon} ${task.label} done`, result.slice(0, 140), task.icon);
    } catch (e) {
      taskState[task.id].running = false;
      taskLog[0] = { task: task.label, status: "error", time: new Date().toISOString(), result: e.message };
      await sendPush(`❌ ${task.label} failed`, e.message.slice(0, 120), "❌");
    }
  }, { timezone: "America/New_York" });
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
    taskLog[0] = { task: task.label, status: "done", time: taskState[task.id].lastRun, result: result.slice(0, 300) };
    await sendPush(`${task.icon} ${task.label} done`, result.slice(0, 140), task.icon);
  } catch (e) {
    taskState[task.id].running = false;
    taskLog[0] = { task: task.label, status: "error", time: new Date().toISOString(), result: e.message };
  }
});

app.get("/api/log", (req, res) => res.json(taskLog.slice(0, 50)));

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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 IBKR Agent on port ${PORT}`));
