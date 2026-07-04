import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import chokidar, { type FSWatcher } from "chokidar";
import fg from "fast-glob";
import picomatch from "picomatch";
import { loadConfigFromFile, type ViteDevServer } from "vite";

export type ExportMode = "auto" | "png-only" | "png-json";

export interface AsepriteRule {
  match: string;
  exportMode: ExportMode;
}

export interface AsepriteLiveSyncConfig {
  inputDir: string;
  outputDir: string;
  publicPath: string;
  exportMode: ExportMode;
  preserveStructure: boolean;
  buildOnStartup: boolean;
  watch: boolean;
  include: string[];
  exclude: string[];
  rules: AsepriteRule[];
  deleteSync: boolean;
  debounceMs: number;
  awaitWriteFinishMs: number;
  asepriteExecutable?: string;
  hmr: boolean;
  verbose: boolean;
}

export interface AsepriteLiveSyncHmrPayload {
  kind: "export" | "delete";
  sourcePath: string;
  outputs: {
    pngPath: string;
    pngPublicPath: string;
    jsonPath: string;
    jsonPublicPath: string;
    hasJson: boolean;
  };
  timestamp: number;
}

export interface AsepriteLiveSyncPlugin {
  name: string;
  apply: "serve";
}

type ResolvedConfig = AsepriteLiveSyncConfig & {
  root: string;
  inputDirAbs: string;
  outputDirAbs: string;
};

type RuleMatcher = {
  match: string;
  exportMode: ExportMode;
  isMatch: (input: string) => boolean;
};

const CONFIG_FILES = [
  "aseprite-live-sync.config.ts",
  "aseprite-live-sync.config.js",
] as const;

const DEFAULT_CONFIG: AsepriteLiveSyncConfig = {
  inputDir: "src-assets/aseprite",
  outputDir: "public/assets/build",
  publicPath: "/assets/build",
  exportMode: "auto",
  preserveStructure: true,
  buildOnStartup: true,
  watch: true,
  include: ["**/*.aseprite", "**/*.ase"],
  exclude: [],
  rules: [],
  deleteSync: true,
  debounceMs: 300,
  awaitWriteFinishMs: 500,
  asepriteExecutable: undefined,
  hmr: true,
  verbose: false,
};

const LOG_PREFIX = "[Aseprite Live Sync]";

export function defineAsepriteLiveSyncConfig(
  config: Partial<AsepriteLiveSyncConfig>,
): Partial<AsepriteLiveSyncConfig> {
  return config;
}

