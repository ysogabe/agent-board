import { SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearJwksCache, verifyAccess } from "../src/access";
import { sameOrigin } from "../src/admin";
import type { Env } from "../src/config";

const TEAM = "yoshio.cloudflareaccess.com";
const AUD = "aud-1234";
const EMAIL = "yoshio@example.com";
const accessEnv = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAIL: EMAIL } as unknown as Env;

let keys: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };

const b64url = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b as ArrayBuffer);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function sign(payload: Record<string, unknown>, kid = "k1"): Promise<string> {
  const h = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const p = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

const now = Math.floor(Date.now() / 1000);
const good = { aud: [AUD], email: EMAIL, exp: now + 600, iat: now, iss: `https://${TEAM}` };
const fetcher = async () => ({ keys: [jwk] });
const req = (token: string) => new Request("https://board.test/admin", { headers: { "Cf-Access-Jwt-Assertion": token } });

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = { ...((await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey), kid: "k1" };
});
beforeEach(() => clearJwksCache());

describe("Cloudflare Access の確認", () => {
  it("正しいトークンなら通す", async () => {
    expect(await verifyAccess(req(await sign(good)), accessEnv, fetcher)).toBe(EMAIL);
  });

  it("クッキーからも読む", async () => {
    const r = new Request("https://board.test/admin", { headers: { Cookie: `a=b; CF_Authorization=${await sign(good)}` } });
    expect(await verifyAccess(r, accessEnv, fetcher)).toBe(EMAIL);
  });

  it.each([
    ["宛先が違う", { ...good, aud: ["other"] }],
    ["メールが違う", { ...good, email: "someone@example.com" }],
    ["期限切れ", { ...good, exp: now - 10 }],
    ["発行元が違う", { ...good, iss: "https://evil.cloudflareaccess.com" }],
  ])("%s なら通さない", async (_label, payload) => {
    expect(await verifyAccess(req(await sign(payload)), accessEnv, fetcher)).toBeNull();
  });

  it("署名が合わなければ通さない", async () => {
    const t = await sign(good);
    const forged = t.split(".");
    forged[1] = b64url(JSON.stringify({ ...good, email: EMAIL.toUpperCase(), exp: now + 9999 }));
    expect(await verifyAccess(req(forged.join(".")), accessEnv, fetcher)).toBeNull();
  });

  it("設定が空なら通さない", async () => {
    expect(await verifyAccess(req(await sign(good)), {} as Env, fetcher)).toBeNull();
  });
});

describe("/admin", () => {
  it("Access を設定するまでは 503（開いたままにしない）", async () => {
    expect((await SELF.fetch("https://board.test/admin")).status).toBe(503);
  });

  it("フォームは同じオリジンからだけ", () => {
    const mk = (h: Record<string, string>) => new Request("https://board.test/admin/withdraw", { method: "POST", headers: h });
    expect(sameOrigin(mk({ Origin: "https://board.test", "Sec-Fetch-Site": "same-origin" }))).toBe(true);
    expect(sameOrigin(mk({ Origin: "https://evil.test" }))).toBe(false);
    expect(sameOrigin(mk({ Origin: "https://board.test", "Sec-Fetch-Site": "cross-site" }))).toBe(false);
    expect(sameOrigin(mk({}))).toBe(false);
  });
});
