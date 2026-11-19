/**
 * 后端 Token 同步
 * ------------------------------------------------------------------
 * 把浏览器里的角色 Token 推送到常驻后端 (render-backend)，
 * 让定时任务可以在关掉浏览器后依然执行。
 *
 * 自包含部署下前端与后端同域名：baseUrl 留空即代表当前站点（同源），
 * 只需打开开关并填 API_KEY 即可，无需手填地址。
 *
 * 设计原则：
 * 1. 默认关闭（enabled=false），用户不配置就完全不影响现有前端行为。
 * 2. 所有网络调用失败都静默降级，只在 console 里 warn，绝不抛错/弹窗。
 * 3. 配置存 localStorage，设置一次即可跨会话生效。
 */

const CONFIG_KEY = "xyzw_backend_sync_config";

/** 把配置里的 baseUrl 解析成实际请求根：留空代表同源 */
function resolveBaseUrl(cfg) {
  if (cfg.baseUrl) return cfg.baseUrl.replace(/\/+$/, "");
  // 自包含部署：前端由同一个服务托管，直接用当前源
  return typeof location !== "undefined" ? location.origin : "";
}

/** @returns {{enabled:boolean, baseUrl:string, apiKey:string}} */
export function getBackendSyncConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const cfg = JSON.parse(raw);
      return {
        enabled: !!cfg.enabled,
        baseUrl: (cfg.baseUrl || "").replace(/\/+$/, ""),
        apiKey: cfg.apiKey || "",
      };
    }
  } catch {
    // 配置损坏时按未配置处理
  }
  return { enabled: false, baseUrl: "", apiKey: "" };
}


export function setBackendSyncConfig(cfg) {
  const normalized = {
    enabled: !!cfg.enabled,
    baseUrl: (cfg.baseUrl || "").replace(/\/+$/, ""),
    apiKey: cfg.apiKey || "",
  };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(normalized));
  return normalized;
}

/** 前端 TokenData -> 后端 tokens 表行 */
function toBackendRow(t) {
  return {
    id: String(t.id),
    name: t.name || null,
    token: t.token,
    ws_url: t.wsUrl || null,
    server: t.server || null,
    import_method: t.importMethod || null,
    level: t.level || 1,
    enabled: t.enabled !== false,
    last_used: t.lastUsed || t.createdAt || null,
  };
}

/**
 * 内部请求封装。未启用 / 未配置 / 任何异常都返回 null，不抛出。
 */
async function post(path, body) {
  const cfg = getBackendSyncConfig();
  if (!cfg.enabled) return null;
  const baseUrl = resolveBaseUrl(cfg);
  if (!baseUrl) return null;
  try {
    const resp = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.apiKey,
      },
      body: JSON.stringify(body),
      // 同步是尽力而为，不需要等待用户停留
      keepalive: true,
    });
    if (!resp.ok) {
      console.warn(`[backendSync] ${path} 失败:`, resp.status, await resp.text());
      return null;
    }
    return await resp.json();
  } catch (e) {
    console.warn(`[backendSync] ${path} 异常:`, e?.message || e);
    return null;
  }
}

/** 新增/更新单个 Token（后端按 id upsert） */
export async function syncToken(token) {
  if (!token?.id || !token?.token) return null;
  return post("/api/tokens/sync", { tokens: [toBackendRow(token)] });
}

/** 首次启用时，把当前所有 Token 一次性推送到后端 */
export async function syncAllTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  return post("/api/tokens/sync", { tokens: tokens.map(toBackendRow) });
}

/** 删除单个 Token（fire-and-forget） */
export function removeBackendToken(id) {
  const cfg = getBackendSyncConfig();
  const baseUrl = resolveBaseUrl(cfg);
  if (!cfg.enabled || !baseUrl || !id) return;
  fetch(`${baseUrl}/api/tokens/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "x-api-key": cfg.apiKey },
    keepalive: true,
  }).catch((e) => console.warn("[backendSync] 删除失败:", e?.message || e));
}

/** 测试后端连通性（设置页“测试连接”用） */
export async function testBackendConnection() {
  const cfg = getBackendSyncConfig();
  const baseUrl = resolveBaseUrl(cfg);
  if (!baseUrl) return { ok: false, error: "未填写后端地址" };
  try {
    const resp = await fetch(`${baseUrl}/health`, {
      headers: { "x-api-key": cfg.apiKey },
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    return { ok: true, data: await resp.json() };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
