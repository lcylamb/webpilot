import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WebPilot — 自然语言驱动的浏览器自动化 Agent",
  description: "LLM 规划 + Playwright 执行 + 断言校验，全程可视化。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
