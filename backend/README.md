# Hadouken Battle — オンライン対戦バックエンド

Hadouken Battle の**オンライン対戦モード**を支える AWS サーバーレスバックエンドです。
API Gateway WebSocket API + 単一 Lambda + DynamoDB + CloudWatch Logs で構成され、
すべて AWS SAM / CloudFormation（`template.yaml`）で管理されます。**常時稼働サーバーは使いません。**

- リージョン: **ap-northeast-1**
- ランタイム: **Node.js 20.x**（`arm64`）
- 課金: DynamoDB はオンデマンド。アイドル時のコストはほぼゼロ。

---

## ディレクトリ構成

```
backend/
├── template.yaml            # SAM + CloudFormation（全リソース定義）
├── samconfig.toml           # sam deploy の既定設定（region=ap-northeast-1）
├── sync-engine.sh           # shared/gameEngine.js を Lambda へコピー
├── package.json             # npm test（ユニットテスト）
├── .gitignore               # 認証情報・ビルド成果物を除外
├── src/
│   ├── package.json         # Lambda 依存（SDK v3 はランタイム同梱のため未バンドル）
│   ├── handlers/
│   │   └── index.js         # 全ルートを処理する単一ディスパッチャ
│   └── lib/
│       ├── gameEngine.js    # 共有ルールエンジン（shared/ のコピー・単一ソース）
│       ├── rooms.js         # DynamoDB アクセス（条件付き更新で整合性を担保）
│       ├── ddb.js           # DocumentClient とテーブル名の集約
│       └── ws.js            # API Gateway Management API 送信ヘルパ
└── test/
    ├── gameEngine.test.js   # ルール判定のユニットテスト
    ├── rooms.test.js        # ルーム整合性（同時更新・二重送信）のテスト
    ├── mockDdb.js           # インメモリ DynamoDB モック（条件式を簡易評価）
    └── localServer.js       # 依存なしのローカル WS サーバー（E2E 用・非デプロイ）
```

---

## データモデル（DynamoDB）

### `Rooms` テーブル（PK: `roomId`）

| 属性 | 型 | 説明 |
|---|---|---|
| `roomId` | S | 4桁のルームコード（例 `"1234"`） |
| `status` | S | `waiting` / `charselect` / `playing` / `finished` |
| `p1Conn` / `p2Conn` | S | 各プレイヤーの connectionId |
| `p1Char` / `p2Char` | S | 選択キャラクター id |
| `hp` | M | `{ "1": n, "2": n }` |
| `energy` | M | `{ "1": n, "2": n }` |
| `turn` | N | 現在のターン番号（1〜） |
| `actions` | M | `{ "<turn>": { "1": action, "2": action } }`（両者揃うまで一方は未設定） |
| `version` | N | 楽観的ロック用のカウンタ |
| `winner` | N | `0`(引分) / `1` / `2` / なし |
| `ttl` | N | 自動削除のための epoch 秒 |

### `Connections` テーブル（PK: `connectionId`）

| 属性 | 型 | 説明 |
|---|---|---|
| `connectionId` | S | WebSocket 接続 ID |
| `roomId` | S | 所属ルーム |
| `slot` | N | `1` or `2` |
| `ttl` | N | 自動削除のための epoch 秒 |

両テーブルとも **TTL 有効**（属性 `ttl`）。終了したルームは短い TTL、活動中は都度延長されます。

---

## WebSocket プロトコル

`RouteSelectionExpression` は `$request.body.action`。クライアントは JSON を送ります。

### クライアント → サーバー

| `action` | 追加フィールド | 説明 |
|---|---|---|
| `createRoom` | `roomId`(4桁) | ルーム作成（コード発行） |
| `joinRoom` | `roomId`(4桁) | ルーム参加 |
| `selectCharacter` | `charId` | 自分のキャラクター確定 |
| `submitAction` | `move`, `turn` | 自分のアクション送信。**移動は `move`**（`action` はルート名に使うため衝突回避） |
| `rematch` | — | 再戦（状態リセット） |
| `leave` | — | 退出（ルーム削除） |

### サーバー → クライアント（`type`）

| `type` | 説明 |
|---|---|
| `roomCreated` | 作成成功。ルーム待機画面へ |
| `roomJoined` | 2人揃った。キャラ選択へ |
| `charUpdate` | どちらかがキャラ選択した |
| `battleStart` | 両者キャラ確定。対戦開始 |
| `waitingForOpponent` | 自分は送信済み。相手待ち |
| `opponentReady` | 相手が選択済み（**内容は含まない**） |
| `turnResult` | 判定結果（両者に同一内容）。アクション・イベント・確定後の HP/EN |
| `rematchStart` | 再戦開始 |
| `opponentDisconnected` / `opponentLeft` | 相手の切断・退出 |
| `state` | 状態の再同期 |
| `error` | エラー（`code`, `message`） |

