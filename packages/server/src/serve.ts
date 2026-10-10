import { createLocalServer } from "./local-server.js";

const databasePath = process.env.PRISM_SQLITE_PATH ?? "./prism.sqlite";
const port = Number.parseInt(process.env.PORT ?? "8787", 10);

process.on("uncaughtException", (error) => {
  console.error("[prism] uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[prism] unhandled rejection:", reason);
});

const server = createLocalServer({
  databasePath,
  port,
});

console.log(`PRiSM local server listening on http://localhost:${server.port}`);
