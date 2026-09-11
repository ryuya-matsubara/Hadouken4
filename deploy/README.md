# AWS デプロイ（S3 + CloudFront）

Hadouken Battle は依存ライブラリのない静的サイトなので、**プライベート S3
バケット + CloudFront** で配信します。バケットは非公開のままで、CloudFront の
**Origin Access Control (OAC)** 経由でのみ読み取れる構成です。

```
ブラウザ ──HTTPS──▶ CloudFront ──OAC(SigV4)──▶ S3（非公開バケット）
```

## 現在のデプロイ

| 項目 | 値 |
|---|---|
| リージョン | `us-east-1` |
| S3 バケット | `hadouken3-<ACCOUNT_ID>-us-east-1`（全public access block） |
| OAC | CloudFront 用（`SigningBehavior: always`, origin type `s3`） |
| CloudFront | `PriceClass_100`, `redirect-to-https`, default root `index.html` |
| Cache Policy | AWS マネージド `CachingOptimized`（`658327ea-f89d-4fab-a63d-7e88639e58f6`） |
| 公開 URL | `https://<distribution>.cloudfront.net/` |

> 実際のバケット名・ディストリビューション ID・ドメインはアカウント依存です。
> 稼働中の値は Pull Request の説明を参照してください。

## 前提

- AWS CLI v2 と有効な認証情報（`aws sts get-caller-identity` が成功すること）
- 静的サイトなのでビルドは不要

## 通常のデプロイ（アセット更新）

インフラが作成済みなら、アセットの同期とキャッシュ無効化はこれだけです。

```bash
./deploy/deploy.sh
```

`deploy.sh` は次を行います。

1. バケットが無ければ作成し、public access を全ブロック
2. `index.html` / `manifest.webmanifest` / `*.png` を適切な `Content-Type`
   と `Cache-Control` でアップロード
3. 対象バケットを origin に持つ CloudFront があれば `/*` を無効化

## 初回のインフラ構築（一度だけ）

`deploy.sh` はバケット作成とアセット同期までを自動化します。CloudFront と
OAC、バケットポリシーは初回のみ以下の手順で作成します（値は環境に合わせて置換）。

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1
BUCKET=hadouken3-${ACCOUNT_ID}-${REGION}

# 1) バケット作成 + アセット同期（public access はブロック）
./deploy/deploy.sh

# 2) OAC を作成
OAC_ID=$(aws cloudfront create-origin-access-control \
  --origin-access-control-config '{
    "Name":"hadouken3-oac","Description":"OAC for Hadouken3",
    "SigningProtocol":"sigv4","SigningBehavior":"always",
    "OriginAccessControlOriginType":"s3"}' \
  --query 'OriginAccessControl.Id' --output text)

# 3) ディストリビューション作成
#    deploy/cloudfront-distribution.json の <BUCKET_REGIONAL_DOMAIN> と
#    <OAC_ID> を置換してから実行
sed -e "s#<BUCKET_REGIONAL_DOMAIN>#${BUCKET}.s3.${REGION}.amazonaws.com#" \
    -e "s#<OAC_ID>#${OAC_ID}#" \
    deploy/cloudfront-distribution.json > /tmp/dist.json
DIST_ID=$(aws cloudfront create-distribution \
  --distribution-config file:///tmp/dist.json \
  --query 'Distribution.Id' --output text)

# 4) バケットポリシーで、その CloudFront からの読み取りだけを許可
sed -e "s#<BUCKET>#${BUCKET}#" \
    -e "s#<ACCOUNT_ID>#${ACCOUNT_ID}#" \
    -e "s#<DISTRIBUTION_ID>#${DIST_ID}#" \
    deploy/bucket-policy.json > /tmp/policy.json
aws s3api put-bucket-policy --bucket "${BUCKET}" --policy file:///tmp/policy.json

# 5) 配信開始まで待機
aws cloudfront wait distribution-deployed --id "${DIST_ID}"
aws cloudfront get-distribution --id "${DIST_ID}" \
  --query 'Distribution.DomainName' --output text
```

## E2E テスト

`e2e/` に Playwright ベースの E2E があり、デプロイ済み URL に対して
ホーム → キャラ選択 → 対戦 → 勝敗表示までを実際に操作して検証します。

```bash
cd e2e
npm install
npx playwright install chromium      # ブラウザが未インストールの場合
SITE_URL=https://<distribution>.cloudfront.net/ npm test
```

検証内容（抜粋）:

- HTTP 200 / HTTPS 配信 / タイトル
- 外部画像（タイトル画像）の読み込み
- 1 ゲームを最後までプレイし、勝者が表示されること（敗者 HP=0）
- `manifest.webmanifest` が 200 で取得できること
- 未捕捉の JS エラー・コンソールエラーが無いこと
