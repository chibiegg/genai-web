// OIDC (Keycloak 等) の JWT 検証ミドルウェア。
// 検証済みクレームを Cognito オーソライザ互換の形に整えてハンドラへ渡す。

import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export type AuthClaims = Record<string, string>;

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let cachedIssuer: string | undefined;

// トークンの iss クレーム検証に使う issuer（＝ブラウザが IdP にアクセスする URL）
const getIssuer = (): string => {
  const issuer = process.env.OIDC_ISSUER;
  if (!issuer) {
    throw new Error('OIDC_ISSUER is not configured (e.g. http://localhost:8180/realms/genai)');
  }
  return issuer.replace(/\/+$/, '');
};

// OIDC ディスカバリ／JWKS を取得する URL。
// Docker 構成では、ブラウザが使う issuer（localhost:8180）と API コンテナから
// Keycloak に到達する URL（keycloak:8180）が異なるため、OIDC_INTERNAL_ISSUER で
// 内部向けの URL を指定できるようにする（未指定なら OIDC_ISSUER と同じ）。
const getInternalIssuer = (): string => {
  const internal = process.env.OIDC_INTERNAL_ISSUER;
  return (internal ?? getIssuer()).replace(/\/+$/, '');
};

const getJwks = async (): Promise<ReturnType<typeof createRemoteJWKSet>> => {
  const internalIssuer = getInternalIssuer();
  if (!jwks || cachedIssuer !== internalIssuer) {
    // OIDC ディスカバリから jwks_uri を取得する（Keycloak 以外の IdP でも動くように）
    const res = await fetch(`${internalIssuer}/.well-known/openid-configuration`);
    if (!res.ok) {
      throw new Error(`Failed to fetch OIDC discovery document: ${res.status}`);
    }
    const discovery = (await res.json()) as { jwks_uri?: string };
    if (!discovery.jwks_uri) {
      throw new Error('OIDC discovery document does not contain jwks_uri');
    }
    jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    cachedIssuer = internalIssuer;
  }
  return jwks;
};

export const verifyToken = async (token: string): Promise<AuthClaims> => {
  const { payload } = await jwtVerify(token, await getJwks(), {
    issuer: getIssuer(),
    ...(process.env.OIDC_AUDIENCE ? { audience: process.env.OIDC_AUDIENCE } : {}),
  });

  if (!payload.sub) {
    throw new Error('Token does not contain sub claim');
  }

  // Cognito オーソライザの claims 形式に合わせる（ハンドラは claims['sub'] 等を参照する）
  // グループは Keycloak の groups クレームまたはレルムロールからマッピングする
  const groups =
    (payload.groups as string[] | undefined) ??
    (payload.realm_access as { roles?: string[] } | undefined)?.roles ??
    [];
  const claims: AuthClaims = {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : '',
    'cognito:username':
      typeof payload.preferred_username === 'string'
        ? payload.preferred_username
        : (payload.sub as string),
    'cognito:groups': groups.map((g) => String(g).replace(/^\//, '')).join(','),
  };
  return claims;
};

declare module 'hono' {
  interface ContextVariableMap {
    claims: AuthClaims;
    idToken: string;
  }
}

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('Authorization') ?? c.req.header('authorization');
  const token = authHeader?.replace(/^Bearer\s+/i, '');
  if (!token) {
    return c.json({ error: 'Authorization header is required' }, 401);
  }

  try {
    const claims = await verifyToken(token);
    c.set('claims', claims);
    c.set('idToken', token);
  } catch (e) {
    console.warn('Token verification failed:', e);
    return c.json({ error: 'Invalid token' }, 401);
  }

  await next();
};
