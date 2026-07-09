# server — 源内 Web API サーバ（AWS 非依存構成）

既存の Lambda ハンドラ（`packages/cdk/lambda/*`）を HTTP アダプタ（`src/adapter.ts`）経由で
常駐プロセスとして提供する。認証は OIDC（Keycloak 等）、DB は PostgreSQL、
ストレージは S3 互換オブジェクトストレージ、LLM はさくらのAI Engine を利用する。

## 起動

```bash
# 依存インフラ一式（PostgreSQL / Keycloak / MinIO / API）
cp .env.sakura.example .env.sakura   # リポジトリルートで
docker compose -f docker-compose.sakura.yml --env-file .env.sakura up -d

# ホストでの開発実行
npm run dev -w server
```

開発ユーザー: `dev-user` / `dev-password`（`docker/keycloak/realm-genai.json` で定義）

## 実装済みルート

| ルート | 元 Lambda | 状態 |
|---|---|---|
| POST /predict, /predict/title | predict / predictTitle | ✅ 実 API で動作確認済み |
| POST /predict/stream | predictStream | ✅ JSONL ストリーミング（Lambda Response Streaming の代替） |
| /chats 系 CRUD + messages | createChat 等 7 本 | ✅ Keycloak 認証込みで動作確認済み |
| /systemcontexts 系 | createSystemContext 等 4 本 | ✅ |
| /file/url, /file/:fileName | 署名付き URL 系 3 本 | ✅（S3 互換ストレージ、`S3_ENDPOINT`） |

## 未実装（既存 Lambda の移植待ち）

- teams / exapps / invokeExApp（SQS → PostgreSQL ジョブテーブル化が必要）
- transcribe（AI Engine の `whisper-large-v3-turbo` へ移行予定。API 動作確認済み）
- 画像生成（AI Engine 非対応のため無効化予定）
- フロントエンド: Amplify(Cognito) → OIDC、`chatApi.ts` の Lambda 直接呼び出し → `/predict/stream` fetch 化

## 依存する repository 層の状態

`packages/cdk/lambda/repository/` のうち chat / message / systemContext / common は
PostgreSQL 実装済み（`db.ts`、`genai_items` テーブル、PGlite によるテストあり）。
team / exApp / invokeHistory / passwordReset は未移植（DynamoDB 実装のまま）。
