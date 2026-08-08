import { join } from "path";
import { existsSync } from "fs";
import { symlink, mkdir } from "fs/promises";

// 支持的配置变量，可由环境变量覆盖，或者使用默认的同级目录名称
const API_PORT = Number(process.env.PORT ?? "8787");
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT ?? "5500");
const PROJECT_ROOT = join(import.meta.dir, "..");

// 优先检测同级目录的 prism-astr 或是 AstrBot，也可通过环境变量指定
const ASTRBOT_DIR = process.env.ASTRBOT_DIR ?? (
  existsSync(join(PROJECT_ROOT, "../prism-astr"))
    ? join(PROJECT_ROOT, "../prism-astr")
    : join(PROJECT_ROOT, "../AstrBot")
);

const processes: any[] = [];

// 退出处理
process.on("SIGINT", () => {
  console.log("\n\x1b[31m[System] Stopping all services...\x1b[0m");
  for (const proc of processes) {
    proc.kill();
  }
  process.exit();
});

// 并发启动子进程并添加彩色前缀
const startProcessWithPrefix = (name: string, colorCode: string, cmd: string[], cwd?: string) => {
  const proc = Bun.spawn(cmd, {
    cwd,
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

// 极简静态托管服务（支持 Flutter Web 的 History 路由回退）
const serveStaticDashboard = (port: number, dir: string) => {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      let path = url.pathname;
      if (path === "/") path = "/index.html";
      const filePath = join(dir, path);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }
      const indexFile = Bun.file(join(dir, "index.html"));
      if (await indexFile.exists()) {
        return new Response(indexFile);
      }
      return new Response("Not Found", { status: 404 });
    }
  });
  console.log(`\x1b[35m[System] Dashboard SPA static server listening on http://localhost:${port}\x1b[0m`);
  return server;
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

  // 2. 运行本地后端 API
  console.log("[System] Launching backend API...");
  startProcessWithPrefix("API", "36", ["bun", "run", "packages/runtime/src/serve.ts"], PROJECT_ROOT);

  // 3. 运行 Dashboard
  const newDashboardWebDir = join(PROJECT_ROOT, "packages/prism-dashboard/build/web");
  const oldDashboardWebDir = join(PROJECT_ROOT, "packages/admin-flutter/build/web");

  if (existsSync(join(newDashboardWebDir, "index.html"))) {
    console.log("[System] Hosting new dashboard (prism-dashboard) from build/web...");
    serveStaticDashboard(DASHBOARD_PORT, newDashboardWebDir);
  } else if (existsSync(join(oldDashboardWebDir, "index.html"))) {
    console.log("[System] Hosting old dashboard (admin-flutter) from build/web...");
    serveStaticDashboard(DASHBOARD_PORT, oldDashboardWebDir);
  } else {
    console.log("\x1b[33m[System] Dashboard static builds not found.\x1b[0m");
    console.log("\x1b[35m[System] Starting Dashboard (prism-dashboard) in hot-reload debug mode via Flutter...\x1b[0m");
    startProcessWithPrefix(
      "Dashboard",
      "35",
      ["flutter", "run", "-d", "web-server", "--web-port", String(DASHBOARD_PORT), "--web-hostname", "127.0.0.1", "--no-pub"],
      join(PROJECT_ROOT, "packages/prism-dashboard")
    );
  }

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
  process.exit(1);
});
