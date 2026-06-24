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

// ─── Flex Web Service ─────────────────────────────────────────────
const FLEX_BASE = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";

async function fetchFlex() {
  if (!FLEX_TOKEN || !FLEX_QUERY_ID) throw new Error("IBKR_FLEX_TOKEN or IBKR_FLEX_QUERY_ID not set");
  const sendRes  = await fetch(`${FLEX_BASE}/SendRequest?t=${FLEX_TOKEN}&q=${FLEX_QUERY_ID}&v=3`, { headers: { "User-Agent": "Node/18" } });
  const sendData = parser.parse(await sendRes.text());
  const status   = sendData?.FlexStatementResponse?.Status;
  const refCode  = sendData?.FlexStatementResponse?.ReferenceCode;
  const url      = sendData?.FlexStatementResponse?.Url;
  if (status !== "Success") throw new Error(`Flex request failed: ${JSON.stringify(sendData)}`);

  // Wait longer for IBKR to generate the report
  await new Promise(r => setTimeout(r, 8000));
  for (let i = 0; i < 10; i++) {
    const getRes  = await fetch(`${url}?t=${FLEX_TOKEN}&q=${refCode}&v=3`, { headers: { "User-Agent": "Node/18" } });
    const rawXml  = await getRes.text();
    const getData = parser.parse(rawXml);
    // Returns either FlexQueryResponse or FlexStatementResponse
    const stmts = getData?.FlexQueryResponse?.FlexStatements?.FlexStatement
               ?? getData?.FlexStatementResponse?.FlexStatements?.FlexStatement;
    if (stmts) return Array.isArray(stmts) ? stmts : [stmts];
    // Still generating — wait longer each retry
    await new Promise(r => setTimeout(r, 3000 + i * 1000));
  }
  throw new Error("Could not retrieve Flex report after retries");
}

let flexCache = null, flexCacheTime = 0;
async function getFlexData(force = false) {
  if (!force && flexCache && Date.now() - flexCacheTime < 15 * 60 * 1000) return flexCache;
  flexCache     = await fetchFlex(); // array of statements
  flexCacheTime = Date.now();
  return flexCache;
}

// ─── Helpers ──────────────────────────────────────────────────────
function toArr(v)    { return Array.isArray(v) ? v : v ? [v] : []; }
function fmt(v)      { return parseFloat(v || 0).toFixed(2); }
function fmtNum(v)   { return parseFloat(v || 0); }

