import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "vite";
import { asepriteLiveSync } from "../src/index";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { recursive: true, force: true });
    }),
  );
});

describe("asepriteLiveSync integration", () => {
  it("exports on startup, reacts to change/add, and sync-deletes on unlink", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await makeFixtureRoot();
    const server = await createServer({
      root,
      configFile: false,
      plugins: [asepriteLiveSync()],
      server: {
        port: 0,
        strictPort: false,
      },
      logLevel: "silent",
    });

    try {
      await server.listen();

      const playerPng = path.join(
        root,
        "public/assets/build/characters/player.png",
      );
      const playerJson = path.join(
        root,
        "public/assets/build/characters/player.json",
      );

      await waitFor(async () => await exists(playerPng));
      await waitFor(async () => await exists(playerJson));

      const oldMtimeMs = (await fs.stat(playerPng)).mtimeMs;
      await fs.writeFile(
        path.join(root, "src-assets/aseprite/characters/player.aseprite"),
        `player-${Date.now()}\n`,
        "utf8",
      );
      await waitFor(
        async () => (await fs.stat(playerPng)).mtimeMs > oldMtimeMs,
      );

      const noTagsSource = path.join(
        root,
        "src-assets/aseprite/characters/notags.aseprite",
      );
      const noTagsPng = path.join(
        root,
        "public/assets/build/characters/notags.png",
      );
      const noTagsJson = path.join(
        root,
        "public/assets/build/characters/notags.json",
      );
      await fs.writeFile(noTagsSource, "no-tags\n", "utf8");

      await waitFor(async () => await exists(noTagsPng));
      await waitFor(async () => !(await exists(noTagsJson)));

      await fs.rm(
        path.join(root, "src-assets/aseprite/characters/player.aseprite"),
        {
          force: true,
        },
      );
      await waitFor(async () => !(await exists(playerPng)));
      await waitFor(async () => !(await exists(playerJson)));
    } finally {
      await server.close();
    }
  });
});

async function makeFixtureRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "aseprite-live-sync-test-"),
  );
  tempRoots.push(root);

  await fs.mkdir(path.join(root, "src-assets/aseprite/characters"), {
    recursive: true,
  });
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });

  await fs.writeFile(
    path.join(root, "index.html"),
    "<!doctype html><html><body></body></html>\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "src-assets/aseprite/characters/player.aseprite"),
    "player\n",
    "utf8",
  );

  const mockAsepritePath = path.join(root, "scripts/mock-aseprite.mjs");
  await fs.writeFile(mockAsepritePath, makeMockAsepriteScript(), "utf8");
  await fs.chmod(mockAsepritePath, 0o755);

  const configText = [
    "export default {",
    '  inputDir: "src-assets/aseprite",',
    '  outputDir: "public/assets/build",',
    '  exportMode: "auto",',
    "  buildOnStartup: true,",
    "  watch: true,",
    '  include: ["**/*.aseprite", "**/*.ase"],',
    "  deleteSync: true,",
    "  debounceMs: 20,",
    "  awaitWriteFinishMs: 20,",
    '  asepriteExecutable: "./scripts/mock-aseprite.mjs",',
    "  verbose: false",
    "};",
    "",
  ].join("\n");
  await fs.writeFile(
    path.join(root, "aseprite-live-sync.config.ts"),
    configText,
    "utf8",
  );

  return root;
}

function makeMockAsepriteScript(): string {
  return [
    "#!/usr/bin/env node",
    'import fs from "node:fs/promises";',
    'import path from "node:path";',
    "",
    "const args = process.argv.slice(2);",
    "",
    "function valueOf(flag) {",
    "  const index = args.indexOf(flag);",
    "  if (index === -1 || index + 1 >= args.length) return undefined;",
    "  return args[index + 1];",
    "}",
    "",
    'const input = valueOf("-b") ?? "";',
    'const sheetPath = valueOf("--sheet");',
    'const dataPath = valueOf("--data");',
    "",
    "if (!sheetPath) {",
    '  console.error("--sheet is required");',
    "  process.exit(1);",
    "}",
    "",
    "await fs.mkdir(path.dirname(sheetPath), { recursive: true });",
    'await fs.writeFile(sheetPath, "PNG\\n", "utf8");',
    "",
    "if (dataPath) {",
    '  const hasTags = !input.toLowerCase().includes("notags");',
    "  const payload = {",
    "    frames: [],",
    "    meta: {",
    '      frameTags: hasTags ? [{ name: "idle", from: 0, to: 0, direction: "forward" }] : []',
    "    }",
    "  };",
    "",
    "  await fs.mkdir(path.dirname(dataPath), { recursive: true });",
    '  await fs.writeFile(dataPath, JSON.stringify(payload, null, 2), "utf8");',
    "}",
    "",
  ].join("\n");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (await check()) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
}
