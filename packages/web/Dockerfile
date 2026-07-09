# 源内 Web フロントエンド（開発／ローカルテスト用）
# ビルドコンテキストはリポジトリルート（npm workspaces のため）
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/common/package.json packages/common/
COPY packages/types/package.json packages/types/
COPY packages/web/package.json packages/web/

RUN npm ci --ignore-scripts

COPY packages/common packages/common
COPY packages/types packages/types
COPY packages/web packages/web

WORKDIR /app/packages/web

EXPOSE 5173

ENTRYPOINT ["sh", "docker-entrypoint.sh"]
