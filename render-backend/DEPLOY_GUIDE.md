# XYZW 自包含服务部署指南（国内服务器）

一个 Node 进程搞定全部：**前端页面 + API 代理 + 定时任务 + SQLite 数据库**。
部署到一台国内服务器后，浏览器访问一个地址即可使用；关掉浏览器，定时任务照常执行。
不再依赖 Cloudflare / Supabase / Render 等任何境外服务。

---

## 0. 架构说明

```
国内用户浏览器
      │  https://你的域名/  （同源）
      ▼
┌─────────────────────────────────────┐
│  一个 Node 服务（本目录 server.js）   │
│  ├─ 静态前端 dist/  + SPA 回退        │
│  ├─ /api/hortor*  → 代理游戏服务器     │
│  ├─ /api/tokens, /api/tasks ...      │
│  ├─ node-cron 定时任务（Asia/Shanghai）│
│  └─ SQLite 本地数据库 data/xyzw.db    │
└─────────────────────────────────────┘
```

数据全部落在服务器本地的 `data/xyzw.db`，单文件、好备份。

---

## 1. 准备服务器

- 一台国内云服务器（阿里云 / 腾讯云 / 华为云均可），最低 1核1G 足够。
- 系统建议 Ubuntu 22.04 / Debian 12。
- **Node.js 18+**（`better-sqlite3` 需要，建议用 Node 20 LTS）。
- 若要给别人访问，需要**已备案域名**指向这台服务器（国内 80/443 必须备案）；
  仅自己/内网使用可直接用 IP + 端口，无需域名备案。

安装 Node 20（Ubuntu/Debian）：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # 确认 v20.x
```

---

## 2. 上传代码并构建前端

把整个仓库放到服务器，例如 `/opt/xyzw`：

```bash
sudo mkdir -p /opt/xyzw
cd /opt/xyzw
# 用 git clone 或 scp 上传，此处以 clone 为例
git clone https://github.com/leaout/xyzw_web_helper.git .
```

构建前端（`pnpm` 或 `npm` 均可）：

```bash
# 用 corepack 启用 pnpm（若没有）
corepack enable && corepack prepare pnpm@latest --activate

pnpm install
pnpm build          # 生成 dist/ 目录
```

确认 `dist/index.html` 已生成。

---

## 3. 配置后端

```bash
cd /opt/xyzw/render-backend
pnpm install                 # 安装后端依赖（含 better-sqlite3）
cp .env.example .env
nano .env
```

`.env` 关键项：

```ini
PORT=3000
HOST=0.0.0.0
API_KEY=换成你自己的一长串随机字符串
# 一般不用改，默认会用 ../dist 和 ./data/xyzw.db
```

> **API_KEY**：公网部署强烈建议设置。前端设置页要填同一个值。
> 生成随机串：`openssl rand -hex 24`

先前台跑一次验证：

```bash
pnpm start
# 另开一个终端
curl http://127.0.0.1:3000/health
# 应返回 {"status":"ok", ... "dbPath": "..."}
```

看到 `status: ok` 就说明服务正常。浏览器打开 `http://服务器IP:3000` 应能看到前端页面。

---

## 4. （推荐）用 systemd 常驻 + nginx 反代

### 4.1 systemd 开机自启

创建 `/etc/systemd/system/xyzw.service`：

```ini
[Unit]
Description=XYZW Self-hosted Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/xyzw/render-backend
EnvironmentFile=/opt/xyzw/render-backend/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> `ExecStart` 里的 node 路径用 `which node` 查到的实际路径替换。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now xyzw
sudo systemctl status xyzw      # 确认 active (running)
sudo journalctl -u xyzw -f      # 实时看日志
```

### 4.2 nginx 反向代理 + HTTPS

有域名的话用 nginx 反代到 3000 端口，并配证书（如 Let's Encrypt）：

```nginx
server {
    listen 443 ssl http2;
    server_name 你的域名;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    client_max_body_size 8m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_read_timeout 120s;   # 代理游戏接口可能需要较长超时
    }
}

server {
    listen 80;
    server_name 你的域名;
    return 301 https://$host$request_uri;
}
```

`sudo nginx -t && sudo systemctl reload nginx`，然后浏览器访问 `https://你的域名`。

---

## 5. 前端开启同步

1. 打开站点 → **个人设置** → 「后端定时任务同步」卡片
2. 打开开关
3. **后端地址留空**（同源部署自动用当前站点）
4. 填入第 3 步设的 `API_KEY`
5. 点「测试连接」→ 显示成功即可
6. 点「同步全部 Token」→ 把浏览器里已有的角色推到后端

之后在浏览器导入新 Token 也会自动同步。

---

## 5.5 完全后台：Token 自动续期（重点）

这个服务**不需要一直开着浏览器**。任务执行、定时调度、Token 续期全部在后端完成。
原理是：任何导入方式（bin / 扫码 / 手机 / URL）最终都会产出一份**原始 bin 凭证**，
前端会把它（base64）连同 `sourceUrl` 等一起同步到后端。后端凭这些凭证，
自己调用游戏的 `login/authuser` 接口换取新的 roleToken——和浏览器里的
`transformToken()` 逻辑完全一致。

### 续期是如何工作的

