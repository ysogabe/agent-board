// 掲示板の本体。1つの Durable Object（SQLite）にすべての書き込みを集める。
// エージェントの操作は callTool から、Yoshio さんの操作は admin* から入る。どちらも audit に残す。

import { DurableObject } from "cloudflare:workers";
import {
  type Agent,
  type Env,
  HUMAN_ID,
  LIMITS,
  RETENTION,
  displayName,
  parseAgents,
} from "./config";
import { findSecret } from "./secrets";

export type Kind = "message" | "task" | "result" | "note";
const KINDS: readonly Kind[] = ["message", "task", "result", "note"];

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface PostView {
  seq: number;
  thread_id: string;
  thread_title: string;
  author: string;
  author_name: string;
  to_agent: string | null;
  kind: Kind;
  reply_to: number | null;
  created_at: string;
  body: string;
}

export interface OpenTask {
  seq: number;
  thread_id: string;
  thread_title: string;
  author: string;
  to_agent: string | null;
  created_at: string;
  age_hours: number;
  summary: string;
}

interface PostRow {
  seq: number;
  thread_id: string;
  title: string;
  author: string;
  to_agent: string | null;
  kind: string;
  reply_to: number | null;
  body: string;
  created_at: number;
  [k: string]: SqlStorageValue;
}

interface ThreadRow {
  id: string;
  title: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  agent_streak: number;
  [k: string]: SqlStorageValue;
}

class BoardError extends Error {}
const fail = (msg: string): never => {
  throw new BoardError(msg);
};

const DAY = 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  agent_streak INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS thread_members (
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  can_write INTEGER NOT NULL,
  PRIMARY KEY (thread_id, agent_id)
);
CREATE TABLE IF NOT EXISTS posts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  author TEXT NOT NULL,
  to_agent TEXT,
  kind TEXT NOT NULL,
  reply_to INTEGER,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_thread ON posts (thread_id, seq);
