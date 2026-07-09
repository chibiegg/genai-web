// チーム・AIアプリ・実行履歴の PostgreSQL リポジトリ（クリーンルーム実装）。
// レスポンス形状は packages/types（MIT）の Team / TeamUser / ExApp / InvokeExAppHistory に従う。

import * as crypto from 'crypto';
import type { ExApp, InvokeExAppHistory, Team, TeamUser } from 'genai-web';
import { getDb } from '../../cdk/lambda/repository/db';

type Row = Record<string, unknown>;

const PAGE_SIZE = 50;

const encodeKey = (offset: number): string => Buffer.from(JSON.stringify({ offset })).toString('base64');
const decodeKey = (key?: string | null): number => {
  if (!key) return 0;
  try {
    return (JSON.parse(Buffer.from(key, 'base64').toString()) as { offset: number }).offset || 0;
  } catch {
    return 0;
  }
};

// ---- teams ----

const rowToTeam = (row: Row): Team => ({
  teamId: String(row.team_id),
  teamName: String(row.team_name),
  createdDate: String(row.created_date),
  updatedDate: String(row.updated_date),
});

export const createTeam = async (teamName: string): Promise<Team> => {
  const now = `${Date.now()}`;
  const teamId = crypto.randomUUID();
  await getDb().query(
    'INSERT INTO teams (team_id, team_name, created_date, updated_date) VALUES ($1, $2, $3, $3)',
    [teamId, teamName, now],
  );
  return { teamId, teamName, createdDate: now, updatedDate: now };
};

// 共通アプリチーム等、ID を指定して作成する場合に使用する
export const createTeamWithId = async (teamId: string, teamName: string): Promise<Team> => {
  const now = `${Date.now()}`;
  await getDb().query(
    `INSERT INTO teams (team_id, team_name, created_date, updated_date) VALUES ($1, $2, $3, $3)
     ON CONFLICT (team_id) DO NOTHING`,
    [teamId, teamName, now],
  );
  return { teamId, teamName, createdDate: now, updatedDate: now };
};

export const findTeamById = async (teamId: string): Promise<Team | null> => {
  const res = await getDb().query('SELECT * FROM teams WHERE team_id = $1', [teamId]);
  return res.rows[0] ? rowToTeam(res.rows[0]) : null;
};

export const updateTeam = async (teamId: string, teamName: string): Promise<Team | null> => {
  const res = await getDb().query(
    'UPDATE teams SET team_name = $2, updated_date = $3 WHERE team_id = $1 RETURNING *',
    [teamId, teamName, `${Date.now()}`],
  );
  return res.rows[0] ? rowToTeam(res.rows[0]) : null;
};

export const deleteTeam = async (teamId: string): Promise<void> => {
  // team_users / ex_apps は外部キーの CASCADE で削除される
  await getDb().query('DELETE FROM invoke_histories WHERE team_id = $1', [teamId]);
  await getDb().query('DELETE FROM teams WHERE team_id = $1', [teamId]);
};

