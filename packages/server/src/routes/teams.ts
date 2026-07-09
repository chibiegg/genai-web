// チーム管理・AIアプリ管理のルート（クリーンルーム実装）。
// API 契約はフロントエンド（MIT）と packages/types（MIT）に準拠する。

import { Hono } from 'hono';
import { COMMON_TEAM_ID } from '../../../cdk/lambda/utils/constants';
import type { AuthClaims } from '../auth';
import { findUserByEmail } from '../keycloak';
import * as repo from '../teamRepository';

export const isSystemAdmin = (claims: AuthClaims): boolean => {
  return (claims['cognito:groups'] ?? '')
    .split(',')
    .map((g) => g.trim())
    .includes('SystemAdminGroup');
};

export const isTeamAdmin = async (claims: AuthClaims, teamId: string): Promise<boolean> => {
  const user = await repo.findTeamUserById(teamId, claims.sub);
  return user?.isAdmin ?? false;
};

export const isTeamMember = async (claims: AuthClaims, teamId: string): Promise<boolean> => {
  if (teamId === COMMON_TEAM_ID) {
    return true;
  }
  return (await repo.findTeamUserById(teamId, claims.sub)) !== null;
};

const forbidden = { error: 'この操作を行う権限がありません。' };
const notFound = { error: 'リクエストされたリソースが見つかりませんでした。' };

export const teamsRoutes = new Hono();

// GET /teams — システム管理者は全チーム、チーム管理者は自分が管理するチーム
teamsRoutes.get('/teams', async (c) => {
  const claims = c.get('claims');
  const exclusiveStartKey = c.req.query('exclusiveStartKey');
  const teamNameFilter = c.req.query('teamName');

  const result = isSystemAdmin(claims)
    ? await repo.listTeams(exclusiveStartKey, teamNameFilter)
    : await repo.listTeamsByAdminId(claims.sub, exclusiveStartKey, teamNameFilter);

  return c.json(result);
});

// POST /teams — システム管理者のみ
teamsRoutes.post('/teams', async (c) => {
  const claims = c.get('claims');
  if (!isSystemAdmin(claims)) {
    return c.json(forbidden, 403);
  }
  const body = (await c.req.json()) as { teamName?: string; teamAdminEmail?: string };
  if (!body.teamName || !body.teamAdminEmail) {
    return c.json({ error: 'teamName と teamAdminEmail は必須です。' }, 400);
  }

  const kcUser = await findUserByEmail(body.teamAdminEmail);
  if (!kcUser) {
    return c.json({ error: '指定されたメールアドレスのユーザーが見つかりません。' }, 400);
  }

  const team = await repo.createTeam(body.teamName);
  const teamUser = await repo.upsertTeamUser(team.teamId, kcUser.id, kcUser.username, true);
  return c.json({ ...team, teamUser });
});

teamsRoutes.get('/teams/:teamId', async (c) => {
  const claims = c.get('claims');
  const teamId = c.req.param('teamId');
  if (
    !isSystemAdmin(claims) &&
    !(await isTeamMember(claims, teamId)) &&
    teamId !== COMMON_TEAM_ID
  ) {
    return c.json(forbidden, 403);
  }
  const team = await repo.findTeamById(teamId);
  if (!team) {
    return c.json(notFound, 404);
  }
  return c.json(team);
});

teamsRoutes.get('/teams/:teamId/raw', async (c) => {
  const claims = c.get('claims');
  if (!isSystemAdmin(claims)) {
    return c.json(forbidden, 403);
  }
  const team = await repo.findTeamById(c.req.param('teamId'));
  if (!team) {
    return c.json(notFound, 404);
  }
  return c.json(team);
});

teamsRoutes.put('/teams/:teamId', async (c) => {
  const claims = c.get('claims');
  const teamId = c.req.param('teamId');
  if (!isSystemAdmin(claims) && !(await isTeamAdmin(claims, teamId))) {
    return c.json(forbidden, 403);
  }
  const body = (await c.req.json()) as { teamName?: string };
  if (!body.teamName) {
    return c.json({ error: 'teamName は必須です。' }, 400);
  }
  const team = await repo.updateTeam(teamId, body.teamName);
  if (!team) {
    return c.json(notFound, 404);
  }
  return c.json(team);
});

