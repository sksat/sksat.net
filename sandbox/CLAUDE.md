# Sandbox 開発ガイドライン

## 概要

このディレクトリは sksat.net における実験的 Web アプリケーションの置き場です。

## 設計原則

### 1. ステートレス・静的

- 各アプリは完全にクライアントサイドで動作
- サーバーサイド処理なし
- 外部 API 呼び出しは最小限

### 2. TDD (テスト駆動開発)

- 新機能は必ずテストを先に書く
- テストページは `[app]/tests/index.html`

### 3. 自己完結

- 各アプリは独立して動作
- アプリ間の依存なし

### 4. WebGPU/WebGL フォールバック

- モダン API を優先
- 非対応ブラウザには適切なエラーメッセージ
- 可能なら CPU フォールバック

## ディレクトリ構造

```
sandbox/
├── CLAUDE.md          # このファイル
├── apps.json          # アプリ一覧メタデータ
├── index.html         # アプリ一覧（静的HTML）
└── [app-name]/        # 各アプリ（独立）
    ├── index.html
    └── tests/
```

## 新規アプリ追加手順

1. `sandbox/[app-name]/` ディレクトリ作成
2. `sandbox/[app-name]/tests/` ディレクトリ作成
3. テストを先に書く（TDD）
4. 実装
5. `sandbox/index.html` にリンク追加
6. `apps.json` にエントリ追加

## テスト実行

ブラウザで `[app]/tests/index.html` を開く

## apps.json スキーマ

```json
{
  "apps": [
    {
      "path": "app-name/",
      "name": "App Name",
      "description": "説明文",
      "requirements": {
        "webgpu": true
      }
    }
  ]
}
```
