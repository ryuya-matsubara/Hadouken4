# Hadouken Battle ⚡

プレイヤー1 vs プレイヤー2 のターン制対戦Webアプリ。**相手のHPを0にした方が勝ち**です。

対戦方式は2種類あります。

- 🎮 **ローカル対戦**（従来どおり）— 1台の端末で交互に操作する「パス＆プレイ」方式。
- 🌐 **オンライン対戦**（新規）— 2台のスマートフォン／ブラウザからインターネット経由で対戦。AWS のサーバーレス構成（API Gateway WebSocket + Lambda + DynamoDB）で動作します。

> ローカル対戦はサーバー不要で今までどおり動きます。オンライン対戦を使う場合のみ、後述の AWS バックエンドをデプロイして `online-config.js` に WebSocket URL を設定してください。

---

## 目次

- [あそび方（ローカル対戦）](#あそび方ローカル対戦)
- [あそび方（オンライン対戦）](#あそび方オンライン対戦)
- [ルール](#ルール)
- [キャラクター](#キャラクター)
- [アクション](#アクション)
- [アーキテクチャ](#アーキテクチャ)
- [AWSサービス構成](#awsサービス構成)
- [デプロイ方法](#デプロイ方法)
- [フロントエンドの設定（GitHub Pages）](#フロントエンドの設定github-pages)
- [削除方法](#削除方法)
- [ローカルテスト方法](#ローカルテスト方法)
- [AWS料金についての注意](#aws料金についての注意)
- [セキュリティ](#セキュリティ)
- [トラブルシューティング](#トラブルシューティング)
- [技術](#技術)

---

## あそび方（ローカル対戦）

1. `index.html` をブラウザで開く。
2. 「🎮 ローカル対戦（1台で交代）」を押す。
3. プレイヤー1がキャラクターを選び、「キャラクターを決定」を押す。
4. 続いてプレイヤー2がキャラクターを選び、「キャラクターを決定」を押す。
5. プレイヤー1 → プレイヤー2 の順にアクションを選び、「決定」を押す。
6. 「⚔️Battle⚔️」ボタンでバトルシーンが再生される。
7. どちらかのHPが0になれば勝者を表示、決着がつかなければ次のターンへ。

## あそび方（オンライン対戦）

事前に AWS バックエンドをデプロイし、`online-config.js` に WebSocket URL を設定しておく必要があります（[デプロイ方法](#デプロイ方法)参照）。

1. 両プレイヤーが `index.html`（GitHub Pages のURL）を開く。
2. 「🌐 オンライン対戦」を押す。
3. 片方が **「ルームを作成（CREATE ROOM）」** を選び、**4桁の数字**を入力して発行する。
4. もう片方が **「ルームに参加（JOIN ROOM）」** を選び、同じ4桁のコードを入力する。
5. 2人が揃うと、両者それぞれがキャラクターを選択する（相手の選択が終わるまで待機）。
6. 各ターン、両者がそれぞれアクションを選ぶ。**自分の選択は相手に見えません。**
7. 先に選んだ側には「対戦相手を待っています…」が表示され、相手が選び終えると
   「相手がアクションを選択しました」と表示されます（内容は伏せられたまま）。
8. 両者の選択が揃うと、**サーバー側で勝敗判定**が行われ、両端末で同じバトルシーンが再生されます。
9. HP・エネルギー・ターン数は常にサーバーの状態に同期されます。
10. HPが0になったら結果画面へ。「もう一度あそぶ」で再戦、「ホームに戻る」で退出できます。

画面には Room Code / Player 1・Player 2 / 接続状態（右上のバッジ）/ 待機表示 / 相手の選択済み表示 / 切断・エラー通知（トースト）が表示されます。

## ルール

- HP制。**HPが0になったら負け**（🟢 が3つからスタート）。
- 1ターンに1アクションを実行する。
- ローカル対戦では プレイヤー1 → プレイヤー2 の順に選択。オンライン対戦では両者が同時に選択（相手には伏せられる）。
- 両者のHPが同時に0になった場合は引き分け。

## キャラクター

キャラクターごとに固有の必殺技を持ちます。

| キャラ | 必殺技 | 消費エネルギー | 効果 |
|---|---|---:|---|
| Hadou | 波動拳 | 3 | ガード不能。相手に1ダメージ |
| Blaze | メガブラスト | 2 | 相手に2ダメージ。ただしガード可能 |
| Phantom | VOID | 0 | 相手のエネルギーを1減らす。相手が攻撃してきた場合、HPは減る |
| Angel | ヒール | 2 | 自分のHPを1回復する |

## アクション

チャージ・ガード・ブラストは全キャラクター共通。必殺技だけがキャラクター固有です。

| アクション | 消費エネルギー | 効果 |
|---|---|---|
| 🔵 チャージ | +1 | エネルギーを1溜める |
| 💥 ブラスト | -1 | 相手に1ダメージ。ガードで防がれる |
| 🛡️ ガード | 0 | ブラスト（およびメガブラスト）を防ぐ |
| ⭐ 必殺技 | キャラ依存 | キャラクター固有の効果を発動 |

- **HP** は 🟢、**エネルギー** は 🟠 で表示します。
- エネルギーは最大 **3** 個。
- 消費エネルギーが足りないアクションは選択できません。
- **ブラスト同士**、および**ブラストとメガブラスト**は相殺し、お互いHPは減りません（ノックバックもなし）。
- **波動拳**は貫通技。相手の**ブラスト／メガブラスト**は失敗し、波動拳のダメージだけが通ります。

これらのルールは `shared/gameEngine.js` に単一のソースとして実装されており、ローカル対戦・オンライン対戦（サーバー側 Lambda）の**両方で同じ判定**を使用します。

---

## アーキテクチャ

```
┌──────────────────────┐         WebSocket (wss://)        ┌───────────────────────────┐
│  ブラウザ (Player 1)   │  ───────────────────────────▶   │  API Gateway WebSocket API  │
│  GitHub Pages         │  ◀───────────────────────────   │  ($connect/$disconnect/    │
│  index.html           │                                  │   $default + カスタムルート) │
└──────────────────────┘                                   └────────────┬──────────────┘
┌──────────────────────┐                                                │ AWS_PROXY
│  ブラウザ (Player 2)   │  ◀───────────────────────────                 ▼
│  GitHub Pages         │  ───────────────────────────▶   ┌───────────────────────────┐
└──────────────────────┘                                   │  Lambda (単一ディスパッチャ) │
                                                            │  handlers/index.js         │
                                                            │  + 共有ルールエンジン        │
                                                            └────┬──────────────┬───────┘
                                                                 │              │ ManageConnections
                                                        条件付き更新 │              │ (結果を両者へ配信)
                                                                 ▼              │
                                                    ┌────────────────────┐      │
                                                    │  DynamoDB           │      │
                                                    │  Rooms / Connections │◀─────┘
                                                    │  (TTL 自動削除)      │
                                                    └────────────────────┘
                                                                 │
                                                                 ▼
                                                    ┌────────────────────┐
                                                    │  CloudWatch Logs    │
                                                    │  (保持期間 14日)     │
                                                    └────────────────────┘
```

- **サーバー権威（server-authoritative）**：クライアントから送られた HP・エネルギーは信用せず、Lambda 側でルールエンジンを使って状態を再計算します。
- **相手の選択は非公開**：両者の選択が揃うまで、相手のアクションはクライアントへ配信されません。
- **常時稼働サーバーなし**：EC2 / ECS は使用しません。リクエストが無いときの費用はほぼゼロです。
- **リージョン**：`ap-northeast-1`（東京）。

詳細な設計は [`backend/README.md`](backend/README.md) を参照してください。

## AWSサービス構成

| サービス | 用途 |
|---|---|
| **API Gateway (WebSocket API)** | 双方向のリアルタイム通信。ルート `$connect` / `$disconnect` / `$default` / `createRoom` / `joinRoom` / `selectCharacter` / `submitAction` / `rematch` / `leave` |
| **AWS Lambda** | 全ルートを処理する単一関数。ルール判定・状態更新・両端末への配信 |
| **Amazon DynamoDB** | ルーム状態（`Rooms`）と接続情報（`Connections`）を保存。オンデマンド課金・TTL 自動削除 |
| **CloudWatch Logs** | Lambda のログ（保持期間14日・出力は最小限） |
| **IAM** | Lambda 実行ロール（最小権限） |
| **AWS SAM / CloudFormation** | 上記すべてを IaC（`backend/template.yaml`）で管理 |

---

## デプロイ方法

### 前提

- [AWS CLI](https://docs.aws.amazon.com/cli/) と [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html) がインストール済み。
- デプロイに使う AWS 認証情報が設定済み（`aws configure` など）。
- リージョンは **`ap-northeast-1`** を使用します。

### 手順

```bash
cd backend

# （共有ルールエンジンを変更した場合のみ）Lambda 用にコピー
./sync-engine.sh

# ビルド
sam build

# 初回デプロイ（対話。以降は sam deploy だけでOK）
sam deploy --guided --region ap-northeast-1
#   Stack Name         : hadouken-online
#   AWS Region         : ap-northeast-1
#   Confirm changes    : N（または任意）
#   Allow SAM CLI IAM  : Y
#   Save arguments     : Y  (samconfig.toml に保存)

# 2回目以降
sam deploy
```

デプロイ後、CloudFormation の **Outputs** に必要な値が出力されます。

```bash
aws cloudformation describe-stacks \
  --stack-name hadouken-online \
  --region ap-northeast-1 \
  --query "Stacks[0].Outputs" --output table
```

| Output キー | 内容 |
|---|---|
| `WebSocketURL` | フロントエンドに設定する `wss://...` の URL |
| `WebSocketApiId` | WebSocket API の ID |
| `RoomsTableName` / `ConnectionsTableName` | DynamoDB テーブル名 |
| `GameFunctionName` | Lambda 関数名 |
| `Region` | デプロイ先リージョン |

## フロントエンドの設定（GitHub Pages）

1. 上記 `WebSocketURL` の値をコピーする。
2. リポジトリ直下の [`online-config.js`](online-config.js) を編集する。

   ```js
   window.HADOUKEN_ONLINE_CONFIG = {
     WEBSOCKET_URL: "wss://xxxxxxxx.execute-api.ap-northeast-1.amazonaws.com/prod",
   };
   ```

3. コミットして GitHub Pages に公開する（Settings → Pages）。

> `online-config.js` に入るのは**公開エンドポイントの URL のみ**で、秘密情報は含みません。AWS のアクセスキーやシークレットは絶対にコミットしないでください。
> `WEBSOCKET_URL` が空のあいだは、「オンライン対戦」ボタンを押すと「未設定」の案内が表示され、ローカル対戦は今までどおり動作します。

## 削除方法

作成した AWS リソースをすべて削除します（テスト用に作成した場合は確認後に削除してください）。

```bash
cd backend
sam delete --stack-name hadouken-online --region ap-northeast-1
```

- DynamoDB テーブル、Lambda、API Gateway、IAM ロール、CloudWatch ロググループを含め、スタックが作成したものはすべて削除されます。
- 終了したルームは TTL によって自動的に消えるため、通常は手動削除は不要です。

## ローカルテスト方法

AWS にデプロイしなくても、ルール判定とオンライン通信フローをローカルで検証できます。

### ユニットテスト（AWS 不要）

ルールエンジンと、ルームの整合性（二重送信・同時更新など）のテストです。

```bash
cd backend
npm test
```

期待結果：`# pass 30 / # fail 0`。テスト項目は以下を含みます。

- 通常攻撃（ブラスト）／ガード／必殺技（波動拳・メガブラスト・ヒール・VOID）
- エネルギー消費・HP 更新
- 同時アクション／無効アクション
- 二重送信の無効化（idempotency）
- ゲーム終了（勝敗・引き分け）
- ルーム作成の重複防止／満室・存在しないルームの拒否／再戦リセット
- バージョン条件付き更新による同時解決の一意性

### オンライン通信フローのローカル E2E（AWS 不要）

依存パッケージ不要のローカル WebSocket サーバーで、実際の 2 ブラウザ対戦を検証できます。
このサーバーは本番と同じ `gameEngine.js` / `rooms.js`（インメモリの DynamoDB モック）を利用します。**テスト専用**でデプロイはされません。

```bash
cd backend
node test/localServer.js 8090     # ローカル WS サーバー起動（別ターミナルで）
```

別ターミナルで静的サーバーを起動し、ブラウザで開きます。

```bash
# リポジトリ直下で
python3 -m http.server 8099
# ブラウザで http://127.0.0.1:8099/index.html を2つ開く
```

各ブラウザのデベロッパーツール（Console）で、一時的に接続先を切り替えます。

```js
window.HADOUKEN_ONLINE_CONFIG.WEBSOCKET_URL = "ws://127.0.0.1:8090";
```

その後、片方で「ルームを作成」、もう片方で同じコードで「参加」すると対戦できます。

## AWS料金についての注意

- 本構成は**完全サーバーレス**で、常時稼働するインスタンスはありません。**アクセスが無いときの費用はほぼゼロ**です。
- DynamoDB は **オンデマンド（PAY_PER_REQUEST）** で、使った分だけ課金されます。ルームは TTL で自動削除されます。
- Lambda・API Gateway（WebSocket）・DynamoDB・CloudWatch Logs には無料枠があります。個人利用の対戦であれば、無料枠内に収まることがほとんどです。
- CloudWatch Logs の保持期間は既定 **14日**（`LogRetentionDays` パラメータで変更可）。ログ出力はエラー中心の最小限に抑えています。
- 料金は変わる可能性があります。正確な金額は [AWS 料金ページ](https://aws.amazon.com/jp/pricing/) と請求ダッシュボードで確認してください。
- 不要になったら [削除方法](#削除方法) でスタックごと削除してください。

## セキュリティ

- IAM は**最小権限**。Lambda は自分のロググループ、指定 DynamoDB テーブル、当該 WebSocket API の接続管理のみ許可されています。
- **秘密情報はリポジトリにコミットしません。** `online-config.js` に入るのは公開 URL のみです。`backend/.gitignore` で認証情報・ビルド成果物を除外しています。
- ルーム操作は接続レコードから解決した自分のルーム・スロットに対してのみ許可され、**他ルームの状態を不正に操作できません**。
- ルームコード（4桁）・キャラクター・アクションなどの**入力値は Lambda 側で検証**します。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| 「オンライン対戦」で「未設定」と出る | `online-config.js` の `WEBSOCKET_URL` を設定してください。 |
| 右上の接続バッジが「切断」のまま | URL のスペル（`wss://`・末尾のステージ名 `/prod`）を確認。ブラウザの Console にエラーが出ていないか確認。 |
| 「そのルームコードは使用中です」 | 別の4桁コードで作成してください。 |
| 「ルームが見つかりません」 | コードの入力ミス、または相手がまだ作成していない可能性。 |
| 「このルームは満員です」 | すでに2人が入室済み。別のルームを作成してください。 |
| 相手が反応しない／切断表示 | 相手のネットワークを確認。数秒待つと自動再接続を試みます。改善しなければホームに戻って再入室してください。 |
| `sam build` でエラー | SAM CLI と Node.js 20.x 相当が入っているか確認。`backend/` で実行しているか確認。 |
| デプロイ後 URL が分からない | `aws cloudformation describe-stacks ...`（[デプロイ方法](#デプロイ方法)）で Outputs を確認。 |
| `npm test` が preload エラーになる（特殊環境） | `NODE_OPTIONS` を解除して実行：`env -u NODE_OPTIONS npm test`（通常の環境では不要）。 |

---

## 画像について

- キャラクターのアイコン・アクションシーンの画像はキャラクターごとに切り替わります。
- **プレイヤー2** は各画像を CSS（`transform: scaleX(-1)`）で左右反転して表示します（反転済み画像は使いません）。
- アクション選択画面では、チャージ・ガード・ブラストは共通アイコン、右下の必殺技だけキャラ固有のアイコンを表示します。

## 技術

- フロントエンドは依存ライブラリなしの単一 HTML ファイル（HTML + CSS + Vanilla JS）＋ 設定ファイル `online-config.js`。ビルド不要（`index.html` を開くだけでローカル対戦は動作）。
- 共有ルールエンジン `shared/gameEngine.js`（ブラウザ / Node.js 両対応、純粋関数）。
- バックエンドは AWS SAM + CloudFormation（`backend/`）。Node.js 20.x / DynamoDB / API Gateway WebSocket。
- 詳細は [`backend/README.md`](backend/README.md) を参照。

## デプロイ（AWS）

- **フロント（静的サイト）**: **S3 + CloudFront** に配信（バケットは非公開、CloudFront の OAC 経由でのみ配信）。手順とスクリプトは [`deploy/`](deploy/) にあります。

  ```bash
  # アセットの同期 + キャッシュ無効化（インフラ構築済みの場合）
  ./deploy/deploy.sh
  ```

  初回のインフラ構築（S3 / OAC / CloudFront / バケットポリシー）は [`deploy/README.md`](deploy/README.md) を参照してください。

- **バックエンド（オンライン対戦）**: AWS SAM で `backend/` をデプロイ（`sam build && sam deploy`、`ap-northeast-1`）。出力された WebSocket URL を `online-config.js` に設定します。詳細は [`backend/README.md`](backend/README.md)。
- 全体構成図は [`docs/architecture.md`](docs/architecture.md) を参照。

## E2E テスト

[`e2e/`](e2e/) に Playwright / WebSocket ベースの E2E を用意しています。

```bash
cd e2e
npm install
npx playwright install chromium
# 静的サイト（デプロイ済み URL に対して）
SITE_URL=https://<distribution>.cloudfront.net/ npm test
# オンライン対戦バックエンド
WS_URL=wss://<api-id>.execute-api.ap-northeast-1.amazonaws.com/prod npm run test:online
```
