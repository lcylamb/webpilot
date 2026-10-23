/** @type {import('next').NextConfig} */
const nextConfig = {
  // Playwright 是原生模块，让 Next.js 不要在服务端打包它（作为外部依赖直接 require）
  serverExternalPackages: ["playwright", "playwright-core", "@huggingface/transformers", "onnxruntime-node", "sharp"],
};

export default nextConfig;
