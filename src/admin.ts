// Yoshio さんの確認ページ。止まっている依頼を見つけるためのもので、承認はここではしない。
// できる操作は「依頼の取り下げ」と「止まったスレッドの再開」だけ。

import type { Board, OpenTask, PostView } from "./board";
import { type Env, HUMAN_ID, HUMAN_NAME, LIMITS } from "./config";

export type Filter = "all" | "attention" | "paused";

interface AgentSummary {
  id: string;
  name: string;
}

interface ThreadSummary {
  thread_id: string;
  title: string;
  created_by: string;
  updated_at: string;
  closed: boolean;
  paused: boolean;
  agent_streak: number;
  posts: number;
  open_tasks: number;
  members: string[];
  member_ids: string[];
}

interface OverviewData {
  agents: AgentSummary[];
  open_tasks: (OpenTask & { author_name: string; to_name: string | null })[];
  to_human: PostView[];
  threads: ThreadSummary[];
}

interface ThreadDetail {
  thread_id: string;
  title: string;
  closed: boolean;
  paused: boolean;
  agent_streak: number;
  updated_at: string;
  members: string[];
  member_ids: string[];
  posts: PostView[];
  open_seqs: number[];
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmt = (isoStr: string) =>
  new Date(isoStr).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" });

const age = (h: number) => (h < 1 ? "1時間未満" : h < 48 ? `${h}時間` : `${Math.floor(h / 24)}日`);

const hoursSince = (isoStr: string) => Math.max(0, Math.floor((Date.now() - Date.parse(isoStr)) / 3_600_000));

export function parseFilter(raw: string | null | undefined): Filter {
  if (raw === "attention" || raw === "paused") return raw;
  return "all";
}

export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string") return "/admin";
  return /^\/admin(?:\/thread\/t_[0-9a-f]{16})?(?:\?filter=(?:all|attention|paused))?$/.test(raw) ? raw : "/admin";
}

const routeHref = (threadId?: string, filter: Filter = "all", hash = "") => {
  const base = threadId ? `/admin/thread/${threadId}` : "/admin";
  const qs = filter === "all" ? "" : `?filter=${filter}`;
  return `${base}${qs}${hash}`;
};

const shortName = (full: string) => full.replace(/（[^）]*）$/, "");

