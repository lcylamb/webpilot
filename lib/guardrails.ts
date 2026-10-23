/**
 * 安全护栏：域名白名单。
 * 防止 Agent 被诱导去访问未授权/恶意站点。
 */
const allowed = (process.env.ALLOWED_DOMAINS || "localhost,127.0.0.1,example.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function isAllowedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return allowed.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

export function allowedDomains(): string[] {
  return allowed;
}
