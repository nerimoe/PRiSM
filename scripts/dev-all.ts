import { join } from "path";
import { existsSync } from "fs";
import { symlink, mkdir } from "fs/promises";

// 支持的配置变量，可由环境变量覆盖，或者使用默认的同级目录名称
const API_PORT = Number(process.env.PORT ?? "8787");
const WEB_PORT = Number(process.env.WEB_PORT ?? "5173");
const PROJECT_ROOT = join(import.meta.dir, "..");
const apiOrigin = `http://127.0.0.1:${API_PORT}`;
const localEnv = {
  ...process.env,
  APP_ORIGIN: apiOrigin,
  EXTRA_ALLOWED_ORIGINS: [
    `http://localhost:${API_PORT}`,
    `http://localhost:${WEB_PORT}`,
    `http://127.0.0.1:${WEB_PORT}`,
    process.env.EXTRA_ALLOWED_ORIGINS,
  ].filter(Boolean).join(","),
};

// 优先检测同级目录的 prism-astr 或是 AstrBot，也可通过环境变量指定
const ASTRBOT_DIR = process.env.ASTRBOT_DIR ?? (
  existsSync(join(PROJECT_ROOT, "../prism-astr"))
    ? join(PROJECT_ROOT, "../prism-astr")
    : join(PROJECT_ROOT, "../AstrBot")
);

const processes: any[] = [];

// 退出处理
const stop = () => {
  console.log("\n\x1b[31m[System] Stopping all services...\x1b[0m");
  for (const proc of processes) {
    proc.kill();
  }
  process.exit();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// 并发启动子进程并添加彩色前缀
const startProcessWithPrefix = (name: string, colorCode: string, cmd: string[], cwd?: string, env = process.env) => {
  const proc = Bun.spawn(cmd, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.push(proc);

  const prefix = `\x1b[${colorCode}m[${name}]\x1b[0m`;

  const logStream = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        console.log(`${prefix} ${line}`);
      }
    }
    if (buffer.trim()) {
      console.log(`${prefix} ${buffer}`);
    }
  };

  logStream(proc.stdout);
  logStream(proc.stderr);

  console.log(`\x1b[${colorCode}m[System] Started ${name} (PID: ${proc.pid})\x1b[0m`);
  return proc;
};

const run = async (cmd: string[]) => {
  const child = Bun.spawn(cmd, { cwd: PROJECT_ROOT, env: localEnv, stdout: "inherit", stderr: "inherit" });
  processes.push(child);
  if (await child.exited !== 0) throw new Error(`${cmd[0]} failed while preparing the local platform.`);
};

const main = async () => {
  console.log("\x1b[36m==================================================\x1b[0m");
  console.log("\x1b[36m          PRiSM Next Developer One-Key Runner     \x1b[0m");
  console.log("\x1b[36m==================================================\x1b[0m\n");

  // 1. 自动软链接 AstrBot 插件
  if (existsSync(ASTRBOT_DIR)) {
    const pluginSrc = join(PROJECT_ROOT, "packages/plugin-prism-next-astrbot");
    const pluginsDestDir = join(ASTRBOT_DIR, "data/plugins");
    const linkPath = join(pluginsDestDir, "astrbot_plugin_prism_next");

    try {
      if (!existsSync(pluginsDestDir)) {
        await mkdir(pluginsDestDir, { recursive: true });
      }
      if (!existsSync(linkPath)) {
        await symlink(pluginSrc, linkPath, "dir");
        console.log(`\x1b[32m[System] Created symlink for AstrBot plugin: ${linkPath} -> ${pluginSrc}\x1b[0m`);
      } else {
        console.log("\x1b[32m[System] AstrBot plugin symlink already exists.\x1b[0m");
      }
    } catch (err) {
      console.error("\x1b[31m[System] Failed to setup symlink for AstrBot plugin:\x1b[0m", err);
    }
  } else {
    console.log(`\x1b[33m[System] Warning: AstrBot workspace not found at ${ASTRBOT_DIR}. Skipping bot runner...\x1b[0m`);
  }

  // 2. 准备统一平台的 React 静态资源及本地 D1 数据库
  await run(["bun", "run", "build:web"]);
  await run(["bun", "run", "scripts/generate-wrangler-config.ts", "--platform", "--local"]);
  await run(["bunx", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--config", "wrangler.generated.jsonc"]);

  // 3. 启动与 React API 契约一致的 Worker 和 Vite 热更新服务器
  startProcessWithPrefix("API", "36", ["bunx", "wrangler", "dev", "--config", "wrangler.generated.jsonc",
    "--ip", "127.0.0.1", "--port", String(API_PORT)], PROJECT_ROOT, localEnv);
  startProcessWithPrefix("Web", "35", ["bun", "run", "dev", "--port", String(WEB_PORT), "--strictPort"],
    join(PROJECT_ROOT, "packages/prism-web"), { ...process.env, PRISM_API_URL: apiOrigin });
  console.log(`[System] React management: http://127.0.0.1:${WEB_PORT}/merchant`);

  // 4. 运行 AstrBot
  if (existsSync(ASTRBOT_DIR)) {
    console.log("[System] Launching AstrBot...");
    startProcessWithPrefix("AstrBot", "32", ["uv", "run", "astrbot", "run"], ASTRBOT_DIR);
  }

  console.log("\n\x1b[32m[System] All services started. Press Ctrl+C to exit and stop all services.\x1b[0m\n");
  
  // 维持主进程运行
  while (true) {
    await Bun.sleep(1000);
  }
};

main().catch(err => {
  console.error(err);
  for (const proc of processes) proc.kill();
  process.exit(1);
});
