#!/bin/sh
# コンテナ起動時に VITE_ プレフィックスの環境変数を .env.local に書き出してから
# Vite を起動する。イメージを再ビルドせず環境変数で接続先を差し替えられる。
#
# WEB_MODE=production のとき本番ビルドを作って preview サーバで配信する
# （公開デモ向け・高速）。それ以外は開発サーバ（HMR あり・ローカル開発向け）。
set -e

: > .env.local
env | grep '^VITE_' >> .env.local || true

echo "=== .env.local ==="
cat .env.local
echo "================="

if [ "$WEB_MODE" = "production" ]; then
  echo "=== 本番ビルドを作成中... ==="
  npx vite build
  echo "=== preview サーバを起動 ==="
  exec npx vite preview --host 0.0.0.0 --port 5173
else
  exec npx vite --host 0.0.0.0 --port 5173
fi
