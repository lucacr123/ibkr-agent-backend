import express from "express";
import cors from "cors";
import cron from "node-cron";
import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";
import webpush from "web-push";
import https from "https";

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────────
// CONFIG  (set all of these as environment variables in Railway)
// ─────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY  || "";
const IBKR_BASE_URL  = process.env.IBKR_BASE_URL      || "https://localhost:5000/v1/api"; // Client Portal Gateway URL
const VAPID_PUBLIC   = process.env.VAPID_PUBLIC_KEY   || "";
const VAPID_PRIVATE  = process.env.VAPID_PRIVATE_KEY  || "";
const VAPID_EMAIL    = process.env.VAPID_EMAIL        || "mailto:you@example.com";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// VAPID setup
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  console.log("✅ Push notifications configured");
} else {
  console.warn("⚠️  VAPID keys not set — push notifications disabled");
}

// ─────────────────────────────────────────────────────────────────
// IBKR CLIENT PORTAL API  — https://interactivebrokers.github.io/cpwebapi/
// The Client Portal Gateway runs locally on your machine (or a server).
// It handles OAuth session; you authenticate once via browser, then
// this backend calls it over REST.
// ─────────────────────────────────────────────────────────────────

// IBKR uses a self-signed cert locally — bypass TLS verification for localhost only.
const ibkrAgent = new https.Agent({ rejectUnauthorized: false });

