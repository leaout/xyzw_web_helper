import process from "node:process";

/**
 * API 代理中间件（从 Cloudflare worker.js 移植到 Express）
 * ------------------------------------------------------------------
 * 前端的登录/验证码/微信扫码请求走 /api/* 前缀，这里按最长前缀匹配，
 * 转发到游戏服务器并补齐移动端 UA / Referer 等头。
 *
 * 注意：本中间件必须使用 express.raw() 读取原始 body，且要注册在
 * express.json() 之前，否则 JSON body 被提前消费会导致转发丢失。
 */

const PROXIES = [
  {
    prefix: "/api/hortor-ucenter",
    target: "https://comb-platform.hortorgames.com",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 12; ALN-AL80 Build/HUAWEIALN-AL80; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36",
      Accept: "application/json",
      Host: "ucenter-app-server.hortorgames.com",
      "Content-Type": "application/json; charset=utf-8",
    },
  },
  {
    prefix: "/api/weixin-long",
    target: "https://long.open.weixin.qq.com",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 7.0; Mi-4c Build/NRD90M; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/53.0.2785.49 Mobile MQQBrowser/6.2 TBS/043632 Safari/537.36 MicroMessenger/6.6.1.1220(0x26060135) NetType/WIFI Language/zh_CN",
      Accept: "*/*",
      Referer: "https://open.weixin.qq.com/",
    },
  },
  {
    prefix: "/api/weixin",
    target: "https://open.weixin.qq.com",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 7.0; Mi-4c Build/NRD90M; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/53.0.2785.49 Mobile MQQBrowser/6.2 TBS/043632 Safari/537.36 MicroMessenger/6.6.1.1220(0x26060135) NetType/WIFI Language/zh_CN",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      Referer: "https://open.weixin.qq.com/",
    },
  },
  {
    prefix: "/api/hortor",
    target: "https://comb-platform.hortorgames.com",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 12; 23117RK66C Build/V417IR; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/95.0.4638.74 Mobile Safari/537.36",
      Accept: "*/*",
      Host: "comb-platform.hortorgames.com",
      Connection: "keep-alive",
      "Content-Type": "text/plain; charset=utf-8",
      Origin: "https://open.weixin.qq.com",
      Referer: "https://open.weixin.qq.com/",
    },
  },
].sort((a, b) => b.prefix.length - a.prefix.length);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};

// 这些是后端自身的管理接口，不能被代理吃掉
const LOCAL_API_PREFIXES = [
  "/api/tokens",
  "/api/tasks",
  "/api/logs",
  "/api/task-definitions",
];

/** 收集原始请求 body 为 Buffer */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * 创建代理中间件。需在 app.use(express.json()) 之前挂载。
 * @param {(level:string, category:string, message:string, meta?:object)=>void} logger
 */
export function createProxyMiddleware(logger = () => {}) {
  return async function proxyMiddleware(req, res, next) {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    const pathname = req.path;
    if (LOCAL_API_PREFIXES.some((p) => pathname.startsWith(p))) {
      next();
      return;
    }

    const proxy = PROXIES.find((p) => pathname.startsWith(p.prefix));
    if (!proxy) {
      next();
      return;
    }

    const targetUrl = new URL(proxy.target);
    targetUrl.pathname = pathname.replace(proxy.prefix, "") || "/";
    targetUrl.search = req.url.includes("?")
      ? req.url.slice(req.url.indexOf("?"))
      : "";

    // 过滤逐跳头，避免 Node fetch 报非法头
    const hopByHop = new Set([
      "connection",
      "keep-alive",
      "proxy-connection",
      "transfer-encoding",
      "upgrade",
      "content-length",
      "host",
    ]);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (hopByHop.has(k.toLowerCase()) || v === undefined) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    Object.assign(headers, proxy.headers);

    const method = req.method.toUpperCase();
    const init = { method, headers, redirect: "follow" };
    if (!["GET", "HEAD"].includes(method)) {
      init.body = await readRawBody(req);
    }

    const controller = new AbortController();
    const timeout = Number.parseInt(process.env.PROXY_TIMEOUT_MS || "30000", 10);
    const timer = setTimeout(() => controller.abort(), timeout);
    init.signal = controller.signal;

    try {
      const upstream = await fetch(targetUrl.toString(), init);
      clearTimeout(timer);
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (hopByHop.has(lower)) return;
        res.setHeader(key, value);
      });
      Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
    } catch (err) {
      clearTimeout(timer);
      logger("ERROR", "proxy", `代理失败 ${pathname}: ${err.message}`);
      if (!res.headersSent) res.status(502);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: err.message }));
    }
  };
}

export { PROXIES };