`turnResult` と各状態通知は、閲覧者ごとに個別化され、**相手の未確定アクションは決して含めません**（`roomView()` 参照）。

---

## 整合性・冪等性の設計

- **二重送信対策**：アクション記録は「そのターン・そのスロットに未記録のときだけ書く」条件付き更新（`attribute_not_exists`）。同じターンに同じプレイヤーが複数回送っても二重処理されません。
- **同時更新対策**：ターン確定は `version` の条件付き更新（`ConditionExpression: version = :expected`）で行い、**同時に来た解決要求のうち1つだけ**がコミット＆配信します。
- **相手アクションの非公開**：両者が揃うまで、相手の `action` はクライアントへ送りません。
- **サーバー権威**：HP/エネルギーはクライアントの申告を使わず、ルールエンジンで再計算します。
- **ルーム分離**：操作は connectionId から解決した自分のルーム・スロットにのみ適用。他ルームは操作不可。
- **入力検証**：ルームコード（`^[0-9]{4}$`）、キャラクター id、アクション名・エネルギーを検証。
- **自動削除**：終了ルームは TTL で消去。

---

## IaC で管理しているリソース（`template.yaml`）

- API Gateway WebSocket API（`AWS::ApiGatewayV2::Api`）
- ルート（`$connect` / `$disconnect` / `$default` / `createRoom` / `joinRoom` / `selectCharacter` / `submitAction` / `rematch` / `leave`）
- Lambda 統合（`AWS::ApiGatewayV2::Integration`, `AWS_PROXY`）
- Deployment / Stage（`AWS::ApiGatewayV2::Deployment` / `Stage`）
- Lambda 関数（`AWS::Serverless::Function`）
- Lambda IAM ロール／ポリシー（最小権限のインラインポリシー）
- DynamoDB テーブル 2 つ（TTL 有効・SSE 有効・オンデマンド）
- Lambda 実行許可（`AWS::Lambda::Permission`）
- CloudWatch ロググループ（保持期間パラメータ化）
- Outputs（`WebSocketURL` ほか）

---

## デプロイ・削除

```bash
# （共有エンジンを変更したとき）
./sync-engine.sh

sam build
sam deploy --guided --region ap-northeast-1   # 初回
sam deploy                                     # 2回目以降

# 出力の確認
aws cloudformation describe-stacks --stack-name hadouken-online \
  --region ap-northeast-1 --query "Stacks[0].Outputs" --output table

# 削除
sam delete --stack-name hadouken-online --region ap-northeast-1
```

`WebSocketURL` の値をリポジトリ直下の `online-config.js` に設定してください。

---

## テスト

```bash
npm test         # ユニットテスト（AWS 不要）
```

- `gameEngine.test.js` … 通常攻撃／ガード／必殺技／エネルギー消費／HP 更新／同時アクション／無効アクション／二重送信（決定性）／ゲーム終了。
- `rooms.test.js` … ルーム作成の重複防止、満室・存在しないルームの拒否、キャラ選択の冪等、**二重送信の拒否**、**バージョン条件付き更新の一意性**、再戦リセット。インメモリの DynamoDB モック（`mockDdb.js`）で条件式を評価します。

### ローカル E2E（AWS 不要）

`test/localServer.js` は依存パッケージなしの WebSocket サーバーで、本番と同じ `gameEngine.js` / `rooms.js` を使って 2 ブラウザ対戦を再現できます（**テスト専用・非デプロイ**）。手順はルート `README.md` の「ローカルテスト方法」を参照。

> 注: 一部のサンドボックス環境では `NODE_OPTIONS` の preload によりテストが失敗することがあります。その場合は `env -u NODE_OPTIONS npm test` を使ってください（通常の環境では不要）。

---

## AWS SDK の扱い

`@aws-sdk/*`（v3）は **Node.js 20.x Lambda ランタイムに同梱**されているため、デプロイ時にはバンドルしません（`src/package.json` では `devDependencies` としてローカル開発用にのみ記載）。これにより成果物が小さく、コールドスタート・保管コストを抑えられます。

## コスト最小化のポイント

- 常時稼働なし（EC2/ECS 不使用）。イベント駆動のみ。
- DynamoDB オンデマンド + TTL で使った分だけ・不要データは自動削除。
- CloudWatch Logs は保持期間短め（既定14日）・出力最小限（`DataTraceEnabled: false`）。
- Stage にスロットリング上限を設定し、想定外の大量リクエストを抑制。
