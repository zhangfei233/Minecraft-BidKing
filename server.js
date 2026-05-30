import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendFile, sendJson, safeJoin } from "./src/net/http.js";
import { acceptWebSocket, sendWsJson } from "./src/net/websocket.js";
import { Warehouse } from "./src/game/Warehouse.js";
import { GameSession } from "./src/game/GameSession.js";
import { createRoom } from "./src/room/room.js";
import { createWikiModule } from "./src/wiki/wiki.js";
import { error, info, initLogger } from "./src/net/logger.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
initLogger(ROOT);
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const PORT = Number(CONFIG.port || 3000);
const PUBLIC_DIR = path.join(ROOT, "public");
const RESOURCE_DIR = path.join(ROOT, "resource");

process.on("uncaughtException", (err) => {
  error("uncaught exception", err);
});

process.on("unhandledRejection", (reason) => {
  error("unhandled rejection", reason instanceof Error ? reason : new Error(String(reason)));
});

const wiki = createWikiModule({ rootDir: ROOT, publicDir: PUBLIC_DIR });
let activeGame = null;
const room = createRoom({
  rootDir: ROOT,
  onGameStart(players, container) {
    info("game starting", { players: players.map((player) => ({ id: player.id, nickname: player.nickname, characterId: player.characterId })), container });
    activeGame = new GameSession({
      rootDir: ROOT,
      players,
      container,
      onFinish() {
        info("game finished");
        room.completeGame();
        activeGame = null;
      },
    });
  },
});

const server = http.createServer((req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (wiki.handle(req, res, requestUrl)) return;

  if (requestUrl.pathname === "/" || requestUrl.pathname === "/room") return sendFile(res, path.join(PUBLIC_DIR, "room", "index.html"));
  if (requestUrl.pathname === "/game") return sendFile(res, path.join(PUBLIC_DIR, "game", "index.html"));
  if (requestUrl.pathname === "/settlement") return sendFile(res, path.join(PUBLIC_DIR, "settlement", "index.html"));
  if (requestUrl.pathname === "/test_warehouse") return sendFile(res, path.join(PUBLIC_DIR, "test_warehouse", "index.html"));
  if (requestUrl.pathname === "/warehouse") return sendFile(res, path.join(PUBLIC_DIR, "warehouse", "index.html"));
  if (requestUrl.pathname === "/shop") return sendFile(res, path.join(PUBLIC_DIR, "shop", "index.html"));

  if (requestUrl.pathname === "/api/test_warehouse") {
    const warehouse = new Warehouse({ rootDir: ROOT });
    const result = warehouse.generate(Number(requestUrl.searchParams.get("k") || 1));
    return sendJson(res, result);
  }

  if (requestUrl.pathname === "/items.csv") return sendFile(res, path.join(ROOT, "items.csv"));
  if (requestUrl.pathname === "/props.csv") return sendFile(res, path.join(ROOT, "props.csv"));
  if (requestUrl.pathname === "/sp_props.csv") return sendFile(res, path.join(ROOT, "sp_props.csv"));

  for (const prefix of ["/room/", "/wiki/", "/game/", "/settlement/", "/test_warehouse/", "/warehouse/", "/shop/", "/common/"]) {
    if (requestUrl.pathname.startsWith(prefix)) return serveStatic(res, PUBLIC_DIR, requestUrl.pathname.slice(1));
  }

  if (requestUrl.pathname.startsWith("/resource/")) {
    return serveStatic(res, RESOURCE_DIR, requestUrl.pathname.slice("/resource/".length));
  }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (err) {
    error("http request failed", err, { url: req.url });
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
  }
});

server.on("upgrade", (req, socket) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    if (handleGameUpgrade(req, socket, requestUrl)) return;
    if (room.handleWarehouseUpgrade(req, socket, requestUrl)) return;
    if (room.handleShopUpgrade(req, socket, requestUrl)) return;
    if (room.handleUpgrade(req, socket, requestUrl)) return;
    socket.destroy();
  } catch (err) {
    error("websocket upgrade failed", err, { url: req.url });
    socket.destroy();
  }
});

server.listen(PORT, () => {
  info(`AuctionMC server listening on http://localhost:${PORT}/`);
});

function serveStatic(res, baseDir, requestPath) {
  const filePath = safeJoin(baseDir, requestPath);
  if (!filePath) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  sendFile(res, filePath);
}

function handleGameUpgrade(req, socket, requestUrl) {
  if (requestUrl.pathname !== "/game-ws") return false;
  if (!acceptWebSocket(req, socket)) return true;

  if (activeGame) {
    activeGame.connect(requestUrl.searchParams.get("playerId"), socket);
    return true;
  }

  sendWsJson(socket, {
    type: "error",
    message: "当前没有进行中的游戏，请先从房间开始游戏",
  });
  socket.end();
  socket.on("error", () => {});
  return true;
}
