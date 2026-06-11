import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
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
      onFinish(finalPlayers) {
        info("game finished");
        room.completeGame(finalPlayers);
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
    if (requestUrl.pathname === "/production") return sendFile(res, path.join(PUBLIC_DIR, "production", "index.html"));
    if (requestUrl.pathname === "/lottery") return sendFile(res, path.join(PUBLIC_DIR, "lottery", "index.html"));
    if (requestUrl.pathname === "/instruction") return sendFile(res, path.join(PUBLIC_DIR, "instruction", "index.html"));
    if (requestUrl.pathname === "/achievement") return sendFile(res, path.join(PUBLIC_DIR, "achievement", "index.html"));

    if (requestUrl.pathname === "/api/test_warehouse") {
      const warehouse = new Warehouse({ rootDir: ROOT });
      const result = warehouse.generate(Number(requestUrl.searchParams.get("k") || 1));
      return sendJson(res, result);
    }

    if (requestUrl.pathname === "/items.csv") return sendFile(res, path.join(ROOT, "items.csv"));
    if (requestUrl.pathname === "/props.csv") return sendFile(res, path.join(ROOT, "props.csv"));
    if (requestUrl.pathname === "/sp_props.csv") return sendFile(res, path.join(ROOT, "sp_props.csv"));
    if (requestUrl.pathname === "/production.json") {
      const productionPath = path.join(ROOT, "production.json");
      return fs.existsSync(productionPath) ? sendFile(res, productionPath) : sendJson(res, []);
    }
    if (requestUrl.pathname === "/lottery.json") {
      const lotteryPath = path.join(ROOT, "lottery.json");
      return fs.existsSync(lotteryPath) ? sendFile(res, lotteryPath) : sendJson(res, []);
    }
    if (requestUrl.pathname === "/instruction.json") return sendFile(res, path.join(ROOT, "instruction.json"));

    for (const prefix of ["/room/", "/wiki/", "/game/", "/settlement/", "/test_warehouse/", "/warehouse/", "/shop/", "/production/", "/lottery/", "/instruction/", "/achievement/", "/common/"]) {
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
    if (room.handleProductionUpgrade(req, socket, requestUrl)) return;
    if (room.handleLotteryUpgrade(req, socket, requestUrl)) return;
    if (room.handleAchievementUpgrade(req, socket, requestUrl)) return;
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

startConsole();

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

function startConsole() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.on("line", (line) => {
    const text = String(line || "").trim();
    if (!text) return;
    const parts = text.startsWith("/") ? text.slice(1).split(/\s+/) : text.split(/\s+/);
    try {
      const result = runCommand(parts);
      if (result != null) console.log(result);
    } catch (err) {
      console.log(`Command failed: ${err.message}`);
    }
  });
}

function runCommand(parts) {
  const [command, ...args] = parts;
  if (command === "help") {
    return [
      "/help",
      "/list",
      "/money get player",
      "/money give player amount",
      "/money set player amount",
      "/config prop value",
      "/kick player",
      "/give player item id amount",
      "/give player prop id amount",
    ].join("\n");
  }
  if (command === "list") {
    return room.listPlayers().map((player) => `${player.nickname} ${player.id} money=${player.money} ready=${player.ready} inGame=${player.inGame}`).join("\n") || "No players";
  }
  if (command === "money") {
    const [action, player, amount] = args;
    if (action === "get") {
      const entry = room.findPlayer(player);
      if (!entry) throw new Error("player not found");
      return `${entry.nickname}: ${entry.profile.money}`;
    }
    if (action === "give") return `${player}: ${room.giveMoney(player, Number(amount))}`;
    if (action === "set") return `${player}: ${room.setMoney(player, Number(amount))}`;
  }
  if (command === "config") {
    const [prop, value] = args;
    if (!prop) throw new Error("missing config key");
    const configPath = path.join(ROOT, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!config.game || typeof config.game !== "object") config.game = {};
    config.game[prop] = Number(value);
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return `config.game.${prop} = ${config.game[prop]}`;
  }
  if (command === "kick") {
    if (!room.kickPlayer(args[0])) throw new Error("player not found");
    return `kicked ${args[0]}`;
  }
  if (command === "give") {
    const [player, kind, id, amount] = args;
    if (kind === "item") room.giveItem(player, id, amount);
    else if (kind === "prop") room.giveProp(player, id, amount);
    else throw new Error("kind must be item or prop");
    return `gave ${kind} ${id} x${amount || 1} to ${player}`;
  }
  return "Unknown command";
}
