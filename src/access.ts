// /admin を守る Cloudflare Access の JWT を確かめる。
// Access の前段だけに頼らず、Worker 側でも署名・宛先（aud）・期限・メールアドレスを確認する。

import type { Env } from "./config";

interface Jwk extends JsonWebKey {
  kid?: string;
}

export type JwksFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

let cache: { url: string; at: number; keys: Jwk[] } | null = null;
const CACHE_MS = 10 * 60 * 1000;

const defaultFetcher: JwksFetcher = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Access の公開鍵を取れません: ${r.status}`);
  return (await r.json()) as { keys: Jwk[] };
};

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodePart<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(s))) as T;
}

export function accessConfigured(env: Env): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD && env.ADMIN_EMAIL);
}

function teamOrigin(env: Env): string {
  const d = String(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${d}`;
}

function tokenFrom(req: Request): string | null {
  const h = req.headers.get("Cf-Access-Jwt-Assertion");
  if (h) return h;
  const cookie = req.headers.get("Cookie") ?? "";
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m?.[1] ?? null;
}

/** 確かめられたら Yoshio さんのメールアドレスを返す。だめなら null */
export async function verifyAccess(
  req: Request,
  env: Env,
  fetcher: JwksFetcher = defaultFetcher,
  now = Date.now(),
): Promise<string | null> {
  if (!accessConfigured(env)) return null;
  const token = tokenFrom(req);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; exp?: number; nbf?: number; iss?: string; email?: string };
  try {
    header = decodePart(h);
    payload = decodePart(p);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  const origin = teamOrigin(env);
  const url = `${origin}/cdn-cgi/access/certs`;
  if (!cache || cache.url !== url || now - cache.at > CACHE_MS || !cache.keys.some((k) => k.kid === header.kid)) {
    try {
      cache = { url, at: now, keys: (await fetcher(url)).keys };
    } catch {
      return null;
    }
  }
  const jwk = cache.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlDecode(sig),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return null;

  const sec = Math.floor(now / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(String(env.ACCESS_AUD))) return null;
  if (typeof payload.exp !== "number" || payload.exp < sec) return null;
  if (typeof payload.nbf === "number" && payload.nbf > sec + 60) return null;
  if (payload.iss !== origin) return null;
  if (!payload.email || payload.email.toLowerCase() !== String(env.ADMIN_EMAIL).toLowerCase()) return null;
  return payload.email;
}

/** 試験用 */
export function clearJwksCache() {
  cache = null;
}
