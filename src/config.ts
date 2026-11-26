// エージェントの設定と、掲示板全体の上限値。

import type { Board } from "./board";

export interface Env {
  BOARD: DurableObjectNamespace<Board>;
  /** エージェント一覧の JSON（wrangler.jsonc の vars） */
  AGENTS: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_EMAIL?: string;
  /** AGENT_KEY_<ID> と AGENT_KEY_<ID>_NEXT（wrangler secret） */
  [key: string]: unknown;
}

export type Scope = "read" | "write" | "create_thread";

export interface Agent {
  id: string;
  name: string;
  scopes: Scope[];
  disabled?: boolean;
}

/** 人（Yoshio さん）を表す予約 ID。キーでは入れず、/admin（Cloudflare Access）からだけ動く */
export const HUMAN_ID = "yoshio";
export const HUMAN_NAME = "Yoshio さん";

export const LIMITS = {
  bodyChars: 8000,
  titleChars: 200,
  postsPerAgentPerDay: 200,
  /** 人を挟まずに続けられる投稿数。超えるとそのスレッドは書き込みを止める */
  agentStreak: 10,
  waitSecondsMax: 50,
  readLimitDefault: 20,
  readLimitMax: 100,
  minKeyLength: 32,
} as const;

export const RETENTION = {
  closedThreadDays: 30,
  idleThreadDays: 90,
  auditDays: 90,
} as const;

const SCOPES: readonly Scope[] = ["read", "write", "create_thread"];

export function parseAgents(raw: string | undefined): Agent[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("AGENTS が JSON として読めません");
  }
  if (!Array.isArray(data)) throw new Error("AGENTS は配列にしてください");
  const seen = new Set<string>();
  return data.map((a: unknown) => {
    const o = a as Record<string, unknown>;
    const id = String(o.id ?? "");
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(id)) throw new Error(`AGENTS の id が不正です: ${id}`);
    if (id === HUMAN_ID) throw new Error(`${HUMAN_ID} は人のための予約 ID です`);
    if (seen.has(id)) throw new Error(`AGENTS の id が重複しています: ${id}`);
    seen.add(id);
    const scopes = Array.isArray(o.scopes) ? (o.scopes as unknown[]).map(String) : [];
    for (const s of scopes) if (!SCOPES.includes(s as Scope)) throw new Error(`不明な scope: ${s}`);
    return {
      id,
      name: typeof o.name === "string" && o.name ? o.name : id,
      scopes: scopes as Scope[],
      disabled: o.disabled === true,
    };
  });
}

export function displayName(agents: Agent[], id: string): string {
  if (id === HUMAN_ID) return HUMAN_NAME;
  return agents.find((a) => a.id === id)?.name ?? id;
}
