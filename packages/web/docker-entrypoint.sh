#!/bin/sh
# コンテナ起動時に VITE_ プレフィックスの環境変数を .env.local に書き出してから
# Vite 開発サーバを起動する。これにより、イメージを再ビルドせずに
# 環境変数で接続先（API / OIDC 等）を差し替えられる。
set -e

: > .env.local
env | grep '^VITE_' >> .env.local || true

echo "=== .env.local ==="
cat .env.local
echo "================="

exec npx vite --host 0.0.0.0 --port 5173
