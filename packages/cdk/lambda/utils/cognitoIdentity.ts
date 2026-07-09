import {
  CognitoIdentityClient,
  DescribeIdentityPoolCommand,
  GetIdCommand,
  ListIdentityPoolsCommand,
} from '@aws-sdk/client-cognito-identity';

const client = new CognitoIdentityClient({});

const USER_POOL_ID = process.env.USER_POOL_ID!;
const REGION = process.env.AWS_REGION!;
const LIST_MAX_RESULTS = 60;

let cachedIdentityPoolId: string | undefined;

export async function resolveIdentityId(idToken: string): Promise<string> {
  // OIDC モード（Keycloak 等）では Cognito Identity Pool を使わず、
  // トークンの sub をそのまま identityId として利用する。
  // トークンの署名検証は API サーバの認証ミドルウェアで実施済みであることが前提。
  if (process.env.AUTH_PROVIDER === 'oidc') {
    return extractSubFromJwt(idToken);
  }

  const issuer = `cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
  try {
    return await getIdOnce(idToken, issuer, await discoverIdentityPoolId());
  } catch (_err) {
    // キャッシュされた Pool ID が stale な可能性を考慮して 1 度だけ再試行
    cachedIdentityPoolId = undefined;
    return await getIdOnce(idToken, issuer, await discoverIdentityPoolId());
  }
}

function extractSubFromJwt(idToken: string): string {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('JWT does not contain sub claim');
  }
  return payload.sub;
}

async function getIdOnce(idToken: string, issuer: string, identityPoolId: string): Promise<string> {
  const result = await client.send(
    new GetIdCommand({
      IdentityPoolId: identityPoolId,
      Logins: { [issuer]: idToken },
    }),
  );
  if (!result.IdentityId) {
    throw new Error('Failed to resolve Cognito Identity ID');
  }
  return result.IdentityId;
}

async function discoverIdentityPoolId(): Promise<string> {
  if (cachedIdentityPoolId) return cachedIdentityPoolId;

  const expectedProvider = `cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
  let nextToken: string | undefined;

  do {
    const res = await client.send(
      new ListIdentityPoolsCommand({ MaxResults: LIST_MAX_RESULTS, NextToken: nextToken }),
    );
    for (const pool of res.IdentityPools ?? []) {
      if (!pool.IdentityPoolId) continue;
      const detail = await client.send(
        new DescribeIdentityPoolCommand({ IdentityPoolId: pool.IdentityPoolId }),
      );
      const matched = detail.CognitoIdentityProviders?.some(
        (p) => p.ProviderName === expectedProvider,
      );
      if (matched) {
        cachedIdentityPoolId = pool.IdentityPoolId;
        return cachedIdentityPoolId;
      }
    }
    nextToken = res.NextToken;
  } while (nextToken);

  throw new Error(
    `No Cognito Identity Pool is linked to User Pool ${USER_POOL_ID} in region ${REGION}`,
  );
}
