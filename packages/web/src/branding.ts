// サイトのブランディング（ロゴ・コピーライト）を環境変数で差し替えるためのモジュール。
// 未設定の場合は従来どおりのプレースホルダを表示する。
//
// ロゴ画像を使う場合は VITE_APP_LOGO_IMAGE_URL に URL を設定する。
// docker compose 構成では .local/branding/ が /branding/ として配信されるため、
// リポジトリにコミットせずに画像を差し替えられる（例: /branding/logo.svg）。

export const LOGO_TEXT: string = import.meta.env.VITE_APP_LOGO_TEXT || 'ここにロゴが入る';

export const LOGO_IMAGE_URL: string | undefined =
  import.meta.env.VITE_APP_LOGO_IMAGE_URL || undefined;

export const COPYRIGHT_TEXT: string =
  import.meta.env.VITE_APP_COPYRIGHT_TEXT || 'ここにコピーライトが入る';