export const listTeams = async (
  exclusiveStartKey?: string | null,
  teamNameFilter?: string,
): Promise<{ teams: Team[]; lastEvaluatedKey: string | null }> => {
  const offset = decodeKey(exclusiveStartKey);
  const params: unknown[] = [];
  let where = '';
  if (teamNameFilter) {
    params.push(`%${teamNameFilter}%`);
    where = `WHERE team_name LIKE $${params.length}`;
  }
  params.push(PAGE_SIZE + 1, offset);
  const res = await getDb().query(
    `SELECT * FROM teams ${where} ORDER BY created_date DESC, team_id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const hasMore = res.rows.length > PAGE_SIZE;
  return {
    teams: res.rows.slice(0, PAGE_SIZE).map(rowToTeam),
    lastEvaluatedKey: hasMore ? encodeKey(offset + PAGE_SIZE) : null,
  };
};

// ユーザーが管理者であるチームの一覧
export const listTeamsByAdminId = async (
  userId: string,
  exclusiveStartKey?: string | null,
  teamNameFilter?: string,
): Promise<{ teams: Team[]; lastEvaluatedKey: string | null }> => {
  const offset = decodeKey(exclusiveStartKey);
  const params: unknown[] = [userId];
  let filter = '';
  if (teamNameFilter) {
    params.push(`%${teamNameFilter}%`);
    filter = `AND t.team_name LIKE $${params.length}`;
  }
  params.push(PAGE_SIZE + 1, offset);
  const res = await getDb().query(
    `SELECT t.* FROM teams t
     INNER JOIN team_users tu ON tu.team_id = t.team_id
     WHERE tu.user_id = $1 AND tu.is_admin ${filter}
     ORDER BY t.created_date DESC, t.team_id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const hasMore = res.rows.length > PAGE_SIZE;
  return {
    teams: res.rows.slice(0, PAGE_SIZE).map(rowToTeam),
    lastEvaluatedKey: hasMore ? encodeKey(offset + PAGE_SIZE) : null,
  };
};

// ---- team_users ----

const rowToTeamUser = (row: Row): TeamUser => ({
  teamId: String(row.team_id),
  userId: String(row.user_id),
  username: String(row.username),
  isAdmin: Boolean(row.is_admin),
  createdDate: String(row.created_date),
  updatedDate: String(row.updated_date),
});

export const upsertTeamUser = async (
  teamId: string,
  userId: string,
  username: string,
  isAdmin: boolean,
): Promise<TeamUser> => {
  const now = `${Date.now()}`;
  const res = await getDb().query(
    `INSERT INTO team_users (team_id, user_id, username, is_admin, created_date, updated_date)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (team_id, user_id)
       DO UPDATE SET username = EXCLUDED.username, is_admin = EXCLUDED.is_admin, updated_date = EXCLUDED.updated_date
     RETURNING *`,
    [teamId, userId, username, isAdmin, now],
  );
  return rowToTeamUser(res.rows[0]);
};

export const updateTeamUser = async (
  teamId: string,
  userId: string,
  isAdmin: boolean,
): Promise<TeamUser | null> => {
  const res = await getDb().query(
    `UPDATE team_users SET is_admin = $3, updated_date = $4
     WHERE team_id = $1 AND user_id = $2 RETURNING *`,
    [teamId, userId, isAdmin, `${Date.now()}`],
  );
  return res.rows[0] ? rowToTeamUser(res.rows[0]) : null;
};

export const deleteTeamUser = async (teamId: string, userId: string): Promise<void> => {
  await getDb().query('DELETE FROM team_users WHERE team_id = $1 AND user_id = $2', [
    teamId,
    userId,
  ]);
};

export const findTeamUserById = async (
  teamId: string,
  userId: string,
): Promise<TeamUser | null> => {
  const res = await getDb().query(
    'SELECT * FROM team_users WHERE team_id = $1 AND user_id = $2',
    [teamId, userId],
  );
  return res.rows[0] ? rowToTeamUser(res.rows[0]) : null;
};

export const listTeamUsers = async (
  teamId: string,
  exclusiveStartKey?: string | null,
): Promise<{ teamUsers: TeamUser[]; lastEvaluatedKey: string | null }> => {
  const offset = decodeKey(exclusiveStartKey);
  const res = await getDb().query(
    `SELECT * FROM team_users WHERE team_id = $1
     ORDER BY created_date ASC, user_id LIMIT $2 OFFSET $3`,
    [teamId, PAGE_SIZE + 1, offset],
  );
  const hasMore = res.rows.length > PAGE_SIZE;
  return {
    teamUsers: res.rows.slice(0, PAGE_SIZE).map(rowToTeamUser),
    lastEvaluatedKey: hasMore ? encodeKey(offset + PAGE_SIZE) : null,
  };
};

// ---- ex_apps ----

const rowToExApp = (row: Row): ExApp => ({
  teamId: String(row.team_id),
  exAppId: String(row.ex_app_id),
  exAppName: String(row.ex_app_name),
  endpoint: String(row.endpoint),
  config: row.config == null ? undefined : String(row.config),
  placeholder: String(row.placeholder),
  systemPrompt: row.system_prompt == null ? undefined : String(row.system_prompt),
  systemPromptKeyName:
    row.system_prompt_key_name == null ? undefined : String(row.system_prompt_key_name),
  description: String(row.description),
  howToUse: String(row.how_to_use),
  apiKey: String(row.api_key),
  copyable: row.copyable == null ? undefined : Boolean(row.copyable),
  status: row.status == null ? undefined : (String(row.status) as ExApp['status']),
  createdDate: String(row.created_date),
  updatedDate: String(row.updated_date),
});

export const createExApp = async (
  teamId: string,
  app: Omit<ExApp, 'teamId' | 'exAppId' | 'createdDate' | 'updatedDate'>,
): Promise<ExApp> => {
  const now = `${Date.now()}`;
  const exAppId = crypto.randomUUID();
  const res = await getDb().query(
    `INSERT INTO ex_apps (
       team_id, ex_app_id, ex_app_name, endpoint, config, placeholder,
       system_prompt, system_prompt_key_name, description, how_to_use,
       api_key, copyable, status, created_date, updated_date
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
     RETURNING *`,
    [
      teamId,
      exAppId,
      app.exAppName,
      app.endpoint,
      app.config ?? null,
      app.placeholder ?? '',
      app.systemPrompt ?? null,
      app.systemPromptKeyName ?? null,
      app.description ?? '',
      app.howToUse ?? '',
      app.apiKey ?? '',
      app.copyable ?? null,
      app.status ?? 'draft',
      now,
    ],
  );
  return rowToExApp(res.rows[0]);
};

export const findExAppById = async (teamId: string, exAppId: string): Promise<ExApp | null> => {
  const res = await getDb().query(
    'SELECT * FROM ex_apps WHERE team_id = $1 AND ex_app_id = $2',
    [teamId, exAppId],
  );
  return res.rows[0] ? rowToExApp(res.rows[0]) : null;
};

const EXAPP_COLUMNS: Record<string, string> = {
  exAppName: 'ex_app_name',
  endpoint: 'endpoint',
  config: 'config',
  placeholder: 'placeholder',
  systemPrompt: 'system_prompt',
  systemPromptKeyName: 'system_prompt_key_name',
  description: 'description',
  howToUse: 'how_to_use',
  apiKey: 'api_key',
  copyable: 'copyable',
  status: 'status',
};

export const updateExApp = async (
  teamId: string,
  exAppId: string,
  updates: Partial<ExApp>,
): Promise<ExApp | null> => {
  const sets: string[] = [];
  const params: unknown[] = [teamId, exAppId];
  for (const [key, column] of Object.entries(EXAPP_COLUMNS)) {
    const value = (updates as Record<string, unknown>)[key];
    if (value !== undefined) {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
  }
  params.push(`${Date.now()}`);
  sets.push(`updated_date = $${params.length}`);

  const res = await getDb().query(
    `UPDATE ex_apps SET ${sets.join(', ')} WHERE team_id = $1 AND ex_app_id = $2 RETURNING *`,
    params,
  );
  return res.rows[0] ? rowToExApp(res.rows[0]) : null;
};

export const deleteExApp = async (teamId: string, exAppId: string): Promise<void> => {
  await getDb().query('DELETE FROM ex_apps WHERE team_id = $1 AND ex_app_id = $2', [
    teamId,
    exAppId,
  ]);
};

export const listTeamExApps = async (
  teamId: string,
  exclusiveStartKey?: string | null,
): Promise<{ teamExApps: ExApp[]; lastEvaluatedKey: string | null }> => {
  const offset = decodeKey(exclusiveStartKey);
  const res = await getDb().query(
    `SELECT * FROM ex_apps WHERE team_id = $1
     ORDER BY created_date DESC, ex_app_id LIMIT $2 OFFSET $3`,
    [teamId, PAGE_SIZE + 1, offset],
  );
  const hasMore = res.rows.length > PAGE_SIZE;
  return {
    teamExApps: res.rows.slice(0, PAGE_SIZE).map(rowToExApp),
    lastEvaluatedKey: hasMore ? encodeKey(offset + PAGE_SIZE) : null,
  };
};

// ユーザーが利用可能な公開済みアプリ一覧（所属チーム + 共通チーム）
export const listPublishedExAppsForUser = async (
  userId: string,
  commonTeamId: string,
): Promise<Array<ExApp & { teamName: string }>> => {
  const res = await getDb().query(
    `SELECT a.*, t.team_name FROM ex_apps a
     INNER JOIN teams t ON t.team_id = a.team_id
     WHERE a.status = 'published'
       AND (a.team_id = $2 OR a.team_id IN (SELECT team_id FROM team_users WHERE user_id = $1))
     ORDER BY a.created_date DESC`,
    [userId, commonTeamId],
  );
  return res.rows.map((row) => ({ ...rowToExApp(row), teamName: String(row.team_name) }));
};

// ---- invoke_histories ----

const rowToHistory = (row: Row): InvokeExAppHistory => ({
  teamId: String(row.team_id),
  teamName: String(row.team_name),
  exAppId: String(row.ex_app_id),
  exAppName: String(row.ex_app_name),
  userId: String(row.user_id),
  inputs: (row.inputs as Record<string, unknown>) ?? {},
  outputs: String(row.outputs),
  createdDate: String(row.created_date),
  status: String(row.status) as InvokeExAppHistory['status'],
  progress: String(row.progress),
  artifacts: (row.artifacts as InvokeExAppHistory['artifacts']) ?? undefined,
  sessionId: row.session_id == null ? undefined : String(row.session_id),
  predictedTitle: row.predicted_title == null ? undefined : String(row.predicted_title),
  usageMetadata: (row.usage_metadata as InvokeExAppHistory['usageMetadata']) ?? undefined,
  totalEstimatedCost:
    (row.total_estimated_cost as InvokeExAppHistory['totalEstimatedCost']) ?? undefined,
});

export type HistoryContent = {
  outputs: string;
  status: InvokeExAppHistory['status'];
  progress?: string;
  artifacts?: InvokeExAppHistory['artifacts'];
  usageMetadata?: InvokeExAppHistory['usageMetadata'];
  totalEstimatedCost?: InvokeExAppHistory['totalEstimatedCost'];
};

export const createInvokeHistory = async (
  teamId: string,
  exAppId: string,
  userId: string,
  createdDate: string,
  teamName: string,
  exAppName: string,
  inputs: Record<string, unknown>,
  content: HistoryContent,
  sessionId?: string,
): Promise<void> => {
  await getDb().query(
    `INSERT INTO invoke_histories (
       team_id, ex_app_id, user_id, created_date, team_name, ex_app_name,
       status, progress, inputs, outputs, artifacts, session_id, usage_metadata, total_estimated_cost
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (team_id, ex_app_id, user_id, created_date) DO UPDATE SET
       status = EXCLUDED.status, progress = EXCLUDED.progress, outputs = EXCLUDED.outputs,
       artifacts = EXCLUDED.artifacts, usage_metadata = EXCLUDED.usage_metadata,
       total_estimated_cost = EXCLUDED.total_estimated_cost`,
    [
      teamId,
      exAppId,
      userId,
      createdDate,
      teamName,
      exAppName,
      content.status,
      content.progress ?? '',
      JSON.stringify(inputs),
      content.outputs,
      content.artifacts ? JSON.stringify(content.artifacts) : null,
      sessionId ?? null,
      content.usageMetadata ? JSON.stringify(content.usageMetadata) : null,
      content.totalEstimatedCost ? JSON.stringify(content.totalEstimatedCost) : null,
    ],
  );
};

export const updateInvokeHistoryContent = async (
  teamId: string,
  exAppId: string,
  userId: string,
  createdDate: string,
  content: HistoryContent,
): Promise<void> => {
  await getDb().query(
    `UPDATE invoke_histories SET
       status = $5, progress = COALESCE($6, progress), outputs = $7,
       artifacts = COALESCE($8, artifacts),
       usage_metadata = COALESCE($9, usage_metadata),
       total_estimated_cost = COALESCE($10, total_estimated_cost)
     WHERE team_id = $1 AND ex_app_id = $2 AND user_id = $3 AND created_date = $4`,
    [
      teamId,
      exAppId,
      userId,
      createdDate,
      content.status,
      content.progress ?? null,
      content.outputs,
      content.artifacts ? JSON.stringify(content.artifacts) : null,
      content.usageMetadata ? JSON.stringify(content.usageMetadata) : null,
      content.totalEstimatedCost ? JSON.stringify(content.totalEstimatedCost) : null,
    ],
  );
};

export const updateInvokeHistoryTitle = async (
  teamId: string,
  exAppId: string,
  userId: string,
  createdDate: string,
  title: string,
): Promise<void> => {
  await getDb().query(
    `UPDATE invoke_histories SET predicted_title = $5
     WHERE team_id = $1 AND ex_app_id = $2 AND user_id = $3 AND created_date = $4`,
    [teamId, exAppId, userId, createdDate, title],
  );
};

export const getInvokeHistory = async (
  teamId: string,
  exAppId: string,
  userId: string,
  createdDate: string,
): Promise<InvokeExAppHistory | null> => {
  const res = await getDb().query(
    `SELECT * FROM invoke_histories
     WHERE team_id = $1 AND ex_app_id = $2 AND user_id = $3 AND created_date = $4`,
    [teamId, exAppId, userId, createdDate],
  );
  return res.rows[0] ? rowToHistory(res.rows[0]) : null;
};

export const listInvokeHistories = async (
  teamId: string,
  exAppId: string,
  userId: string,
  exclusiveStartKey?: string | null,
): Promise<{ history: InvokeExAppHistory[]; lastEvaluatedKey: string | null }> => {
  const offset = decodeKey(exclusiveStartKey);
  const res = await getDb().query(
    `SELECT * FROM invoke_histories
     WHERE team_id = $1 AND ex_app_id = $2 AND user_id = $3
     ORDER BY created_date DESC LIMIT $4 OFFSET $5`,
    [teamId, exAppId, userId, PAGE_SIZE + 1, offset],
  );
  const hasMore = res.rows.length > PAGE_SIZE;
  return {
    history: res.rows.slice(0, PAGE_SIZE).map(rowToHistory),
    lastEvaluatedKey: hasMore ? encodeKey(offset + PAGE_SIZE) : null,
  };
};

export const deleteInvokeHistory = async (
  teamId: string,
  exAppId: string,
  userId: string,
  createdDate: string,
): Promise<void> => {
  await getDb().query(
    `DELETE FROM invoke_histories
     WHERE team_id = $1 AND ex_app_id = $2 AND user_id = $3 AND created_date = $4`,
    [teamId, exAppId, userId, createdDate],
  );
};

// ---- exapp_jobs（非同期ポーリング） ----

export type ExAppJob = {
  jobId: number;
  teamId: string;
  exAppId: string;
  userId: string;
  createdDate: string;
  stableUserId: string;
  statusUrl: string;
  endpoint: string;
  attempts: number;
};

export const enqueueExAppJob = async (
  job: Omit<ExAppJob, 'jobId' | 'attempts'>,
): Promise<void> => {
  await getDb().query(
    `INSERT INTO exapp_jobs (team_id, ex_app_id, user_id, created_date, stable_user_id, status_url, endpoint)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [job.teamId, job.exAppId, job.userId, job.createdDate, job.stableUserId, job.statusUrl, job.endpoint],
  );
};

// 実行対象のジョブを1件取得して next_poll_at を先送りする（多重実行防止）。
export const claimNextExAppJob = async (pollIntervalSec: number): Promise<ExAppJob | null> => {
  const res = await getDb().query(
    `UPDATE exapp_jobs SET attempts = attempts + 1, next_poll_at = now() + ($1 || ' seconds')::interval
     WHERE job_id = (
       SELECT job_id FROM exapp_jobs
       WHERE NOT done AND next_poll_at <= now()
       ORDER BY next_poll_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [String(pollIntervalSec)],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    jobId: Number(row.job_id),
    teamId: String(row.team_id),
    exAppId: String(row.ex_app_id),
    userId: String(row.user_id),
    createdDate: String(row.created_date),
    stableUserId: String(row.stable_user_id),
    statusUrl: String(row.status_url),
    endpoint: String(row.endpoint),
    attempts: Number(row.attempts),
  };
};

export const completeExAppJob = async (jobId: number): Promise<void> => {
  await getDb().query('UPDATE exapp_jobs SET done = TRUE WHERE job_id = $1', [jobId]);
};
