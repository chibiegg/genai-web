// 認証プロバイダのファサード。
// VITE_APP_AUTH_PROVIDER=oidc のとき OIDC (Keycloak 等、oidc-client-ts) を、
// それ以外は従来どおり Amplify (Cognito) を利用する。
// セッションオブジェクトは Amplify の fetchAuthSession() 互換の形
// （tokens.idToken.payload / tokens.accessToken.payload）で返す。

import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

export const authProvider: 'oidc' | 'amplify' =
  import.meta.env.VITE_APP_AUTH_PROVIDER === 'oidc' ? 'oidc' : 'amplify';

type TokenLike = {
  payload: Record<string, unknown>;
  toString: () => string;
};

export type AuthSession = {
  tokens?: {
    idToken?: TokenLike;
    accessToken?: TokenLike;
  };
};

let userManager: UserManager | undefined;

export const getUserManager = (): UserManager => {
  if (!userManager) {
    const issuer = import.meta.env.VITE_APP_OIDC_ISSUER;
    const clientId = import.meta.env.VITE_APP_OIDC_CLIENT_ID;
    if (!issuer || !clientId) {
      throw new Error('VITE_APP_OIDC_ISSUER / VITE_APP_OIDC_CLIENT_ID が設定されていません。');
    }
    // Keycloak の Identity Brokering で特定 IdP（GitHub 等）へ直行させる場合は
    // VITE_APP_OIDC_IDP_HINT に IdP のエイリアスを設定する（kc_idp_hint）。
    const idpHint = import.meta.env.VITE_APP_OIDC_IDP_HINT;
    userManager = new UserManager({
      authority: issuer,
      client_id: clientId,
      redirect_uri: `${window.location.origin}/`,
      post_logout_redirect_uri: `${window.location.origin}/signed-out`,
      scope: 'openid profile email',
      userStore: new WebStorageStateStore({ store: window.localStorage }),
      automaticSilentRenew: true,
      ...(idpHint ? { extraQueryParams: { kc_idp_hint: idpHint } } : {}),
    });
  }
  return userManager;
};

const decodeJwtPayload = (jwt: string): Record<string, unknown> => {
  const part = jwt.split('.')[1];
  const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(normalized))));
};

// Keycloak 等のクレームを Cognito 互換キーに正規化する。
// 既存コードは accessToken.payload['cognito:groups'] を参照するため、
// groups / realm_access.roles をマッピングする。
const normalizePayload = (payload: Record<string, unknown>): Record<string, unknown> => {
  if (payload['cognito:groups']) {
    return payload;
  }
  const groups =
    (payload.groups as string[] | undefined) ??
    ((payload.realm_access as { roles?: string[] } | undefined)?.roles as string[] | undefined) ??
    [];
  return {
    ...payload,
    // Keycloak の group パスは "/GroupName" 形式のため先頭スラッシュを除去する
    'cognito:groups': groups.map((g) => g.replace(/^\//, '')),
    'cognito:username': payload.preferred_username ?? payload.sub,
  };
};

const wrapToken = (token: string): TokenLike => ({
  payload: normalizePayload(decodeJwtPayload(token)),
  toString: () => token,
});

export const fetchSession = async (): Promise<AuthSession> => {
  if (authProvider === 'oidc') {
    const user = await getUserManager().getUser();
    if (!user || user.expired) {
      return {};
    }
    return {
      tokens: {
        idToken: wrapToken(user.id_token ?? user.access_token),
        accessToken: wrapToken(user.access_token),
      },
    };
  }

  const { fetchAuthSession } = await import('aws-amplify/auth');
  return (await fetchAuthSession()) as AuthSession;
};

// API 呼び出し用のトークンを返す。
// OIDC ではリソースサーバ向けの access_token を、Cognito では従来どおり idToken を使う。
export const getAuthToken = async (): Promise<string | undefined> => {
  const session = await fetchSession();
  if (authProvider === 'oidc') {
    return session.tokens?.accessToken?.toString();
  }
  return session.tokens?.idToken?.toString();
};

export const signOutUser = async (): Promise<void> => {
  if (authProvider === 'oidc') {
    await getUserManager().signoutRedirect();
    return;
  }
  const { signOut } = await import('aws-amplify/auth');
  await signOut();
};
