# vite-plugin-aseprite-live-sync

**Draw. Save. Play.**

Phaser + Vite での開発を主対象とした、Aseprite ファイルの自動エクスポートプラグインです。

`.aseprite` / `.ase` ファイルを保存するたびに Aseprite CLI が自動で PNG / JSON をエクスポートするため、手動でのエクスポート作業が不要になります。エクスポート完了時には Vite の HMR カスタムイベントが送信されるので、ページリロードなしにテクスチャをゲーム画面へ即反映する体験が実現できます。

## 特徴

- Viteプラグインとして動作（別コマンド不要）
- `.aseprite` / `.ase` の `add` / `change` / `unlink` を監視
- 保存されたファイルのみをAseprite CLIで再生成
- `exportMode: auto | png-only | png-json`
- `include` / `exclude` / `rules` 対応
- 入力ディレクトリ構造を出力側に維持（デフォルト）
- Aseprite CLIの自動検出

## インストール

```bash
npm install -D vite-plugin-aseprite-live-sync
```

## Vite登録

```ts
import { defineConfig } from "vite";
import { asepriteLiveSync } from "vite-plugin-aseprite-live-sync";

export default defineConfig({
  plugins: [asepriteLiveSync()],
});
```

## 使い方

Aseprite ファイルを置く入力ディレクトリだけ手動で作成してください。
出力先は `outputDir` の設定に従い、初回エクスポート時にプラグインが自動で作成します。

```bash
mkdir -p src-assets/aseprite
```

あとは開発サーバーを起動するだけです。

```bash
npm run dev
```

これだけでVite Dev Serverと同時にAseprite Live Syncが動きます。

## 推奨フォルダ構成

```text
your-game/
  public/
    assets/
      build/
        characters/
          player.png
          player.json
        tiles/
          grass.png

  src/
    scenes/
    main.ts

  src-assets/
    aseprite/
      characters/
        player.aseprite
      tiles/
        grass.aseprite

  vite.config.ts
  aseprite-live-sync.config.ts
  package.json
```

編集用ソース（`.aseprite` / `.ase`）は`public`外に置き、ゲームが読むPNG/JSONのみ`public/assets/build`へ出力する運用を推奨します。

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
  - ゲームから読む公開パス（将来拡張用に保持）
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

## HMRイベント

エクスポートが完了すると、プラグインはゲームのコード側へ `aseprite-live-sync:update` イベントを送信します。このイベントを受け取ることで、**ページをリロードせずにゲーム画面のテクスチャをその場で差し替える**ことができます。

受け取らなくても動作します。HMR を使わない場合はこのセクションは無視してください。

- event名: `aseprite-live-sync:update`
- payload型: `AsepriteLiveSyncHmrPayload`

`payload.outputs.pngPublicPath` にエクスポートされたPNGの公開URLが入るので、Phaser の `textures.get()` などで差し替えに使えます。

```ts
import type { AsepriteLiveSyncHmrPayload } from "vite-plugin-aseprite-live-sync";

if (import.meta.hot) {
  import.meta.hot.on(
    "aseprite-live-sync:update",
    (payload: AsepriteLiveSyncHmrPayload) => {
      // Phaser側で texture を差し替える
      console.log(payload.kind, payload.outputs.pngPublicPath);
    },
  );
}
```

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

## Phaserでの読み込み例

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

## API

```ts
import {
  asepriteLiveSync,
  defineAsepriteLiveSyncConfig,
  type AsepriteLiveSyncConfig,
  type AsepriteLiveSyncHmrPayload,
  type AsepriteRule,
  type ExportMode,
} from "vite-plugin-aseprite-live-sync";
```

## 開発者向け時短ワークフロー

ローカルでプラグインを開発するときは、次の2コマンドだけ覚えれば十分です。

```bash
# 型チェック + 自動テスト + ビルド
npm run check

# プラグイン本体のみwatch
npm run dev

# テスト
npm run test
npm run test:watch
```

## TODO（将来機能）

- manifest生成
- Phaserアニメーションコード自動生成
- clean command
- init command
- dryRun
- renameSync
- changedOnlyキャッシュ
- タグ一覧TypeScript生成
- Webpack / Parcel対応
- PixiJSなど他エンジン向けサンプル