teamsRoutes.delete('/teams/:teamId', async (c) => {
  const claims = c.get('claims');
  if (!isSystemAdmin(claims)) {
    return c.json(forbidden, 403);
  }
  await repo.deleteTeam(c.req.param('teamId'));
  return c.newResponse(null, 204);
});

// ---- チームメンバー ----

teamsRoutes.get('/teams/:teamId/users', async (c) => {
  const claims = c.get('claims');
  const teamId = c.req.param('teamId');
  if (!isSystemAdmin(claims) && !(await isTeamMember(claims, teamId))) {
    return c.json(forbidden, 403);
  }
  const result = await repo.listTeamUsers(teamId, c.req.query('exclusiveStartKey'));
  return c.json(result);
});

teamsRoutes.get('/teams/:teamId/users/:userId', async (c) => {
  const claims = c.get('claims');
  const teamId = c.req.param('teamId');
  if (!isSystemAdmin(claims) && !(await isTeamMember(claims, teamId))) {
    return c.json(forbidden, 403);
  }
  const user = await repo.findTeamUserById(teamId, c.req.param('userId'));
  if (!user) {
    return c.json(notFound, 404);
  }
  return c.json(user);
});

teamsRoutes.post('/teams/:teamId/users', async (c) => {
  const claims = c.get('claims');
  const teamId = c.req.param('teamId');
  if (!isSystemAdmin(claims) && !(await isTeamAdmin(claims, teamId))) {
    return c.json(forbidden, 403);
  }
  const body = (await c.req.json()) as { email?: string; isAdmin?: boolean };
  if (!body.email) {
    return c.json({ error: 'email は必須です。' }, 400);
  }
  const kcUser = await findUserByEmail(body.email);
  if (!kcUser) {
    return c.json({ error: '指定されたメールアドレスのユーザーが見つかりません。' }, 400);
  }
  const teamUser = await repo.upsertTeamUser(teamId, kcUser.id, kcUser.username, !!body.isAdmin);
  return c.json(teamUser);
});

teamsRoutes.put('/teams/:teamId/users/:userId', async (c) => {
  const claims = c.get('claims');
  const teamId = c.req.param('teamId');
  if (!isSystemAdmin(claims) && !(await isTeamAdmin(claims, teamId))) {
    return c.json(forbidden, 403);
  }
  const body = (await c.req.json()) as { isAdmin?: boolean };
  const teamUser = await repo.updateTeamUser(teamId, c.req.param('userId'), !!body.isAdmin);
  if (!teamUser) {
    return c.json(notFound, 404);
  }
  return c.json(teamUser);
});

teamsRoutes.delete('/teams/:teamId/users/:userId', async (c) => {
  const claims = c.get('claims');
  const teamId = c.req.param('teamId');
  if (!isSystemAdmin(claims) && !(await isTeamAdmin(claims, teamId))) {
    return c.json(forbidden, 403);
  }
  await repo.deleteTeamUser(teamId, c.req.param('userId'));
  return c.newResponse(null, 204);
});

// ---- AIアプリ（exapps） ----

teamsRoutes.get('/teams/:teamId/exapps', async (c) => {
  const claims = c.get('claims');
  const teamId = c.req.param('teamId');
  if (!isSystemAdmin(claims) && !(await isTeamMember(claims, teamId))) {
    return c.json(forbidden, 403);
  }
  const result = await repo.listTeamExApps(teamId, c.req.query('exclusiveStartKey'));
  return c.json(result);
});

