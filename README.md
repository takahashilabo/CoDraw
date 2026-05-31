# CoDraw

AI と一緒に一枚の絵を描き上げるお絵かきツールです。あなたが描いたストロークを AI が読み取り、続きを描き加えてくれます。交互に描き合いながら、ひとつの作品を共同制作する体験を楽しめます。

## 必要なもの

- [Node.js](https://nodejs.org/) v18 以上
- [OpenRouter](https://openrouter.ai/) の API キー（無料・支払い情報不要）

## セットアップ

```bash
# リポジトリをクローン
git clone https://github.com/takahashilabo/codraw.git
cd codraw

# 依存パッケージをインストール
npm install

# .env ファイルを作成
cp .env.example .env
```

`.env` をエディタで開き、API キーを貼る：

```
OPENROUTER_API_KEY=sk-or-xxxxxxxxxxxx
```

> API キーは [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) で取得できます。アカウント登録のみで無料で使えます。

## 起動

```bash
npm start
```

ブラウザで `http://localhost:3000` を開いてください。

## 使い方

1. キャンバスにマウスや指で自由に描く
2. 描くのを止めると **3 秒後に AI が自動で続きを描いてくれる**
3. AI が描き終えたら、またあなたが描き足す
4. これを繰り返してひとつの作品を仕上げる

| ボタン | 機能 |
|---|---|
| AI に描いてもらう | 手動で AI に描かせる |
| AI を戻す | AI の直前の描画を取り消す |
| クリア | キャンバスをリセット |
| 保存 | PNG としてダウンロード |

## 技術スタック

- **フロントエンド**: HTML / CSS / Vanilla JavaScript（Canvas API）
- **バックエンド**: Node.js / Express
- **AI**: [OpenRouter](https://openrouter.ai/) 経由で `google/gemini-2.0-flash-exp:free` を使用