export function asepriteLiveSync(): AsepriteLiveSyncPlugin {
  let watcher: FSWatcher | undefined;

  return {
    name: "vite-plugin-aseprite-live-sync",
    apply: "serve",

    async configureServer(server: ViteDevServer) {
      const { config, ruleMatchers, includeMatchers, excludeMatchers } =
        await resolveConfig(server);
      const logger = createLogger(server, config.verbose);
      const asepriteExecutable = await resolveAsepriteExecutable(config);

      logger.info(`Aseprite detected: ${asepriteExecutable}`);

      if (config.hmr) {
        server.watcher.unwatch(config.outputDirAbs);
        logger.debug(
          `HMR enabled. Ignoring output directory in Vite watcher: ${toRelativeOrSelf(config.root, config.outputDirAbs)}`,
        );
      }

      if (config.buildOnStartup) {
        await buildAllExistingAssets(
          config,
          ruleMatchers,
          asepriteExecutable,
          logger,
        );
      }

      const scheduled = new Map<string, NodeJS.Timeout>();

      const scheduleExport = (
        event: "add" | "change" | "unlink",
        absoluteFilePath: string,
      ): void => {
        const sourceFileAbs = path.resolve(absoluteFilePath);
        const relativeSourcePath = toPosix(
          path.relative(config.inputDirAbs, sourceFileAbs),
        );

        if (!isInsideDirectory(config.inputDirAbs, sourceFileAbs)) {
          return;
        }

        if (
          !matchesSourcePath(
            relativeSourcePath,
            includeMatchers,
            excludeMatchers,
          )
        ) {
          return;
        }

        const pending = scheduled.get(sourceFileAbs);
        if (pending) {
          clearTimeout(pending);
        }

        const timer = setTimeout(() => {
          void processEvent({
            event,
            sourceFileAbs,
            relativeSourcePath,
            config,
            ruleMatchers,
            asepriteExecutable,
            logger,
          })
            .then((result) => {
              if (!result || !config.hmr) {
                return;
              }

              broadcastHmrUpdate(server, config, result);
            })
            .catch((error) => {
              logger.error(
                error instanceof Error ? error.message : String(error),
              );
            });
          scheduled.delete(sourceFileAbs);
        }, config.debounceMs);

        scheduled.set(sourceFileAbs, timer);
      };

      if (config.watch) {
        watcher = chokidar.watch(config.inputDirAbs, {
          ignoreInitial: true,
          awaitWriteFinish:
            config.awaitWriteFinishMs > 0
              ? {
                  stabilityThreshold: config.awaitWriteFinishMs,
                  pollInterval: 100,
                }
              : false,
        });

        watcher.on("add", (filePath) => scheduleExport("add", filePath));
        watcher.on("change", (filePath) => scheduleExport("change", filePath));
        watcher.on("unlink", (filePath) => scheduleExport("unlink", filePath));

        logger.info(
          `Watching: ${toRelativeOrSelf(config.root, config.inputDirAbs)}`,
        );
      }

      const cleanup = async (): Promise<void> => {
        for (const timeout of scheduled.values()) {
          clearTimeout(timeout);
        }
        scheduled.clear();
        if (watcher) {
          await watcher.close();
          watcher = undefined;
        }
      };

      if (server.httpServer) {
        server.httpServer.once("close", () => {
          void cleanup();
        });
      }
    },
  } as AsepriteLiveSyncPlugin;
}

async function resolveConfig(server: ViteDevServer): Promise<{
  config: ResolvedConfig;
  ruleMatchers: RuleMatcher[];
  includeMatchers: ((input: string) => boolean)[];
  excludeMatchers: ((input: string) => boolean)[];
}> {
  const root = server.config.root ?? process.cwd();
  const userConfig = await loadUserConfig(root, server.config.mode);

  const normalizedConfig: AsepriteLiveSyncConfig = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    include: userConfig.include ?? DEFAULT_CONFIG.include,
    exclude: userConfig.exclude ?? DEFAULT_CONFIG.exclude,
    rules: userConfig.rules ?? DEFAULT_CONFIG.rules,
  };

  const config: ResolvedConfig = {
    ...normalizedConfig,
    root,
    inputDirAbs: path.resolve(root, normalizedConfig.inputDir),
    outputDirAbs: path.resolve(root, normalizedConfig.outputDir),
  };

  const ruleMatchers = config.rules.map((rule) => ({
    ...rule,
    isMatch: picomatch(rule.match, { dot: true }),
  }));

  const includeMatchers = config.include.map((pattern) =>
    picomatch(pattern, { dot: true }),
  );
  const excludeMatchers = config.exclude.map((pattern) =>
    picomatch(pattern, { dot: true }),
  );

  return { config, ruleMatchers, includeMatchers, excludeMatchers };
}

async function loadUserConfig(
  root: string,
  mode: string,
): Promise<Partial<AsepriteLiveSyncConfig>> {
  for (const configFileName of CONFIG_FILES) {
    const fullPath = path.join(root, configFileName);
    if (!(await fileExists(fullPath))) {
      continue;
    }

    const loaded = await loadConfigFromFile(
      { command: "serve", mode },
      fullPath,
      root,
    );
    if (!loaded) {
      continue;
    }

    const config = loaded.config as Partial<AsepriteLiveSyncConfig>;
    return config ?? {};
  }

  return {};
}

