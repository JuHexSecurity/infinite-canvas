# 构建 Vite 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 运行镜像：默认只提供静态前端；启用 PRIVATE_DEPLOYMENT=true 时，同时启动同源 AI 网关。
FROM nginx:1.27-alpine

RUN apk add --no-cache nodejs

COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
COPY private-gateway/index.js /opt/infinite-canvas/private-gateway/index.js
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh

EXPOSE 3000
