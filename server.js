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

// ─── Config ──────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY  || "";
const FLEX_TOKEN    = process.env.IBKR_FLEX_TOKEN    || "";
const FLEX_QUERY_ID = process.env.IBKR_FLEX_QUERY_ID || "";
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY   || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY  || "";
const VAPID_EMAIL   = process.env.VAPID_EMAIL        || "mailto:you@example.com";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const parser    = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  console.log("✅ Push configured");
}

// ─── Flex Web Service ─────────────────────────────────────────────
const FLEX_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";

async function fetchFlex() {
  if (!FLEX_TOKEN || !FLEX_QUERY_ID) throw new Error("IBKR_FLEX_TOKEN or IBKR_FLEX_QUERY_ID not set");

  // Step 1: request
  const sendRes  = await fetch(`${FLEX_BASE}/SendRequest?t=${FLEX_TOKEN}&q=${FLEX_QUERY_ID}&v=3`, { headers: { "User-Agent": "Node/18" } });
  const sendXml  = await sendRes.text();
  const sendData = parser.parse(sendXml);
  const status   = sendData?.FlexStatementResponse?.Status;
  const refCode  = sendData?.FlexStatementResponse?.ReferenceCode;
  const url      = sendData?.FlexStatementResponse?.Url;
  if (status !== "Success") throw new Error(`Flex request failed: ${JSON.stringify(sendData)}`);

  // Step 2: retrieve (retry)
  await new Promise(r => setTimeout(r, 3000));
  for (let i = 0; i < 6; i++) {
    const getRes  = await fetch(`${url}?t=${FLEX_TOKEN}&q=${refCode}&v=3`, { headers: { "User-Agent": "Node/18" } });
    const getXml  = await getRes.text();
    const getData = parser.parse(getXml);
    const stmts   = getData?.FlexQueryResponse?.FlexStatements?.FlexStatement
                 ?? getData?.FlexStatementResponse?.FlexStatements?.FlexStatement;
    if (stmts) return Array.isArray(stmts) ? stmts[0] : stmts;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("Could not retrieve Flex report after retries");
}

// Cache 15 min
let flexCache = null, flexCacheTime = 0;
async function getFlexData(force = false) {
  if (!force && flexCache && Date.now() - flexCacheTime < 15 * 60 * 1000) return flexCache;
  flexCache     = await fetchFlex();
  flexCacheTime = Date.now();
  return flexCache;
}

// ─── Helpers ──────────────────────────────────────────────────────
function toArr(v) { return Array.isArray(v) ? v : v ? [v] : []; }
function fmt(v)   { return parseFloat(v || 0).toFixed(2); }

// ─── Tool executor ────────────────────────────────────────────────
async function executeTool(name, input) {
  switch (name) {

    case "get_account_summary": {
      const d = await getFlexData(input?.refresh);

      // Positions from FIFOPerformanceSummaryInBase (excludes the "Total" row)
      const perf = toArr(d?.FIFOPerformanceSummaryInBase?.FIFOPerformanceSummaryUnderlying)
        .filter(p => p.symbol && p.symbol !== "");

      // Cash from CashReport — base currency summary
      const cashRows  = toArr(d?.CashReport?.CashReportCurrency);
      const baseCash  = cashRows.find(c => c.currency === "BASE_SUMMARY") || cashRows[0] || {};

      const totalUnrealized = perf.reduce((s, p) => s + parseFloat(p.totalUnrealizedPnl || 0), 0);
      const totalRealized   = perf.reduce((s, p) => s + parseFloat(p.totalRealizedPnl   || 0), 0);

      return {
        accountId:       d?.accountId,
        fromDate:        d?.fromDate,
        toDate:          d?.toDate,
        endingCash:      fmt(baseCash.endingCash),
        endingSettledCash: fmt(baseCash.endingSettledCash),
        totalUnrealizedPnl: fmt(totalUnrealized),
        totalRealizedPnl:   fmt(totalRealized),
        totalPnl:        fmt(totalUnrealized + totalRealized),
        positionCount:   perf.length,
        positions: perf.map(p => ({
          symbol:          p.symbol,
          description:     p.description,
          assetCategory:   p.assetCategory,
          subCategory:     p.subCategory,
          exchange:        p.listingExchange,
          realizedPnl:     fmt(p.totalRealizedPnl),
          unrealizedPnl:   fmt(p.totalUnrealizedPnl),
          totalPnl:        fmt(p.totalFifoPnl),
        })),
      };
    }

    case "get_trades": {
      const d      = await getFlexData();
      const trades = toArr(d?.Trades?.Trade);
      const filtered = input?.symbol
        ? trades.filter(t => t.symbol?.toUpperCase() === input.symbol.toUpperCase())
        : trades;
      return {
        count: filtered.length,
        trades: filtered.slice(0, 100).map(t => ({
          symbol:      t.symbol,
          description: t.description,
          dateTime:    t.dateTime,
          side:        t.buySell,
          quantity:    t.quantity,
          price:       t.tradePrice,
          currency:    t.currency,
          proceeds:    fmt(t.proceeds),
          commission:  fmt(t.ibCommission),
          realizedPnl: fmt(t.fifoPnlRealized),
        })),
      };
    }

    case "get_cash": {
      const d       = await getFlexData();
      const rows    = toArr(d?.CashReport?.CashReportCurrency);
      return {
        currencies: rows.map(c => ({
          currency:          c.currency,
          endingCash:        fmt(c.endingCash),
          endingSettledCash: fmt(c.endingSettledCash),
          commissions:       fmt(c.commissions),
          deposits:          fmt(c.deposits),
          withdrawals:       fmt(c.withdrawals),
          dividends:         fmt(c.dividends),
          brokerInterest:    fmt(c.brokerInterest),
        })),
      };
    }

    case "get_pnl_summary": {
      const d    = await getFlexData();
      const perf = toArr(d?.FIFOPerformanceSummaryInBase?.FIFOPerformanceSummaryUnderlying)
        .filter(p => p.symbol);

      const totalRow = toArr(d?.FIFOPerformanceSummaryInBase?.FIFOPerformanceSummaryUnderlying)
        .find(p => p.description === "Total (All Assets)");

      const cashRows = toArr(d?.CashReport?.CashReportCurrency);
      const base     = cashRows.find(c => c.currency === "BASE_SUMMARY") || {};

      // Best and worst positions
      const sorted = [...perf].sort((a, b) => parseFloat(b.totalFifoPnl) - parseFloat(a.totalFifoPnl));

      return {
        totalRealizedPnl:   fmt(totalRow?.totalRealizedPnl),
        totalUnrealizedPnl: fmt(totalRow?.totalUnrealizedPnl),
        totalFifoPnl:       fmt(totalRow?.totalFifoPnl),
        commissions:        fmt(base.commissions),
        dividends:          fmt(base.dividends),
        brokerInterest:     fmt(base.brokerInterest),
        bestPositions:  sorted.slice(0, 3).map(p => ({ symbol: p.symbol, totalPnl: fmt(p.totalFifoPnl) })),
        worstPositions: sorted.slice(-3).reverse().map(p => ({ symbol: p.symbol, totalPnl: fmt(p.totalFifoPnl) })),
      };
    }

    case "refresh_data": {
      flexCache = null;
      const d = await getFlexData(true);
      return { ok: true, message: "Refreshed from IBKR", accountId: d?.accountId };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── Claude agent ─────────────────────────────────────────────────
const TOOLS = [
  { name: "get_account_summary", description: "Get full IBKR account: all positions with realized/unrealized P&L, cash balance.", input_schema: { type: "object", properties: { refresh: { type: "boolean" } }, required: [] } },
  { name: "get_trades",          description: "Get trade history, optionally filtered by symbol.", input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: [] } },
  { name: "get_cash",            description: "Get cash balances by currency including commissions, deposits, dividends.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_pnl_summary",     description: "Get P&L summary: realized, unrealized, best/worst positions, commissions.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "refresh_data",        description: "Force a fresh data pull from IBKR.", input_schema: { type: "object", properties: {}, required: [] } },
];

const SYSTEM = `You are a professional finance AI agent with read access to an Interactive Brokers (IBKR) account.

The portfolio contains ETFs and stocks. Data comes from IBKR's Flex Web Service (read-only — no order placement).

You can:
- Show all positions with P&L
- Analyse trade history
- Check cash balances, commissions, dividends
- Summarise realized and unrealized P&L
- Identify best/worst performers
- Analyse portfolio concentration

Be concise and data-driven. Format numbers with currency symbols. Today is ${new Date().toDateString()}.`;

async function runAgent(prompt, history = []) {
  const messages = [...history, { role: "user", content: prompt }];
  let response = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 1500, system: SYSTEM, tools: TOOLS, messages });
  let loop = [...messages];
  let i = 0;
  while (response.stop_reason === "tool_use" && i++ < 8) {
    loop.push({ role: "assistant", content: response.content });
    const results = await Promise.all(
      response.content.filter(b => b.type === "tool_use").map(async b => {
        let result;
        try { result = await executeTool(b.name, b.input); } catch (e) { result = { error: e.message }; }
        return { type: "tool_result", tool_use_id: b.id, content: JSON.stringify(result) };
      })
    );
    loop.push({ role: "user", content: results });
    response = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 1500, system: SYSTEM, tools: TOOLS, messages: loop });
  }
  return response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

// ─── Push ─────────────────────────────────────────────────────────
const pushSubs = new Map();
async function sendPush(title, body, icon = "📈", data = {}) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !pushSubs.size) return;
  const payload = JSON.stringify({ title, body, icon, data, timestamp: Date.now() });
  const expired = [];
  for (const [id, sub] of pushSubs.entries()) {
    try { await webpush.sendNotification(sub, payload); }
    catch (e) { if (e.statusCode === 410 || e.statusCode === 404) expired.push(id); }
  }
  expired.forEach(id => pushSubs.delete(id));
}

