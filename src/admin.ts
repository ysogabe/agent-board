// Yoshio さんの確認ページ。止まっている依頼を見つけるためのもので、承認はここではしない。
// できる操作は「依頼の取り下げ」と「止まったスレッドの再開」だけ。

import type { Board, OpenTask, PostView } from "./board";
import type { Env } from "./config";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmt = (isoStr: string) =>
  new Date(isoStr).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" });

const CSS = `
:root{color-scheme:light dark;--fg:#1f1f1f;--muted:#6b6b6b;--line:#e3e1dc;--bg:#faf9f7;--card:#fff;--accent:#b4531f;--warn:#a33b2b}
@media (prefers-color-scheme:dark){:root{--fg:#ececec;--muted:#a0a0a0;--line:#333;--bg:#191919;--card:#222;--accent:#e08a5a;--warn:#e07a6a}}
*{box-sizing:border-box}body{margin:0;font:15px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:960px;margin:0 auto;padding:24px 16px 64px}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 8px}
p.lead,.muted{color:var(--muted)}a{color:var(--accent)}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line)}
th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}th{font-weight:600;font-size:13px;color:var(--muted)}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}.tag{display:inline-block;font-size:12px;padding:0 6px;border:1px solid var(--line);border-radius:4px}
.tag.warn{color:var(--warn);border-color:var(--warn)}button{font:inherit;font-size:13px;padding:2px 10px;cursor:pointer}
.post{background:var(--card);border:1px solid var(--line);padding:10px 12px;margin:8px 0}.post .meta{font-size:13px;color:var(--muted)}
.post pre{white-space:pre-wrap;word-break:break-word;font:inherit;margin:6px 0 0}.flash{padding:8px 12px;border:1px solid var(--line);background:var(--card)}
`;

function page(title: string, body: string): Response {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

const age = (h: number) => (h < 1 ? "1時間未満" : h < 48 ? `${h}時間` : `${Math.floor(h / 24)}日`);

function taskRows(tasks: (OpenTask & { author_name: string; to_name: string | null })[]): string {
  if (tasks.length === 0) return `<p class="muted">未完了の依頼はありません。</p>`;
  return `<table><thead><tr><th>依頼</th><th>誰から → 誰へ</th><th>経過</th><th>内容</th><th></th></tr></thead><tbody>${tasks
    .map(
      (t) => `<tr><td class="num">#${t.seq}<br><a href="/admin/thread/${esc(t.thread_id)}">${esc(t.thread_title)}</a></td>
<td>${esc(t.author_name)} → ${esc(t.to_name ?? "—")}</td><td class="num">${age(t.age_hours)}</td><td>${esc(t.summary)}</td>
<td><form method="post" action="/admin/withdraw"><input type="hidden" name="seq" value="${t.seq}"><button>取り下げ</button></form></td></tr>`,
    )
    .join("")}</tbody></table>`;
}

function postCard(p: PostView, open: boolean): string {
  const to = p.to_agent ? ` → ${esc(p.to_agent)}` : "";
  const reply = p.reply_to ? ` · #${p.reply_to} への返信` : "";
  const state = p.kind === "task" ? (open ? ` <span class="tag warn">未完了</span>` : ` <span class="tag">完了</span>`) : "";
  return `<div class="post" id="p${p.seq}"><div class="meta">#${p.seq} · ${esc(p.author_name)}${to} · <span class="tag">${esc(
    p.kind,
  )}</span>${state}${reply} · ${fmt(p.created_at)}</div><pre>${esc(p.body)}</pre></div>`;
}

export async function overview(board: DurableObjectStub<Board>, flash?: string): Promise<Response> {
  const o = await board.adminOverview();
  const paused = o.threads.filter((t) => t.paused && !t.closed);
  const body = `
<h1>agent-board 確認ページ</h1>
<p class="lead">止まっている依頼を見つけるためのページです。承認は Duet や Muse に戻って、それぞれの中で行ってください。</p>
${flash ? `<p class="flash">${esc(flash)}</p>` : ""}
<h2>未完了の依頼（${o.open_tasks.length}件・古い順）</h2>
${taskRows(o.open_tasks)}
<h2>止まっているスレッド（${paused.length}件）</h2>
${
  paused.length === 0
    ? `<p class="muted">ありません。人の確認を挟まずに10投稿続くと止まります。</p>`
    : `<table><tbody>${paused
        .map(
          (t) => `<tr><td><a href="/admin/thread/${esc(t.thread_id)}">${esc(t.title)}</a></td><td>${esc(t.members.join("、"))}</td>
<td><form method="post" action="/admin/resume"><input type="hidden" name="thread_id" value="${esc(t.thread_id)}"><button>再開</button></form></td></tr>`,
        )
        .join("")}</tbody></table>`
}
<h2>Yoshio さん宛ての投稿（新しい順・最大30件）</h2>
${o.to_human.length === 0 ? `<p class="muted">ありません。</p>` : o.to_human.map((p) => postCard(p, false).replace(' <span class="tag">完了</span>', "")).join("")}
<h2>スレッド（${o.threads.length}件）</h2>
${
  o.threads.length === 0
    ? `<p class="muted">まだスレッドはありません。</p>`
    : `<table><thead><tr><th>題</th><th>メンバー</th><th>投稿</th><th>更新</th></tr></thead><tbody>${o.threads
        .map(
          (t) => `<tr><td><a href="/admin/thread/${esc(t.thread_id)}">${esc(t.title)}</a>${t.closed ? ` <span class="tag">閉</span>` : ""}${
            t.paused && !t.closed ? ` <span class="tag warn">停止中</span>` : ""
          }</td><td>${esc(t.members.join("、"))}</td><td class="num">${t.posts}</td><td class="num">${fmt(t.updated_at)}</td></tr>`,
        )
        .join("")}</tbody></table>`
}`;
  return page("agent-board 確認ページ", body);
}

export async function threadPage(board: DurableObjectStub<Board>, threadId: string): Promise<Response> {
  const t = await board.adminThread(threadId);
  if (!t) return new Response("スレッドが見つかりません", { status: 404 });
  const open = new Set(t.open_seqs);
  const body = `<p><a href="/admin">← 確認ページ</a></p><h1>${esc(t.title)}</h1>
<p class="muted">${esc(t.members.join("、"))}${t.closed ? " · 閉じています" : ""}${t.paused && !t.closed ? " · 停止中" : ""}</p>
${t.posts.map((p) => postCard(p, open.has(p.seq))).join("")}`;
  return page(t.title, body);
}

/** フォームの POST は同じオリジンからだけ受ける（Access のクッキーを悪用した CSRF を防ぐ） */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  const site = req.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin") return false;
  return origin === new URL(req.url).origin;
}

export async function action(req: Request, env: Env, path: string): Promise<Response> {
  if (!sameOrigin(req)) return new Response("別のページからの送信は受け付けません", { status: 403 });
  const board = env.BOARD.get(env.BOARD.idFromName("board"));
  const form = await req.formData();
  let r;
  if (path === "/admin/withdraw") {
    const seq = Number(form.get("seq"));
    if (!Number.isInteger(seq) || seq < 1) return new Response("seq が不正です", { status: 400 });
    r = await board.adminWithdraw(seq);
  } else if (path === "/admin/resume") {
    r = await board.adminResume(String(form.get("thread_id") ?? ""));
  } else {
    return new Response("Not found", { status: 404 });
  }
  if (!r.ok) return overview(board, `できませんでした: ${r.error}`);
  return new Response(null, { status: 303, headers: { Location: "/admin" } });
}
