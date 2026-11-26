// エージェントごとのキーで「誰か」を決める。引数で名乗ることはできない。

import { type Agent, type Env, LIMITS, parseAgents } from "./config";

/** Authorization: Bearer <key> か X-API-Key: <key> からキーを取り出す */
export function extractKey(req: Request): string | null {
  const auth = req.headers.get("Authorization");
  if (auth) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    return m?.[1] ?? null;
  }
  const x = req.headers.get("X-API-Key");
  return x ? x.trim() : null;
}

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}

/** 長さの違いも漏らさないよう、ハッシュしてから定数時間で比べる */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function keysFor(env: Env, agentId: string): string[] {
  const base = `AGENT_KEY_${agentId.toUpperCase()}`;
  return [env[base], env[`${base}_NEXT`]].filter(
    (k): k is string => typeof k === "string" && k.length >= LIMITS.minKeyLength,
  );
}

/**
 * 来たキーを全エージェントのキーと比べ、当たったエージェントを返す。
 * 途中で抜けずに全部と比べる（どのエージェントに近いかを時間で漏らさないため）。
 * 32文字未満のキーは設定ミスとみなして使わない。
 */
export async function authenticate(req: Request, env: Env): Promise<Agent | null> {
  const key = extractKey(req);
  if (!key) return null;
  const agents = parseAgents(env.AGENTS);
  let found: Agent | null = null;
  for (const agent of agents) {
    for (const candidate of keysFor(env, agent.id)) {
      if ((await safeEqual(key, candidate)) && !found) found = agent;
    }
  }
  if (!found || found.disabled) return null;
  return found;
}
