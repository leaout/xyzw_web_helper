import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import cron from "node-cron";
import { createApiKeyMiddleware } from "./lib/apiKeyAuth.js";
import { GameClient } from "./lib/gameClient.js";
import { createProxyMiddleware } from "./lib/proxy.js";
import * as db from "./lib/db.js";

/**
 * XYZW 自包含全栈服务
 * ------------------------------------------------------------------
 * 一个 Node 进程同时提供：
 *   1. 前端静态页面（dist/，含 SPA history 回退）
 *   2. 游戏服务器 API 代理（/api/hortor、/api/weixin ...）
 *   3. 后端定时任务（node-cron，关掉浏览器照常执行）
 *   4. 本地 SQLite 数据存储（零外部依赖）
 *
 * 部署到国内服务器后，浏览器访问一个端口/域名即可，不依赖任何境外服务。
 */

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const app = express();
app.disable("x-powered-by");
app.use(cors());

// ==================== 日志 ====================
const LOG_MAX = 500;
const logs = [];

function addLog(level, category, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    category,
    message,
    ...meta,
  };
  logs.unshift(entry);
  if (logs.length > LOG_MAX) logs.pop();
  console.log(`[${level}] [${category}] ${message}`, meta);
}

// ==================== 任务定义 ====================
const TASK_DEFINITIONS = {
  signIn: {
    name: "签到",
    commands: [{ cmd: "system_signinreward", params: {} }],
  },
  claimHangup: {
    name: "领取挂机奖励",
    commands: [{ cmd: "system_claimhangupreward", params: {} }],
  },
  claimDaily: {
    name: "领取日常奖励",
    commands: [{ cmd: "task_claimdailyreward", params: { rewardId: 0 } }],
  },
  claimDailyPoint: {
    name: "领取每日积分",
    commands: [{ cmd: "task_claimdailypoint", params: { taskId: 1 } }],
  },
  climbTower: {
    name: "爬塔领奖励",
    commands: [
      { cmd: "tower_getinfo", params: {} },
      { cmd: "tower_claimreward", params: {} },
    ],
  },
  climbWeirdTower: {
    name: "怪异塔",
    commands: [
      { cmd: "evotower_getinfo", params: {} },
      { cmd: "evotower_claimreward", params: {} },
    ],
  },
  arenaFight: {
    name: "竞技场",
    commands: [
      { cmd: "arena_startarea", params: {} },
      { cmd: "arena_getareatarget", params: { refresh: false } },
    ],
  },
  claimMail: {
    name: "领取邮件附件",
    commands: [{ cmd: "mail_claimallattachment", params: { category: 0 } }],
  },
  legacyHangup: {
    name: "功法挂机",
    commands: [
      { cmd: "legacy_getinfo", params: {} },
      { cmd: "legacy_claimhangup", params: {} },
    ],
  },
  heroRecruit: {
    name: "武将招募",
    commands: [
      {
        cmd: "hero_recruit",
        params: { byClub: false, recruitNumber: 1, recruitType: 3 },
      },
    ],
  },
  studyGame: {
    name: "学习问答",
    commands: [{ cmd: "study_startgame", params: {} }],
  },
  genieSweep: {
    name: "灯神",
    commands: [{ cmd: "genie_sweep", params: { genieId: 1 } }],
  },
  openBox: {
    name: "开箱",
    commands: [{ cmd: "item_openbox", params: { itemId: 2001, number: 10 } }],
  },
  legionSignIn: {
    name: "军团签到",
    commands: [
      { cmd: "legion_getinfo", params: {} },
      { cmd: "legion_signin", params: {} },
    ],
  },
  bossTower: {
    name: "咸王宝库",
    commands: [
      { cmd: "bosstower_getinfo", params: {} },
      { cmd: "bosstower_startboss", params: {} },
      { cmd: "bosstower_startbox", params: {} },
    ],
  },
  mergeBox: {
    name: "合并魔盒",
    commands: [
      { cmd: "mergebox_getinfo", params: {} },
      { cmd: "mergebox_claimfreeenergy", params: {} },
      { cmd: "mergebox_openbox", params: {} },
    ],
  },
  dailyBundle: {
    name: "一键日常",
    commands: [
      { cmd: "system_signinreward", params: {} },
      { cmd: "system_claimhangupreward", params: {} },
      { cmd: "task_claimdailyreward", params: { rewardId: 0 } },
      { cmd: "tower_getinfo", params: {} },
      { cmd: "tower_claimreward", params: {} },
      { cmd: "mail_claimallattachment", params: { category: 0 } },
      { cmd: "legacy_getinfo", params: {} },
      { cmd: "legacy_claimhangup", params: {} },
    ],
  },
};

