import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * SQLite 数据层
 * ------------------------------------------------------------------
 * 自包含部署：所有数据存在本地单文件数据库，零外部依赖。
 * 表结构与原 Supabase 版保持一致（tokens / cron_tasks / task_logs），
 * 并兼容旧字段名（token_ids / cron_expression），方便平滑迁移。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 数据库路径可用 DB_PATH 环境变量覆盖；默认放在 render-backend/data/
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(__dirname, "..", "data", "xyzw.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");

// ==================== 建表 ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    id            TEXT PRIMARY KEY,
    name          TEXT,
    token         TEXT NOT NULL,
    ws_url        TEXT,
    remark        TEXT,
    server        TEXT,
    level         INTEGER DEFAULT 1,
    profession    TEXT,
    import_method TEXT,
    enabled       INTEGER DEFAULT 1,
    created_at    TEXT,
    last_used     TEXT,
    -- 自动续期所需凭证（逐步迁移：老库缺列时由下方 ALTER 补齐）
    source_url    TEXT,
    comb_user     TEXT,
    bin_data      TEXT,
    role_id       TEXT,
    server_id     TEXT,
    role_index    INTEGER,
    last_refreshed TEXT
  );

  CREATE TABLE IF NOT EXISTS cron_tasks (
    id              TEXT PRIMARY KEY,
    name            TEXT,
    enabled         INTEGER DEFAULT 1,
    cron_expr       TEXT,
    cron_expression TEXT,
    selected_tokens TEXT DEFAULT '[]',
    token_ids       TEXT,
    selected_tasks  TEXT DEFAULT '[]',
    task_type       TEXT,
    last_run_at     TEXT,
    created_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS task_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT,
    token_name TEXT,
    task_type  TEXT,
    status     TEXT,
    message    TEXT,
    created_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tokens_enabled ON tokens(enabled);
  CREATE INDEX IF NOT EXISTS idx_tasks_enabled ON cron_tasks(enabled);
  CREATE INDEX IF NOT EXISTS idx_logs_created ON task_logs(created_at);
`);

// 轻量迁移：老数据库可能缺少续期相关列，逐列补齐（幂等）
{
  const existing = new Set(
    db.prepare("PRAGMA table_info(tokens)").all().map((c) => c.name),
  );
  const additions = {
    source_url: "TEXT",
    comb_user: "TEXT",
    bin_data: "TEXT",
    role_id: "TEXT",
    server_id: "TEXT",
    role_index: "INTEGER",
    last_refreshed: "TEXT",
  };
  for (const [col, type] of Object.entries(additions)) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE tokens ADD COLUMN ${col} ${type}`);
    }
  }
}

const now = () => new Date().toISOString();

