// 入口。/mcp/key はエージェントのキーで、/admin は Cloudflare Access で守る。

import { accessConfigured, verifyAccess } from "./access";
import { action, overview, parseFilter, threadPage } from "./admin";
import { authenticate } from "./auth";
import type { Env } from "./config";
import { handleMcp } from "./mcp";

export { Board } from "./board";

const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/") return text("agent-board\n", 200);

    if (path === "/mcp/key") {
      if (req.method !== "POST") return text("POST だけを受け付けます", 405, { Allow: "POST" });
      const agent = await authenticate(req, env);
      if (!agent)
        return new Response(JSON.stringify({ error: "キーが違うか、ありません" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="agent-board"' },
        });
      return handleMcp(req, env, agent);
    }

    if (path === "/admin" || path.startsWith("/admin/")) {
      if (!accessConfigured(env)) return text("確認ページはまだ設定されていません（Cloudflare Access の設定が要ります）", 503);
      const email = await verifyAccess(req, env);
      if (!email) return text("Cloudflare Access での確認が取れません", 403);
      const board = env.BOARD.get(env.BOARD.idFromName("board"));
      if (req.method === "POST") return action(req, env, path);
      if (req.method !== "GET") return text("Method not allowed", 405);
      if (path === "/admin") return overview(board, { filter: parseFilter(url.searchParams.get("filter")) });
      const m = /^\/admin\/thread\/(t_[0-9a-f]{16})$/.exec(path);
      if (m) return threadPage(board, m[1]!, { filter: parseFilter(url.searchParams.get("filter")) });
      return text("Not found", 404);
    }

    return text("Not found", 404);
  },
} satisfies ExportedHandler<Env>;