async function ibkrGet(path) {
  const res = await fetch(`${IBKR_BASE_URL}${path}`, {
    agent: IBKR_BASE_URL.startsWith("https://localhost") ? ibkrAgent : undefined,
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  });
  if (!res.ok) throw new Error(`IBKR ${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function ibkrPost(path, body = {}) {
  const res = await fetch(`${IBKR_BASE_URL}${path}`, {
    method: "POST",
    agent: IBKR_BASE_URL.startsWith("https://localhost") ? ibkrAgent : undefined,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`IBKR POST ${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function ibkrDelete(path) {
  const res = await fetch(`${IBKR_BASE_URL}${path}`, {
    method: "DELETE",
    agent: IBKR_BASE_URL.startsWith("https://localhost") ? ibkrAgent : undefined,
  });
  return res.json();
}

// Keep session alive (IBKR session expires after ~5 min without a tickle)
cron.schedule("*/4 * * * *", async () => {
  try { await ibkrPost("/tickle"); } catch (e) { /* silent */ }
});

// ─────────────────────────────────────────────────────────────────
// TOOL EXECUTOR  — maps Claude tool calls → IBKR API calls
// ─────────────────────────────────────────────────────────────────
async function executeTool(name, input) {
  switch (name) {

    // ── Account summary ────────────────────────────────────────────
    case "get_account_summary": {
      const accounts = await ibkrGet("/portfolio/accounts");
      const accountId = accounts[0]?.id;
      if (!accountId) throw new Error("No IBKR account found");
      const [summary, positions] = await Promise.all([
        ibkrGet(`/portfolio/${accountId}/summary`),
        ibkrGet(`/portfolio/${accountId}/positions/0`),
      ]);
      return {
        accountId,
        netliquidation: summary.netliquidation?.amount,
        totalcashvalue: summary.totalcashvalue?.amount,
        unrealizedpnl: summary.unrealizedpnl?.amount,
        realizedpnl: summary.realizedpnl?.amount,
        positions: (positions || []).map(p => ({
          symbol: p.contractDesc || p.ticker,
          conid: p.conid,
          position: p.position,
          mktValue: p.mktValue,
          avgCost: p.avgCost,
          unrealizedPnl: p.unrealizedPnl,
          assetClass: p.assetClass,
        })),
      };
    }

    // ── Market data snapshot ───────────────────────────────────────
    case "get_market_data": {
      // First resolve symbol → conid
      const search = await ibkrGet(`/trsrv/stocks?symbols=${encodeURIComponent(input.symbol)}`);
      const conid = search[input.symbol]?.[0]?.contracts?.[0]?.conid;
      if (!conid) return { error: `Could not find conid for ${input.symbol}` };

      // Fields: 31=last, 7295=bid, 7296=ask, 84=volume, 7741=% chg
      const snap = await ibkrGet(`/md/snapshot?conids=${conid}&fields=31,7295,7296,84,7741,7762`);
      const d = snap?.[0] || {};
      return {
        symbol: input.symbol,
        conid,
        last: d["31"],
        bid: d["7295"],
        ask: d["7296"],
        volume: d["84"],
        changePct: d["7741"],
        high52: d["7762"],
      };
    }

    // ── Place order ────────────────────────────────────────────────
    case "place_order": {
      const accounts = await ibkrGet("/portfolio/accounts");
      const accountId = accounts[0]?.id;

      // Resolve symbol to conid if not provided
      let conid = input.conid;
      if (!conid) {
        const search = await ibkrGet(`/trsrv/stocks?symbols=${encodeURIComponent(input.symbol)}`);
        conid = search[input.symbol]?.[0]?.contracts?.[0]?.conid;
        if (!conid) throw new Error(`Cannot find conid for ${input.symbol}`);
      }

      const orderPayload = {
        orders: [{
          conid,
          orderType: input.orderType || "MKT",   // MKT, LMT, STP, STP_LIMIT
          side: input.side.toUpperCase(),          // BUY or SELL
          quantity: input.quantity,
          tif: input.tif || "DAY",                // DAY, GTC, IOC
          ...(input.price ? { price: input.price } : {}),
          ...(input.auxPrice ? { auxPrice: input.auxPrice } : {}),
        }],
      };

      const result = await ibkrPost(`/iserver/account/${accountId}/orders`, orderPayload);

      // IBKR may return a confirmation question — auto-confirm
      if (result?.[0]?.id) {
        const confirmed = await ibkrPost(`/iserver/reply/${result[0].id}`, { confirmed: true });
        await sendPush(
          `Order ${input.side.toUpperCase()} ${input.symbol}`,
          `${input.quantity} × ${input.orderType || "MKT"} — ${confirmed?.[0]?.order_status || "submitted"}`,
          input.side.toLowerCase() === "buy" ? "🟢" : "🔴"
        );
        return confirmed;
      }
      return result;
    }

    // ── Cancel order ───────────────────────────────────────────────
    case "cancel_order": {
      const accounts = await ibkrGet("/portfolio/accounts");
      const accountId = accounts[0]?.id;
      const result = await ibkrDelete(`/iserver/account/${accountId}/order/${input.orderId}`);
      return result;
    }

    // ── List open orders ───────────────────────────────────────────
    case "get_open_orders": {
      return ibkrGet("/iserver/account/orders");
    }

    // ── Trade history ──────────────────────────────────────────────
    case "get_trades": {
      return ibkrGet("/iserver/account/trades");
    }

    // ── Account PnL ────────────────────────────────────────────────
    case "get_pnl": {
      const accounts = await ibkrGet("/portfolio/accounts");
      const accountId = accounts[0]?.id;
      return ibkrGet(`/iserver/account/pnl/partitioned`);
    }

    // ── Search instruments ─────────────────────────────────────────
    case "search_instruments": {
      return ibkrGet(`/iserver/secdef/search?symbol=${encodeURIComponent(input.query)}&name=${input.searchByName ? "true" : "false"}`);
    }

    // ── Portfolio allocation ───────────────────────────────────────
    case "get_allocation": {
      const accounts = await ibkrGet("/portfolio/accounts");
      const accountId = accounts[0]?.id;
      return ibkrGet(`/portfolio/${accountId}/allocation`);
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─────────────────────────────────────────────────────────────────
// CLAUDE AGENT LOOP
// ─────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "get_account_summary",
    description: "Get full IBKR account summary: net liquidation value, cash, unrealized/realized P&L, and all current positions.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_market_data",
    description: "Get real-time market data snapshot for a stock symbol: last price, bid/ask, volume, % change.",
    input_schema: { type: "object", properties: { symbol: { type: "string", description: "Stock ticker e.g. AAPL" } }, required: ["symbol"] },
  },
  {
    name: "place_order",
    description: "Place an order on IBKR. Supports market, limit, stop, and stop-limit orders.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        conid: { type: "number", description: "IBKR contract ID (optional — resolved from symbol if omitted)" },
        side: { type: "string", enum: ["BUY", "SELL"] },
        quantity: { type: "number" },
        orderType: { type: "string", enum: ["MKT", "LMT", "STP", "STP_LIMIT"], description: "Default: MKT" },
        price: { type: "number", description: "Limit price (required for LMT/STP_LIMIT)" },
        auxPrice: { type: "number", description: "Stop price (for STP/STP_LIMIT)" },
        tif: { type: "string", enum: ["DAY", "GTC", "IOC"], description: "Time in force. Default: DAY" },
      },
      required: ["symbol", "side", "quantity"],
    },
  },
  {
    name: "cancel_order",
    description: "Cancel an open order by order ID.",
    input_schema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
  },
  {
    name: "get_open_orders",
    description: "List all currently open (pending) orders.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_trades",
    description: "Get recent trade history for the account.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_pnl",
    description: "Get partitioned P&L across all positions.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_instruments",
    description: "Search for tradeable instruments by symbol or name.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        searchByName: { type: "boolean", description: "Search by company name instead of ticker" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_allocation",
    description: "Get portfolio allocation breakdown by asset class, sector, and geography.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

const SYSTEM_PROMPT = `You are a professional finance AI agent with full access to an Interactive Brokers (IBKR) account via the Client Portal API.

You can:
- Check account value, cash, P&L, and all positions
- Fetch real-time market data for any stock
- Place, modify, and cancel orders (market, limit, stop)
- View trade history and open orders
- Analyse portfolio allocation by asset class and sector
- Research and search for instruments

Guidelines:
- Always be concise and data-driven. Format numbers clearly with $ signs and 2 decimal places.
- Before placing any order, confirm the symbol, quantity, type, and estimated cost/proceeds with the user.
- If asked to "rebalance" or "run strategy", get current positions first, analyse, then propose specific trades for confirmation.
- Warn clearly about any risk — e.g. if selling a large position or placing a market order in low-liquidity conditions.
- Today is ${new Date().toDateString()}.`;

async function runAgent(userPrompt, history = []) {
  const messages = [...history, { role: "user", content: userPrompt }];
  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
  });

  let loopMsgs = [...messages];
  let iterations = 0;

  while (response.stop_reason === "tool_use" && iterations < 10) {
    iterations++;
    loopMsgs.push({ role: "assistant", content: response.content });

    const toolResults = await Promise.all(
      response.content
        .filter(b => b.type === "tool_use")
        .map(async b => {
          let result;
          try { result = await executeTool(b.name, b.input); }
          catch (e) { result = { error: e.message }; }
          return { type: "tool_result", tool_use_id: b.id, content: JSON.stringify(result) };
        })
    );

    loopMsgs.push({ role: "user", content: toolResults });
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: loopMsgs,
    });
  }

  return response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

// ─────────────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
// SCHEDULED TASKS
// Each task runs Claude with a specific prompt and sends a push.
// ─────────────────────────────────────────────────────────────────
const TASKS = [
  {
    id: "morning_briefing",
    label: "Morning market briefing",
    icon: "🌅",
    // 8:30 AM ET, weekdays
    cron: "30 8 * * 1-5",
    prompt: `Generate a morning market briefing:
1. Get the full account summary with all positions
2. Get market data for each position held
3. Note any large overnight moves (>2%)
4. Summarise: account value, top gainers/losers in portfolio, and 2-3 things to watch today.
Keep it concise — this is a morning brief, not a report.`,
  },
  {
    id: "midday_check",
    label: "Midday portfolio check",
    icon: "☀️",
    // 12:00 PM ET, weekdays
    cron: "0 12 * * 1-5",
    prompt: `Quick midday check:
1. Get current P&L (get_pnl)
2. Check open orders
3. Flag any position that has moved >3% since open
Return a 3-sentence summary only.`,
  },
  {
    id: "eod_summary",
    label: "End-of-day summary",
    icon: "🌆",
    // 4:30 PM ET, weekdays (after market close)
    cron: "30 16 * * 1-5",
    prompt: `End-of-day summary:
1. Get account summary with all positions
2. Get today's trades
3. Calculate today's realized + unrealized P&L
4. List positions with biggest moves today
5. Note any open orders still pending
Format as a clean daily report with sections.`,
  },
  {
    id: "weekly_rebalance",
    label: "Weekly rebalance review",
    icon: "⚖️",
    // Friday 3:00 PM ET
    cron: "0 15 * * 5",
    prompt: `Weekly rebalance review:
1. Get full account summary and portfolio allocation
2. Identify any position that is >5% over or under its target weight (assume equal weight if no targets set)
3. List suggested rebalancing trades but DO NOT execute them — present them for my approval
4. Note total portfolio drift from target allocation.`,
  },
];

const taskState = {};
TASKS.forEach(t => { taskState[t.id] = { enabled: true, lastRun: null, lastResult: null, running: false }; });

TASKS.forEach(task => {
  cron.schedule(task.cron, async () => {
    if (!taskState[task.id].enabled || taskState[task.id].running) return;
    taskState[task.id].running = true;
    console.log(`⏱  Running: ${task.label}`);
    taskLog.unshift({ task: task.label, status: "running", time: new Date().toISOString() });

    await sendPush(`${task.icon} ${task.label}`, "Running now — you'll get a summary shortly.", task.icon);

    try {
      const result = await runAgent(task.prompt);
      taskState[task.id].lastRun = new Date().toISOString();
      taskState[task.id].lastResult = result;
      taskState[task.id].running = false;
      taskLog[0] = { task: task.label, status: "done", time: taskState[task.id].lastRun, result: result.slice(0, 300) };
      await sendPush(`${task.icon} ${task.label} done`, result.slice(0, 140), task.icon, { type: "task", taskId: task.id });
    } catch (e) {
      taskState[task.id].running = false;
      taskLog[0] = { task: task.label, status: "error", time: new Date().toISOString(), result: e.message };
      await sendPush(`❌ ${task.label} failed`, e.message.slice(0, 120), "❌");
    }
  }, { timezone: "America/New_York" });
});

// ─────────────────────────────────────────────────────────────────
// TASK LOG (in-memory, last 100)
// ─────────────────────────────────────────────────────────────────
const taskLog = [];

// ─────────────────────────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────────────────────────

// ── Chat ──────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    const reply = await runAgent(message, history);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Account ───────────────────────────────────────────────────────
app.get("/api/account", async (req, res) => {
  try { res.json(await executeTool("get_account_summary", {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Market data ───────────────────────────────────────────────────
app.get("/api/market/:symbol", async (req, res) => {
  try { res.json(await executeTool("get_market_data", { symbol: req.params.symbol })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Orders ────────────────────────────────────────────────────────
app.get("/api/orders", async (req, res) => {
  try { res.json(await executeTool("get_open_orders", {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Scheduled tasks ───────────────────────────────────────────────
app.get("/api/tasks", (req, res) => {
  res.json(TASKS.map(t => ({ ...t, ...taskState[t.id] })));
});

app.patch("/api/tasks/:id", (req, res) => {
  const { id } = req.params;
  if (!taskState[id]) return res.status(404).json({ error: "Not found" });
  taskState[id].enabled = req.body.enabled;
  res.json({ id, enabled: req.body.enabled });
});

app.post("/api/tasks/:id/run", async (req, res) => {
  const task = TASKS.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Not found" });
  if (taskState[task.id].running) return res.status(409).json({ error: "Already running" });

  taskState[task.id].running = true;
  taskLog.unshift({ task: task.label, status: "running", time: new Date().toISOString() });
  if (taskLog.length > 100) taskLog.pop();

  // Run async, return immediately
  res.json({ ok: true, message: "Task started" });

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
});

app.get("/api/tasks/:id/result", (req, res) => {
  const state = taskState[req.params.id];
  if (!state) return res.status(404).json({ error: "Not found" });
  res.json(state);
});

app.get("/api/log", (req, res) => res.json(taskLog.slice(0, 50)));

// ── Push ──────────────────────────────────────────────────────────
app.get("/api/push/vapid-key", (req, res) => res.json({ publicKey: VAPID_PUBLIC }));

app.post("/api/push/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: "Invalid subscription" });
  const id = Buffer.from(sub.endpoint).toString("base64").slice(0, 32);
  pushSubscriptions.set(id, sub);
  console.log(`📱 Push subscriber registered (total: ${pushSubscriptions.size})`);
  res.json({ ok: true });
});

app.post("/api/push/unsubscribe", (req, res) => {
  const id = Buffer.from(req.body.endpoint || "").toString("base64").slice(0, 32);
  pushSubscriptions.delete(id);
  res.json({ ok: true });
});

app.post("/api/push/test", async (req, res) => {
  await sendPush("✅ Test notification", "Your IBKR Agent push notifications are working.", "✅");
  res.json({ ok: true, subscribers: pushSubscriptions.size });
});

// ── IBKR session ──────────────────────────────────────────────────
app.get("/api/ibkr/status", async (req, res) => {
  try {
    const status = await ibkrGet("/iserver/auth/status");
    res.json(status);
  } catch (e) {
    res.status(503).json({ error: e.message, hint: "Is the IBKR Client Portal Gateway running?" });
  }
});

app.post("/api/ibkr/reauthenticate", async (req, res) => {
  try {
    const result = await ibkrPost("/iserver/reauthenticate");
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Health ────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({
  status: "ok",
  time: new Date().toISOString(),
  pushSubscribers: pushSubscriptions.size,
  scheduledTasks: TASKS.length,
}));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 IBKR Agent backend running on port ${PORT}`));
