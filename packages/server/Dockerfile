# 源内 Web API サーバ（AWS 非依存構成）
# ビルドコンテキストはリポジトリルート（npm workspaces のため）
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/cdk/package.json packages/cdk/
COPY packages/common/package.json packages/common/
COPY packages/types/package.json packages/types/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

RUN npm ci --ignore-scripts

COPY packages/cdk packages/cdk
COPY packages/common packages/common
COPY packages/types packages/types
COPY packages/server packages/server

EXPOSE 3001

WORKDIR /app/packages/server
CMD ["npx", "tsx", "src/index.ts"]
