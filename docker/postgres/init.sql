-- genai-web 用スキーマ（DynamoDB 単一テーブル設計の PostgreSQL 版）
-- sk はバイト順整列を保証するため COLLATE "C" を指定する。

CREATE TABLE IF NOT EXISTS genai_items (
  pk TEXT COLLATE "C" NOT NULL,
  sk TEXT COLLATE "C" NOT NULL,
  attributes JSONB NOT NULL,
  expire_at BIGINT,
  PRIMARY KEY (pk, sk)
);

CREATE INDEX IF NOT EXISTS idx_genai_items_gsi1 ON genai_items (sk, pk);
CREATE INDEX IF NOT EXISTS idx_genai_items_expire ON genai_items (expire_at);