async function buildAllExistingAssets(
  config: ResolvedConfig,
  ruleMatchers: RuleMatcher[],
  asepriteExecutable: string,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  if (!(await fileExists(config.inputDirAbs))) {
    logger.debug(
      `Input directory does not exist yet: ${toRelativeOrSelf(config.root, config.inputDirAbs)}`,
    );
    return;
  }

  const entries = await fg(config.include, {
    cwd: config.inputDirAbs,
    ignore: config.exclude,
    absolute: true,
    onlyFiles: true,
    dot: false,
  });

  for (const absoluteFilePath of entries) {
    const relativeSourcePath = toPosix(
      path.relative(config.inputDirAbs, absoluteFilePath),
    );
    await exportOneFile({
      sourceFileAbs: absoluteFilePath,
      relativeSourcePath,
      config,
      ruleMatchers,
      asepriteExecutable,
      logger,
    });
  }
}

async function processEvent(args: {
  event: "add" | "change" | "unlink";
  sourceFileAbs: string;
  relativeSourcePath: string;
  config: ResolvedConfig;
  ruleMatchers: RuleMatcher[];
  asepriteExecutable: string;
  logger: ReturnType<typeof createLogger>;
}): Promise<ProcessResult | undefined> {
  if (args.event === "unlink") {
    if (!args.config.deleteSync) {
      return undefined;
    }

    const paths = getOutputPaths(args.config, args.relativeSourcePath);
    await fs.rm(paths.pngPath, { force: true });
    await fs.rm(paths.jsonPath, { force: true });
    args.logger.info(
      `Deleted: ${toRelativeOrSelf(args.config.root, paths.pngPath)}`,
    );

    return {
      kind: "delete",
      relativeSourcePath: args.relativeSourcePath,
      pngPath: paths.pngPath,
      jsonPath: paths.jsonPath,
      hasJson: false,
    };
  }

  return await exportOneFile(args);
}

async function exportOneFile(args: {
  sourceFileAbs: string;
  relativeSourcePath: string;
  config: ResolvedConfig;
  ruleMatchers: RuleMatcher[];
  asepriteExecutable: string;
  logger: ReturnType<typeof createLogger>;
}): Promise<ProcessResult> {
  const exportMode = getExportMode(
    args.relativeSourcePath,
    args.config.exportMode,
    args.ruleMatchers,
  );
  const outputPaths = getOutputPaths(args.config, args.relativeSourcePath);

  await fs.mkdir(path.dirname(outputPaths.pngPath), { recursive: true });

  if (exportMode === "png-only") {
    await runAseprite(args.asepriteExecutable, [
      "-b",
      args.sourceFileAbs,
      "--sheet",
      outputPaths.pngPath,
    ]);
    await fs.rm(outputPaths.jsonPath, { force: true });

    args.logger.info(
      `Exported: ${args.relativeSourcePath} -> ${toRelativeOrSelf(args.config.root, outputPaths.pngPath)} (png-only)`,
    );

    return {
      kind: "export",
      relativeSourcePath: args.relativeSourcePath,
      pngPath: outputPaths.pngPath,
      jsonPath: outputPaths.jsonPath,
      hasJson: false,
    };
  }

  await runAseprite(args.asepriteExecutable, [
    "-b",
    args.sourceFileAbs,
    "--sheet",
    outputPaths.pngPath,
    "--data",
    outputPaths.jsonPath,
    "--format",
    "json-array",
    "--list-tags",
  ]);

  if (exportMode === "png-json") {
    args.logger.info(
      `Exported: ${args.relativeSourcePath} -> ${toRelativeOrSelf(
        args.config.root,
        outputPaths.pngPath,
      )} + ${path.basename(outputPaths.jsonPath)} (png-json)`,
    );
    return {
      kind: "export",
      relativeSourcePath: args.relativeSourcePath,
      pngPath: outputPaths.pngPath,
      jsonPath: outputPaths.jsonPath,
      hasJson: true,
    };
  }

  const hasTags = await jsonHasFrameTags(outputPaths.jsonPath);
  if (!hasTags) {
    await fs.rm(outputPaths.jsonPath, { force: true });
    args.logger.info(
      `Exported: ${args.relativeSourcePath} -> ${toRelativeOrSelf(args.config.root, outputPaths.pngPath)} (auto - no tags)`,
    );
    return {
      kind: "export",
      relativeSourcePath: args.relativeSourcePath,
      pngPath: outputPaths.pngPath,
      jsonPath: outputPaths.jsonPath,
      hasJson: false,
    };
  }

  args.logger.info(
    `Exported: ${args.relativeSourcePath} -> ${toRelativeOrSelf(
      args.config.root,
      outputPaths.pngPath,
    )} + ${path.basename(outputPaths.jsonPath)} (auto)`,
  );

  return {
    kind: "export",
    relativeSourcePath: args.relativeSourcePath,
    pngPath: outputPaths.pngPath,
    jsonPath: outputPaths.jsonPath,
    hasJson: true,
  };
}

