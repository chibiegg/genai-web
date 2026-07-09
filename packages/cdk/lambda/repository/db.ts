// PostgreSQL 接続の共有モジュール。
// DynamoDB 単一テーブル設計を (pk, sk, attributes JSONB) の汎用テーブルで再現する。
// エンティティの JSON 形状は DynamoDB 時代と同一に保ち、ハンドラ層を無改修で動かす。

import { Pool } from 'pg';

export type QueryResultRow = { [column: string]: unknown };

export type QueryExecutor = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: QueryResultRow[] }>;
};

// メインテーブル（チャット・メッセージ・システムコンテキスト・チーム等）
export const ITEMS_TABLE = 'genai_items';

let executor: QueryExecutor | undefined;

// テストから PGlite 等の代替実装を注入するためのフック
export const setQueryExecutor = (e: QueryExecutor | undefined): void => {
  executor = e;
};

export const getDb = (): QueryExecutor => {
  if (!executor) {
    executor = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return executor;
};

export const TTL_DAYS = parseInt(process.env.TTL_DAYS || '364', 10);

export const calcExpireAt = (): number => {
  return Math.floor(Date.now() / 1000) + TTL_DAYS * 24 * 60 * 60;
};

// DynamoDB の sk はバイト順で整列されるため、PostgreSQL でも COLLATE "C" で
// ロケール非依存の順序を保証する（schema.sql 側で列定義にも指定している）。
export const ITEMS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${ITEMS_TABLE} (
  pk TEXT COLLATE "C" NOT NULL,
  sk TEXT COLLATE "C" NOT NULL,
  attributes JSONB NOT NULL,
  expire_at BIGINT,
  PRIMARY KEY (pk, sk)
);
CREATE INDEX IF NOT EXISTS idx_${ITEMS_TABLE}_gsi1 ON ${ITEMS_TABLE} (sk, pk);
CREATE INDEX IF NOT EXISTS idx_${ITEMS_TABLE}_expire ON ${ITEMS_TABLE} (expire_at);
`;

// スキーマを適用する（起動時・テストセットアップ用）。
export const ensureSchema = async (db: QueryExecutor = getDb()): Promise<void> => {
  for (const statement of ITEMS_SCHEMA_SQL.split(';')) {
    if (statement.trim()) {
      await db.query(statement);
    }
  }
};