function parseJson(value, fallback = []) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// 把 JSON 数组字段序列化成字符串（SQLite 无原生数组类型）
function stringifyArray(value) {
  if (value == null) return "[]";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

// 行 -> API 返回对象：把 SQLite 的 0/1 转回布尔，把 JSON 字符串转回数组
function taskRow(row) {
  if (!row) return row;
  return {
    ...row,
    enabled: !!row.enabled,
    selected_tokens: parseJson(row.selected_tokens ?? row.token_ids, []),
    selected_tasks: parseJson(row.selected_tasks, []),
  };
}

function tokenRow(row) {
  if (!row) return row;
  return { ...row, enabled: !!row.enabled };
}

// ==================== tokens ====================

export function getAllTokens() {
  return db
    .prepare("SELECT * FROM tokens ORDER BY created_at ASC")
    .all()
    .map(tokenRow);
}

export function getEnabledTokens() {
  return db
    .prepare("SELECT * FROM tokens WHERE enabled = 1 ORDER BY created_at ASC")
    .all()
    .map(tokenRow);
}

// 把输入对象规整成 tokens 表的完整行（含续期凭证字段）
function normalizeTokenInput(input) {
  return {
    id: String(input.id),
    name: input.name ?? null,
    token: input.token,
    ws_url: input.ws_url ?? null,
    remark: input.remark ?? null,
    server: input.server ?? null,
    level: input.level ?? 1,
    profession: input.profession ?? null,
    import_method: input.import_method ?? null,
    enabled: input.enabled === false || input.enabled === 0 ? 0 : 1,
    created_at: input.created_at ?? now(),
    last_used: input.last_used ?? null,
    source_url: input.source_url ?? null,
    comb_user: input.comb_user ?? null,
    bin_data: input.bin_data ?? null,
    role_id: input.role_id ?? null,
    server_id: input.server_id ?? null,
    role_index: input.role_index ?? null,
    last_refreshed: input.last_refreshed ?? null,
  };
}

const TOKEN_COLUMNS = [
  "id", "name", "token", "ws_url", "remark", "server", "level",
  "profession", "import_method", "enabled", "created_at", "last_used",
  "source_url", "comb_user", "bin_data", "role_id", "server_id",
  "role_index", "last_refreshed",
];

export function insertToken(input) {
  const row = normalizeTokenInput(input);
  const cols = TOKEN_COLUMNS.join(", ");
  const slots = TOKEN_COLUMNS.map((c) => `@${c}`).join(", ");
  db.prepare(`INSERT INTO tokens (${cols}) VALUES (${slots})`).run(row);
  return tokenRow(row);
}

export function getToken(id) {
  return tokenRow(
    db.prepare("SELECT * FROM tokens WHERE id = ?").get(String(id)),
  );
}

export function upsertTokens(rows) {
  const cols = TOKEN_COLUMNS.join(", ");
  const slots = TOKEN_COLUMNS.map((c) => `@${c}`).join(", ");
  // 续期凭证字段：仅当同步端确实带来了新值(excluded 非 NULL)时才覆盖，
  // 避免一次不带凭证的同步把已有的 bin_data 冲掉。
  const updateCols = TOKEN_COLUMNS.filter((c) => c !== "id" && c !== "created_at");
  const setClause = updateCols
    .map((c) => {
      if (["source_url", "comb_user", "bin_data", "role_id", "server_id", "role_index"].includes(c)) {
        return `${c} = COALESCE(excluded.${c}, tokens.${c})`;
      }
      return `${c} = excluded.${c}`;
    })
    .join(",\n      ");
  const stmt = db.prepare(`
    INSERT INTO tokens (${cols})
    VALUES (${slots})
    ON CONFLICT(id) DO UPDATE SET
      ${setClause}
  `);
  const run = db.transaction((list) => {
    for (const t of list) stmt.run(normalizeTokenInput(t));
  });
  run(rows);
  return rows.length;
}

/** 记录 token 最近一次被任务使用的时间 */
export function updateTokenLastUsed(id) {
  db.prepare("UPDATE tokens SET last_used = ? WHERE id = ?").run(now(), String(id));
}

/** 续期成功后回写新的 roleToken（不覆盖凭证字段） */
export function updateTokenCredential(id, { token, last_refreshed }) {
  const fields = [];
  const values = [];
  if (token != null) {
    fields.push("token = ?");
    values.push(token);
  }
  fields.push("last_refreshed = ?");
  values.push(last_refreshed ?? now());
  values.push(String(id));
  db.prepare(`UPDATE tokens SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getToken(id);
}

export function deleteToken(id) {
  return db.prepare("DELETE FROM tokens WHERE id = ?").run(String(id)).changes;
}

// ==================== cron_tasks ====================

export function getAllTasks() {
  return db
    .prepare("SELECT * FROM cron_tasks ORDER BY created_at ASC")
    .all()
    .map(taskRow);
}

export function getEnabledTasks() {
  return db
    .prepare("SELECT * FROM cron_tasks WHERE enabled = 1")
    .all()
    .map(taskRow);
}

export function getTask(id) {
  return taskRow(
    db.prepare("SELECT * FROM cron_tasks WHERE id = ?").get(String(id)),
  );
}

function normalizeTaskInput(input, existing) {
  const expr = input.cron_expr ?? input.cron_expression ?? existing?.cron_expr ?? null;
  const selectedTokens =
    input.selected_tokens ?? input.token_ids ?? existing?.selected_tokens ?? [];
  return {
    id: String(input.id ?? existing?.id),
    name: input.name ?? existing?.name ?? null,
    enabled:
      input.enabled === undefined
        ? existing?.enabled === false
          ? 0
          : 1
        : input.enabled === false || input.enabled === 0
          ? 0
          : 1,
    cron_expr: expr,
    cron_expression: input.cron_expression ?? existing?.cron_expression ?? null,
    selected_tokens: stringifyArray(selectedTokens),
    selected_tasks: stringifyArray(
      input.selected_tasks ?? existing?.selected_tasks ?? [],
    ),
    task_type: input.task_type ?? existing?.task_type ?? null,
    created_at: input.created_at ?? existing?.created_at ?? now(),
  };
}

export function insertTask(input) {
  const row = normalizeTaskInput(input, null);
  db.prepare(`
    INSERT INTO cron_tasks (id, name, enabled, cron_expr, cron_expression,
      selected_tokens, selected_tasks, task_type, created_at)
    VALUES (@id, @name, @enabled, @cron_expr, @cron_expression,
      @selected_tokens, @selected_tasks, @task_type, @created_at)
  `).run(row);
  return getTask(row.id);
}

export function updateTask(id, patch) {
  const existing = db.prepare("SELECT * FROM cron_tasks WHERE id = ?").get(String(id));
  if (!existing) return undefined;
  const row = normalizeTaskInput({ ...patch, id: String(id) }, existing);
  db.prepare(`
    UPDATE cron_tasks SET name=@name, enabled=@enabled, cron_expr=@cron_expr,
      cron_expression=@cron_expression, selected_tokens=@selected_tokens,
      selected_tasks=@selected_tasks, task_type=@task_type
    WHERE id=@id
  `).run(row);
  return getTask(id);
}

export function deleteTask(id) {
  return db.prepare("DELETE FROM cron_tasks WHERE id = ?").run(String(id)).changes;
}

export function updateTaskLastRun(id) {
  db.prepare("UPDATE cron_tasks SET last_run_at = ? WHERE id = ?").run(
    now(),
    String(id),
  );
}

// ==================== task_logs ====================

export function insertLog(row) {
  const info = db.prepare(`
    INSERT INTO task_logs (task_id, token_name, task_type, status, message, created_at)
    VALUES (@task_id, @token_name, @task_type, @status, @message, @created_at)
  `).run({
    task_id: row.task_id ?? null,
    token_name: row.token_name ?? null,
    task_type: row.task_type ?? null,
    status: row.status ?? null,
    message: row.message ?? null,
    created_at: now(),
  });
  return info.lastInsertRowid;
}

export function getLogs(limit = 100) {
  return db
    .prepare("SELECT * FROM task_logs ORDER BY created_at DESC LIMIT ?")
    .all(Math.min(limit, 1000));
}

export function deleteOldLogs(beforeISO) {
  return db.prepare("DELETE FROM task_logs WHERE created_at < ?").run(beforeISO)
    .changes;
}

export function countLogs() {
  return db.prepare("SELECT COUNT(*) AS n FROM task_logs").get().n;
}

export function getDbPath() {
  return DB_PATH;
}