type ProcessResult = {
  kind: "export" | "delete";
  relativeSourcePath: string;
  pngPath: string;
  jsonPath: string;
  hasJson: boolean;
};

function broadcastHmrUpdate(
  server: ViteDevServer,
  config: ResolvedConfig,
  result: ProcessResult,
): void {
  const payload: AsepriteLiveSyncHmrPayload = {
    kind: result.kind,
    sourcePath: result.relativeSourcePath,
    outputs: {
      pngPath: toRelativeOrSelf(config.root, result.pngPath),
      pngPublicPath: toPublicPath(config, result.pngPath),
      jsonPath: toRelativeOrSelf(config.root, result.jsonPath),
      jsonPublicPath: toPublicPath(config, result.jsonPath),
      hasJson: result.kind === "export" ? result.hasJson : false,
    },
    timestamp: Date.now(),
  };

  server.ws.send({
    type: "custom",
    event: "aseprite-live-sync:update",
    data: payload,
  });
}

function toPublicPath(
  config: ResolvedConfig,
  absoluteFilePath: string,
): string {
  const relativeOutputPath = toPosix(
    path.relative(config.outputDirAbs, absoluteFilePath),
  );
  const normalizedPublicPath = config.publicPath.endsWith("/")
    ? config.publicPath.slice(0, -1)
    : config.publicPath;

  return `${normalizedPublicPath}/${relativeOutputPath}`;
}

function getExportMode(
  relativeSourcePath: string,
  defaultMode: ExportMode,
  ruleMatchers: RuleMatcher[],
): ExportMode {
  for (const rule of ruleMatchers) {
    if (rule.isMatch(relativeSourcePath)) {
      return rule.exportMode;
    }
  }

  return defaultMode;
}

function matchesSourcePath(
  relativeSourcePath: string,
  includeMatchers: ((input: string) => boolean)[],
  excludeMatchers: ((input: string) => boolean)[],
): boolean {
  if (!isAsepriteFile(relativeSourcePath)) {
    return false;
  }

  const included = includeMatchers.some((isMatch) =>
    isMatch(relativeSourcePath),
  );
  const excluded = excludeMatchers.some((isMatch) =>
    isMatch(relativeSourcePath),
  );

  return included && !excluded;
}

function getOutputPaths(
  config: ResolvedConfig,
  relativeSourcePath: string,
): { pngPath: string; jsonPath: string } {
  const noExt = stripAsepriteExtension(relativeSourcePath);

  const basePath = config.preserveStructure
    ? path.join(config.outputDirAbs, noExt)
    : path.join(config.outputDirAbs, path.basename(noExt));

  return {
    pngPath: `${basePath}.png`,
    jsonPath: `${basePath}.json`,
  };
}

function stripAsepriteExtension(filePath: string): string {
  if (filePath.endsWith(".aseprite")) {
    return filePath.slice(0, -".aseprite".length);
  }
  if (filePath.endsWith(".ase")) {
    return filePath.slice(0, -".ase".length);
  }
  return filePath;
}

function isAsepriteFile(filePath: string): boolean {
  return filePath.endsWith(".aseprite") || filePath.endsWith(".ase");
}

async function jsonHasFrameTags(jsonPath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as {
      meta?: {
        frameTags?: unknown[];
      };
    };

    return (
      Array.isArray(parsed.meta?.frameTags) && parsed.meta.frameTags.length > 0
    );
  } catch {
    return false;
  }
}

