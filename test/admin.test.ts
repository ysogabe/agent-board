import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearJwksCache, verifyAccess } from "../src/access";
import { overview, parseFilter, safeReturnTo, sameOrigin, threadPage } from "../src/admin";
import type { Board } from "../src/board";
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

  it("safeReturnTo は同一サイトの確認ページ URL だけ許可する", () => {
    expect(safeReturnTo("/admin")).toBe("/admin");
    expect(safeReturnTo("/admin?filter=attention")).toBe("/admin?filter=attention");
    expect(safeReturnTo("/admin/thread/t_0123456789abcdef")).toBe("/admin/thread/t_0123456789abcdef");
    expect(safeReturnTo("/admin/thread/t_0123456789abcdef?filter=paused")).toBe(
      "/admin/thread/t_0123456789abcdef?filter=paused",
    );
    expect(safeReturnTo("https://evil.test")).toBe("/admin");
    expect(safeReturnTo("//evil.test")).toBe("/admin");
    expect(safeReturnTo("/admin/other")).toBe("/admin");
    expect(safeReturnTo(null)).toBe("/admin");
    expect(parseFilter("paused")).toBe("paused");
    expect(parseFilter("unknown")).toBe("all");
  });
});

const KEY = {
  daidai: "test-key-daidai-0123456789abcdef0123456789",
  claude: "test-key-claude-0123456789abcdef0123456789",
};
const boardStub = () => env.BOARD.get(env.BOARD.idFromName("board"));

let rpcId = 0;
async function mcpCall(who: keyof typeof KEY, name: string, args: Record<string, unknown> = {}) {
  const res = await SELF.fetch("https://board.test/mcp/key", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY[who]}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return JSON.parse(text.slice(text.indexOf("\n\n") + 2));
}

describe("確認ページの画面（案 A+C）", () => {
  beforeEach(async () => {
    await runInDurableObject(boardStub(), async (_inst: Board, state) => {
      for (const t of ["posts", "threads", "thread_members", "cursors", "audit"]) state.storage.sql.exec(`DELETE FROM ${t}`);
    });
  });

  it("空の掲示板でも厳格な CSP 付きでエラーなく表示できる", async () => {
    const res = await overview(boardStub());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('<details class="triage-drawer">');
    expect(html).not.toContain('<details class="triage-drawer" open>');
    expect(html).toContain("まだスレッドはありません。");
  });

  it("未完了依頼・停止スレッド・Yoshio宛をトリアージと2ペインで表示し、XSSをエスケープする", async () => {
    const t1 = await mcpCall("daidai", "create_thread", {
      title: "UI検討 <script>alert(1)</script>",
      members: ["claude"],
      body: "依頼本文 <b>test</b>",
      kind: "task",
      to_agent: "claude",
    });
    await mcpCall("claude", "post", {
      thread_id: t1.thread_id,
      body: "確認お願いします",
      to_agent: "yoshio",
    });

    const t2 = await mcpCall("claude", "create_thread", {
      title: "停止テスト用スレッド",
      members: ["daidai"],
      body: "1",
    });
    for (let i = 2; i <= 10; i++) {
      await mcpCall(i % 2 ? "claude" : "daidai", "post", { thread_id: t2.thread_id, body: `msg-${i}` });
    }

    // /admin: 要対応があるためトリアージドロワーが初期展開
    const ov = await overview(boardStub());
    expect(ov.status).toBe(200);
    expect(ov.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const ovHtml = await ov.text();
    expect(ovHtml).toContain('<details class="triage-drawer" open>');
    expect(ovHtml).toContain("今対応が必要な項目（再開・取り下げ）");
    expect(ovHtml).toContain('action="/admin/resume"');
    expect(ovHtml).toContain('action="/admin/withdraw"');
    expect(ovHtml).toContain("Yoshio さん宛て");
    expect(ovHtml).not.toContain("<script>alert(1)</script>");
    expect(ovHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

    // /admin/thread/:id: ドロワーは初期閉じ・選択スレッドが右ペインに表示
    const th = await threadPage(boardStub(), t1.thread_id);
    expect(th.status).toBe(200);
    const thHtml = await th.text();
    expect(thHtml).toContain('<details class="triage-drawer">');
    expect(thHtml).not.toContain('<details class="triage-drawer" open>');
    expect(thHtml).toContain("依頼本文 &lt;b&gt;test&lt;/b&gt;");

    // ?filter=paused: 左一覧は停止中スレッドのみ
    const pausedOnly = await overview(boardStub(), { filter: "paused" });
    const pausedHtml = await pausedOnly.text();
    expect(pausedHtml).toContain(`<a class="thread-item active" href="/admin/thread/${t2.thread_id}?filter=paused">`);
    expect(pausedHtml).not.toContain(`<a class="thread-item" href="/admin/thread/${t1.thread_id}?filter=paused">`);

    // 存在しないスレッド ID は 404
    const missing = await threadPage(boardStub(), "t_0000000000000000");
    expect(missing.status).toBe(404);
  });
});
