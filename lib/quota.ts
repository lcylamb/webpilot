import { createHash } from "crypto";
import path from "path";
import fs from "fs";

/**
 * 每日用量配额（持久化，SQLite）。
 *
 * 只在设置了 ACCESS_TOKEN 的部署态启用（quotaEnabled()）——本地开发不设，
 * 一切限制都不生效。防的是「口令扩散后当天被烧光 LLM 额度」，两层：
 *
 * 1. 按口令持有者：每人每天最多 DAILY_TASK_LIMIT 次任务、
 *    DAILY_TOKEN_LIMIT 个 token（prompt+completion 合计）。
 * 2. 按 IP：每个 IP 每天最多 IP_DAILY_TASK_LIMIT 次任务（口令正确也计），
 *    防一个口令被多人共享时总量失控。
 *
 * 超限返回 429。存储在 data/usage.db，服务重启不丢。
 * 数据库任何故障都降级为「放行」并留痕——配额是护栏，不能反过来杀死主功能。
 */

const DAILY_TASK_LIMIT = Number(process.env.DAILY_TASK_LIMIT ?? 20);
const DAILY_TOKEN_LIMIT = Number(process.env.DAILY_TOKEN_LIMIT ?? 200_000);
const IP_DAILY_TASK_LIMIT = Number(process.env.IP_DAILY_TASK_LIMIT ?? 50);

type Usage = { tasks: number; prompt: number; completion: number };

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function openDb() {
  const dir = process.env.MEMORY_DIR
    ? path.resolve(process.env.MEMORY_DIR)
    : path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  const db = new Database(path.join(dir, "usage.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      day        TEXT NOT NULL,
      identity   TEXT NOT NULL,
      tasks      INTEGER NOT NULL DEFAULT 0,
      prompt     INTEGER NOT NULL DEFAULT 0,
      completion INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, identity)
    )
  `);
  return db;
}

function getUsage(db: any, identity: string): Usage {
  const row = db
    .prepare("SELECT tasks, prompt, completion FROM usage WHERE day = ? AND identity = ?")
    .get(today(), identity) as Usage | undefined;
  return row ?? { tasks: 0, prompt: 0, completion: 0 };
}

function bump(db: any, identity: string, fields: { tasks?: number; prompt?: number; completion?: number }) {
  db.prepare(`
    INSERT INTO usage (day, identity, tasks, prompt, completion)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(day, identity) DO UPDATE SET
      tasks = tasks + excluded.tasks,
      prompt = prompt + excluded.prompt,
      completion = completion + excluded.completion
  `).run(
    today(),
    identity,
    fields.tasks ?? 0,
    fields.prompt ?? 0,
    fields.completion ?? 0,
  );
}

export function quotaEnabled(): boolean {
  return Boolean(process.env.ACCESS_TOKEN?.trim());
}

export function tokenIdentity(providedToken: string): string {
  return "tok:" + createHash("sha256").update(providedToken).digest("hex").slice(0, 16);
}

export function ipIdentity(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() || "unknown";
  return "ip:" + ip;
}

export type ReserveResult = { ok: true; identity: string } | { ok: false; message: string };

/**
 * 校验并预留一次任务名额：通过后任务数 +1（即便任务中途失败也计入，
 * 防止「发起一万次必然超时的任务」绕过次数配额）。
 * token 消耗在任务结束后由 addTokenUsage() 回补。
 */
export function checkAndReserve(req: Request, providedToken: string): ReserveResult {
  if (!quotaEnabled()) return { ok: true, identity: "" };

  try {
    const db = openDb();
    const ipId = ipIdentity(req);

    // 第一层：按 IP（口令正确也计，防一个口令传遍一群人）
    const ipUsage = getUsage(db, ipId);
    if (ipUsage.tasks >= IP_DAILY_TASK_LIMIT) {
      return { ok: false, message: `今日任务数已达上限（每 IP ${IP_DAILY_TASK_LIMIT} 次/天），请明天再试` };
    }

    // 第二层：按口令持有者
    let identity = "";
    if (providedToken) {
      identity = tokenIdentity(providedToken);
      const u = getUsage(db, identity);
      if (u.tasks >= DAILY_TASK_LIMIT) {
        return { ok: false, message: `今日任务数已达上限（${DAILY_TASK_LIMIT} 次/天），请明天再试` };
      }
      if (u.prompt + u.completion >= DAILY_TOKEN_LIMIT) {
        return { ok: false, message: `今日 token 用量已达上限（${DAILY_TOKEN_LIMIT}），请明天再试` };
      }
    }

    bump(db, ipId, { tasks: 1 });
    if (identity) bump(db, identity, { tasks: 1 });
    return { ok: true, identity };
  } catch (err) {
    // 配额系统故障不能杀死主功能：放行，留痕
    console.error("[quota] checkAndReserve failed, allowing request:", err);
    return { ok: true, identity: "" };
  }
}

/** 任务结束后回补 token 消耗（从 report 事件取数）。 */
export function addTokenUsage(identity: string, promptTokens: number, completionTokens: number) {
  if (!identity || (!promptTokens && !completionTokens)) return;
  try {
    const db = openDb();
    bump(db, identity, { prompt: promptTokens, completion: completionTokens });
  } catch (err) {
    console.error("[quota] addTokenUsage failed:", err);
  }
}