// ==================== 任务执行引擎 ====================
async function executeTask(task) {
  addLog("INFO", "task", `开始执行任务: ${task.name}`, { taskId: task.id });

  const tokenIds = task.selected_tokens || task.token_ids || [];
  if (!Array.isArray(tokenIds) || tokenIds.length === 0) {
    addLog("WARN", "task", "没有选中的token，跳过", { taskId: task.id });
    return;
  }

  let taskKeys = task.selected_tasks || [];
  if ((!Array.isArray(taskKeys) || taskKeys.length === 0) && task.task_type) {
    taskKeys = [task.task_type];
  }
  if (!Array.isArray(taskKeys) || taskKeys.length === 0) {
    addLog("ERROR", "task", "没有选择任何任务类型", { taskId: task.id });
    return;
  }

  const allCommands = [];
  const seenCmds = new Set();
  for (const key of taskKeys) {
    const taskDef = TASK_DEFINITIONS[key];
    if (!taskDef) {
      addLog("WARN", "task", `未知任务类型: ${key}，跳过`, { taskId: task.id });
      continue;
    }
    for (const cmd of taskDef.commands) {
      const cmdKey = cmd.cmd + JSON.stringify(cmd.params);
      if (!seenCmds.has(cmdKey)) {
        seenCmds.add(cmdKey);
        allCommands.push(cmd);
      }
    }
  }
  if (allCommands.length === 0) {
    addLog("ERROR", "task", "没有有效的命令可执行", { taskId: task.id });
    return;
  }

  const allTokens = db.getEnabledTokens();
  const targetTokens = allTokens.filter((t) => tokenIds.includes(t.id));
  if (targetTokens.length === 0) {
    addLog("WARN", "task", "没有找到匹配的tokens", { taskId: task.id });
    return;
  }

  addLog("INFO", "task", `将执行于 ${targetTokens.length} 个角色`, {
    taskId: task.id,
  });

  for (const token of targetTokens) {
    let tokenData;
    try {
      tokenData =
        typeof token.token === "string" && token.token.startsWith("{")
          ? JSON.parse(token.token)
          : {
              roleToken: token.token,
              roleId: token.roleId,
              sessId: token.sessId,
              connId: token.connId,
              isRestore: token.isRestore,
            };
      tokenData.name = token.name;
    } catch (err) {
      addLog("ERROR", "task", `Token解析失败: ${token.name}`, {
        error: err.message,
      });
      continue;
    }

    const client = new GameClient(tokenData, token.ws_url);
    try {
      await client.connect(15000);
      try {
        await client.sendWithPromise("role_getroleinfo", {}, 8000);
        await sleep(500);
      } catch (e) {
        addLog("WARN", "task", `获取角色信息失败 (${token.name})`, {
          error: e.message,
        });
      }

      const cmdResults = await client.executeBatch(allCommands, 800);
      for (const r of cmdResults) {
        addLog(
          r.success ? "INFO" : "ERROR",
          "task",
          `[${token.name}] ${r.cmd}: ${r.success ? "OK" : r.error}`,
          { taskId: task.id },
        );
        db.insertLog({
          task_id: task.id,
          token_name: token.name,
          task_type: r.cmd,
          status: r.success ? "success" : "error",
          message: r.success ? null : r.error,
        });
      }
    } catch (err) {
      addLog("ERROR", "task", `执行失败 (${token.name}): ${err.message}`, {
        taskId: task.id,
      });
      db.insertLog({
        task_id: task.id,
        token_name: token.name,
        task_type: taskKeys.join(","),
        status: "error",
        message: err.message,
      });
    } finally {
      client.disconnect();
    }
    await sleep(2000);
  }

  db.updateTaskLastRun(task.id);
  addLog("INFO", "task", `任务完成: ${task.name}`, { taskId: task.id });
}

// ==================== 定时任务调度 ====================
const cronJobs = new Map();

function registerAllCrons() {
  for (const job of cronJobs.values()) job.stop();
  cronJobs.clear();
  const tasks = db.getEnabledTasks();
  for (const task of tasks) registerCron(task);
  addLog("INFO", "cron", `已注册 ${tasks.length} 个定时任务`);
}

function registerCron(task) {
  if (cronJobs.has(task.id)) cronJobs.get(task.id).stop();
  const cronExpr = task.cron_expr || task.cron_expression;
  if (!task.enabled || !cronExpr) return;
  try {
    const job = cron.schedule(
      cronExpr,
      () => {
        executeTask(task).catch((err) => {
          addLog("ERROR", "cron", `任务执行异常: ${task.name}`, {
            error: err.message,
          });
        });
      },
      { timezone: "Asia/Shanghai" },
    );
    cronJobs.set(task.id, job);
    addLog(
      "INFO",
      "cron",
      `注册定时任务: ${task.name} (${cronExpr} Asia/Shanghai)`,
    );
  } catch (err) {
    addLog("ERROR", "cron", `注册失败: ${task.name}`, { error: err.message });
  }
}

