import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // 試験用のキー（本番では wrangler secret で入れる）
          AGENT_KEY_DAIDAI: "test-key-daidai-0123456789abcdef0123456789",
          AGENT_KEY_CLAUDE: "test-key-claude-0123456789abcdef0123456789",
        },
      },
    }),
  ],
});
