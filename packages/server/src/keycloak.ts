// Keycloak Admin REST API クライアント（メールアドレス → ユーザー解決用）。
// チームメンバー追加時に email から sub / username を引くために使用する。

type KeycloakUser = {
  id: string;
  username: string;
  email?: string;
};

const getAdminBaseUrl = (): { base: string; realm: string } => {
  // OIDC_ISSUER (http://host:8180/realms/genai) から導出する
  const issuer = (process.env.OIDC_ISSUER ?? '').replace(/\/+$/, '');
  const m = issuer.match(/^(.*)\/realms\/([^/]+)$/);
  if (!m) {
    throw new Error('OIDC_ISSUER から Keycloak の URL を導出できません');
  }
  return { base: process.env.KEYCLOAK_ADMIN_URL?.replace(/\/+$/, '') || m[1], realm: m[2] };
};

let cachedToken: { token: string; expiresAt: number } | undefined;

const getAdminToken = async (): Promise<string> => {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5000) {
    return cachedToken.token;
  }

  const { base } = getAdminBaseUrl();
  const username = process.env.KEYCLOAK_ADMIN_USER ?? 'admin';
  const password = process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin';

  const res = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username,
      password,
    }),
  });
  if (!res.ok) {
    throw new Error(`Keycloak admin token の取得に失敗しました (${res.status})`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
};

export const findUserByEmail = async (email: string): Promise<KeycloakUser | null> => {
  const { base, realm } = getAdminBaseUrl();
  const token = await getAdminToken();
  const res = await fetch(
    `${base}/admin/realms/${realm}/users?email=${encodeURIComponent(email)}&exact=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error(`Keycloak ユーザー検索に失敗しました (${res.status})`);
  }
  const users = (await res.json()) as KeycloakUser[];
  return users[0] ?? null;
};
