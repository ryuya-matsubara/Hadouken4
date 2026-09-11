# E2E テスト（オンライン対戦）

デプロイ済みのオンライン対戦バックエンド（API Gateway WebSocket）とフロント
（S3 + CloudFront）に対する End-to-End テストです。

## セットアップ

```bash
cd e2e
npm install
npx playwright install chromium   # ブラウザテスト用（未インストールの場合）
```

## テスト

### 1. WebSocket バックエンド E2E（`online.e2e.mjs`）

2 つの WebSocket クライアントを実際に接続し、サーバー権威型の対戦フローを検証
します: `createRoom → joinRoom → selectCharacter ×2 → submitAction ループ →
勝敗 → 再戦 → エラー処理`。両クライアントに同一の解決結果が届くこと、KO で
勝者が確定することを確認します。

```bash
WS_URL=wss://<api-id>.execute-api.ap-northeast-1.amazonaws.com/prod \
  npm run test:online
```

### 2. ブラウザ E2E（`online-browser.e2e.mjs`）

デプロイ済みサイトを 2 つのヘッドレスブラウザで開き、`online-config.js` に
正しい `wss://` URL が設定されていること、オンライン対戦ボタンが存在すること、
ブラウザからバックエンドへ WebSocket ハンドシェイクが成立することを確認します。

```bash
SITE_URL=https://<distribution>.cloudfront.net/ \
  npm run test:online-browser
```

## 環境変数

| 変数 | 説明 | 既定値 |
|---|---|---|
| `WS_URL` | バックエンドの WebSocket URL | デプロイ済みの値 |
| `SITE_URL` | フロントの公開 URL | デプロイ済みの CloudFront URL |
| `CHROME_PATH` | Chromium 実行ファイルのパス（任意） | Playwright 既定 |
| `SCREENSHOT_PATH` | スクリーンショット出力先（任意） | カレントディレクトリ |
