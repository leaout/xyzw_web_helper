# 后端定时任务部署指南（不用开浏览器也能自动执行）

这套 `render-backend` 是一个常驻的 Node 服务：它用 `node-cron` 按时间表触发游戏任务，
通过 WebSocket 直连游戏服务器执行签到、领奖、爬塔等操作。**部署后即使关掉浏览器，
任务照样按时执行。**

整个链路：

```
浏览器导入 Token ──自动同步──> Supabase.tokens 表
                                      │
                         Render 后端每 5 分钟读取配置
                                      │
                          cron 到点 → 连游戏 WS → 执行任务 → 写日志
```

---

## 第 1 步：创建 Supabase 项目并建表

1. 去 https://supabase.com 新建一个免费项目（记住区域，选离你近的）。
2. 左侧 **SQL Editor** → New query → 粘贴 `render-backend/supabase_schema.sql` 全部内容 → Run。
   执行完应有 `tokens`、`cron_tasks`、`task_logs` 三张表。
3. 左侧 **Settings → API**，记下两个值，后面要用：
   - **Project URL**（即 `SUPABASE_URL`）
   - **service_role** 的 `secret` key（即 `SUPABASE_KEY`，绕过 RLS 最省事）

---

## 第 2 步：部署后端到 Render

**方式 A：Blueprint 一键部署（推荐）**

1. 打开 https://dashboard.render.com → **New → Blueprint**。
2. 连接你的 GitHub 账号，选中 `leaout/xyzw_web_helper` 仓库。
3. Blueprint Path 填 `render-backend/render.yaml`，Apply。
4. 在面板里补填环境变量：
   - `SUPABASE_URL` = 第 1 步的 Project URL
   - `SUPABASE_KEY` = 第 1 步的 service_role key
   - `API_KEY` = Render 已自动生成，点开复制保存好（前端要用）
5. 等部署完成，访问 `https://xyzw-backend.onrender.com/health`，
   看到 `{"status":"ok",...}` 就成功了。记下这个地址。

> 注意：Render 免费层 15 分钟无访问会休眠，唤醒需几十秒。定时任务由服务内部的
> node-cron 触发，属于进程内部计时，休眠期间不会执行。若要求准时，建议升级付费层
> （$7/月）或用常驻 VPS。

**方式 B：Web Service 手动创建**

不选 Blueprint，直接 New → Web Service，填：

| 项 | 值 |
|----|----|
| Runtime | Node |
| Root Directory | `render-backend` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| 环境变量 | 同上（PORT 默认 3000） |

---

## 第 3 步：前端配置（个人设置页）

1. 打开部署好的网页版工具 → **个人设置**。
2. 找到新增的 **「后端定时任务同步」** 卡片，打开开关。
3. 填入：
   - 后端地址：第 2 步记下的 `https://xyzw-backend.onrender.com`
   - API 密钥：第 2 步的 `API_KEY`
4. 点 **测试连接**，提示"连接成功"即配置正确。
5. 点 **同步全部 Token**，把你浏览器里已有的角色全部推到后端。

之后每次新导入角色，都会自动同步到后端，不用再手动操作。

---

## 第 4 步：创建定时任务

任务配置存在 Supabase 的 `cron_tasks` 表。在 **SQL Editor** 里插入，例如：

```sql
insert into public.cron_tasks (id, name, enabled, cron_expr, selected_tokens, selected_tasks)
values (
  'daily-morning',                    -- 任意唯一 id
  '每日签到挂机',
  true,
  '0 8 * * *',                         -- 每天北京时间 8:00（cron 用 5 段，时区 Asia/Shanghai）
  '["token_xxx_yyy"]'::jsonb,          -- 要执行的 token id 数组（从前端同步过去的 id）
  '["dailyBundle"]'::jsonb             -- 任务类型 key 数组
);
```

**可用任务 key**（来自 `server.js` 的 `TASK_DEFINITIONS`）：

| key | 含义 | key | 含义 |
|-----|------|-----|------|
| `signIn` | 签到 | `claimHangup` | 领挂机奖励 |
| `claimDaily` | 领日常奖励 | `claimDailyPoint` | 领每日积分 |
| `climbTower` | 爬塔领奖 | `climbWeirdTower` | 怪异塔 |
| `arenaFight` | 竞技场 | `claimMail` | 领邮件附件 |
| `legacyHangup` | 功法挂机 | `heroRecruit` | 武将招募 |
| `studyGame` | 学习问答 | `genieSweep` | 灯神 |
| `openBox` | 开箱 | `legionSignIn` | 军团签到 |
| `bossTower` | 咸王宝库 | `mergeBox` | 合并魔盒 |
| `dailyBundle` | 一键日常（推荐） |  |  |

**cron 表达式**（5 段：分 时 日 月 周，时区固定 Asia/Shanghai）：
- `0 8 * * *` 每天 8:00
- `0 8,20 * * *` 每天 8:00 和 20:00
- `*/30 * * * *` 每 30 分钟
- `0 9 * * 1` 每周一 9:00

**token id 从哪来**：在 Supabase 表编辑器打开 `tokens` 表，`id` 列就是（形如 `token_1234_abcde`）。

**也可以不写 SQL**：后端提供了 API，用 `curl` 创建任务（把 `<BACKEND_URL>`、`<API_KEY>`、token id 换成你的）：

```bash
curl -X POST https://xyzw-backend.onrender.com/api/tasks \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: <API_KEY>' \
  -d '{
    "id": "daily-morning",
    "name": "每日签到挂机",
    "enabled": true,
    "cron_expr": "0 8 * * *",
    "selected_tokens": ["token_xxx_yyy"],
    "selected_tasks": ["dailyBundle"]
  }'
```

---

## 第 5 步：验证

- `GET /health`：看 `activeCrons` 是否等于你启用的任务数。
- `GET /api/logs`（带 x-api-key）：看任务执行日志。
- Supabase `task_logs` 表：每条命令的成功/失败记录。
- 后端每 5 分钟自动重载一次 `cron_tasks`，改完配置最多等 5 分钟生效（重启服务可立即生效）。

---

## 常见问题

**Q：Token 会过期吗？要重新导入吗？**
A：BIN/扫码/手机号/URL 导入的 token 是长期有效的（前端 `cleanExpiredTokens` 不会清理它们）。
若游戏侧踢下线导致 token 失效，需要重新导入，前端会自动同步覆盖。

**Q：前端关了，token 同步还能用吗？**
A：同步只在导入/删除时发生。关掉浏览器不影响后端执行已同步的 token。

**Q：一个任务能对多个角色执行吗？**
A：能。`selected_tokens` 是数组，后端会逐个连接执行，每个角色间隔 2 秒。

**Q：想立刻跑一次测试怎么办？**
A：`POST /api/tasks/<任务id>/run`（带 x-api-key），或在 Supabase 里手动改。

**Q：Render 免费层休眠导致定时任务不执行？**
A：升级到付费层（$7/月）保持常驻，或改用一台 VPS/Cloudflare 之外的常驻主机。