function init() {
  addLog("INFO", "server", "服务器启动中...");
  addLog("INFO", "server", `数据库: ${db.getDbPath()}`);

  registerAllCrons();

  // 每天中午12点清理前一天的任务日志
  cron.schedule(
    "0 12 * * *",
    () => {
      try {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);
        const removed = db.deleteOldLogs(yesterday.toISOString());
        addLog("INFO", "cron", `已清理 ${removed} 条旧日志`);
      } catch (err) {
        addLog("ERROR", "cron", "日志清理异常", { error: err.message });
      }
    },
    { timezone: "Asia/Shanghai" },
  );

  // 每 5 分钟重载定时任务配置
  setInterval(() => {
    registerAllCrons();
  }, 5 * 60 * 1000).unref();

  addLog("INFO", "server", "服务器就绪");
}

// ==================== 路由 ====================

// 1) 游戏服务器代理（必须在 express.json / API_KEY 之前）
app.use(createProxyMiddleware(addLog));

// 2) JSON body 解析（仅用于本地管理 API）
app.use(express.json({ limit: "4mb" }));

// 3) 健康检查（公开）
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    activeCrons: cronJobs.size,
    logsInMemory: logs.length,
    dbPath: db.getDbPath(),
  });
});

// 4) 管理 API 鉴权（未配置 API_KEY 时放行，方便本地/内网使用）
app.use("/api", createApiKeyMiddleware());

// —— tokens ——
app.get("/api/tokens", (req, res) => res.json(db.getAllTokens()));

app.post("/api/tokens", (req, res) => {
  try {
    const row = db.insertToken(req.body);
    res.json([row]);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/tokens/sync", (req, res) => {
  const incoming = Array.isArray(req.body?.tokens) ? req.body.tokens : null;
  if (!incoming) return res.status(400).json({ error: "tokens must be an array" });
  const rows = incoming
    .filter((t) => t && t.id && t.token)
    .map((t) => ({
      id: String(t.id),
      name: t.name || null,
      token: t.token,
      ws_url: t.ws_url ?? t.wsUrl ?? null,
      server: t.server || null,
      import_method: t.import_method ?? t.importMethod ?? null,
      level: t.level || 1,
      enabled: t.enabled !== false,
      last_used: t.last_used ?? t.lastUsed ?? null,
    }));
  if (rows.length === 0) return res.json({ ok: true, count: 0 });
  try {
    const count = db.upsertTokens(rows);
    addLog("INFO", "api", `同步 ${count} 个tokens`);
    res.json({ ok: true, count });
  } catch (e) {
    addLog("ERROR", "api", "同步tokens失败", { error: e.message });
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/tokens/:id", (req, res) => {
  db.deleteToken(req.params.id);
  res.json({ ok: true });
});

// —— cron tasks ——
app.get("/api/tasks", (req, res) => res.json(db.getAllTasks()));

app.post("/api/tasks", (req, res) => {
  try {
    const row = db.insertTask(req.body);
    registerCron(row);
    res.json([row]);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch("/api/tasks/:id", (req, res) => {
  try {
    const row = db.updateTask(req.params.id, req.body);
    if (!row) return res.status(404).json({ error: "任务不存在" });
    registerAllCrons();
    res.json([row]);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/tasks/:id", (req, res) => {
  db.deleteTask(req.params.id);
  registerAllCrons();
  res.json({ ok: true });
});

app.post("/api/tasks/:id/run", (req, res) => {
  const task = db.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "任务不存在" });
  executeTask(task).catch((err) =>
    addLog("ERROR", "api", `手动执行失败: ${err.message}`),
  );
  res.json({ status: "running", task: task.name });
});

// —— logs ——
app.get("/api/logs", (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit) || 100, LOG_MAX);
  res.json(logs.slice(0, limit));
});

app.get("/api/logs/db", (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit) || 100, 500);
  res.json(db.getLogs(limit));
});

app.get("/api/task-definitions", (req, res) => {
  const list = Object.entries(TASK_DEFINITIONS).map(([key, val]) => ({
    key,
    name: val.name,
    commands: val.commands.map((c) => c.cmd),
  }));
  res.json(list);
});

// 5) 前端静态托管 + SPA history 回退
const STATIC_DIR = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.resolve(__dirname, "..", "dist");

if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR, { index: false }));
  // 非 /api 的 GET 请求一律回退到 index.html，支持 history 路由刷新
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(STATIC_DIR, "index.html"));
  });
  addLog("INFO", "server", `静态资源目录: ${STATIC_DIR}`);
} else {
  addLog(
    "WARN",
    "server",
    `未找到前端目录 ${STATIC_DIR}，仅提供 API 服务（先运行 pnpm build 生成 dist）`,
  );
}

// 未匹配的 /api 请求返回 JSON 404
app.use("/api", (req, res) => res.status(404).json({ error: "Not Found" }));

// ==================== 启动 ====================
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
init();
app.listen(PORT, HOST, () => {
  addLog("INFO", "server", `监听 http://${HOST}:${PORT}`);
});

// 优雅退出
function shutdown() {
  addLog("INFO", "server", "收到退出信号，停止定时任务...");
  for (const job of cronJobs.values()) job.stop();
  db.db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
