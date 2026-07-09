// チーム管理・AIアプリ管理のスキーマ。
// （旧 AWS 版の該当機能は ASL ライセンスのため、本実装は API 契約から新規に実装した
//   クリーンルーム実装であり、リレーショナルなテーブル設計を採用している）

import { getDb, QueryExecutor } from '../../cdk/lambda/repository/db';

export const TEAM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS teams (
  team_id TEXT PRIMARY KEY,
  team_name TEXT NOT NULL,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_users (
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_users_user ON team_users (user_id);

CREATE TABLE IF NOT EXISTS ex_apps (
  team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  ex_app_id TEXT NOT NULL,
  ex_app_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  config TEXT,
  placeholder TEXT NOT NULL DEFAULT '',
  system_prompt TEXT,
  system_prompt_key_name TEXT,
  description TEXT NOT NULL DEFAULT '',
  how_to_use TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  copyable BOOLEAN,
  status TEXT,
  created_date TEXT NOT NULL,
  updated_date TEXT NOT NULL,
  PRIMARY KEY (team_id, ex_app_id)
);

CREATE TABLE IF NOT EXISTS invoke_histories (
  team_id TEXT NOT NULL,
  ex_app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_date TEXT NOT NULL,
  team_name TEXT NOT NULL DEFAULT '',
  ex_app_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  progress TEXT NOT NULL DEFAULT '',
  inputs JSONB NOT NULL DEFAULT '{}',
  outputs TEXT NOT NULL DEFAULT '',
  artifacts JSONB,
  session_id TEXT,
  predicted_title TEXT,
  usage_metadata JSONB,
  total_estimated_cost JSONB,
  PRIMARY KEY (team_id, ex_app_id, user_id, created_date)
);

-- 非同期実行（202 + status_url）のポーリングジョブ。
-- SQS の代替として PostgreSQL をジョブキューに使う（SELECT ... FOR UPDATE SKIP LOCKED）。
CREATE TABLE IF NOT EXISTS exapp_jobs (
  job_id BIGSERIAL PRIMARY KEY,
  team_id TEXT NOT NULL,
  ex_app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_date TEXT NOT NULL,
  stable_user_id TEXT NOT NULL,
  status_url TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_poll_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  done BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_exapp_jobs_pending ON exapp_jobs (next_poll_at) WHERE NOT done;

-- 文字起こしジョブ（Amazon Transcribe の代替。AI Engine の Whisper 互換 API を使用）
CREATE TABLE IF NOT EXISTS transcribe_jobs (
  job_name TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  language_code TEXT NOT NULL DEFAULT 'ja-JP',
  transcripts JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export const ensureTeamSchema = async (db: QueryExecutor = getDb()): Promise<void> => {
  await db.query(TEAM_SCHEMA_SQL);
};
