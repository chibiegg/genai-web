import { ReactNode, useEffect, useState } from 'react';
import { getUserManager } from '@/lib/auth';

type Props = {
  children: ReactNode;
};

// OIDC (Keycloak 等) の Authorization Code + PKCE フローで認証する。
// 未認証なら IdP へリダイレクトし、コールバック（?code=...&state=...）を処理する。
export const AuthWithOidc = ({ children }: Props) => {
  const [status, setStatus] = useState<'loading' | 'authenticated' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const um = getUserManager();

    const run = async () => {
      const params = new URLSearchParams(window.location.search);

      // IdP からのリダイレクトコールバック
      if (params.has('code') && params.has('state')) {
        const user = await um.signinCallback();
        // クエリパラメータを除去（元のパスに戻す）
        const returnTo =
          user && typeof user.state === 'string' && user.state.startsWith('/')
            ? user.state
            : window.location.pathname;
        window.history.replaceState({}, '', returnTo);
        if (user) {
          setStatus('authenticated');
          return;
        }
      }

      // 既存セッションの確認
      const existing = await um.getUser();
      if (existing && !existing.expired) {
        setStatus('authenticated');
        return;
      }

      // サインアウト直後のページではリダイレクトしない
      if (window.location.pathname === '/signed-out') {
        setStatus('error');
        setErrorMessage('サインアウトしました。');
        return;
      }

      // 未認証 → IdP へ（復帰先のパスを state に保存）
      await um.signinRedirect({
        state: `${window.location.pathname}${window.location.search}`,
      });
    };

    run().catch((e) => {
      console.error('OIDC authentication error:', e);
      setErrorMessage(String(e));
      setStatus('error');
    });
  }, []);

  if (status === 'authenticated') {
    return <>{children}</>;
  }

  return (
    <div className='flex h-screen items-center justify-center'>
      <div className='text-center'>
        {status === 'loading' ? (
          <p>認証情報を確認しています...</p>
        ) : (
          <div>
            <p className='mb-4'>{errorMessage || '認証でエラーが発生しました。'}</p>
            <button
              type='button'
              className='underline'
              onClick={() => {
                window.location.href = '/';
              }}
            >
              サインイン画面へ
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
