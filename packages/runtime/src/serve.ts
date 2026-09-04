import { Database } from "bun:sqlite";
import {
  handleMachineWebSocketClose,
  handleMachineWebSocketMessage,
} from "@prism/server-hono";
import {
  createPrismLocalDependencies,
  initializeSqliteSchema,
} from "./index";
import { createPrismLocalFetchHandler } from "./local-server";

const databasePath = process.env.PRISM_SQLITE_PATH ?? "./prism.sqlite";
const port = Number.parseInt(process.env.PORT ?? "8787", 10);

process.on("uncaughtException", (error) => {
  console.error("[prism] uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("[prism] unhandled rejection:", reason);
});

const db = new Database(databasePath);
initializeSqliteSchema(db);

const dependencies = createPrismLocalDependencies({
  db,
});
const fetch = createPrismLocalFetchHandler(dependencies);

Bun.serve({
  port,
  fetch,
  websocket: {
    async message(socket, message) {
      try {
        await handleMachineWebSocketMessage(socket, message, dependencies);
      } catch (error) {
        socket.send(JSON.stringify({
          type: "error",
          code: error instanceof Error && "code" in error ? String(error.code) : "MACHINE_WS_ERROR",
          message: error instanceof Error ? error.message : "Machine WebSocket error.",
        }));
      }
    },
    close(socket) {
      void handleMachineWebSocketClose(socket, dependencies);
    },
  },
});

console.log(`PRiSM local API listening on http://localhost:${port}`);
