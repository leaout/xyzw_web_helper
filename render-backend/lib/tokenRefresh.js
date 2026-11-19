/**
 * 后端 Token 自动续期引擎
 * ------------------------------------------------------------------
 * 目标：让服务彻底摆脱浏览器。任何导入方式最终都会产出一份"原始 bin
 * 字节"，前端把它（base64）连同 sourceUrl/combUser 一起同步到后端。
 * 后端凭这些凭证，自己调用游戏的 authuser / serverlist 接口换取新的
 * roleToken，从而在 token 过期时自动续期。
 *
 * 原理与前端 src/utils/token.ts 的 transformToken 完全一致：
 *   POST https://xxz-xyzw.hortorgames.com/login/authuser?_seq=1
 *   body = 原始 bin 字节（application/octet-stream）
 *   resp = BON/加密二进制 -> g_utils.parse(buf, 'auto').getData()
 *   roleToken = JSON.stringify({...data, sessId, connId, isRestore: 0})
 */

import { g_utils } from "./bonProtocol.js";

const AUTHUSER_URL =
  "https://xxz-xyzw.hortorgames.com/login/authuser?_seq=1";
const SERVERLIST_URL =
  "https://xxz-xyzw.hortorgames.com/login/serverlist?_seq=3";

/** 解密/解析 bin 的入参：既支持 base64 字符串，也支持 Buffer/Uint8Array */
function toBytes(binData) {
  if (!binData) throw new Error("缺少 bin 凭证");
  if (Buffer.isBuffer(binData)) return binData;
  if (typeof binData === "string") return Buffer.from(binData, "base64");
  if (binData instanceof Uint8Array) return Buffer.from(binData);
  if (Array.isArray(binData)) return Buffer.from(binData);
  throw new Error("无法识别的 bin 凭证格式");
}

function buildRoleToken(data) {
  const currentTime = Date.now();
  const sessId = currentTime * 100 + Math.floor(Math.random() * 100);
  const connId = currentTime + Math.floor(Math.random() * 10);
  return JSON.stringify({
    ...data,
    sessId,
    connId,
    isRestore: 0,
  });
}

/**
 * 用原始 bin 调用 authuser 换取新的 roleToken。
 * @param {string} binData base64 编码的原始 bin 字节
 * @returns {Promise<{token:string, data:object}>}
 */
export async function exchangeBinForToken(binData) {
  const bytes = toBytes(binData);
  const resp = await fetch(AUTHUSER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
      "User-Agent": "Mozilla/5.0",
    },
    body: bytes,
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    throw new Error(`authuser 返回 HTTP ${resp.status}`);
  }
  const arrayBuffer = await resp.arrayBuffer();
  // 后端 bonProtocol 的 g_utils.parse 与前端 src/utils/bonProtocol 同源实现
  const msg = g_utils.parse(arrayBuffer, "auto");
  const data = msg.getData();
  if (!data || typeof data !== "object") {
    throw new Error("authuser 响应解析失败：无有效数据");
  }
  if (!data.roleToken) {
    throw new Error("authuser 响应缺少 roleToken");
  }
  return { token: buildRoleToken(data), data };
}

/**
 * URL 导入方式：直接 GET sourceUrl 拿新 token。
 * 兼容返回纯文本 token、JSON {token:...} 两种形式。
 */
export async function fetchTokenFromUrl(sourceUrl) {
  if (!sourceUrl) throw new Error("缺少 sourceUrl");
  const resp = await fetch(sourceUrl, {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!resp.ok) throw new Error(`sourceUrl 返回 HTTP ${resp.status}`);
  const text = await resp.text();
  let token = text.trim();
  try {
    const json = JSON.parse(text);
    token = json.token || json.data?.token || token;
  } catch {
    /* 纯文本 token，直接用 */
  }
  if (!token || token.length < 8) throw new Error("sourceUrl 未返回有效 token");
  return token;
}

/**
 * 判断一条 token 记录是否具备自动续期能力。
 */
export function canRefresh(row) {
  return Boolean(row?.bin_data || row?.source_url);
}

/**
 * 统一的续期入口。按凭证优先级分派：
 *   1. bin_data  -> authuser（覆盖 bin / singleBin / wxQrcode / mobile / wxForceLogout）
 *   2. source_url -> GET（覆盖 url 导入）
 * @param {object} row tokens 表的一行
 * @returns {Promise<{token:string, via:string}>}
 */
export async function refreshToken(row) {
  if (row.bin_data) {
    const { token } = await exchangeBinForToken(row.bin_data);
    return { token, via: "bin" };
  }
  if (row.source_url) {
    const token = await fetchTokenFromUrl(row.source_url);
    return { token, via: "url" };
  }
  throw new Error("该 token 没有可用的续期凭证（bin_data / source_url 均为空）");
}
