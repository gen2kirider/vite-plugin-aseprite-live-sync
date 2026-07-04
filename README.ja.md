# vite-plugin-aseprite-live-sync

[English](./README.md) | 日本語

**Draw. Save. Play.**

Vite プロジェクト向けの、Aseprite ファイル自動エクスポートプラグインです。

`.aseprite` / `.ase` ファイルを保存するたびに Aseprite CLI が自動で PNG / JSON をエクスポートするため、手動でのエクスポート作業が不要になります。Vite の HMR カスタムイベントも送信できるため、必要に応じてアプリ側で受け取り、ページリロードなしの差し替え処理に利用できます。

## 向いているケース

- Vite で開発している
- Aseprite を編集ソースとして管理したい
- 描き直して保存するたびに PNG / JSON を自動生成したい
- 必要に応じて HMR で生成アセットの更新通知を受け取りたい

## 特徴

- Vite dev server（serve）で動作（別コマンド不要）
- `.aseprite` / `.ase` の `add` / `change` / `unlink` を監視
- 保存されたファイルのみをAsepriteで再生成
- 入力ディレクトリ構造を出力側に維持（デフォルト）
- Asepriteの自動検出
- 生成完了時に HMR custom event を送信（デフォルト有効、`hmr: false` で無効化可能）

## インストール

```bash
npm install -D vite-plugin-aseprite-live-sync
```

> このプラグインを使うには、Aseprite がインストールされている必要があります。
> Aseprite の自動検出を試みますが、見つからない場合は `aseprite-live-sync.config.ts` で `asepriteExecutable` を指定してください。

## クイックスタート

### 1. `vite.config.ts` に登録

```ts
import { defineConfig } from "vite";
import { asepriteLiveSync } from "vite-plugin-aseprite-live-sync";

export default defineConfig({
  plugins: [asepriteLiveSync()],
});
```

### 2. 入力ディレクトリを作成

Aseprite ファイルを置く入力ディレクトリだけ手動で作成してください。
出力先は `outputDir` の設定に従い、初回エクスポート時にプラグインが自動で作成します。

```bash
mkdir -p src-assets/aseprite
```

### 3. dev server を起動

あとは開発サーバーを起動するだけです。

```bash
npm run dev
```

これだけでVite Dev Serverと同時にAseprite Live Syncが動きます。

## 推奨フォルダ構成

```text
your-app/
  public/                     # アプリから参照する公開アセット
    assets/
      build/                  # プラグインが出力する PNG / JSON
        characters/
          player.png
          player.json
        tiles/
          grass.png

  src/                        # アプリ本体のコード
    scenes/
    main.ts

  src-assets/                 # 編集用の元アセット
    aseprite/                 # Aseprite ファイルの入力先
      characters/
        player.aseprite
      tiles/
        grass.aseprite

  vite.config.ts              # Vite プラグイン登録
  aseprite-live-sync.config.ts # プラグイン設定
  package.json
```

編集用ソース（`.aseprite` / `.ase`）は `public` 外に置き、アプリが参照する PNG / JSON のみ `public/assets/build` へ出力する運用を推奨します。

## 設定ファイル

設定ファイルは省略できます。その場合は `inputDir: "src-assets/aseprite"` / `outputDir: "public/assets/build"` / `exportMode: "auto"` などのデフォルト値で動作します。

カスタマイズしたい場合は、次のいずれかをプロジェクトルートに作成します。

- `aseprite-live-sync.config.ts`
- `aseprite-live-sync.config.js`

```ts
import { defineAsepriteLiveSyncConfig } from "vite-plugin-aseprite-live-sync";

export default defineAsepriteLiveSyncConfig({
  inputDir: "src-assets/aseprite",
  outputDir: "public/assets/build",
  publicPath: "/assets/build",

  exportMode: "auto",
  preserveStructure: true,

  buildOnStartup: true,
  watch: true,

  include: ["**/*.aseprite", "**/*.ase"],
  exclude: ["_old/**", "backup/**", "wip/**", "**/*.tmp.aseprite"],

  rules: [
    { match: "characters/**", exportMode: "auto" },
    { match: "tiles/**", exportMode: "png-only" },
    { match: "effects/**", exportMode: "png-json" },
  ],

  deleteSync: true,
  debounceMs: 300,
  awaitWriteFinishMs: 500,

  asepriteExecutable: undefined,
  hmr: true,
  verbose: true,
});
```

## 設定項目

- `inputDir`
  - Aseprite編集用ソースの場所
  - デフォルト: `src-assets/aseprite`
- `outputDir`
  - 生成PNG/JSONの出力先
  - デフォルト: `public/assets/build`
- `publicPath`
  - 出力したアセットをブラウザから参照するときのベースURL
  - `outputDir` と対応する公開パスを指定してください
  - デフォルト: `/assets/build`
- `exportMode`
  - `auto | png-only | png-json`
  - デフォルト: `auto`
  - `auto`: まずPNG + JSONを生成し、`meta.frameTags` が空ならJSONを削除
  - `png-only`: 常にPNGのみ生成
  - `png-json`: 常にPNG + JSON生成（`--format json-array`）