1. **执行前**：若某 token 距上次刷新超过 12 小时，后端先用凭证换新 roleToken 再执行。
2. **执行中**：若连接报「token 过期/失效」，后端自动强制刷新一次并重试。
3. **无凭证**：没有 bin/sourceUrl 的 token（如纯手动导入）无法续期，只能用导入时的
   roleToken，过期后需重新导入。

### 确保自动续期生效的注意事项

- **导入时不要勾选「强制下线账号」**（扫码/手机表单里的 `saveCombUser` 选项）。
  勾选后前端只保存 combUser、不保存 bin，而 combUser 重建 bin 依赖浏览器加密模块，
  后端无法完成 → 这类 token 无法自动续期。默认不勾选，正常都能续期。
- **开启同步后，务必点一次「同步全部 Token」**：这一步会把已导入角色的 bin 凭证
  一并推送到后端。仅靠自动同步钩子，旧 token 可能没带上 bin。
- URL 导入方式只要 `sourceUrl` 长期有效，后端就能一直续期，最省事。
- 续期需要后端服务器能访问 `xxz-xyzw.hortorgames.com`（国内服务器通常可达）。

### 查看某 token 是否具备续期能力

```bash
curl -H "x-api-key: <API_KEY>" http://127.0.0.1:3000/api/tokens | \
  jq '.[] | {name, has_bin: (.bin_data != null), has_url: (.source_url != null), last_refreshed}'
```

`has_bin` 或 `has_url` 至少有一个为 true，才支持自动续期。

---

## 6. 创建定时任务

定时任务存在 SQLite 里。用 API 创建最直接（替换 `<API_KEY>`）：

```bash
# 每天 08:00 对某角色执行「一键日常」
curl -X POST http://127.0.0.1:3000/api/tasks \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_KEY>" \
  -d '{
    "id": "daily-0800",
    "name": "每日一键日常",
    "enabled": true,
    "cron_expr": "0 8 * * *",
    "selected_tokens": ["这里填token的id"],
    "selected_tasks": ["dailyBundle"]
  }'
```

- `cron_expr` 是 5 段 cron，时区固定 `Asia/Shanghai`。
- `selected_tokens`：token 的 id 数组（可在前端同步后从 `/api/tokens` 查）。
- `selected_tasks`：任务 key 数组，可选值见 `GET /api/task-definitions`，常用的有：
  `signIn`、`claimHangup`、`claimMail`、`climbTower`、`arenaFight`、
  `legacyHangup`、`bossTower`、`legionSignIn`、`dailyBundle` 等。

立即手动触发一次（验证能不能跑通）：

```bash
curl -X POST http://127.0.0.1:3000/api/tasks/daily-0800/run \
  -H "x-api-key: <API_KEY>"
```

查看执行日志：

```bash
curl http://127.0.0.1:3000/api/logs/db?limit=50 -H "x-api-key: <API_KEY>"
```

也随时可以 `sudo journalctl -u xyzw -f` 看实时日志。

---

## 7. 数据备份

SQLite 是单文件，直接复制即可（建议停服或低峰期）：

```bash
cp /opt/xyzw/render-backend/data/xyzw.db /备份路径/xyzw-$(date +%F).db
```

配合 crontab 每天自动备份：

```bash
0 3 * * * cp /opt/xyzw/render-backend/data/xyzw.db /backup/xyzw-$(date +\%F).db
```

---

## 8. 常见问题

- **页面能开但登录/验证码失败**：检查代理是否正常——看 `journalctl` 里有没有
  `[proxy] 代理失败`，多为服务器无法访问游戏/微信域名或超时，可调大 `PROXY_TIMEOUT_MS`。
- **定时任务没执行**：确认 `enabled=true`、cron 表达式正确、token 已同步且 `enabled`，
  并看 `/health` 的 `activeCrons` 是否 > 0。改配置后最多 5 分钟自动重载。
- **Token 同步 401**：前端填的 API_KEY 与后端 `.env` 不一致。
- **WAL 文件**：data 目录下出现 `xyzw.db-wal`/`xyzw.db-shm` 是正常的，备份时三个一起拷更稳妥。
- **前端构建产物更新**：每次改前端代码后要在服务器重新 `pnpm build`，并重启服务或刷新。

---

## 9. API 一览

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| GET | `/health` | 健康检查 | 否 |
| GET | `/api/tokens` | 列出 token | 是* |
| POST | `/api/tokens/sync` | 批量 upsert（前端同步用） | 是* |
| DELETE | `/api/tokens/:id` | 删除 token | 是* |
| GET | `/api/tasks` | 列出定时任务 | 是* |
| POST | `/api/tasks` | 新建定时任务 | 是* |
| PATCH | `/api/tasks/:id` | 修改定时任务 | 是* |
| DELETE | `/api/tasks/:id` | 删除定时任务 | 是* |
| POST | `/api/tasks/:id/run` | 立即执行 | 是* |
| GET | `/api/logs` / `/api/logs/db` | 执行日志 | 是* |
| GET | `/api/task-definitions` | 任务类型清单 | 是* |

\* 配置了 API_KEY 时需要，未配置则免鉴权。

（说明：本工具涉及游戏协议自动化与 Token 模拟登录，账号与合规风险请自行评估。）