teamsRoutes.post('/teams/:teamId/exapps', async (c) => {
  const claims = c.get('claims');
  const teamId = c.req.param('teamId');
  if (!isSystemAdmin(claims) && !(await isTeamAdmin(claims, teamId))) {
    return c.json(forbidden, 403);
  }
  const body = await c.req.json();
  if (!body.exAppName || !body.endpoint) {
    return c.json({ error: 'exAppName と endpoint は必須です。' }, 400);
  }
  const app = await repo.createExApp(teamId, body);
  return c.json(app);
});

teamsRoutes.get('/teams/:teamId/exapps/:exAppId', async (c) => {
  const claims = c.get('claims');
  const teamId = c.req.param('teamId');
  if (!isSystemAdmin(claims) && !(await isTeamMember(claims, teamId))) {
    return c.json(forbidden, 403);
  }
  const app = await repo.findExAppById(teamId, c.req.param('exAppId'));
  if (!app) {
    return c.json(notFound, 404);
  }
  // APIキーはチーム管理者のみに返す
  if (!isSystemAdmin(claims) && !(await isTeamAdmin(claims, teamId))) {
    app.apiKey = '';
  }
  return c.json(app);
});

teamsRoutes.get('/teams/:teamId/exapps/:exAppId/raw', async (c) => {
  const claims = c.get('claims');
  if (!isSystemAdmin(claims)) {
    return c.json(forbidden, 403);
  }
  const app = await repo.findExAppById(c.req.param('teamId'), c.req.param('exAppId'));
  if (!app) {
    return c.json(notFound, 404);
  }
  return c.json(app);
});

teamsRoutes.put('/teams/:teamId/exapps/:exAppId', async (c) => {
  const claims = c.get('claims');
  const teamId = c.req.param('teamId');
  if (!isSystemAdmin(claims) && !(await isTeamAdmin(claims, teamId))) {
    return c.json(forbidden, 403);
  }
  const app = await repo.updateExApp(teamId, c.req.param('exAppId'), await c.req.json());
  if (!app) {
    return c.json(notFound, 404);
  }
  return c.json(app);
});

teamsRoutes.delete('/teams/:teamId/exapps/:exAppId', async (c) => {
  const claims = c.get('claims');
  const teamId = c.req.param('teamId');
  if (!isSystemAdmin(claims) && !(await isTeamAdmin(claims, teamId))) {
    return c.json(forbidden, 403);
  }
  await repo.deleteExApp(teamId, c.req.param('exAppId'));
  return c.newResponse(null, 204);
});

// POST /teams/{teamId}/exapps/{exAppId}/copy — コピー元（自チームまたは共通チーム）から複製する
teamsRoutes.post('/teams/:teamId/exapps/:exAppId/copy', async (c) => {
  const claims = c.get('claims');
  const teamId = c.req.param('teamId');
  const exAppId = c.req.param('exAppId');
  if (!isSystemAdmin(claims) && !(await isTeamAdmin(claims, teamId))) {
    return c.json(forbidden, 403);
  }

  const source =
    (await repo.findExAppById(teamId, exAppId)) ??
    (await repo.findExAppById(COMMON_TEAM_ID, exAppId));
  if (!source) {
    return c.json(notFound, 404);
  }
  if (!source.copyable) {
    return c.json({ error: 'このAIアプリはコピーを許可していません。' }, 403);
  }

  const overrides = (await c.req.json()) as Record<string, unknown>;
  const app = await repo.createExApp(teamId, {
    exAppName: (overrides.exAppName as string) ?? `${source.exAppName}のコピー`,
    endpoint: source.endpoint,
    config: (overrides.config as string) ?? source.config,
    placeholder: (overrides.placeholder as string) ?? source.placeholder,
    systemPrompt: (overrides.systemPrompt as string) ?? source.systemPrompt,
    systemPromptKeyName: (overrides.systemPromptKeyName as string) ?? source.systemPromptKeyName,
    description: (overrides.description as string) ?? source.description,
    howToUse: (overrides.howToUse as string) ?? source.howToUse,
    apiKey: source.apiKey,
    copyable: (overrides.copyable as boolean) ?? source.copyable,
    status: (overrides.status as 'draft' | 'published') ?? 'draft',
  });
  return c.json(app);
});
