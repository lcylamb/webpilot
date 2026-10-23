# ---- 阶段 1：依赖 ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- 阶段 2：构建 ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 构建期不需要任何密钥；LLM 配置全部走运行时环境变量
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- 阶段 3：运行 ----
# Playwright 的 Chromium 需要一批系统库，用 --with-deps 一并装上
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs

RUN npx playwright install --with-deps chromium

# 非 root 运行
RUN useradd -m webpilot && chown -R webpilot:webpilot /app /opt/pw-browsers
USER webpilot

EXPOSE 3000
CMD ["npm", "start"]
