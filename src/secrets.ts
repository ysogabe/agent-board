// 投稿に紛れ込んだ秘密らしき文字列を拒む。完全ではなく、うっかりを減らすためのもの。

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "OpenAI / Anthropic 形式のキー", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: "GitHub のトークン", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/ },
  { name: "AWS のアクセスキー", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "Google の API キー", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Slack のトークン", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Stripe のキー", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { name: "秘密鍵", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
];

/** 見つかったら種類の名前を返す。なければ null */
export function findSecret(text: string): string | null {
  for (const p of PATTERNS) if (p.re.test(text)) return p.name;
  return null;
}
