// sub から安定ユーザーID（外部AIアプリへ渡す x-user-id）を生成する。
// AWS 版は KMS HMAC を使用していたが、本実装はローカル HMAC-SHA256 を使用する。
// USER_IDENTIFIER_HMAC_SECRET を変更すると全ユーザーの安定IDが変わる点に注意。

import * as crypto from 'crypto';

const DOMAIN_PREFIX = 'genai-web-user-id:';

export const generateStableUserId = (sub: string): string => {
  if (!sub) {
    throw new Error('sub is required');
  }
  const secret = process.env.USER_IDENTIFIER_HMAC_SECRET;
  if (!secret) {
    throw new Error('USER_IDENTIFIER_HMAC_SECRET is not configured');
  }
  return crypto
    .createHmac('sha256', secret)
    .update(DOMAIN_PREFIX + sub)
    .digest('base64url');
};
