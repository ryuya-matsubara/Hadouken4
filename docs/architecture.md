# Hadouken Battle — 構成図（AWS / GitHub）

現在デプロイされている構成のドキュメントです。
（フロント: `us-east-1` の S3+CloudFront / バックエンド: `ap-northeast-1` のサーバーレス）

## 1. システム全体（AWS ランタイム構成）

```mermaid
flowchart TB
    subgraph Client["📱 ユーザー（ブラウザ / iPhone Safari 等）"]
        P1["プレイヤー1"]
        P2["プレイヤー2"]
    end

    subgraph Ext["🌐 外部CDN（画像アセット）"]
        GH_IMG["github.com/user-attachments<br/>キャラ・タイトル画像"]
    end

    subgraph AWS_US["☁️ AWS us-east-1（フロント配信）"]
        CF["CloudFront<br/>E1UQDCBDOY5NBN<br/>ddurmbogk47n4.cloudfront.net"]
        OAC["Origin Access Control (OAC)"]
        S3F["S3（非公開）<br/>hadouken3-456422343464-us-east-1<br/>index.html / online-config.js / manifest / png"]
    end

    subgraph AWS_JP["☁️ AWS ap-northeast-1（オンライン対戦バックエンド：サーバーレス）"]
        WSAPI["API Gateway<br/>WebSocket API (ylb3wopy88)<br/>wss://.../prod"]
        LAMBDA["Lambda<br/>hadouken-online-game<br/>Node.js 20.x / arm64"]
        DDB_R[("DynamoDB<br/>hadouken-online-Rooms")]
        DDB_C[("DynamoDB<br/>hadouken-online-Connections")]
        CW["CloudWatch Logs"]
    end

    P1 & P2 -->|"① HTTPS（サイト取得）"| CF
    CF --> OAC --> S3F
    P1 & P2 -.->|"② 画像を直接取得"| GH_IMG

    P1 & P2 -->|"③ WSS（オンライン対戦）"| WSAPI
    WSAPI -->|"$connect / action ルート"| LAMBDA
    LAMBDA -->|"ルーム状態 read/write"| DDB_R
    LAMBDA -->|"接続ID管理"| DDB_C
    LAMBDA -->|"@connections で相手へ送信"| WSAPI
    LAMBDA --> CW
```

**ポイント**
- フロントは静的サイト。S3 は非公開で、CloudFront の **OAC** 経由でのみ配信。
- ゲーム画像は GitHub の CDN からブラウザが直接取得（AWS を経由しない）。
- オンライン対戦は **常時稼働サーバーなし**。WebSocket API → 単一 Lambda → DynamoDB。
- サーバーが権威（HP・エネルギーはサーバーが計算し、両クライアントへ同一結果を配信）。

## 2. オンライン対戦のメッセージフロー（2プレイヤー）

```mermaid
sequenceDiagram
    participant P1 as プレイヤー1（ブラウザ）
    participant WS as API Gateway WebSocket
    participant L as Lambda (game)
    participant DB as DynamoDB (Rooms/Connections)
    participant P2 as プレイヤー2（ブラウザ）

    P1->>WS: createRoom {roomId}
    WS->>L: dispatch
    L->>DB: ルーム作成 + 接続登録
    L-->>P1: roomCreated (slot=1)

    P2->>WS: joinRoom {roomId}
    WS->>L: dispatch
    L->>DB: 参加登録
    L-->>P1: roomJoined (charselect)
    L-->>P2: roomJoined (charselect)

    P1->>WS: selectCharacter
    P2->>WS: selectCharacter
    L->>DB: 両者確定 → playing
    L-->>P1: battleStart
    L-->>P2: battleStart

    P1->>WS: submitAction {move, turn}
    L-->>P2: opponentReady（手は非公開）
    P2->>WS: submitAction {move, turn}
    L->>DB: 両者の手が揃う → ターン解決（サーバー権威）
    L-->>P1: turnResult（同一結果）
    L-->>P2: turnResult（同一結果）
    Note over P1,P2: HP=0 で勝敗確定 / rematch でリセット
```

## 3. GitHub と デプロイの関係

```mermaid
flowchart LR
    subgraph GH["🐙 GitHub: ryuya-matsubara/Hadouken3"]
        MAIN["main ブランチ<br/>（1台対戦版のみ）"]
        OB["online-battle ブランチ<br/>（オンライン対戦 + backend/）"]
        PR2["PR #2: online-battle → main<br/>【オープン・未マージ】"]
        OB -. 提案 .-> PR2
        PR2 -. マージ先 .-> MAIN
    end

    subgraph DEPLOY["🚀 手動デプロイ（このブランチの内容）"]
        FE["フロント: aws s3 cp + CloudFront 無効化"]
        BE["バックエンド: sam build && sam deploy"]
    end

    subgraph AWS["☁️ AWS（稼働中）"]
        S3CF["S3 + CloudFront (us-east-1)"]
        SAM["hadouken-online スタック (ap-northeast-1)"]
    end

    OB -->|"index.html / online-config.js / *.png"| FE --> S3CF
    OB -->|"backend/template.yaml (SAM)"| BE --> SAM

    classDef note fill:#fff3cd,stroke:#d39e00,color:#333;
    class PR2 note;
```

**重要**
- AWS で今動いているのは **`online-battle` ブランチ（= PR #2 の内容）** をデプロイしたもの。
- **PR #2 は未マージ**。デプロイと PR のマージは独立（マージしなくても AWS では稼働する）。

## 主要リソース一覧

| 種別 | 名前 / ID | リージョン |
|---|---|---|
| CloudFront | `E1UQDCBDOY5NBN`（`ddurmbogk47n4.cloudfront.net`） | Global |
| S3（フロント・非公開） | `hadouken3-456422343464-us-east-1` | us-east-1 |
| WebSocket API | `ylb3wopy88`（`wss://ylb3wopy88.execute-api.ap-northeast-1.amazonaws.com/prod`） | ap-northeast-1 |
| Lambda | `hadouken-online-game` | ap-northeast-1 |
| DynamoDB | `hadouken-online-Rooms` / `hadouken-online-Connections` | ap-northeast-1 |
| CloudFormation スタック | `hadouken-online` | ap-northeast-1 |
| SAM アーティファクト用 S3 | `hadouken-online-sam-456422343464-apne1` | ap-northeast-1 |
