-- ============================================================
-- XYZW 自动化后端 - Supabase 建表脚本
-- 用法：Supabase 控制台 -> SQL Editor -> 粘贴整体执行（可重复执行）
-- ============================================================

-- ------------------------------------------------------------
-- 1. tokens：游戏角色 Token
--    前端导入角色后自动同步到此表。
--    token 列存的是 transformToken() 产出的完整 JSON 字符串
--    （内含 roleToken/sessId/connId/isRestore），后端会自动 JSON.parse。
--    id 用前端生成的字符串 ID（如 token_123_xxx），故主键为 text。
-- ------------------------------------------------------------
create table if not exists public.tokens (
  id            text primary key,
  name          text,
  token         text not null,
  ws_url        text,
  remark        text,
  server        text,
  level         integer default 1,
  profession    text,
  import_method text,
  enabled       boolean default true,
  created_at    timestamptz default now(),
  last_used     timestamptz
);

-- ------------------------------------------------------------
-- 2. cron_tasks：定时任务配置
--    selected_tokens / selected_tasks 存 JSON 数组（uuid/任务 key）。
-- ------------------------------------------------------------
create table if not exists public.cron_tasks (
  id              text primary key,
  name            text,
  enabled         boolean default true,
  cron_expr       text not null,             -- 5 段 cron，如 "0 8 * * *"
  selected_tokens jsonb default '[]'::jsonb, -- token id 数组
  selected_tasks  jsonb default '[]'::jsonb, -- TASK_DEFINITIONS 的 key 数组
  task_type       text,                       -- 兼容旧版单任务字段
  last_run_at     timestamptz,
  created_at      timestamptz default now()
);

-- ------------------------------------------------------------
-- 3. task_logs：任务执行日志
-- ------------------------------------------------------------
create table if not exists public.task_logs (
  id         bigint generated always as identity primary key,
  task_id    text,
  token_name text,
  task_type  text,
  status     text,
  message    text,
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- 4. 权限：后端用 SUPABASE_KEY 直连，这里放开 anon 访问。
--    若你用的是 service_role key，可跳过这一段。
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['tokens','cron_tasks','task_logs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "anon_all" on public.%I', t);
    execute format('create policy "anon_all" on public.%I for all to anon using (true) with check (true)', t);
  end loop;
end $$;
