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
const ANTHROPIC_KEY     = process.env.ANTHROPIC_API_KEY   || "";
const FLEX_TOKEN        = process.env.IBKR_FLEX_TOKEN     || "";
const FLEX_QUERY_ID     = process.env.IBKR_FLEX_QUERY_ID  || "";
const VAPID_PUBLIC      = process.env.VAPID_PUBLIC_KEY    || "";
const VAPID_PRIVATE     = process.env.VAPID_PRIVATE_KEY   || "";
const VAPID_EMAIL       = process.env.VAPID_EMAIL         || "mailto:you@example.com";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const parser    = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  console.log("✅ Push notifications configured");
}

// ─── IBKR Flex Web Service ────────────────────────────────────────
const FLEX_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";

async function fetchFlex() {
  if (!FLEX_TOKEN || !FLEX_QUERY_ID) throw new Error("IBKR_FLEX_TOKEN or IBKR_FLEX_QUERY_ID not set");

  // Step 1: request the report
  const sendRes = await fetch(`${FLEX_BASE}/SendRequest?t=${FLEX_TOKEN}&q=${FLEX_QUERY_ID}&v=3`, {
    headers: { "User-Agent": "Node/18" }
  });
  const sendXml = await sendRes.text();
  const sendData = parser.parse(sendXml);
  const status = sendData?.FlexStatementResponse?.Status;
  const refCode = sendData?.FlexStatementResponse?.ReferenceCode;
  const url     = sendData?.FlexStatementResponse?.Url;

  if (status !== "Success") throw new Error(`Flex request failed: ${JSON.stringify(sendData)}`);

  // Step 2: retrieve the report (retry a few times — IBKR needs a moment)
  await new Promise(r => setTimeout(r, 3000));
  for (let i = 0; i < 5; i++) {
    const getRes = await fetch(`${url}?t=${FLEX_TOKEN}&q=${refCode}&v=3`, {
      headers: { "User-Agent": "Node/18" }
    });
    const getXml = await getRes.text();
    const getData = parser.parse(getXml);
    if (getData?.FlexStatementResponse?.FlexStatements) return getData.FlexStatementResponse.FlexStatements.FlexStatement;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("Could not retrieve Flex report after retries");
}

// Cache the flex data so we don't hammer IBKR
let flexCache = null;
let flexCacheTime = 0;

async function getFlexData(forceRefresh = false) {
  const age = Date.now() - flexCacheTime;
  if (!forceRefresh && flexCache && age < 15 * 60 * 1000) return flexCache; // 15 min cache
  flexCache = await fetchFlex();
  flexCacheTime = Date.now();
  return flexCache;
}

// ─── Tool executor ────────────────────────────────────────────────
async function executeTool(name, input) {
  switch (name) {

    case "get_account_summary": {
      const data = await getFlexData(input.refresh);
      const stmt = data;
      const positions = Array.isArray(stmt?.OpenPositions?.OpenPosition)
        ? stmt.OpenPositions.OpenPosition
        : stmt?.OpenPositions?.OpenPosition ? [stmt.OpenPositions.OpenPosition] : [];

      const totalValue = positions.reduce((sum, p) => sum + parseFloat(p.positionValue || 0), 0);
      const totalPnl   = positions.reduce((sum, p) => sum + parseFloat(p.fifoPnlUnrealized || 0), 0);

      return {
        accountId: stmt?.accountId,
        currency: stmt?.currency,
        fromDate: stmt?.fromDate,
        toDate: stmt?.toDate,
        totalPositionValue: totalValue.toFixed(2),
        totalUnrealizedPnl: totalPnl.toFixed(2),
        positionCount: positions.length,
        positions: positions.map(p => ({
          symbol: p.symbol,
          description: p.description,
          assetCategory: p.assetCategory,
          quantity: p.position,
          costBasis: p.costBasisPrice,
          currentPrice: p.markPrice,
          positionValue: p.positionValue,
          unrealizedPnl: p.fifoPnlUnrealized,
          currency: p.currency,
        })),
      };
    }

    case "get_trades": {
      const data = await getFlexData();
      const trades = Array.isArray(data?.Trades?.Trade)
        ? data.Trades.Trade
        : data?.Trades?.Trade ? [data.Trades.Trade] : [];

      const filtered = input.symbol
        ? trades.filter(t => t.symbol?.toUpperCase() === input.symbol.toUpperCase())
        : trades;

      return {
        count: filtered.length,
        trades: filtered.slice(0, 50).map(t => ({
          symbol: t.symbol,
          dateTime: t.dateTime,
          side: t.buySell,
          quantity: t.quantity,
          price: t.tradePrice,
          proceeds: t.proceeds,
          commission: t.ibCommission,
          realizedPnl: t.fifoPnlRealized,
          currency: t.currency,
        })),
      };
    }

    case "get_cash": {
      const data = await getFlexData();
      const cash = Array.isArray(data?.CashReport?.CashReportCurrency)
        ? data.CashReport.CashReportCurrency
        : data?.CashReport?.CashReportCurrency ? [data.CashReport.CashReportCurrency] : [];
      return { cash: cash.map(c => ({ currency: c.currency, endingCash: c.endingCash, endingSettledCash: c.endingSettledCash })) };
    }

    case "get_pnl_summary": {
      const data = await getFlexData();
      const trades = Array.isArray(data?.Trades?.Trade) ? data.Trades.Trade : data?.Trades?.Trade ? [data.Trades.Trade] : [];
      const totalRealized   = trades.reduce((sum, t) => sum + parseFloat(t.fifoPnlRealized || 0), 0);
      const totalCommission = trades.reduce((sum, t) => sum + parseFloat(t.ibCommission || 0), 0);
      const positions = Array.isArray(data?.OpenPositions?.OpenPosition) ? data.OpenPositions.OpenPosition : data?.OpenPositions?.OpenPosition ? [data.OpenPositions.OpenPosition] : [];
      const totalUnrealized = positions.reduce((sum, p) => sum + parseFloat(p.fifoPnlUnrealized || 0), 0);
      return {
        realizedPnl: totalRealized.toFixed(2),
        unrealizedPnl: totalUnrealized.toFixed(2),
        totalPnl: (totalRealized + totalUnrealized).toFixed(2),
        commissions: totalCommission.toFixed(2),
        netPnl: (totalRealized + totalUnrealized + totalCommission).toFixed(2),
        tradeCount: trades.length,
      };
    }

    case "refresh_data": {
      flexCache = null;
      const data = await getFlexData(true);
      return { ok: true, message: "Data refreshed from IBKR", accountId: data?.accountId };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── Claude agent ─────────────────────────────────────────────────
const TOOLS = [
  {
    name: "get_account_summary",
    description: "Get full IBKR account summary: all open positions, market values, unrealized P&L, cost basis.",
    input_schema: { type: "object", properties: { refresh: { type: "boolean", description: "Force refresh from IBKR" } }, required: [] },
  },
  {
    name: "get_trades",
    description: "Get trade history. Optionally filter by symbol.",
    input_schema: { type: "object", properties: { symbol: { type: "string", description: "Filter by ticker symbol (optional)" } }, required: [] },
  },
  {
    name: "get_cash",
    description: "Get cash balances by currency.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_pnl_summary",
    description: "Get P&L summary: realized, unrealized, commissions, net P&L.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "refresh_data",
    description: "Force a fresh data pull from IBKR (use when data seems stale).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

const SYSTEM = `You are a professional finance AI agent with read access to an Interactive Brokers (IBKR) account via the Flex Web Service.

You can:
- View all open positions with market values and P&L
- Analyse trade history
- Check cash balances
- Summarise realized and unrealized P&L
- Identify top performers and losers
- Analyse portfolio composition and concentration

Note: This is a read-only connection (Flex Web Service). You cannot place orders through this interface — that requires the IBKR Gateway.

Be concise and data-driven. Format numbers with $ signs and 2 decimal places. Today is ${new Date().toDateString()}.`;

async function runAgent(userPrompt, history = []) {
  const messages = [...history, { role: "user", content: userPrompt }];
  let response = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 1500, system: SYSTEM, tools: TOOLS, messages });

  let loopMsgs = [...messages];
  let iterations = 0;
  while (response.stop_reason === "tool_use" && iterations < 8) {
    iterations++;
    loopMsgs.push({ role: "assistant", content: response.content });
    const toolResults = await Promise.all(
      response.content.filter(b => b.type === "tool_use").map(async b => {
        let result;
        try { result = await executeTool(b.name, b.input); }
        catch (e) { result = { error: e.message }; }
        return { type: "tool_result", tool_use_id: b.id, content: JSON.stringify(result) };
      })
    );
    loopMsgs.push({ role: "user", content: toolResults });
    response = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 1500, system: SYSTEM, tools: TOOLS, messages: loopMsgs });
  }
  return response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

// ─── Push ─────────────────────────────────────────────────────────
const pushSubscriptions = new Map();

async function sendPush(title, body, icon = "📈", data = {}) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || pushSubscriptions.size === 0) return;
  const payload = JSON.stringify({ title, body, icon, data, timestamp: Date.now() });
  const expired = [];
  for (const [id, sub] of pushSubscriptions.entries()) {
    try { await webpush.sendNotification(sub, payload); }
    catch (e) { if (e.statusCode === 410 || e.statusCode === 404) expired.push(id); }
  }
  expired.forEach(id => pushSubscriptions.delete(id));
}

// ─── Scheduled tasks ──────────────────────────────────────────────
const TASKS = [
  {
    id: "morning_briefing", label: "Morning briefing", icon: "🌅",
    cron: "30 8 * * 1-5",
    prompt: "Get account summary and P&L summary. Give me a morning briefing: total portfolio value, unrealized P&L, top 3 positions by value, and any position down more than 5%. Keep it short.",
  },
  {
    id: "midday_check", label: "Midday check", icon: "☀️",
    cron: "0 12 * * 1-5",
    prompt: "Quick midday check: get P&L summary and list any positions with large unrealized losses. 3 sentences max.",
  },
  {
    id: "eod_summary", label: "End-of-day summary", icon: "🌆",
    cron: "30 16 * * 1-5",
    prompt: "End of day report: get account summary, trades, and P&L summary. List today's trades, total realized P&L, unrealized P&L, and top movers in the portfolio.",
  },
  {
    id: "weekly_review", label: "Weekly review", icon: "⚖️",
    cron: "0 15 * * 5",
    prompt: "Weekly portfolio review: get account summary, P&L summary, and all trades. Summarise the week: total P&L, best and worst positions, number of trades, total commissions paid, and any portfolio concentration risks.",
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
      taskState[task.id].lastRun = new Date().toISOString();
      taskState[task.id].lastResult = result;
      taskState[task.id].running = false;
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
    taskState[task.id].lastRun = new Date().toISOString();
    taskState[task.id].lastResult = result;
    taskState[task.id].running = false;
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
  pushSubscriptions.set(id, sub);
  res.json({ ok: true });
});

app.post("/api/push/unsubscribe", (req, res) => {
  const id = Buffer.from(req.body.endpoint || "").toString("base64").slice(0, 32);
  pushSubscriptions.delete(id);
  res.json({ ok: true });
});

app.post("/api/push/test", async (req, res) => {
  await sendPush("✅ Test", "Push notifications working!", "✅");
  res.json({ ok: true });
});

app.get("/api/ibkr/status", async (req, res) => {
  try {
    await getFlexData();
    res.json({ authenticated: true, mode: "flex_web_service" });
  } catch (e) {
    res.status(503).json({ authenticated: false, error: e.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString(), pushSubscribers: pushSubscriptions.size }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 IBKR Agent running on port ${PORT}`));