// ─── Tool executor ────────────────────────────────────────────────
async function executeTool(name, input) {
  switch (name) {

    case "get_account_summary": {
      const allStmts = await getFlexData(input?.refresh);

      // Deduplicate — keep only the most recent statement per account
      const byAccount = {};
      for (const s of allStmts) {
        const id = s.accountId;
        if (!byAccount[id] || s.whenGenerated > byAccount[id].whenGenerated) {
          byAccount[id] = s;
        }
      }
      const stmts = Object.values(byAccount);

      const accounts = stmts.map(stmt => {
        const info = stmt?.AccountInformation || {};
        // Equity summary — get the last (most recent) row
        const equityRows = toArr(stmt?.EquitySummaryInBase?.EquitySummaryByReportDateInBase);
        const equity     = equityRows[equityRows.length - 1] || {};
        // Use OpenPositions for actual position data
        const positions  = toArr(stmt?.OpenPositions?.OpenPosition)
          .filter(p => p.levelOfDetail === "SUMMARY" || !p.levelOfDetail);
        const totalUnrealized = positions.reduce((s, p) => s + fmtNum(p.fifoPnlUnrealized), 0);
        return {
          accountId:          stmt.accountId,
          accountName:        info.name || "",
          currency:           info.currency || "EUR",
          netLiquidation:     fmt(equity.total),
          cash:               fmt(equity.cash),
          stockValue:         fmt(equity.stock),
          totalUnrealizedPnl: fmt(totalUnrealized),
          totalPnl:           fmt(totalUnrealized),
          positionCount:      positions.length,
          positions: positions.map(p => ({
            symbol:        p.symbol,
            description:   p.description,
            assetCategory: p.assetCategory,
            quantity:      p.position,
            markPrice:     fmt(p.markPrice),
            positionValue: fmt(p.positionValue),
            costBasis:     fmt(p.costBasisPrice),
            unrealizedPnl: fmt(p.fifoPnlUnrealized),
            percentOfNAV:  p.percentOfNAV,
            currency:      p.currency,
          })),
        };
      });

      // Combined totals
      const combined = {
        totalNetLiquidation: fmt(accounts.reduce((s, a) => s + fmtNum(a.netLiquidation), 0)),
        totalCash:           fmt(accounts.reduce((s, a) => s + fmtNum(a.cash), 0)),
        totalUnrealizedPnl:  fmt(accounts.reduce((s, a) => s + fmtNum(a.totalUnrealizedPnl), 0)),
        totalRealizedPnl:    fmt(accounts.reduce((s, a) => s + fmtNum(a.totalRealizedPnl), 0)),
        totalPnl:            fmt(accounts.reduce((s, a) => s + fmtNum(a.totalPnl), 0)),
      };

      return { accounts, combined };
    }

    case "get_trades": {
      const allStmts = await getFlexData();
      const byAccount = {};
      for (const s of allStmts) {
        if (!byAccount[s.accountId] || s.whenGenerated > byAccount[s.accountId].whenGenerated) byAccount[s.accountId] = s;
      }
      const all = Object.values(byAccount).flatMap(s => toArr(s?.Trades?.Trade).map(t => ({ ...t, accountId: s.accountId })));
      const filtered = input?.symbol ? all.filter(t => t.symbol?.toUpperCase() === input.symbol.toUpperCase()) : all;
      return {
        count: filtered.length,
        trades: filtered.slice(0, 100).map(t => ({
          accountId:   t.accountId,
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
      const allStmts = await getFlexData();
      const byAccount = {};
      for (const s of allStmts) {
        if (!byAccount[s.accountId] || s.whenGenerated > byAccount[s.accountId].whenGenerated) byAccount[s.accountId] = s;
      }
      const stmts = Object.values(byAccount);
      return {
        accounts: stmts.map(s => {
          const rows = toArr(s?.CashReport?.CashReportCurrency);
          const base = rows.find(c => c.currency === "BASE_SUMMARY") || rows[0] || {};
          return {
            accountId:         s.accountId,
            endingCash:        fmt(base.endingCash),
            endingSettledCash: fmt(base.endingSettledCash),
            commissions:       fmt(base.commissions),
            deposits:          fmt(base.deposits),
            withdrawals:       fmt(base.withdrawals),
            dividends:         fmt(base.dividends),
            brokerInterest:    fmt(base.brokerInterest),
          };
        }),
      };
    }

    case "get_pnl_summary": {
      const allStmts = await getFlexData();
      const byAccount = {};
      for (const s of allStmts) {
        if (!byAccount[s.accountId] || s.whenGenerated > byAccount[s.accountId].whenGenerated) byAccount[s.accountId] = s;
      }
      const stmts = Object.values(byAccount);
      return {
        accounts: stmts.map(s => {
          const positions = toArr(s?.OpenPositions?.OpenPosition).filter(p => p.levelOfDetail === "SUMMARY" || !p.levelOfDetail);
          const perf      = toArr(s?.FIFOPerformanceSummaryInBase?.FIFOPerformanceSummaryUnderlying).filter(p => p.symbol);
          const sorted    = [...positions].sort((a, b) => fmtNum(b.fifoPnlUnrealized) - fmtNum(a.fifoPnlUnrealized));
          const cashRows  = toArr(s?.CashReport?.CashReportCurrency);
          const base      = cashRows.find(c => c.currency === "BASE_SUMMARY") || {};
          const totalU    = positions.reduce((sum, p) => sum + fmtNum(p.fifoPnlUnrealized), 0);
          const totalR    = perf.reduce((sum, p) => sum + fmtNum(p.totalRealizedPnl), 0);
          return {
            accountId:          s.accountId,
            totalRealizedPnl:   fmt(totalR),
            totalUnrealizedPnl: fmt(totalU),
            totalPnl:           fmt(totalR + totalU),
            commissions:        fmt(base.commissions),
            dividends:          fmt(base.dividends),
            brokerInterest:     fmt(base.brokerInterest),
            bestPositions:      sorted.slice(0, 3).map(p => ({ symbol: p.symbol, unrealizedPnl: fmt(p.fifoPnlUnrealized) })),
            worstPositions:     sorted.slice(-3).reverse().map(p => ({ symbol: p.symbol, unrealizedPnl: fmt(p.fifoPnlUnrealized) })),
          };
        }),
      };
    }

    case "refresh_data": {
      flexCache = null;
      const stmts = await getFlexData(true);
      return { ok: true, message: "Refreshed", accounts: stmts.map(s => s.accountId) };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── Claude agent ─────────────────────────────────────────────────
const TOOLS = [
  { name: "get_account_summary", description: "Get full summary for ALL accounts: positions, net liquidation, cash, P&L per account and combined totals.", input_schema: { type: "object", properties: { refresh: { type: "boolean" } }, required: [] } },
  { name: "get_trades",          description: "Get trade history across all accounts. Filter by symbol optionally.", input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: [] } },
  { name: "get_cash",            description: "Get cash balances, commissions, deposits, dividends for all accounts.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_pnl_summary",     description: "Get P&L summary per account: realized, unrealized, best/worst positions, commissions.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "refresh_data",        description: "Force a fresh data pull from IBKR.", input_schema: { type: "object", properties: {}, required: [] } },
];

const SYSTEM = `You are a professional finance AI agent managing an Interactive Brokers (IBKR) account with TWO sub-accounts (U11354150 and U9733561). Data is read-only via IBKR Flex Web Service.

You can view positions, P&L, trades, cash, and dividends across both accounts. Always show combined totals as well as per-account breakdowns when relevant.

Be concise and data-driven. Format numbers with currency symbols (EUR). Today is ${new Date().toDateString()}.`;

async function runAgent(prompt, history = []) {
  const messages = [...history, { role: "user", content: prompt }];
  let response = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 1500, system: SYSTEM, tools: TOOLS, messages });
  let loop = [...messages], i = 0;
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
  { id: "morning", label: "Morning briefing",  icon: "🌅", cron: "30 8 * * 1-5",  prompt: "Get account summary for both accounts. Morning briefing: combined net liquidation, combined P&L, top 3 positions across both accounts, any position down >5%. Keep it short." },
  { id: "midday",  label: "Midday check",      icon: "☀️", cron: "0 12 * * 1-5",  prompt: "Quick midday: get P&L summary for both accounts. Combined unrealized P&L. 3 sentences." },
  { id: "eod",     label: "End-of-day summary",icon: "🌆", cron: "30 16 * * 1-5", prompt: "End of day: account summary and trades for both accounts. Combined totals, today's trades, overall P&L." },
  { id: "weekly",  label: "Weekly review",     icon: "⚖️", cron: "0 15 * * 5",    prompt: "Weekly review across both accounts: combined P&L, best/worst positions, trades made this week, commissions paid, any concentration risks." },
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
    const stmts = await getFlexData();
    res.json({ authenticated: true, mode: "flex_web_service", accounts: stmts.map(s => s.accountId) });
  } catch (e) {
    res.status(503).json({ authenticated: false, error: e.message });
  }
});
app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString(), pushSubscribers: pushSubs.size }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 IBKR Agent on port ${PORT}`));

// Debug endpoint — remove after fixing
app.get("/api/debug/structure", async (req, res) => {
  try {
    const stmts = await getFlexData(true);
    const structure = stmts.map(s => ({
      accountId: s.accountId,
      sections: Object.keys(s),
      FIFOCount: toArr(s?.FIFOPerformanceSummaryInBase?.FIFOPerformanceSummaryUnderlying).length,
      OpenPositionsCount: toArr(s?.OpenPositions?.OpenPosition).length,
      TradesCount: toArr(s?.Trades?.Trade).length,
      EquitySummaryCount: toArr(s?.EquitySummaryInBase?.EquitySummaryByReportDateInBase).length,
      // Show first FIFO item keys if exists
      firstFIFOKeys: toArr(s?.FIFOPerformanceSummaryInBase?.FIFOPerformanceSummaryUnderlying)[0] 
        ? Object.keys(toArr(s?.FIFOPerformanceSummaryInBase?.FIFOPerformanceSummaryUnderlying)[0])
        : [],
      firstOpenPosKeys: toArr(s?.OpenPositions?.OpenPosition)[0]
        ? Object.keys(toArr(s?.OpenPositions?.OpenPosition)[0])
        : [],
    }));
    res.json(structure);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