async function resolveAsepriteExecutable(
  config: ResolvedConfig,
): Promise<string> {
  if (config.asepriteExecutable) {
    const configuredPath = resolveMaybeRelativePath(
      config.root,
      config.asepriteExecutable,
    );
    if (await fileExists(configuredPath)) {
      return configuredPath;
    }

    throw new Error(
      `${LOG_PREFIX} asepriteExecutable is set but not found: ${configuredPath}`,
    );
  }

  const pathExecutable = findOnPath("aseprite");
  if (pathExecutable) {
    return pathExecutable;
  }

  const osCandidates = getOsCandidates();
  for (const candidate of osCandidates) {
    const fullPath = resolveHome(candidate);
    if (await fileExists(fullPath)) {
      return fullPath;
    }
  }

  throw new Error(
    `${LOG_PREFIX} Aseprite executable was not found. Please install Aseprite or set asepriteExecutable in aseprite-live-sync.config.ts.`,
  );
}

function getOsCandidates(): string[] {
  const home = os.homedir();

  switch (process.platform) {
    case "darwin":
      return uniquePaths([
        "/Applications/Aseprite.app/Contents/MacOS/aseprite",
        "~/Applications/Aseprite.app/Contents/MacOS/aseprite",
        path.join(
          home,
          "Library/Application Support/Steam/steamapps/common/Aseprite/Aseprite.app/Contents/MacOS/aseprite",
        ),
      ]);
    case "win32": {
      const programFiles = process.env.ProgramFiles ?? "C:/Program Files";
      const programFilesX86 =
        process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)";
      const localAppData = process.env.LocalAppData;

      return uniquePaths([
        path.join(programFiles, "Aseprite", "Aseprite.exe"),
        path.join(programFilesX86, "Aseprite", "Aseprite.exe"),
        localAppData
          ? path.join(localAppData, "Programs", "Aseprite", "Aseprite.exe")
          : "",
        path.join(
          programFiles,
          "Steam",
          "steamapps",
          "common",
          "Aseprite",
          "Aseprite.exe",
        ),
        path.join(
          programFilesX86,
          "Steam",
          "steamapps",
          "common",
          "Aseprite",
          "Aseprite.exe",
        ),
      ]);
    }
    default:
      return uniquePaths([
        "/usr/bin/aseprite",
        "/usr/local/bin/aseprite",
        "/snap/bin/aseprite",
        "/var/lib/flatpak/exports/bin/com.aseprite.Aseprite",
        "~/.local/bin/aseprite",
        "~/.local/share/Steam/steamapps/common/Aseprite/aseprite",
        "~/.steam/steam/steamapps/common/Aseprite/aseprite",
      ]);
  }
}

function uniquePaths(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => v.length > 0)));
}

function findOnPath(commandName: string): string | undefined {
  if (process.platform === "win32") {
    const result = spawnSync("where", [commandName], { encoding: "utf8" });
    if (result.status === 0) {
      const line = result.stdout
        .split(/\r?\n/)
        .map((v) => v.trim())
        .find(Boolean);
      if (line) {
        return line;
      }
    }
    return undefined;
  }

  const result = spawnSync(
    "sh",
    ["-lc", `command -v ${escapeShellArg(commandName)}`],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    return undefined;
  }

  const executable = result.stdout.trim();
  return executable.length > 0 ? executable : undefined;
}

function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runAseprite(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(executable, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${LOG_PREFIX} Aseprite CLI exited with code ${String(code)}.${
            stderr ? `\n${stderr.trim()}` : ""
          }`,
        ),
      );
    });
  });
}

function createLogger(server: ViteDevServer, verbose: boolean) {
  const logger = server.config.logger;

  return {
    info(message: string): void {
      logger.info(`${LOG_PREFIX} ${message}`);
    },
    debug(message: string): void {
      if (verbose) {
        logger.info(`${LOG_PREFIX} ${message}`);
      }
    },
    error(message: string): void {
      logger.error(`${LOG_PREFIX} ${message}`);
    },
  };
}

function resolveHome(inputPath: string): string {
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function resolveMaybeRelativePath(root: string, maybePath: string): string {
  const expanded = resolveHome(maybePath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toPosix(inputPath: string): string {
  return inputPath.split(path.sep).join("/");
}

function isInsideDirectory(parentDir: string, candidatePath: string): boolean {
  const relative = path.relative(parentDir, candidatePath);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function toRelativeOrSelf(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolutePath;
  }
  return toPosix(relative);
}
