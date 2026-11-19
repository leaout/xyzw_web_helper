import process from "node:process";

/**
 * 保护后端管理 API。
 * ------------------------------------------------------------------
 * - 未配置 API_KEY：直接放行（方便本地/内网使用，公网部署强烈建议配置）。
 * - 已配置：接受 x-api-key 或 Authorization: Bearer <key>。
 * /health 不经过此中间件，始终公开。
 */
export function createApiKeyMiddleware(getApiKey = () => process.env.API_KEY) {
  return (req, res, next) => {
    const expected = getApiKey();
    // 未配置密钥 -> 免鉴权（本地开发 / 内网 trusted 环境）
    if (!expected) return next();

    const provided =
      req.header("x-api-key") ||
      req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (provided !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };
}