// ─── Scheduled tasks ──────────────────────────────────────────────
const TASKS = [
  { id: "morning",   label: "Morning briefing",   icon: "🌅", cron: "30 8 * * 1-5",  prompt: "Get account summary and P&L summary. Give a morning briefing: total P&L, top 3 positions, any position down more than 5%. Keep it short." },
  { id: "midday",    label: "Midday check",        icon: "☀️", cron: "0 12 * * 1-5",  prompt: "Quick midday check: get P&L summary. Any notable P&L changes? 3 sentences max." },
  { id: "eod",       label: "End-of-day summary",  icon: "🌆", cron: "30 16 * * 1-5", prompt: "End of day: get account summary, trades today, and P&L. List today's trades and overall portfolio P&L." },
  { id: "weekly",    label: "Weekly review",       icon: "⚖️", cron: "0 15 * * 5",    prompt: "Weekly review: get account summary, P&L summary, and all trades. Summarise the week: total P&L, best/worst positions, trades made, commissions paid." },
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

// ─── Routes ───────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  try { res.json({ reply: await runAgent(message, history) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/account", async (req, res) => {
  try { res.json(await executeTool("get_account_summary", {})); }
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
  res.json({ ok: true });
});

app.get("/api/ibkr/status", async (req, res) => {
  try {
    const d = await getFlexData();
    res.json({ authenticated: true, mode: "flex_web_service", accountId: d?.accountId });
  } catch (e) {
    res.status(503).json({ authenticated: false, error: e.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString(), pushSubscribers: pushSubs.size }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 IBKR Agent on port ${PORT}`));