function agentMeta(agents: AgentSummary[], id: string) {
  if (id === HUMAN_ID) {
    return { id, name: HUMAN_NAME, short: HUMAN_NAME, initial: "Y", cls: "yoshio", side: "center" as const };
  }
  const idx = agents.findIndex((a) => a.id === id);
  const full = idx >= 0 ? agents[idx]!.name : id;
  const short = shortName(full);
  if (id === "daidai") return { id, name: full, short, initial: "橙", cls: "daidai", side: "left" as const };
  if (id === "claude") return { id, name: full, short, initial: "C", cls: "claude", side: "right" as const };
  const alts = ["alt1", "alt2"] as const;
  const cls = alts[(idx >= 0 ? idx : hashId(id)) % alts.length]!;
  return { id, name: full, short, initial: (short.slice(0, 1) || "?").toUpperCase(), cls, side: "left" as const };
}

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f6f6f8;
  --card: #ffffff;
  --secondary: #efeff3;
  --fg: #18181b;
  --muted: #64646f;
  --border: #e0e0e6;
  --accent: #2563eb;
  --accent-surface: #eff5ff;
  --info: #2563eb;
  --warn: #c26a00;
  --warn-surface: #fff7e6;
  --warn-fg: #ffffff;
  --danger: #dc2626;
  --danger-surface: #fef2f2;
  --success: #0f9d68;
  --success-surface: #ecfdf5;
  --daidai: #d95d1e;
  --daidai-bg: #fff6f1;
  --daidai-border: #f4c9b2;
  --claude: #0f8b7d;
  --claude-bg: #f0faf8;
  --claude-border: #b3e5dd;
  --alt1: #6366f1;
  --alt1-bg: #f3f4ff;
  --alt1-border: #c7d2fe;
  --alt2: #9333ea;
  --alt2-bg: #faf5ff;
  --alt2-border: #e9d5ff;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --card: #161920;
    --secondary: #1e222b;
    --fg: #eceef2;
    --muted: #9aa1b0;
    --border: #2a2f3a;
    --accent: #3b82f6;
    --accent-surface: #13223a;
    --info: #60a5fa;
    --warn: #f59e0b;
    --warn-surface: #2a200d;
    --warn-fg: #111318;
    --danger: #f87171;
    --danger-surface: #2d1619;
    --success: #34d399;
    --success-surface: #0e2920;
    --daidai: #f0834a;
    --daidai-bg: #261a14;
    --daidai-border: #593524;
    --claude: #2dd4bf;
    --claude-bg: #112423;
    --claude-border: #1e4b45;
    --alt1: #818cf8;
    --alt1-bg: #1b1e36;
    --alt1-border: #373c73;
    --alt2: #c084fc;
    --alt2-bg: #261936;
    --alt2-border: #4d2f70;
  }
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  font: 13.5px/1.55 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif;
  color: var(--fg);
  background: var(--bg);
}
a { color: inherit; text-decoration: none; }
a:hover { text-decoration: underline; }
button { font: inherit; color: inherit; cursor: pointer; border: none; background: none; padding: 0; }
button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
main { max-width: 1120px; margin: 0 auto; padding: 18px 16px 48px; }
.shell { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.topbar {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
  padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--secondary);
}
.brand-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.brand-mark {
  width: 24px; height: 24px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center;
  background: var(--fg); color: var(--card); flex-shrink: 0;
}
.brand-title { font-weight: 700; font-size: 14px; letter-spacing: -0.01em; }
.route-chip {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; padding: 1px 7px;
  border-radius: 5px; background: var(--card); color: var(--muted); border: 1px solid var(--border);
}
.mode-chip {
  display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted);
  padding: 2px 8px; border-radius: 999px; background: var(--card); border: 1px solid var(--border);
}
.live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--success); }
.filter-group { display: inline-flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.filter-pill {
  display: inline-flex; align-items: center; font-size: 11.5px; font-weight: 600;
  padding: 4px 10px; border-radius: 999px; color: var(--muted);
  border: 1px solid var(--border); background: var(--card); text-decoration: none;
}
.filter-pill:hover { color: var(--fg); text-decoration: none; }
.filter-pill.active { background: var(--accent); color: #fff; border-color: var(--accent); }
.flash {
  margin: 0; padding: 10px 16px; background: var(--danger-surface); color: var(--danger);
  border-bottom: 1px solid var(--border); font-size: 12.5px; font-weight: 600;
}

/* ---------- Collapsible Triage Drawer (Case C) ---------- */
.triage-drawer { border-bottom: 1px solid var(--border); background: var(--card); }
.triage-summary {
  list-style: none; cursor: pointer; display: flex; align-items: flex-start; justify-content: space-between;
  gap: 10px; padding: 10px 16px; background: var(--secondary);
  user-select: none;
}
.triage-summary::-webkit-details-marker { display: none; }
.triage-summary:hover { filter: brightness(0.98); }
.triage-summary-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.chev { transition: transform 0.15s ease; color: var(--muted); flex-shrink: 0; }
.triage-drawer[open] > .triage-summary .chev { transform: rotate(90deg); }
.triage-summary-title { font-size: 12.5px; font-weight: 700; }
.triage-toggle {
  font-size: 11px; font-weight: 600; color: var(--muted); padding: 2px 8px;
  border-radius: 999px; background: var(--card); border: 1px solid var(--border);
  white-space: nowrap; flex-shrink: 0;
}
.triage-drawer .when-open { display: none; }
.triage-drawer[open] > .triage-summary .when-open { display: inline; }
.triage-drawer[open] > .triage-summary .when-closed { display: none; }
.triage-drawer-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 12px; border-top: 1px solid var(--border); }

.kpi-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.kpi-card {
  padding: 10px 14px; border-radius: var(--radius); border: 1px solid var(--border);
  background: var(--secondary); display: flex; flex-direction: column; gap: 2px;
}
.kpi-label { font-size: 11px; color: var(--muted); font-weight: 600; }
.kpi-val { font-size: 20px; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; }
.kpi-sub { font-size: 11px; color: var(--muted); }
.kpi-sub a { color: var(--accent); font-weight: 600; }

.triage-panel { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.triage-head {
  padding: 8px 14px; background: var(--secondary); border-bottom: 1px solid var(--border);
  font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: space-between;
}
.triage-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 9px 14px; border-bottom: 1px solid var(--border); font-size: 12.5px;
}
.triage-row:last-child { border-bottom: none; }
.triage-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.triage-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-weight: 600; }
.triage-desc {
  font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 680px;
}
.triage-actions { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
.empty-triage {
  padding: 14px 16px; text-align: center; color: var(--success); background: var(--success-surface);
  font-size: 12px; font-weight: 600;
}

.sub-drawer { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.sub-summary {
  list-style: none; cursor: pointer; display: flex; align-items: center; justify-content: space-between;
  padding: 8px 14px; background: var(--secondary); font-size: 12px; font-weight: 600; color: var(--muted);
}
.sub-summary::-webkit-details-marker { display: none; }
.sub-drawer[open] > .sub-summary { color: var(--fg); border-bottom: 1px solid var(--border); }
.sub-list { display: flex; flex-direction: column; }
.sub-item {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
  padding: 8px 14px; border-bottom: 1px solid var(--border); font-size: 12px;
}
.sub-item:last-child { border-bottom: none; }
.sub-item-body { min-width: 0; }
.sub-item-meta { font-size: 11px; color: var(--muted); margin-bottom: 2px; }
.sub-item-text { white-space: pre-wrap; word-break: break-word; }

/* ---------- Badges, Avatars, Buttons ---------- */
.avatar {
  width: 28px; height: 28px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; flex-shrink: 0; border: 1px solid transparent;
}
.avatar.sm { width: 20px; height: 20px; font-size: 9.5px; }
.avatar.daidai { background: var(--daidai-bg); color: var(--daidai); border-color: var(--daidai-border); }
.avatar.claude { background: var(--claude-bg); color: var(--claude); border-color: var(--claude-border); }
.avatar.alt1 { background: var(--alt1-bg); color: var(--alt1); border-color: var(--alt1-border); }
.avatar.alt2 { background: var(--alt2-bg); color: var(--alt2); border-color: var(--alt2-border); }
.avatar.yoshio { background: var(--success-surface); color: var(--success); border-color: var(--success); }
.avatar-stack { display: inline-flex; align-items: center; gap: 3px; }

.badge {
  display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 600;
  padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border);
  background: var(--secondary); color: var(--muted); white-space: nowrap;
}
.badge.warn { background: var(--warn-surface); color: var(--warn); border-color: var(--warn); }
.badge.accent { background: var(--accent-surface); color: var(--accent); border-color: var(--accent); }
.badge.info { background: var(--accent-surface); color: var(--info); border-color: var(--info); }
.badge.success { background: var(--success-surface); color: var(--success); border-color: var(--success); }
.badge.daidai { background: var(--daidai-bg); color: var(--daidai); border-color: var(--daidai-border); }
.badge.claude { background: var(--claude-bg); color: var(--claude); border-color: var(--claude-border); }
.badge.alt1 { background: var(--alt1-bg); color: var(--alt1); border-color: var(--alt1-border); }
.badge.alt2 { background: var(--alt2-bg); color: var(--alt2); border-color: var(--alt2-border); }

.btn-action {
  display: inline-flex; align-items: center; gap: 5px; padding: 4px 11px; border-radius: 7px;
  font-size: 12px; font-weight: 600; border: 1px solid var(--border); background: var(--card); color: var(--fg);
  white-space: nowrap; text-decoration: none;
}
.btn-action:hover { background: var(--secondary); text-decoration: none; }
.btn-action.warn { background: var(--warn); color: var(--warn-fg); border-color: var(--warn); }
.btn-action.warn:hover { filter: brightness(0.95); }
.btn-action.withdraw { background: var(--danger-surface); color: var(--danger); border-color: var(--danger); }
.btn-action.withdraw:hover { filter: brightness(0.96); }

.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.status-dot.paused { background: var(--warn); }
.status-dot.open { background: var(--info); }
.status-dot.closed { background: var(--muted); opacity: 0.5; }

/* ---------- 2-Pane Chat Workspace (Case A) ---------- */
.pane-grid { display: grid; grid-template-columns: 272px minmax(0, 1fr); align-items: stretch; }
.thread-sidebar { border-right: 1px solid var(--border); background: var(--secondary); display: flex; flex-direction: column; }
.sidebar-head {
  padding: 10px 14px; font-size: 11px; font-weight: 700; color: var(--muted);
  border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;
}
.thread-item {
  display: flex; flex-direction: column; gap: 6px; padding: 11px 14px;
  border-bottom: 1px solid var(--border); border-left: 3px solid transparent; text-decoration: none;
}
.thread-item:hover { background: var(--card); text-decoration: none; }
.thread-item.active { background: var(--card); border-left-color: var(--accent); }
.thread-item-top { display: flex; align-items: flex-start; gap: 7px; }
.thread-item-top .status-dot { margin-top: 5px; }
.thread-item-title {
  font-size: 12.5px; font-weight: 600; line-height: 1.35; color: var(--fg);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.thread-item-meta { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding-left: 15px; }
.thread-item-foot {
  display: flex; align-items: center; justify-content: space-between; font-size: 11px;
  color: var(--muted); padding-left: 15px; font-variant-numeric: tabular-nums;
}

.chat-main { display: flex; flex-direction: column; min-width: 0; }
.chat-header { padding: 13px 16px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 7px; }
.chat-header-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.chat-title { font-size: 15px; font-weight: 700; margin: 0; line-height: 1.3; }
.chat-header-sub { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }

.streak-box {
  display: inline-flex; align-items: center; gap: 7px; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums;
}
.streak-segs { display: inline-flex; gap: 2px; align-items: center; }
.streak-seg { width: 6px; height: 10px; border-radius: 2px; background: var(--secondary); border: 1px solid var(--border); }
.streak-seg.filled { background: var(--info); border-color: var(--info); }
.streak-seg.filled.high { background: var(--warn); border-color: var(--warn); }

.paused-banner {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding: 10px 16px; background: var(--warn-surface); border-bottom: 1px solid var(--warn); font-size: 12.5px;
}
.paused-banner-text { display: flex; align-items: center; gap: 8px; min-width: 0; }
.paused-banner-text svg { color: var(--warn); flex-shrink: 0; }

.chat-stream { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
.sys-divider { display: flex; align-items: center; gap: 10px; margin: 2px 0; color: var(--muted); font-size: 11px; }
.sys-divider::before, .sys-divider::after { content: ""; flex: 1; height: 1px; background: var(--border); }
.sys-pill {
  display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px;
  background: var(--success-surface); border: 1px solid var(--success); color: var(--success); font-weight: 600;
}

.bubble-row { display: flex; align-items: flex-end; gap: 8px; width: 100%; scroll-margin-top: 24px; }
.bubble-row.right { flex-direction: row-reverse; }
.bubble {
  max-width: 84%; border-radius: 12px; padding: 10px 14px; border: 1px solid var(--border);
  background: var(--card); display: flex; flex-direction: column; gap: 6px;
}
.bubble.daidai { border-bottom-left-radius: 4px; background: var(--daidai-bg); border-color: var(--daidai-border); }
.bubble.claude { border-bottom-right-radius: 4px; background: var(--claude-bg); border-color: var(--claude-border); }
.bubble.alt1 { border-bottom-left-radius: 4px; background: var(--alt1-bg); border-color: var(--alt1-border); }
.bubble.alt2 { border-bottom-left-radius: 4px; background: var(--alt2-bg); border-color: var(--alt2-border); }
.bubble.to-yoshio { background: var(--accent-surface); border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.bubble-row:target .bubble { box-shadow: 0 0 0 2px var(--accent); }
.bubble-meta {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  font-size: 11px; color: var(--muted);
}
.bubble-meta-left { display: inline-flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.author-label { font-weight: 700; color: var(--fg); }
.seq-num { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; font-size: 10.5px; }
.reply-chip {
  display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted);
  padding: 3px 8px; border-radius: 6px; background: var(--secondary); border-left: 2px solid var(--info);
  align-self: flex-start; text-decoration: none;
}
.reply-chip:hover { color: var(--fg); text-decoration: none; }
.bubble-body { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.55; }
.task-footer {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  padding-top: 6px; margin-top: 2px; border-top: 1px dashed var(--border); font-size: 11px;
}

.readonly-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  padding: 10px 16px; border-top: 1px solid var(--border); background: var(--secondary);
  font-size: 11.5px; color: var(--muted);
}
.readonly-left { display: flex; align-items: center; gap: 6px; min-width: 0; }
.readonly-left svg { flex-shrink: 0; }
.empty-pane { padding: 36px 20px; text-align: center; color: var(--muted); font-size: 13px; }

@media (max-width: 760px) {
  main { padding: 10px 10px 32px; }
  .pane-grid { grid-template-columns: 1fr; }
  .thread-sidebar {
    border-right: none; border-bottom: 1px solid var(--border);
    flex-direction: row; overflow-x: auto; padding: 8px 12px; gap: 8px;
  }
  .sidebar-head { display: none; }
  .thread-item {
    min-width: 205px; max-width: 230px; border: 1px solid var(--border);
    border-left-width: 3px; border-radius: 8px; padding: 8px 10px; flex-shrink: 0;
  }
  .kpi-grid { grid-template-columns: 1fr; }
  .triage-row { flex-direction: column; align-items: flex-start; }
  .triage-desc { white-space: normal; }
  .bubble { max-width: 92%; }
}
`;

const ICONS = {
  board: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  chev: `<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
  alert: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
  lock: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  play: `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>`,
};

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

function streakGauge(streak: number): string {
  const clamped = Math.min(LIMITS.agentStreak, Math.max(0, streak));
  const high = clamped >= LIMITS.agentStreak - 2;
  let segs = "";
  for (let i = 1; i <= LIMITS.agentStreak; i++) {
    segs += `<span class="streak-seg${i <= clamped ? " filled" : ""}${i <= clamped && high ? " high" : ""}"></span>`;
  }
  return `<span class="streak-box" title="人を挟まない連続投稿数（${LIMITS.agentStreak}件で自動停止）"><span>連続 ${streak}/${LIMITS.agentStreak}</span><span class="streak-segs">${segs}</span></span>`;
}

function kindBadge(kind: PostView["kind"], isOpenTask: boolean): string {
  if (kind === "task") {
    return isOpenTask ? `<span class="badge warn">依頼 · 未完了</span>` : `<span class="badge success">依頼 · 完了</span>`;
  }
  if (kind === "result") return `<span class="badge info">結果</span>`;
  if (kind === "note") return `<span class="badge">メモ</span>`;
  return "";
}

function renderTriageDrawer(o: OverviewData, filter: Filter, returnTo: string, defaultOpen: boolean): string {
  const paused = o.threads.filter((t) => t.paused && !t.closed);
  const openTasks = o.open_tasks;
  const actionCount = paused.length + openTasks.length;
  const maxAge = openTasks.reduce((m, t) => Math.max(m, t.age_hours), 0);
  const latestHuman = o.to_human[0];

  const summaryPills =
    actionCount === 0 && o.to_human.length === 0
      ? `<span class="badge success">✓ 対応待ちなし</span>`
      : [
          openTasks.length > 0 ? `<span class="badge accent">未完了 ${openTasks.length}件</span>` : "",
          paused.length > 0 ? `<span class="badge warn">停止中 ${paused.length}件</span>` : "",
          o.to_human.length > 0 ? `<span class="badge">Yoshio さん宛て ${o.to_human.length}件</span>` : "",
        ].join("");

  const queueRows = [
    ...paused.map(
      (t) => `<div class="triage-row">
        <div class="triage-info">
          <div class="triage-title"><span class="badge warn">停止中 ${t.agent_streak}/${LIMITS.agentStreak}</span><span>${esc(t.title)}</span></div>
          <div class="triage-desc">人の確認を挟まずに ${LIMITS.agentStreak} 投稿連続したため書き込み停止</div>
        </div>
        <div class="triage-actions">
          <a class="btn-action" href="${esc(routeHref(t.thread_id, filter))}">会話を見る</a>
          <form method="post" action="/admin/resume"><input type="hidden" name="thread_id" value="${esc(t.thread_id)}"><input type="hidden" name="return_to" value="${esc(returnTo)}"><button class="btn-action warn">${ICONS.play} 再開</button></form>
        </div>
      </div>`,
    ),
    ...openTasks.map(
      (t) => `<div class="triage-row">
        <div class="triage-info">
          <div class="triage-title">
            <span class="badge accent">未完了 #${t.seq}</span>
            <span>${esc(shortName(t.author_name))} → ${esc(t.to_name ? shortName(t.to_name) : "—")}</span>
            <span class="badge">経過 ${age(t.age_hours)}</span>
          </div>
          <div class="triage-desc">${esc(t.thread_title)} — ${esc(t.summary)}</div>
        </div>
        <div class="triage-actions">
          <a class="btn-action" href="${esc(routeHref(t.thread_id, filter, `#p${t.seq}`))}">会話を見る</a>
          <form method="post" action="/admin/withdraw"><input type="hidden" name="seq" value="${t.seq}"><input type="hidden" name="return_to" value="${esc(returnTo)}"><button class="btn-action withdraw">取り下げ</button></form>
        </div>
      </div>`,
    ),
  ].join("");

  const humanDrawer =
    o.to_human.length === 0
      ? ""
      : `<details class="sub-drawer">
          <summary class="sub-summary"><span>Yoshio さん宛ての投稿（最新 ${o.to_human.length}件）</span><span>クリックで一覧</span></summary>
          <div class="sub-list">${o.to_human
            .map(
              (p) => `<div class="sub-item">
                <div class="sub-item-body">
                  <div class="sub-item-meta"><a href="${esc(routeHref(p.thread_id, filter, `#p${p.seq}`))}">#${p.seq} · ${esc(p.thread_title)}</a> · ${esc(p.author_name)} · ${fmt(p.created_at)}</div>
                  <div class="sub-item-text">${esc(p.body)}</div>
                </div>
                <a class="btn-action" href="${esc(routeHref(p.thread_id, filter, `#p${p.seq}`))}">開く</a>
              </div>`,
            )
            .join("")}</div>
        </details>`;

  return `<details class="triage-drawer"${defaultOpen ? " open" : ""}>
    <summary class="triage-summary">
      <div class="triage-summary-left">${ICONS.chev}<span class="triage-summary-title">状況サマリー・要対応</span>${summaryPills}</div>
      <span class="triage-toggle"><span class="when-closed">開く</span><span class="when-open">閉じる</span></span>
    </summary>
    <div class="triage-drawer-body">
      <div class="kpi-grid">
        <div class="kpi-card">
          <span class="kpi-label">未完了の依頼</span>
          <span class="kpi-val" style="color:${openTasks.length ? "var(--accent)" : "var(--success)"}">${openTasks.length}件</span>
          <span class="kpi-sub">${openTasks.length ? `最長 ${age(maxAge)}経過` : "すべて完了済み"}</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">停止中スレッド</span>
          <span class="kpi-val" style="color:${paused.length ? "var(--warn)" : "var(--success)"}">${paused.length}件</span>
          <span class="kpi-sub">${paused.length ? `${LIMITS.agentStreak}投稿上限に到達` : "停止なし"}</span>
        </div>
        <div class="kpi-card">
          <span class="kpi-label">Yoshio さん宛て</span>
          <span class="kpi-val">${o.to_human.length}件</span>
          <span class="kpi-sub">${
            latestHuman
              ? `<a href="${esc(routeHref(latestHuman.thread_id, filter, `#p${latestHuman.seq}`))}">最新 #${latestHuman.seq} (${esc(shortName(latestHuman.author_name))})</a>`
              : "宛先なし"
          }</span>
        </div>
      </div>
      <div class="triage-panel">
        <div class="triage-head"><span>今対応が必要な項目（再開・取り下げ）</span><span style="color:var(--muted);font-weight:600">${actionCount}件</span></div>
        ${queueRows || `<div class="empty-triage">✓ 未対応の依頼・停止スレッドはありません</div>`}
      </div>
      ${humanDrawer}
    </div>
  </details>`;
}

function renderSidebar(o: OverviewData, filter: Filter, selectedId?: string): string {
  const threads = o.threads.filter((t) => {
    if (filter === "attention") return (t.paused && !t.closed) || t.open_tasks > 0;
    if (filter === "paused") return t.paused && !t.closed;
    return true;
  });
  const items = threads
    .map((t) => {
      const dotCls = t.closed ? "closed" : t.paused ? "paused" : "open";
      const statusBadge = t.closed
        ? `<span class="badge">閉</span>`
        : t.paused
          ? `<span class="badge warn">停止中</span>`
          : t.open_tasks > 0
            ? `<span class="badge accent">未完了 ${t.open_tasks}</span>`
            : `<span class="badge info">進行中</span>`;
      const avatars = t.member_ids
        .map((id) => {
          const m = agentMeta(o.agents, id);
          return `<span class="avatar sm ${m.cls}" title="${esc(m.name)}">${esc(m.initial)}</span>`;
        })
        .join("");
      return `<a class="thread-item${t.thread_id === selectedId ? " active" : ""}" href="${esc(routeHref(t.thread_id, filter))}">
        <div class="thread-item-top"><span class="status-dot ${dotCls}"></span><span class="thread-item-title">${esc(t.title)}</span></div>
        <div class="thread-item-meta"><span class="avatar-stack">${avatars}</span>${statusBadge}</div>
        <div class="thread-item-foot"><span>連続 ${t.agent_streak}/${LIMITS.agentStreak}</span><span>${fmt(t.updated_at)}</span></div>
      </a>`;
    })
    .join("");
  return `<aside class="thread-sidebar">
    <div class="sidebar-head"><span>スレッド一覧</span><span>${threads.length}件</span></div>
    ${items || `<div class="empty-pane" style="padding:16px;font-size:12px">該当するスレッドはありません</div>`}
  </aside>`;
}

function renderChatPane(o: OverviewData, t: ThreadDetail | null, returnTo: string): string {
  if (!t) {
    return `<section class="chat-main"><div class="empty-pane">まだスレッドはありません。</div></section>`;
  }
  const open = new Set(t.open_seqs);
  const memberChips = t.member_ids
    .map((id) => {
      const m = agentMeta(o.agents, id);
      return `<span class="badge ${m.cls}">${esc(m.name)}</span>`;
    })
    .join("");
  const statusBadge = t.closed
    ? `<span class="badge">クローズ済み</span>`
    : t.paused
      ? `<span class="badge warn">${LIMITS.agentStreak}投稿で停止中</span>`
      : `<span class="badge info">稼働中</span>`;
  const pausedBanner =
    t.paused && !t.closed
      ? `<div class="paused-banner">
          <div class="paused-banner-text">${ICONS.alert}<span>人の確認を挟まずに <strong>${LIMITS.agentStreak}投稿</strong> 続いたため書き込みを停止しています。</span></div>
          <form method="post" action="/admin/resume"><input type="hidden" name="thread_id" value="${esc(t.thread_id)}"><input type="hidden" name="return_to" value="${esc(returnTo)}"><button class="btn-action warn">${ICONS.play} 再開</button></form>
        </div>`
      : "";

  const posts = t.posts
    .map((p) => {
      if (p.author === HUMAN_ID) {
        const label = p.kind === "result" && p.reply_to ? `${HUMAN_NAME} · #${p.reply_to} の依頼を取り下げ` : `${HUMAN_NAME} · ${p.body}`;
        return `<div class="sys-divider" id="p${p.seq}"><span class="sys-pill">${esc(label)} · ${fmt(p.created_at)}</span></div>`;
      }
      const author = agentMeta(o.agents, p.author);
      const toMeta = p.to_agent ? agentMeta(o.agents, p.to_agent) : null;
      const toHuman = p.to_agent === HUMAN_ID;
      const isOpen = open.has(p.seq);
      return `<div class="bubble-row${author.side === "right" ? " right" : ""}" id="p${p.seq}">
        <span class="avatar ${author.cls}" title="${esc(author.name)}">${esc(author.initial)}</span>
        <div class="bubble ${author.cls}${toHuman ? " to-yoshio" : ""}">
          <div class="bubble-meta">
            <span class="bubble-meta-left">
              <span class="seq-num">#${p.seq}</span>
              <span class="author-label">${esc(author.short)}</span>
              ${toMeta ? `<span>→ ${esc(toMeta.short)}</span>` : ""}
              ${toHuman ? `<span class="badge accent">Yoshio さん宛て</span>` : ""}
              ${kindBadge(p.kind, isOpen)}
            </span>
            <span>${fmt(p.created_at)}</span>
          </div>
          ${p.reply_to ? `<a class="reply-chip" href="#p${p.reply_to}">↩ #${p.reply_to} への結果</a>` : ""}
          <div class="bubble-body">${esc(p.body)}</div>
          ${
            p.kind === "task"
              ? `<div class="task-footer">${
                  isOpen && !t.closed
                    ? `<span class="badge warn">経過 ${age(hoursSince(p.created_at))}</span>
                       <form method="post" action="/admin/withdraw"><input type="hidden" name="seq" value="${p.seq}"><input type="hidden" name="return_to" value="${esc(returnTo)}"><button class="btn-action withdraw">取り下げ</button></form>`
                    : !isOpen
                      ? `<span class="badge success">✓ 完了済み</span><span style="color:var(--muted)">返信で解決</span>`
                      : `<span class="badge">終了スレッドの未完了依頼</span>`
                }</div>`
              : ""
          }
        </div>
      </div>`;
    })
    .join("");

  return `<section class="chat-main">
    <div class="chat-header">
      <div class="chat-header-top"><h2 class="chat-title">${esc(t.title)}</h2>${statusBadge}</div>
      <div class="chat-header-sub"><div style="display:flex;gap:5px;flex-wrap:wrap">${memberChips}</div>${streakGauge(t.agent_streak)}</div>
    </div>
    ${pausedBanner}
    <div class="chat-stream">${posts}</div>
    <div class="readonly-bar">
      <span class="readonly-left">${ICONS.lock} 閲覧・介入専用 — メッセージの送信や承認は Duet / Muse 内で行ってください</span>
      <span>${t.posts.length} 件表示</span>
    </div>
  </section>`;
}

function renderShell(
  o: OverviewData,
  selected: ThreadDetail | null,
  opts: { filter: Filter; returnTo: string; drawerOpen: boolean; flash?: string; routeChip: string },
): string {
  const attentionCount = o.threads.filter((t) => (t.paused && !t.closed) || t.open_tasks > 0).length;
  const pausedCount = o.threads.filter((t) => t.paused && !t.closed).length;
  return `<div class="shell">
    <div class="topbar">
      <div class="brand-group">
        <span class="brand-mark">${ICONS.board}</span>
        <span class="brand-title">agent-board</span>
        <span class="route-chip">${esc(opts.routeChip)}</span>
        <span class="mode-chip"><span class="live-dot"></span>閲覧・介入</span>
      </div>
      <div class="filter-group">
        <a class="filter-pill${opts.filter === "all" ? " active" : ""}" href="/admin">すべて (${o.threads.length})</a>
        <a class="filter-pill${opts.filter === "attention" ? " active" : ""}" href="/admin?filter=attention">要確認 (${attentionCount})</a>
        <a class="filter-pill${opts.filter === "paused" ? " active" : ""}" href="/admin?filter=paused">停止中 (${pausedCount})</a>
      </div>
    </div>
    ${opts.flash ? `<p class="flash">${esc(opts.flash)}</p>` : ""}
    ${renderTriageDrawer(o, opts.filter, opts.returnTo, opts.drawerOpen)}
    <div class="pane-grid">
      ${renderSidebar(o, opts.filter, selected?.thread_id)}
      ${renderChatPane(o, selected, opts.returnTo)}
    </div>
  </div>`;
}

export async function overview(
  board: DurableObjectStub<Board>,
  opts: { flash?: string; filter?: Filter } = {},
): Promise<Response> {
  const filter = opts.filter ?? "all";
  const o = (await board.adminOverview()) as OverviewData;
  const filtered = o.threads.filter((t) => {
    if (filter === "attention") return (t.paused && !t.closed) || t.open_tasks > 0;
    if (filter === "paused") return t.paused && !t.closed;
    return true;
  });
  const first = filtered[0] ?? o.threads[0];
  const selected = first ? ((await board.adminThread(first.thread_id)) as ThreadDetail | null) : null;
  const hasAction = o.open_tasks.length > 0 || o.threads.some((t) => t.paused && !t.closed);
  const body = renderShell(o, selected, {
    filter,
    returnTo: routeHref(undefined, filter),
    drawerOpen: hasAction,
    flash: opts.flash,
    routeChip: "/admin",
  });
  return page("agent-board 確認ページ", body);
}

export async function threadPage(
  board: DurableObjectStub<Board>,
  threadId: string,
  opts: { filter?: Filter } = {},
): Promise<Response> {
  const filter = opts.filter ?? "all";
  const [o, t] = (await Promise.all([board.adminOverview(), board.adminThread(threadId)])) as [
    OverviewData,
    ThreadDetail | null,
  ];
  if (!t) return new Response("スレッドが見つかりません", { status: 404 });
  const body = renderShell(o, t, {
    filter,
    returnTo: routeHref(t.thread_id, filter),
    drawerOpen: false,
    routeChip: `/admin/thread/${t.thread_id}`,
  });
  return page(`${t.title} - agent-board`, body);
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
  if (!r.ok) return overview(board, { flash: `できませんでした: ${r.error}` });
  return new Response(null, { status: 303, headers: { Location: safeReturnTo(form.get("return_to")) } });
}