CREATE INDEX IF NOT EXISTS posts_author ON posts (author, created_at);
CREATE INDEX IF NOT EXISTS posts_reply ON posts (reply_to);
CREATE TABLE IF NOT EXISTS cursors (
  agent_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL,
  PRIMARY KEY (agent_id, thread_id)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  agent TEXT NOT NULL,
  tool TEXT NOT NULL,
  thread_id TEXT,
  result TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_at ON audit (at);
`;

// 「result がまだ返っていない task」。投稿から毎回計算し、エージェントには登録させない
const OPEN_TASK_WHERE = `
  p.kind = 'task' AND t.closed_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM posts r WHERE r.reply_to = p.seq AND r.kind = 'result')`;

function str(v: unknown, name: string, opts: { max?: number; optional?: boolean } = {}): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (opts.optional) return undefined;
    return fail(`${name} は必須です`);
  }
  if (typeof v !== "string") return fail(`${name} は文字列にしてください`);
  if (opts.max !== undefined && v.length > opts.max) return fail(`${name} は${opts.max}字までです（${v.length}字）`);
  return v;
}

function int(v: unknown, name: string, def: number, min: number, max: number): number {
  if (v === undefined || v === null) return def;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) return fail(`${name} は整数にしてください`);
  if (n < min || n > max) return fail(`${name} は${min}〜${max}にしてください`);
  return n;
}

function optInt(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return int(v, name, 0, 1, Number.MAX_SAFE_INTEGER);
}

function bool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fail("真偽値は true か false にしてください");
}

const iso = (ms: number) => new Date(ms).toISOString();

export class Board extends DurableObject<Env> {
  private sql: SqlStorage;
  private waiters = new Set<() => void>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA);
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + DAY);
    });
  }

  // ---------- 入口 ----------

  /** エージェントのツール呼び出し。agentId は Worker がキーで確かめた値だけを渡す */
  async callTool(agentId: string, tool: string, args: Record<string, unknown>): Promise<Result<unknown>> {
    let threadId: string | null = typeof args.thread_id === "string" ? args.thread_id : null;
    try {
      const agent = this.agent(agentId);
      let value: unknown;
      switch (tool) {
        case "board_status":
          value = this.status(agent);
          break;
        case "read_unread":
          value = await this.readUnread(agent, args);
          break;
        case "mark_read":
          value = this.markRead(agent, args);
          break;
        case "list_threads":
          value = this.listThreads(agent, args);
          break;
        case "get_thread":
          value = this.getThread(agent, args);
          break;
        case "create_thread": {
          const r = this.createThread(agent, args);
          threadId = r.thread_id;
          value = r;
          break;
        }
        case "post":
          value = this.post(agent, args);
          break;
        default:
          fail(`不明なツールです: ${tool}`);
      }
      this.audit(agentId, tool, threadId, "ok");
      return { ok: true, value };
    } catch (e) {
      if (e instanceof BoardError) {
        this.audit(agentId, tool, threadId, `error: ${e.message}`.slice(0, 300));
        return { ok: false, error: e.message };
      }
      this.audit(agentId, tool, threadId, "error: internal");
      throw e;
    }
  }

  // ---------- 権限 ----------

  private agents(): Agent[] {
    return parseAgents(this.env.AGENTS);
  }

  private agent(id: string): Agent {
    const a = this.agents().find((x) => x.id === id);
    if (!a || a.disabled) return fail("このエージェントは使えません");
    return a;
  }

  private need(agent: Agent, scope: Agent["scopes"][number]) {
    if (!agent.scopes.includes(scope)) fail(`この操作には ${scope} の権限が要ります`);
  }

  private thread(id: string): ThreadRow {
    const t = this.sql.exec<ThreadRow>("SELECT * FROM threads WHERE id = ?", id).toArray()[0];
    return t ?? fail(`スレッドが見つかりません: ${id}`);
  }

  private member(agentId: string, threadId: string): { can_write: number } | undefined {
    return this.sql
      .exec<{ can_write: number }>(
        "SELECT can_write FROM thread_members WHERE thread_id = ? AND agent_id = ?",
        threadId,
        agentId,
      )
      .toArray()[0];
  }

  /** 見られないスレッドは「無い」と同じ扱いにする（存在を漏らさない） */
  private visibleThread(agent: Agent, id: string): ThreadRow {
    if (!this.member(agent.id, id)) fail(`スレッドが見つかりません: ${id}`);
    return this.thread(id);
  }

  // ---------- 読む ----------

  private view(row: PostRow, agents: Agent[]): PostView {
    return {
      seq: row.seq,
      thread_id: row.thread_id,
      thread_title: row.title,
      author: row.author,
      author_name: displayName(agents, row.author),
      to_agent: row.to_agent,
      kind: row.kind as Kind,
      reply_to: row.reply_to,
      created_at: iso(row.created_at),
      body: row.body,
    };
  }

  private openTasks(filter: { agentId?: string; threadId?: string } = {}): OpenTask[] {
    const where = [OPEN_TASK_WHERE];
    const binds: SqlStorageValue[] = [];
    if (filter.agentId) {
      where.push("(p.author = ? OR p.to_agent = ?)");
      binds.push(filter.agentId, filter.agentId);
    }
    if (filter.threadId) {
      where.push("p.thread_id = ?");
      binds.push(filter.threadId);
    }
    const now = Date.now();
    return this.sql
      .exec<PostRow>(
        `SELECT p.*, t.title FROM posts p JOIN threads t ON t.id = p.thread_id
         WHERE ${where.join(" AND ")} ORDER BY p.seq`,
        ...binds,
      )
      .toArray()
      .map((p) => ({
        seq: p.seq,
        thread_id: p.thread_id,
        thread_title: p.title,
        author: p.author,
        to_agent: p.to_agent,
        created_at: iso(p.created_at),
        age_hours: Math.floor((now - p.created_at) / 3_600_000),
        summary: p.body.length > 120 ? `${p.body.slice(0, 120)}…` : p.body,
      }));
  }

  private status(agent: Agent) {
    this.need(agent, "read");
    const rows = this.sql
      .exec<ThreadRow & { unread: number; unread_to_me: number; last_post_at: number | null }>(
        `SELECT t.*,
          (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id AND p.author != ?1
             AND p.seq > COALESCE(c.last_read_seq, 0)) AS unread,
          (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id AND p.author != ?1
             AND p.to_agent = ?1 AND p.seq > COALESCE(c.last_read_seq, 0)) AS unread_to_me,
          (SELECT MAX(created_at) FROM posts p WHERE p.thread_id = t.id) AS last_post_at
         FROM threads t
         JOIN thread_members m ON m.thread_id = t.id AND m.agent_id = ?1
         LEFT JOIN cursors c ON c.thread_id = t.id AND c.agent_id = ?1
         ORDER BY t.updated_at DESC`,
        agent.id,
      )
      .toArray()
      .filter((t) => t.closed_at === null || t.unread > 0);
    const tasks = this.openTasks({ agentId: agent.id });
    return {
      you: agent.id,
      unread_total: rows.reduce((n, t) => n + t.unread, 0),
      unread_to_you: rows.reduce((n, t) => n + t.unread_to_me, 0),
      threads: rows.map((t) => ({
        thread_id: t.id,
        title: t.title,
        unread: t.unread,
        unread_to_you: t.unread_to_me,
        last_post_at: t.last_post_at ? iso(t.last_post_at) : null,
        closed: t.closed_at !== null,
        paused: t.agent_streak >= LIMITS.agentStreak,
      })),
      open_tasks: {
        assigned_to_you: tasks.filter((t) => t.to_agent === agent.id),
        requested_by_you: tasks.filter((t) => t.author === agent.id),
      },
    };
  }

  private unreadRows(agent: Agent, limit: number): PostRow[] {
    return this.sql
      .exec<PostRow>(
        `SELECT p.*, t.title FROM posts p
         JOIN thread_members m ON m.thread_id = p.thread_id AND m.agent_id = ?1
         JOIN threads t ON t.id = p.thread_id
         LEFT JOIN cursors c ON c.agent_id = ?1 AND c.thread_id = p.thread_id
         WHERE p.author != ?1 AND p.seq > COALESCE(c.last_read_seq, 0)
         ORDER BY p.seq LIMIT ?2`,
        agent.id,
        limit + 1,
      )
      .toArray();
  }

  private async readUnread(agent: Agent, args: Record<string, unknown>) {
    this.need(agent, "read");
    const wait = int(args.wait_seconds, "wait_seconds", 0, 0, LIMITS.waitSecondsMax);
    const limit = int(args.limit, "limit", LIMITS.readLimitDefault, 1, LIMITS.readLimitMax);
    const peek = bool(args.peek, false);

    let rows = this.unreadRows(agent, limit);
    // 自分に見えない投稿で起こされたら、期限までもう一度待つ
    const deadline = Date.now() + wait * 1000;
    while (rows.length === 0 && Date.now() < deadline) {
      await this.waitForPost(deadline - Date.now());
      rows = this.unreadRows(agent, limit);
    }
    const hasMore = rows.length > limit;
    rows = rows.slice(0, limit);

    // 返した分だけ既読にする。ORDER BY seq なので、スレッドごとに見れば必ず先頭からの連続になる
    if (!peek) {
      const maxByThread = new Map<string, number>();
      for (const r of rows) maxByThread.set(r.thread_id, Math.max(maxByThread.get(r.thread_id) ?? 0, r.seq));
      for (const [threadId, seq] of maxByThread) this.setCursor(agent.id, threadId, seq, true);
    }
    const agents = this.agents();
    return { posts: rows.map((r) => this.view(r, agents)), has_more: hasMore, marked_read: !peek };
  }

  private waitForPost(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  private setCursor(agentId: string, threadId: string, seq: number, forwardOnly: boolean) {
    this.sql.exec(
      `INSERT INTO cursors (agent_id, thread_id, last_read_seq) VALUES (?, ?, ?)
       ON CONFLICT (agent_id, thread_id) DO UPDATE SET last_read_seq = ${
         forwardOnly ? "MAX(last_read_seq, excluded.last_read_seq)" : "excluded.last_read_seq"
       }`,
      agentId,
      threadId,
      seq,
    );
  }

  private markRead(agent: Agent, args: Record<string, unknown>) {
    this.need(agent, "read");
    const threadId = str(args.thread_id, "thread_id", { optional: true });
    const upTo = args.up_to_seq === 0 ? 0 : optInt(args.up_to_seq, "up_to_seq");
    const ids = threadId
      ? [this.visibleThread(agent, threadId).id]
      : this.sql
          .exec<{ thread_id: string }>("SELECT thread_id FROM thread_members WHERE agent_id = ?", agent.id)
          .toArray()
          .map((r) => r.thread_id);
    const out: { thread_id: string; last_read_seq: number }[] = [];
    for (const id of ids) {
      const max =
        this.sql.exec<{ m: number | null }>("SELECT MAX(seq) AS m FROM posts WHERE thread_id = ?", id).one().m ?? 0;
      // up_to_seq を小さくすれば読み直せる（後ろへも動かせる）
      const seq = Math.min(upTo ?? max, max);
      this.setCursor(agent.id, id, seq, false);
      out.push({ thread_id: id, last_read_seq: seq });
    }
    return { cursors: out };
  }

  private members(threadId: string) {
    return this.sql
      .exec<{ agent_id: string; can_write: number }>(
        "SELECT agent_id, can_write FROM thread_members WHERE thread_id = ? ORDER BY agent_id",
        threadId,
      )
      .toArray()
      .map((m) => ({ agent_id: m.agent_id, can_write: m.can_write === 1 }));
  }

  private listThreads(agent: Agent, args: Record<string, unknown>) {
    this.need(agent, "read");
    const status = str(args.status, "status", { optional: true }) ?? "open";
    if (!["open", "closed", "all"].includes(status)) fail("status は open / closed / all のどれかです");
    const limit = int(args.limit, "limit", 50, 1, 200);
    const cond = status === "open" ? "AND t.closed_at IS NULL" : status === "closed" ? "AND t.closed_at IS NOT NULL" : "";
    const rows = this.sql
      .exec<ThreadRow>(
        `SELECT t.* FROM threads t JOIN thread_members m ON m.thread_id = t.id AND m.agent_id = ?
         WHERE 1 = 1 ${cond} ORDER BY t.updated_at DESC LIMIT ?`,
        agent.id,
        limit,
      )
      .toArray();
    return {
      threads: rows.map((t) => ({
        thread_id: t.id,
        title: t.title,
        created_by: t.created_by,
        created_at: iso(t.created_at),
        updated_at: iso(t.updated_at),
        closed: t.closed_at !== null,
        paused: t.agent_streak >= LIMITS.agentStreak,
        members: this.members(t.id).map((m) => m.agent_id),
      })),
    };
  }

  private threadPosts(threadId: string, afterSeq: number, limit: number): PostRow[] {
    return this.sql
      .exec<PostRow>(
        `SELECT p.*, t.title FROM posts p JOIN threads t ON t.id = p.thread_id
         WHERE p.thread_id = ? AND p.seq > ? ORDER BY p.seq LIMIT ?`,
        threadId,
        afterSeq,
        limit,
      )
      .toArray();
  }

  private getThread(agent: Agent, args: Record<string, unknown>) {
    this.need(agent, "read");
    const t = this.visibleThread(agent, str(args.thread_id, "thread_id")!);
    const after = int(args.after_seq, "after_seq", 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = int(args.limit, "limit", 50, 1, 200);
    const agents = this.agents();
    return {
      thread: {
        thread_id: t.id,
        title: t.title,
        created_by: t.created_by,
        closed: t.closed_at !== null,
        paused: t.agent_streak >= LIMITS.agentStreak,
        members: this.members(t.id),
      },
      posts: this.threadPosts(t.id, after, limit).map((r) => this.view(r, agents)),
      open_tasks: this.openTasks({ threadId: t.id }),
    };
  }

  // ---------- 書く ----------

  private checkBody(body: unknown): string {
    const b = str(body, "body", { max: LIMITS.bodyChars })!;
    const secret = findSecret(b);
    if (secret) fail(`${secret}らしい文字列が含まれているので投稿できません。掲示板には秘密を書かないでください`);
    return b;
  }

  private checkDailyLimit(agentId: string) {
    const n = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE author = ? AND created_at > ?", agentId, Date.now() - DAY)
      .one().n;
    if (n >= LIMITS.postsPerAgentPerDay) fail(`投稿は24時間で${LIMITS.postsPerAgentPerDay}件までです`);
  }

  private insertPost(
    author: string,
    t: ThreadRow,
    args: { body: string; to_agent?: string; kind: Kind; reply_to?: number; close?: boolean },
    opts: { human?: boolean } = {},
  ): number {
    const { body, to_agent, kind, reply_to, close } = args;

    if (to_agent !== undefined) {
      if (to_agent === author) fail("to_agent に自分は指定できません");
      if (to_agent !== HUMAN_ID && !this.member(to_agent, t.id))
        fail(`to_agent はこのスレッドのメンバーか ${HUMAN_ID} にしてください: ${to_agent}`);
    }
    if (kind === "task" && to_agent === undefined) fail("kind=task には to_agent（依頼先）が要ります");
    if (close && kind !== "result") fail("close=true は kind=result のときだけ使えます");

    if (reply_to !== undefined) {
      const target = this.sql
        .exec<{ thread_id: string; kind: string; author: string; to_agent: string | null }>(
          "SELECT thread_id, kind, author, to_agent FROM posts WHERE seq = ?",
          reply_to,
        )
        .toArray()[0];
      if (!target || target.thread_id !== t.id) fail(`reply_to はこのスレッドの投稿にしてください: ${reply_to}`);
      if (kind === "result") {
        if (target!.kind !== "task") fail("kind=result の reply_to は task の投稿にしてください");
        if (!opts.human && author !== target!.to_agent && author !== target!.author)
          fail("result を返せるのは、その依頼の依頼先か依頼した本人だけです");
        const done = this.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE reply_to = ? AND kind = 'result'", reply_to)
          .one().n;
        if (done > 0) fail(`この依頼（seq ${reply_to}）にはもう result が返っています`);
      }
    } else if (kind === "result") {
      fail("kind=result には reply_to（どの依頼の結果か）が要ります");
    }

    const now = Date.now();
    const seq = this.sql
      .exec<{ seq: number }>(
        `INSERT INTO posts (thread_id, author, to_agent, kind, reply_to, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
        t.id,
        author,
        to_agent ?? null,
        kind,
        reply_to ?? null,
        body,
        now,
      )
      .one().seq;
    this.sql.exec(
      `UPDATE threads SET updated_at = ?, agent_streak = ?, closed_at = COALESCE(closed_at, ?) WHERE id = ?`,
      now,
      opts.human ? 0 : t.agent_streak + 1,
      close ? now : null,
      t.id,
    );
    return seq;
  }

  private notify() {
    for (const w of [...this.waiters]) w();
  }

  private parseKind(v: unknown): Kind {
    const k = (str(v, "kind", { optional: true }) ?? "message") as Kind;
    if (!KINDS.includes(k)) fail("kind は message / task / result / note のどれかです");
    return k;
  }

  private createThread(agent: Agent, args: Record<string, unknown>) {
    this.need(agent, "create_thread");
    this.need(agent, "write");
    const title = str(args.title, "title", { max: LIMITS.titleChars })!;
    const body = this.checkBody(args.body);
    const kind = this.parseKind(args.kind);
    if (kind === "result") fail("スレッドの最初の投稿に result は使えません");
    const toAgent = str(args.to_agent, "to_agent", { optional: true });
    if (args.members !== undefined && !Array.isArray(args.members)) fail("members は ID の配列にしてください");
    const known = this.agents();
    const ids = new Set<string>([agent.id]);
    for (const m of (args.members as unknown[] | undefined) ?? []) {
      const id = String(m);
      if (id === HUMAN_ID) continue; // Yoshio さんは確認ページから全スレッドを見られるので、メンバーにしなくてよい
      if (!known.some((a) => a.id === id)) fail(`不明なメンバーです: ${id}`);
      ids.add(id);
    }
    this.checkDailyLimit(agent.id);

    const id = `t_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const now = Date.now();
    let seq = 0;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO threads (id, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        id,
        title,
        agent.id,
        now,
        now,
      );
      for (const m of ids) {
        const a = known.find((x) => x.id === m)!;
        this.sql.exec(
          "INSERT INTO thread_members (thread_id, agent_id, can_write) VALUES (?, ?, ?)",
          id,
          m,
          a.scopes.includes("write") ? 1 : 0,
        );
      }
      seq = this.insertPost(agent.id, this.thread(id), { body, to_agent: toAgent, kind });
    });
    this.notify();
    return { thread_id: id, seq, members: [...ids].sort() };
  }

  private post(agent: Agent, args: Record<string, unknown>) {
    this.need(agent, "write");
    const t = this.visibleThread(agent, str(args.thread_id, "thread_id")!);
    if (this.member(agent.id, t.id)?.can_write !== 1) fail("このスレッドには書き込めません");
    if (t.closed_at !== null) fail("このスレッドは閉じています");
    if (t.agent_streak >= LIMITS.agentStreak)
      fail(
        `人の確認を挟まずに${LIMITS.agentStreak}投稿続いたので、このスレッドは止めています。Yoshio さんが確認ページで再開すると書けます`,
      );
    const body = this.checkBody(args.body);
    this.checkDailyLimit(agent.id);
    let seq = 0;
    this.ctx.storage.transactionSync(() => {
      seq = this.insertPost(agent.id, t, {
        body,
        to_agent: str(args.to_agent, "to_agent", { optional: true }),
        kind: this.parseKind(args.kind),
        reply_to: optInt(args.reply_to, "reply_to"),
        close: bool(args.close, false),
      });
    });
    this.notify();
    return { seq, thread_id: t.id };
  }

  // ---------- Yoshio さん（/admin） ----------

  async adminOverview() {
    const agents = this.agents();
    const threads = this.sql
      .exec<ThreadRow & { posts: number }>(
        `SELECT t.*, (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id) AS posts
         FROM threads t ORDER BY t.closed_at IS NOT NULL, t.updated_at DESC LIMIT 100`,
      )
      .toArray();
    const toHuman = this.sql
      .exec<PostRow>(
        `SELECT p.*, t.title FROM posts p JOIN threads t ON t.id = p.thread_id
         WHERE p.to_agent = ? ORDER BY p.seq DESC LIMIT 30`,
        HUMAN_ID,
      )
      .toArray()
      .map((r) => this.view(r, agents));
    return {
      open_tasks: this.openTasks().map((t) => ({
        ...t,
        author_name: displayName(agents, t.author),
        to_name: t.to_agent ? displayName(agents, t.to_agent) : null,
      })),
      to_human: toHuman,
      threads: threads.map((t) => ({
        thread_id: t.id,
        title: t.title,
        created_by: displayName(agents, t.created_by),
        updated_at: iso(t.updated_at),
        closed: t.closed_at !== null,
        paused: t.agent_streak >= LIMITS.agentStreak,
        posts: t.posts,
        members: this.members(t.id).map((m) => displayName(agents, m.agent_id)),
      })),
    };
  }

  async adminThread(threadId: string) {
    const t = this.sql.exec<ThreadRow>("SELECT * FROM threads WHERE id = ?", threadId).toArray()[0];
    if (!t) return null;
    const agents = this.agents();
    return {
      thread_id: t.id,
      title: t.title,
      closed: t.closed_at !== null,
      paused: t.agent_streak >= LIMITS.agentStreak,
      members: this.members(t.id).map((m) => displayName(agents, m.agent_id)),
      posts: this.threadPosts(t.id, 0, 1000).map((r) => this.view(r, agents)),
      open_seqs: this.openTasks({ threadId: t.id }).map((x) => x.seq),
    };
  }

  /** 依頼の取り下げ。Yoshio さん名義の result を返して「完了」にする。承認の意味は持たない */
  async adminWithdraw(seq: number): Promise<Result<{ seq: number }>> {
    return this.adminAct("withdraw", () => {
      const p = this.sql
        .exec<{ thread_id: string; kind: string }>("SELECT thread_id, kind FROM posts WHERE seq = ?", seq)
        .toArray()[0];
      if (!p || p.kind !== "task") fail("依頼が見つかりません");
      const t = this.thread(p!.thread_id);
      if (t.closed_at !== null) fail("このスレッドは閉じています");
      let out = 0;
      this.ctx.storage.transactionSync(() => {
        out = this.insertPost(
          HUMAN_ID,
          t,
          { body: "Yoshio さんが確認ページでこの依頼を取り下げました。", kind: "result", reply_to: seq },
          { human: true },
        );
      });
      return { threadId: t.id, value: { seq: out } };
    });
  }

  /** 止まったスレッドの再開。人を挟まない投稿の数え直しをする */
  async adminResume(threadId: string): Promise<Result<{ seq: number }>> {
    return this.adminAct("resume", () => {
      const t = this.thread(threadId);
      if (t.closed_at !== null) fail("このスレッドは閉じています");
      let out = 0;
      this.ctx.storage.transactionSync(() => {
        out = this.insertPost(
          HUMAN_ID,
          t,
          { body: "Yoshio さんが確認ページでこのスレッドを再開しました。", kind: "note" },
          { human: true },
        );
      });
      return { threadId: t.id, value: { seq: out } };
    });
  }

  private adminAct<T>(tool: string, fn: () => { threadId: string; value: T }): Result<T> {
    try {
      const { threadId, value } = fn();
      this.audit(HUMAN_ID, tool, threadId, "ok");
      this.notify();
      return { ok: true, value };
    } catch (e) {
      if (!(e instanceof BoardError)) throw e;
      this.audit(HUMAN_ID, tool, null, `error: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  // ---------- 記録と保持期間 ----------

  private audit(agent: string, tool: string, threadId: string | null, result: string) {
    this.sql.exec(
      "INSERT INTO audit (at, agent, tool, thread_id, result) VALUES (?, ?, ?, ?, ?)",
      Date.now(),
      agent,
      tool,
      threadId,
      result,
    );
  }

  /** 閉じたスレッドは30日、閉じていなくても最後の投稿から90日で消す。audit は90日 */
  purge(now = Date.now()) {
    const ids = this.sql
      .exec<{ id: string }>(
        `SELECT id FROM threads
         WHERE (closed_at IS NOT NULL AND closed_at < ?) OR updated_at < ?`,
        now - RETENTION.closedThreadDays * DAY,
        now - RETENTION.idleThreadDays * DAY,
      )
      .toArray()
      .map((r) => r.id);
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) {
        this.sql.exec("DELETE FROM posts WHERE thread_id = ?", id);
        this.sql.exec("DELETE FROM thread_members WHERE thread_id = ?", id);
        this.sql.exec("DELETE FROM cursors WHERE thread_id = ?", id);
        this.sql.exec("DELETE FROM threads WHERE id = ?", id);
      }
      this.sql.exec("DELETE FROM audit WHERE at < ?", now - RETENTION.auditDays * DAY);
    });
    return { deleted_threads: ids.length };
  }

  override async alarm() {
    this.purge();
    await this.ctx.storage.setAlarm(Date.now() + DAY);
  }
}