- `preserveStructure`
  - 入力サブフォルダを出力側でも維持
  - デフォルト: `true`
- `buildOnStartup`
  - Vite起動時に既存ファイルを一括変換
  - デフォルト: `true`
- `watch`
  - dev server中の監視有効化
  - デフォルト: `true`
- `include`
  - 対象グロブ
  - デフォルト: `["**/*.aseprite", "**/*.ase"]`
- `exclude`
  - 除外グロブ
  - デフォルト: `[]`
- `rules`
  - `match`ごとの`exportMode`上書き
  - 先に一致したルールを優先
  - 省略または `[]` の場合、`include` / `exclude` を通過した全ファイルに `exportMode` が一律適用
  - 例: `{ match: "characters/**", exportMode: "auto" }`
- `deleteSync`
  - 元ソース削除時に対応する生成物を削除
  - デフォルト: `true`
- `debounceMs`
  - 保存連打対策
  - デフォルト: `300`
- `awaitWriteFinishMs`
  - 保存直後の不完全読み込み対策
  - デフォルト: `500`
- `asepriteExecutable`
  - Aseprite CLIの明示パス
  - 未指定時は自動検出
- `hmr`
  - 生成時にVite custom event (`aseprite-live-sync:update`) を送信
  - `true` の場合、生成先ディレクトリをVite watcherから外してフルリロードを抑制
  - デフォルト: `true`
- `verbose`
  - 詳細ログ出力
  - デフォルト: `false`

## 任意: HMRイベントを受け取る

アプリ側で `aseprite-live-sync:update` を受け取ると、エクスポート完了をトリガーにテクスチャ再読込などの処理を実装できます。

```ts
import type { AsepriteLiveSyncHmrPayload } from "vite-plugin-aseprite-live-sync";

if (import.meta.hot) {
  import.meta.hot.on(
    "aseprite-live-sync:update",
    (payload: AsepriteLiveSyncHmrPayload) => {
      console.log("updated:", payload.outputs.pngPublicPath);
      // ここで任意の再読込・差し替え処理を行う
    },
  );
}
```

この受信コードを書かなくても、Asepriteの自動エクスポート自体は動作します。

## Aseprite CLI検出順

1. 設定ファイルの`asepriteExecutable`
2. PATH上の`aseprite`
3. OS標準候補
   - macOS:
     - `/Applications/Aseprite.app/Contents/MacOS/aseprite`
     - `~/Applications/Aseprite.app/Contents/MacOS/aseprite`
     - `~/Library/Application Support/Steam/steamapps/common/Aseprite/Aseprite.app/Contents/MacOS/aseprite`
   - Windows:
     - `%ProgramFiles%\Aseprite\Aseprite.exe`
     - `%ProgramFiles(x86)%\Aseprite\Aseprite.exe`
     - `%LocalAppData%\Programs\Aseprite\Aseprite.exe`
     - `%ProgramFiles%\Steam\steamapps\common\Aseprite\Aseprite.exe`
     - `%ProgramFiles(x86)%\Steam\steamapps\common\Aseprite\Aseprite.exe`
   - Linux:
     - `/usr/bin/aseprite`
     - `/usr/local/bin/aseprite`
     - `/snap/bin/aseprite`
     - `/var/lib/flatpak/exports/bin/com.aseprite.Aseprite`
     - `~/.local/bin/aseprite`
     - `~/.local/share/Steam/steamapps/common/Aseprite/aseprite`
     - `~/.steam/steam/steamapps/common/Aseprite/aseprite`

見つからない場合は次のエラーを出します。

```text
[Aseprite Live Sync] Aseprite executable was not found. Please install Aseprite or set asepriteExecutable in aseprite-live-sync.config.ts.
```

## ログ例

```text
[Aseprite Live Sync] Aseprite detected: /Applications/Aseprite.app/Contents/MacOS/aseprite
[Aseprite Live Sync] Watching: src-assets/aseprite
[Aseprite Live Sync] Exported: characters/player.aseprite -> public/assets/build/characters/player.png + player.json (auto)
[Aseprite Live Sync] Exported: tiles/grass.aseprite -> public/assets/build/tiles/grass.png (auto - no tags)
[Aseprite Live Sync] Deleted: public/assets/build/characters/slime.png
```

## 利用例

### Phaserでの読み込み例

静止画:

```ts
this.load.image("grass", "/assets/build/tiles/grass.png");
```

Asepriteアニメーション:

```ts
this.load.aseprite(
  "player",
  "/assets/build/characters/player.png",
  "/assets/build/characters/player.json",
);
```

## トラブルシューティング

- Asepriteが見つからない
  - `aseprite-live-sync.config.ts`に`asepriteExecutable`を設定
  - macOSなら`/Applications/Aseprite.app/Contents/MacOS/aseprite`の存在確認
- 保存しても変換されない
  - `include` / `exclude` パターンを確認
  - `watch: true` か確認
  - `inputDir` が正しいか確認
- JSONが出力されない
  - `exportMode: auto` でタグが無い場合、JSONは削除されます
  - 必ずJSONを出したい場合は `png-json` を使用
