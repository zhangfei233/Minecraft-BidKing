import fs from "node:fs";
import path from "node:path";
import { loadDefinitions } from "../game/definitions.js";
import { validateSelections } from "../game/GameSession.js";
import { loadItemsById } from "../items/items.js";
import { drawLottery, loadLotteryRecipes, lotteryConsumableIds, normalizeLotteryState } from "../lottery/lottery.js";
import {
  addMoney,
  addProfileItem,
  buyProfileProps,
  deductMoney,
  ensureProfile,
  removeProfileItem,
  saveProfileByNickname,
  sellProfileItems,
  sellProfileProps,
  setFavorite,
  toggleFavorite,
} from "../player/profile.js";
import { acceptWebSocket, decodeWsText, sendWsJson } from "../net/websocket.js";
import { PRODUCTION_MAX_PAGES, loadProductionRecipes, normalizeProductionState } from "../production/production.js";
import { loadAchievements, normalizeAchievementState, publicAchievementState } from "../achievement/achievement.js";

const MAX_PLAYERS = 4;
const HEARTBEAT_TIMEOUT_MS = 20_000;

export function createRoom({ rootDir, onGameStart }) {
  const players = new Map();
  const disconnectedPlayers = new Map();
  const characterDefinitions = loadDefinitions(rootDir, "characters.csv");
  const propDefinitions = loadDefinitions(rootDir, "props.csv");
  const itemsById = loadItemsById(rootDir);
  const productionRecipes = loadProductionRecipes(rootDir, itemsById);
  const lotteryRecipes = loadLotteryRecipes(loadLotteryRaw(rootDir), itemsById, propDefinitions);
  const achievements = loadAchievements(rootDir);
  const maxPlayers = loadMaxPlayers(rootDir);
  const containers = loadContainers(rootDir);
  let currentContainer = pickContainer(containers);
  let gameInProgress = false;

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const player of players.values()) {
      if (!player.inGame && !player.sideConnections && now > (player.sidePageGraceUntil || 0) && isRoomPlayerStale(player, now)) removePlayer(player.id);
    }
    for (const [id, player] of disconnectedPlayers) {
      if (now - player.lastSeen > 120_000) disconnectedPlayers.delete(id);
    }
  }, 5_000);
  heartbeatTimer.unref?.();

  function handleUpgrade(req, socket, requestUrl) {
    if (requestUrl.pathname !== "/room-ws") return false;
    if (!acceptWebSocket(req, socket)) return true;
    cleanupStaleRoomPlayers();

    const resumeId = requestUrl.searchParams.get("playerId");
    if (resumeId) {
      let player = players.get(resumeId);
      if (!player && disconnectedPlayers.has(resumeId) && players.size < maxPlayers) {
        player = disconnectedPlayers.get(resumeId);
        disconnectedPlayers.delete(resumeId);
        player.socket = socket;
        player.inGame = false;
        player.sideConnections = 0;
        players.set(player.id, player);
      }
      if (!player) return reject(socket, "房间中没有这个玩家，请重新输入昵称");
      player.ready = false;
      return attachExistingPlayer(player, socket);
    }

    const nickname = normalizeNickname(requestUrl.searchParams.get("nickname"));
    if (!nickname) return reject(socket, "昵称不能为空");
    const existing = [...players.values()].find((player) => player.nickname === nickname);
    if (existing) return reject(socket, "房间内已经有同昵称玩家");
    if (players.size >= maxPlayers) return reject(socket, "房间已满");

    const profile = ensureProfile(rootDir, nickname);
    normalizeAchievementState(profile, achievements);
    saveProfileByNickname(rootDir, profile);
    const player = {
      id: createPlayerId(),
      nickname,
      socket,
      ready: false,
      inGame: false,
      characterId: firstKey(characterDefinitions) || "character_1",
      props: defaultCarriedProps(profile, propDefinitions),
      profile,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      sideConnections: 0,
      sidePageGraceUntil: 0,
      roomDisconnectedAt: 0,
    };

    players.set(player.id, player);
    attachSocket(player, socket);
    sendWsJson(socket, {
      type: "join_success",
      message: "加入成功",
      body: { id: player.id, player: clientPlayer(player), room: roomSnapshot(player.id) },
    });
    broadcastRoomState();
    return true;
  }

  function attachExistingPlayer(player, socket) {
    const previousSocket = player.socket;
    player.socket = socket;
    player.lastSeen = Date.now();
    player.roomDisconnectedAt = 0;
    attachSocket(player, socket);
    if (previousSocket && previousSocket !== socket) previousSocket.destroy();
    sendWsJson(socket, {
      type: "join_success",
      message: "加入成功",
      body: { id: player.id, player: clientPlayer(player), room: roomSnapshot(player.id) },
    });
    broadcastRoomState();
    return true;
  }

  function attachSocket(player, socket) {
    socket.on("data", (buffer) => handleMessage(player, buffer));
    socket.on("close", () => scheduleDisconnectRemoval(player, socket));
    socket.on("error", () => scheduleDisconnectRemoval(player, socket));
  }

  function scheduleDisconnectRemoval(player, socket) {
    if (player.inGame || player.socket !== socket) return;
    player.lastSeen = Date.now();
    player.roomDisconnectedAt = Date.now();
    broadcastRoomState();
  }

  function cleanupStaleRoomPlayers() {
    const now = Date.now();
    for (const player of [...players.values()]) {
      if (!player.inGame && !player.sideConnections && now > (player.sidePageGraceUntil || 0) && isRoomPlayerStale(player, now)) removePlayer(player.id);
    }
  }

  function isRoomPlayerStale(player, now = Date.now()) {
    if (isSocketClosed(player.socket)) return now - (player.roomDisconnectedAt || player.lastSeen || 0) >= HEARTBEAT_TIMEOUT_MS;
    return now - (player.lastSeen || 0) >= HEARTBEAT_TIMEOUT_MS;
  }

  function handleWarehouseUpgrade(req, socket, requestUrl) {
    if (requestUrl.pathname !== "/warehouse-ws") return false;
    if (!acceptWebSocket(req, socket)) return true;
    const player = resolvePlayerForSideConnection(requestUrl.searchParams.get("playerId"), socket);
    if (!player) return rejectWs(socket, "只有房间内玩家可以访问仓库");
    attachSideSocket(player, socket, () => sendWarehouseState(player, socket), (buffer) => handleWarehouseMessage(player, socket, buffer));
    return true;
  }

  function handleShopUpgrade(req, socket, requestUrl) {
    if (requestUrl.pathname !== "/shop-ws") return false;
    if (!acceptWebSocket(req, socket)) return true;
    const player = resolvePlayerForSideConnection(requestUrl.searchParams.get("playerId"), socket);
    if (!player) return rejectWs(socket, "只有房间内玩家可以访问商城");
    attachSideSocket(player, socket, () => sendShopState(player, socket), (buffer) => handleShopMessage(player, socket, buffer));
    return true;
  }

  function handleProductionUpgrade(req, socket, requestUrl) {
    if (requestUrl.pathname !== "/production-ws") return false;
    if (!acceptWebSocket(req, socket)) return true;
    const player = resolvePlayerForSideConnection(requestUrl.searchParams.get("playerId"), socket);
    if (!player) return rejectWs(socket, "只有房间内玩家可以访问仓库");
    attachSideSocket(player, socket, () => sendProductionState(player, socket), (buffer) => handleProductionMessage(player, socket, buffer));
    return true;
  }

  function handleLotteryUpgrade(req, socket, requestUrl) {
    if (requestUrl.pathname !== "/lottery-ws") return false;
    if (!acceptWebSocket(req, socket)) return true;
    const player = resolvePlayerForSideConnection(requestUrl.searchParams.get("playerId"), socket);
    if (!player) return rejectWs(socket, "只有房间内玩家可以访问仓库");
    attachSideSocket(player, socket, () => sendLotteryState(player, socket), (buffer) => handleLotteryMessage(player, socket, buffer));
    return true;
  }

  function handleAchievementUpgrade(req, socket, requestUrl) {
    if (requestUrl.pathname !== "/achievement-ws") return false;
    if (!acceptWebSocket(req, socket)) return true;
    const player = resolvePlayerForSideConnection(requestUrl.searchParams.get("playerId"), socket);
    if (!player) return rejectWs(socket, "只有房间内玩家可以访问成就");
    attachSideSocket(player, socket, () => sendAchievementState(player, socket), (buffer) => handleAchievementMessage(player, socket, buffer));
    return true;
  }

  function attachSideSocket(player, socket, sendInitial, onMessage) {
    player.lastSeen = Date.now();
    player.sidePageGraceUntil = 0;
    player.sideConnections = (player.sideConnections || 0) + 1;
    sendInitial();
    socket.on("data", (buffer) => {
      player.lastSeen = Date.now();
      onMessage(buffer);
    });
    socket.on("close", () => {
      player.sideConnections = Math.max(0, (player.sideConnections || 0) - 1);
      player.sidePageGraceUntil = Date.now() + HEARTBEAT_TIMEOUT_MS;
    });
    socket.on("error", () => {});
  }

  function resolvePlayerForSideConnection(playerId, socket) {
    let player = players.get(playerId);
    if (!player && disconnectedPlayers.has(playerId) && players.size < maxPlayers) {
      player = disconnectedPlayers.get(playerId);
      disconnectedPlayers.delete(playerId);
      player.socket = socket;
      player.inGame = false;
      player.ready = false;
      player.sideConnections = 0;
      players.set(player.id, player);
      broadcastRoomState();
    }
    return player;
  }

  function handleMessage(player, buffer) {
    player.lastSeen = Date.now();
    const message = readJson(buffer);
    if (!message) return sendWsJson(player.socket, { type: "error", message: "消息格式错误" });
    if (message.type === "ws_close") {
      if (!player.inGame) removePlayer(player.id);
      return;
    }
    if (message.type === "heartbeat") return;
    if (message.type === "enter_side_page") {
      player.sidePageGraceUntil = Date.now() + 5 * 60_000;
      return;
    }
    if (message.type === "set_selection") {
      if (!player.inGame) applySelection(player, message.selection);
      broadcastRoomState();
      return;
    }
    if (message.type === "set_ready") {
      if (player.inGame) return sendWsJson(player.socket, { type: "error", message: "游戏中不能准备下一局" });
      if (player.profile.money < 0) return sendWsJson(player.socket, { type: "error", message: "金钱为负时不能准备" });
      applySelection(player, message.selection);
      if (isHost(player.id)) return sendWsJson(player.socket, { type: "error", message: "房主不能设置准备状态" });
      player.ready = Boolean(message.ready);
      broadcastRoomState();
      return;
    }
    if (message.type === "save_loadout") {
      player.profile.settings.propLoadout = normalizeLoadout(message.props, propDefinitions);
      saveProfileByNickname(rootDir, player.profile);
      sendWsJson(player.socket, { type: "loadout_saved", message: "配置已保存" });
      return;
    }
    if (message.type === "use_loadout") {
      const loadout = normalizeLoadout(player.profile.settings.propLoadout, propDefinitions);
      const validation = validatePropCounts(player.profile, loadout);
      if (!validation.ok) return sendWsJson(player.socket, { type: "error", message: validation.message });
      player.props = loadout;
      player.ready = false;
      sendWsJson(player.socket, { type: "loadout_used", body: { props: loadout } });
      broadcastRoomState();
      return;
    }
    if (message.type === "start_game") {
      applySelection(player, message.selection);
      if (!isHost(player.id)) return sendWsJson(player.socket, { type: "error", message: "只有房主可以开始游戏" });
      if (!canStart()) return sendWsJson(player.socket, { type: "error", message: "至少需要2名未在游戏中的玩家，且其他玩家都已准备" });
      const gamePlayers = [...players.values()]
        .filter((entry) => !entry.inGame)
        .map((entry) => ({
          id: entry.id,
          nickname: entry.nickname,
          title: "",
          characterId: entry.characterId,
          props: entry.props,
          profile: entry.profile,
        }));
      const validation = validateSelections(gamePlayers);
      if (!validation.ok) return sendWsJson(player.socket, { type: "error", message: validation.message });
      if (gamePlayers.some((gamePlayer) => gamePlayer.profile.money < 0 || gamePlayer.profile.money < currentContainer.entryFee)) {
        return sendWsJson(player.socket, { type: "error", message: "有玩家余额不足" });
      }
      for (const gamePlayer of gamePlayers) {
        deductMoney(gamePlayer.profile, currentContainer.entryFee);
        saveProfileByNickname(rootDir, gamePlayer.profile);
      }
      for (const entry of players.values()) {
        if (gamePlayers.some((gamePlayer) => gamePlayer.id === entry.id)) {
          entry.inGame = true;
          entry.ready = false;
        }
      }
      gameInProgress = true;
      onGameStart?.(gamePlayers, currentContainer);
      broadcast({ type: "game_starting", message: "游戏即将开始", body: { url: "/game" } });
      broadcastRoomState();
      return;
    }

    sendWsJson(player.socket, { type: "error", message: "未知消息类型" });
  }

  function handleWarehouseMessage(player, socket, buffer) {
    const message = readJson(buffer);
    if (!message) return sendWsJson(socket, { type: "error", message: "消息格式错误" });
    if (message.type === "ws_close") return socket.end();
    if (message.type === "heartbeat") return;
    try {
      if (message.type === "toggle_favorite") {
        const itemId = Number(message.itemId);
        const collected = toggleFavorite(player.profile, itemId);
        saveProfileByNickname(rootDir, player.profile);
        sendWsJson(socket, { type: "favorite_updated", body: { itemId, collected } });
        sendWarehouseState(player, socket);
        return;
      }
      if (message.type === "sell_items") {
        const result = sellProfileItems(player.profile, message.itemIds || [], message.quantity, itemsById);
        saveProfileByNickname(rootDir, player.profile);
        sendWsJson(socket, { type: "sell_result", body: result });
        sendWarehouseState(player, socket);
        broadcastRoomState();
        return;
      }
      if (message.type === "sell_props") {
        const result = sellProfileProps(player.profile, message.propIds || [], message.quantity, propDefinitions);
        saveProfileByNickname(rootDir, player.profile);
        sendWsJson(socket, { type: "sell_result", body: result });
        sendWarehouseState(player, socket);
        broadcastRoomState();
        return;
      }
      if (message.type === "production_set_recipe") {
        setProductionRecipe(player, Number(message.slot), Number(message.recipeId));
        saveProfileByNickname(rootDir, player.profile);
        sendWarehouseState(player, socket);
        return;
      }
      if (message.type === "production_place_input") {
        placeProductionInput(player, Number(message.slot), Number(message.inputIndex));
        saveProfileByNickname(rootDir, player.profile);
        sendWarehouseState(player, socket);
        return;
      }
      if (message.type === "production_remove_input") {
        removeProductionInput(player, Number(message.slot), Number(message.inputIndex));
        saveProfileByNickname(rootDir, player.profile);
        sendWarehouseState(player, socket);
        return;
      }
      if (message.type === "production_collect") {
        const result = collectProductionOutput(player, Number(message.slot), Number(message.outputIndex), message.mode);
        saveProfileByNickname(rootDir, player.profile);
        sendWsJson(socket, { type: "production_collect_result", body: result });
        sendWarehouseState(player, socket);
        broadcastRoomState();
        return;
      }
      if (message.type === "production_favorite_inputs") {
        for (const id of productionRequirementIds(productionRecipes)) setFavorite(player.profile, id, true);
        saveProfileByNickname(rootDir, player.profile);
        sendWarehouseState(player, socket);
        return;
      }
      if (message.type === "warehouse_clear_notification") {
        clearWarehouseNotification(player, message.kind);
        saveProfileByNickname(rootDir, player.profile);
        sendWarehouseState(player, socket);
        return;
      }
      if (message.type === "lottery_refill") {
        refillLottery(player);
        saveProfileByNickname(rootDir, player.profile);
        sendWarehouseState(player, socket);
        return;
      }
      if (message.type === "lottery_draw") {
        const result = performLottery(player);
        saveProfileByNickname(rootDir, player.profile);
        sendWsJson(socket, { type: "lottery_result", body: result });
        sendWarehouseState(player, socket);
        return;
      }
      if (message.type === "lottery_collect") {
        const result = collectLotteryResults(player, message.mode);
        saveProfileByNickname(rootDir, player.profile);
        sendWsJson(socket, { type: "lottery_collect_result", body: result });
        sendWarehouseState(player, socket);
        broadcastRoomState();
        return;
      }
      if (message.type === "lottery_favorite_consumes") {
        for (const id of lotteryConsumableIds(lotteryRecipes)) setFavorite(player.profile, id, true);
        saveProfileByNickname(rootDir, player.profile);
        sendWarehouseState(player, socket);
        return;
      }
    } catch (error) {
      sendWsJson(socket, { type: "error", message: error.message });
    }
  }

  function handleShopMessage(player, socket, buffer) {
    const message = readJson(buffer);
    if (!message) return sendWsJson(socket, { type: "error", message: "消息格式错误" });
    if (message.type === "heartbeat") return;
    try {
      if (message.type === "buy_props") {
        const ids = Array.isArray(message.propIds) ? message.propIds : [];
        const quantity = Math.max(1, Math.floor(Number(message.quantity) || 1));
        const results = ids.map((id) => buyProfileProps(player.profile, id, quantity, propDefinitions));
        saveProfileByNickname(rootDir, player.profile);
        sendWsJson(socket, { type: "buy_result", body: { results, money: player.profile.money } });
        sendShopState(player, socket);
        broadcastRoomState();
      }
    } catch (error) {
      sendWsJson(socket, { type: "error", message: error.message });
    }
  }

  function handleProductionMessage(player, socket, buffer) {
    const message = readJson(buffer);
    if (!message) return sendWsJson(socket, { type: "error", message: "消息格式错误" });
    if (message.type === "heartbeat") return;
    try {
      if (message.type === "production_set_page") {
        player.profile.production = normalizeProductionState(player.profile.production);
        player.profile.production.currentPage = clampProductionPage(message.page);
        saveProfileByNickname(rootDir, player.profile);
        sendProductionState(player, socket);
        return;
      }
      if (message.type === "toggle_favorite") {
        const itemId = Number(message.itemId);
        const collected = toggleFavorite(player.profile, itemId);
        saveProfileByNickname(rootDir, player.profile);
        sendWsJson(socket, { type: "favorite_updated", body: { itemId, collected } });
        sendProductionState(player, socket);
        return;
      }
      if (message.type === "production_buy_page") {
        const result = buyProductionPage(player);
        saveProfileByNickname(rootDir, player.profile);
        sendWsJson(socket, { type: "production_buy_result", body: result });
        sendProductionState(player, socket);
        broadcastRoomState();
        return;
      }
      if (message.type === "production_collect_all") {
        const result = collectAllProductionOutputs(player, message.mode);
        saveProfileByNickname(rootDir, player.profile);
        sendWsJson(socket, { type: "production_collect_all_result", body: result });
        sendProductionState(player, socket);
        broadcastRoomState();
        return;
      }
      if (message.type === "production_set_recipe") setProductionRecipe(player, Number(message.slot), Number(message.recipeId), message.page);
      else if (message.type === "production_place_input") placeProductionInput(player, Number(message.slot), Number(message.inputIndex), message.page);
      else if (message.type === "production_remove_input") removeProductionInput(player, Number(message.slot), Number(message.inputIndex), message.page);
      else if (message.type === "production_favorite_inputs") for (const id of productionRequirementIds(productionRecipes)) setFavorite(player.profile, id, true);
      else if (message.type === "production_collect") {
        const result = collectProductionOutput(player, Number(message.slot), Number(message.outputIndex), message.mode, message.page);
        sendWsJson(socket, { type: "production_collect_result", body: result });
      } else if (message.type === "warehouse_clear_notification") {
        clearWarehouseNotification(player, "production");
      } else {
        return;
      }
      saveProfileByNickname(rootDir, player.profile);
      sendProductionState(player, socket);
    } catch (error) {
      sendWsJson(socket, { type: "error", message: error.message });
    }
  }

  function handleLotteryMessage(player, socket, buffer) {
    const message = readJson(buffer);
    if (!message) return sendWsJson(socket, { type: "error", message: "消息格式错误" });
    if (message.type === "heartbeat") return;
    try {
      if (message.type === "lottery_refill") refillLottery(player);
      else if (message.type === "lottery_draw") sendWsJson(socket, { type: "lottery_result", body: performLottery(player) });
      else if (message.type === "lottery_collect") {
        const result = collectLotteryResults(player, message.mode);
        sendWsJson(socket, { type: "lottery_collect_result", body: result });
        broadcastRoomState();
      } else if (message.type === "lottery_favorite_consumes") {
        for (const id of lotteryConsumableIds(lotteryRecipes)) setFavorite(player.profile, id, true);
      } else if (message.type === "warehouse_clear_notification") {
        clearWarehouseNotification(player, "lottery");
      } else {
        return;
      }
      saveProfileByNickname(rootDir, player.profile);
      sendLotteryState(player, socket);
    } catch (error) {
      sendWsJson(socket, { type: "error", message: error.message });
    }
  }

  function completeGame(finalPlayers = []) {
    const finalPropsById = new Map(finalPlayers.map((player) => [player.id, player.props || []]));
    const now = Date.now();
    for (const player of players.values()) {
      if (finalPropsById.has(player.id)) player.props = normalizePostGameProps(finalPropsById.get(player.id), propDefinitions);
      player.inGame = false;
      player.ready = false;
      player.lastSeen = now;
      player.sideConnections = 0;
    }
    gameInProgress = false;
    currentContainer = pickContainer(containers);
    broadcastRoomState();
  }

  function applySelection(player, selection = {}) {
    if (!selection || typeof selection !== "object") return;
    if (selection.characterId && characterDefinitions.has(selection.characterId)) player.characterId = selection.characterId;
    if (Array.isArray(selection.props)) player.props = normalizeLoadout(selection.props, propDefinitions);
  }

  function sendWarehouseState(player, socket) {
    sendWsJson(socket, {
      type: "warehouse_state",
      body: {
        money: player.profile.money,
        items: player.profile.warehouse.items,
        props: player.profile.warehouse.props,
        propDefinitions: Object.fromEntries(propDefinitions),
        production: normalizeProductionState(player.profile.production),
        productionRecipes,
        lottery: normalizeLotteryState(player.profile.lottery),
        lotteryRecipes: publicLotteryRecipes(lotteryRecipes),
        notifications: {
          production: Boolean(player.profile.settings?.warehouseNotifications?.production),
          lottery: Boolean(player.profile.settings?.warehouseNotifications?.lottery),
        },
      },
    });
  }

  function sendShopState(player, socket) {
    sendWsJson(socket, {
      type: "shop_state",
      body: {
        money: player.profile.money,
        props: Object.fromEntries(propDefinitions),
      },
    });
  }

  function sendProductionState(player, socket) {
    sendWsJson(socket, {
      type: "production_state",
      body: {
        money: player.profile.money,
        items: player.profile.warehouse.items,
        production: normalizeProductionState(player.profile.production),
        productionRecipes,
        notifications: {
          production: Boolean(player.profile.settings?.warehouseNotifications?.production),
          lottery: Boolean(player.profile.settings?.warehouseNotifications?.lottery),
        },
      },
    });
  }

  function sendLotteryState(player, socket) {
    sendWsJson(socket, {
      type: "lottery_state",
      body: {
        money: player.profile.money,
        items: player.profile.warehouse.items,
        props: player.profile.warehouse.props,
        lottery: normalizeLotteryState(player.profile.lottery),
        lotteryRecipes: publicLotteryRecipes(lotteryRecipes),
        propDefinitions: Object.fromEntries(propDefinitions),
        notifications: {
          production: Boolean(player.profile.settings?.warehouseNotifications?.production),
          lottery: Boolean(player.profile.settings?.warehouseNotifications?.lottery),
        },
      },
    });
  }

  function sendAchievementState(player, socket) {
    normalizeAchievementState(player.profile, achievements);
    sendWsJson(socket, {
      type: "achievement_state",
      body: {
        money: player.profile.money,
        achievements: publicAchievementState(player.profile, achievements),
        items: Object.fromEntries([...itemsById].map(([id, item]) => [id, { id, name: item.name, rarity: item.rarity, price: item.price }])),
      },
    });
  }

  function handleAchievementMessage(player, socket, buffer) {
    const message = readJson(buffer);
    if (!message) return sendWsJson(socket, { type: "error", message: "消息格式错误" });
    try {
      if (message.type === "claim_achievement") {
        const result = claimAchievementReward(player, message.id);
        saveProfileByNickname(rootDir, player.profile);
        sendWsJson(socket, { type: "achievement_claimed", body: result });
        sendAchievementState(player, socket);
      }
    } catch (err) {
      sendWsJson(socket, { type: "error", message: err.message || "成就操作失败" });
    }
  }

  function claimAchievementReward(player, id) {
    normalizeAchievementState(player.profile, achievements);
    const achievement = achievements.find((entry) => String(entry.id) === String(id));
    if (!achievement) throw new Error("未知成就");
    const state = player.profile.achievements[String(achievement.id)];
    if (!state.completed) throw new Error("成就尚未完成");
    if (state.claimed) throw new Error("奖励已经领取");
    if (!achievement.reward || !itemsById.has(Number(achievement.reward))) throw new Error("成就奖励无效");
    addProfileItem(player.profile, Number(achievement.reward), 1);
    state.claimed = true;
    return { id: achievement.id, reward: achievement.reward, rewardName: itemsById.get(Number(achievement.reward))?.name || `#${achievement.reward}` };
  }

  function setProductionRecipe(player, slotIndex, recipeId, pageNumber = null) {
    const slot = getProductionSlot(player, slotIndex, pageNumber);
    if (slot.outputs.some(Boolean)) throw new Error("\u8bf7\u5148\u5904\u7406\u4ea7\u7269\u683c\u4e2d\u7684\u7269\u54c1");
    const returnedInputs = slot.inputs.filter(Boolean);
    if (!recipeId) {
      slot.recipeId = null;
      slot.inputs = [null, null, null, null];
      for (const input of returnedInputs) addProfileItem(player.profile, input.id, input.count);
      return;
    }
    const recipe = productionRecipes.find((entry) => entry.recipe_id === recipeId);
    if (!recipe) throw new Error("该物品不是抽奖道具");
    slot.recipeId = recipe.recipe_id;
    slot.inputs = [null, null, null, null];
    for (const input of returnedInputs) addProfileItem(player.profile, input.id, input.count);
  }

  function placeProductionInput(player, slotIndex, inputIndex, pageNumber = null) {
    const slot = getProductionSlot(player, slotIndex, pageNumber);
    const recipe = productionRecipes.find((entry) => entry.recipe_id === slot.recipeId);
    if (!recipe) throw new Error("该物品不是抽奖道具");
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= 4) throw new Error("\u751f\u4ea7\u683c\u65e0\u6548");
    const itemId = recipe.recipe[inputIndex];
    if (!itemId) throw new Error("\u8be5\u914d\u65b9\u4e0d\u9700\u8981\u8fd9\u4e2a\u683c\u5b50");
    if (slot.inputs[inputIndex]) throw new Error("\u8be5\u751f\u4ea7\u683c\u5df2\u7ecf\u653e\u5165\u7269\u54c1");
    takeProfileItemWithoutNormalizing(player.profile, itemId, 1);
    slot.inputs[inputIndex] = { id: itemId, count: 1 };
  }

  function removeProductionInput(player, slotIndex, inputIndex, pageNumber = null) {
    const slot = getProductionSlot(player, slotIndex, pageNumber);
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= 4) throw new Error("\u751f\u4ea7\u683c\u65e0\u6548");
    const input = slot.inputs[inputIndex];
    if (!input) return;
    slot.inputs[inputIndex] = null;
    addProfileItem(player.profile, input.id, input.count);
  }

  function collectProductionOutput(player, slotIndex, outputIndex, mode = "take", pageNumber = null) {
    const slot = getProductionSlot(player, slotIndex, pageNumber);
    if (!Number.isInteger(outputIndex) || outputIndex < 0 || outputIndex >= 2) throw new Error("\u4ea7\u7269\u683c\u65e0\u6548");
    const output = slot.outputs[outputIndex];
    if (!output || output.count <= 0) throw new Error("\u8be5\u4ea7\u7269\u683c\u4e3a\u7a7a");
    const item = itemsById.get(output.id);
    if (!item) throw new Error("\u672a\u77e5\u4ea7\u7269");
    const result = { mode, itemId: output.id, count: output.count, itemName: item.name, total: 0, money: player.profile.money };
    slot.outputs[outputIndex] = null;
    if (mode === "sell") {
      result.total = output.count * Number(item.price || 0);
      addMoney(player.profile, result.total);
      result.money = player.profile.money;
    } else {
      addProfileItem(player.profile, output.id, output.count);
    }
    return result;
  }

  function buyProductionPage(player) {
    player.profile.production = normalizeProductionState(player.profile.production);
    const opened = player.profile.production.pages.filter((page) => page.open).length;
    if (opened >= PRODUCTION_MAX_PAGES) throw new Error("车间页已达上限");
    const price = opened * 1_000_000;
    if (player.profile.money < price) throw new Error("金钱不足");
    player.profile.money -= price;
    const page = player.profile.production.pages.find((entry) => !entry.open);
    page.open = true;
    player.profile.production.currentPage = page.page;
    return { page: page.page, price, money: player.profile.money };
  }

  function collectAllProductionOutputs(player, mode = "take") {
    player.profile.production = normalizeProductionState(player.profile.production);
    const handled = [];
    let total = 0;
    for (const page of player.profile.production.pages) {
      if (!page.open) continue;
      for (const slot of page.slots) {
        for (let outputIndex = 0; outputIndex < slot.outputs.length; outputIndex += 1) {
          const output = slot.outputs[outputIndex];
          if (!output) continue;
          const item = itemsById.get(output.id);
          if (!item) continue;
          const entry = { id: output.id, name: item.name, count: output.count, subtotal: 0 };
          slot.outputs[outputIndex] = null;
          if (mode === "sell") {
            entry.subtotal = output.count * Number(item.price || 0);
            total += entry.subtotal;
          } else {
            addProfileItem(player.profile, output.id, output.count);
          }
          handled.push(entry);
        }
      }
    }
    if (mode === "sell" && total > 0) addMoney(player.profile, total);
    return { mode, handled, total, money: player.profile.money };
  }

  function refillLottery(player) {
    player.profile.lottery = normalizeLotteryState(player.profile.lottery);
    if (player.profile.lottery.results.length) throw new Error("请先领取或出售当前抽奖结果");
    if (player.profile.lottery.slot) return;
    const ids = lotteryConsumableIds(lotteryRecipes);
    const id = ids.find((itemId) => (player.profile.warehouse.items[String(itemId)]?.count || 0) > 0);
    if (!id) throw new Error("没有可补充的抽奖道具");
    removeProfileItem(player.profile, id, 1);
    player.profile.lottery.slot = { id, count: 1 };
  }

  function performLottery(player) {
    player.profile.lottery = normalizeLotteryState(player.profile.lottery);
    if (player.profile.lottery.results.length) throw new Error("请先领取或出售当前抽奖结果");
    const slot = player.profile.lottery.slot;
    if (!slot) throw new Error("请先放入抽奖道具");
    const recipe = lotteryRecipes.find((entry) => entry.consume === slot.id);
    if (!recipe) throw new Error("该物品不是抽奖道具");
    const results = drawLottery(recipe, Math.random);
    player.profile.lottery.slot = null;
    player.profile.lottery.results = mergeLotteryResults(results);
    return { results: player.profile.lottery.results };
  }

  function collectLotteryResults(player, mode = "take") {
    player.profile.lottery = normalizeLotteryState(player.profile.lottery);
    const results = player.profile.lottery.results || [];
    if (!results.length) throw new Error("没有可领取的抽奖结果");
    let total = 0;
    const collected = [];
    for (const result of results) {
      if (mode === "sell" || (mode === "sell_unfavorite" && (result.class === "prop" || !player.profile.warehouse.items[String(result.id)]?.collected))) {
        total += lotteryResultValue(result);
      } else {
        addLotteryResultToProfile(player.profile, result);
        collected.push(result);
      }
    }
    if (total > 0) addMoney(player.profile, total);
    player.profile.lottery.results = [];
    return { mode, total, collected, money: player.profile.money };
  }

  function addLotteryResultToProfile(profile, result) {
    if (result.class === "prop") {
      profile.warehouse.props[result.id] = (profile.warehouse.props[result.id] || 0) + result.count;
    } else {
      addProfileItem(profile, result.id, result.count);
    }
  }

  function lotteryResultValue(result) {
    if (result.class === "prop") return Number(propDefinitions.get(String(result.id))?.price || 0) * result.count;
    return Number(itemsById.get(Number(result.id))?.price || 0) * result.count;
  }

  function getProductionSlot(player, slotIndex, pageNumber = null) {
    player.profile.production = normalizeProductionState(player.profile.production);
    const page = player.profile.production.pages.find((entry) => entry.page === clampProductionPage(pageNumber || player.profile.production.currentPage));
    if (!page?.open) throw new Error("生产车间页未开通");
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= page.slots.length) throw new Error("生产槽无效");
    return page.slots[slotIndex];
  }

  function roomSnapshot(viewerId) {
    const hostId = getHostId();
    return {
      maxPlayers,
      hostId,
      viewerId,
      canStart: canStart(),
      gameInProgress,
      container: currentContainer,
      players: [...players.values()].map((player) => ({ ...clientPlayer(player), isHost: player.id === hostId })),
      characters: Object.fromEntries(characterDefinitions),
      props: Object.fromEntries(propDefinitions),
      notifications: viewerId ? {
        production: Boolean(players.get(viewerId)?.profile.settings?.warehouseNotifications?.production),
        lottery: Boolean(players.get(viewerId)?.profile.settings?.warehouseNotifications?.lottery),
      } : { production: false, lottery: false },
    };
  }

  function clientPlayer(player) {
    return {
      id: player.id,
      nickname: player.nickname,
      money: player.profile.money,
      ready: player.ready,
      inGame: player.inGame,
      characterId: player.characterId,
      props: player.props,
      ownedProps: player.profile.warehouse.props,
      savedLoadout: player.profile.settings.propLoadout,
    };
  }

  function broadcastRoomState() {
    for (const player of players.values()) sendWsJson(player.socket, { type: "room_state", body: roomSnapshot(player.id) });
  }

  function broadcast(payload) {
    for (const player of players.values()) sendWsJson(player.socket, payload);
  }

  function removePlayer(id) {
    const player = players.get(id);
    if (!player) return;
    players.delete(id);
    disconnectedPlayers.set(id, {
      ...player,
      ready: false,
      inGame: false,
      sideConnections: 0,
      lastSeen: Date.now(),
    });
    player.socket.destroy();
    broadcastRoomState();
  }

  function getHostId() {
    return [...players.values()].filter((player) => !player.inGame).sort((a, b) => a.joinedAt - b.joinedAt)[0]?.id || null;
  }

  function isHost(id) {
    return getHostId() === id;
  }

  function canStart() {
    if (gameInProgress) return false;
    const candidates = [...players.values()].filter((player) => !player.inGame);
    if (candidates.length < 2) return false;
    const hostId = getHostId();
    return candidates.every((player) => player.profile.money >= 0 && !isSocketClosed(player.socket) && (player.id === hostId || player.ready));
  }

  function createPlayerId() {
    let id;
    do {
      id = String(Math.floor(Math.random() * 100_000_000)).padStart(8, "0");
    } while (players.has(id));
    return id;
  }

  return {
    handleUpgrade,
    handleWarehouseUpgrade,
    handleShopUpgrade,
    handleProductionUpgrade,
    handleLotteryUpgrade,
    handleAchievementUpgrade,
    completeGame,
    listPlayers,
    findPlayer,
    kickPlayer,
    giveMoney,
    setMoney,
    giveItem,
    giveProp,
  };

  function listPlayers() {
    return [...players.values()].map((player) => ({ id: player.id, nickname: player.nickname, money: player.profile.money, ready: player.ready, inGame: player.inGame }));
  }

  function findPlayer(ref) {
    return players.get(String(ref)) || [...players.values()].find((player) => player.nickname === ref);
  }

  function kickPlayer(ref) {
    const player = findPlayer(ref);
    if (!player) return false;
    removePlayer(player.id);
    return true;
  }

  function giveMoney(ref, amount) {
    const player = findPlayer(ref);
    if (!player) throw new Error("player not found");
    addMoney(player.profile, amount);
    saveProfileByNickname(rootDir, player.profile);
    broadcastRoomState();
    return player.profile.money;
  }

  function setMoney(ref, amount) {
    const player = findPlayer(ref);
    if (!player) throw new Error("player not found");
    player.profile.money = Math.floor(Number(amount) || 0);
    saveProfileByNickname(rootDir, player.profile);
    broadcastRoomState();
    return player.profile.money;
  }

  function giveItem(ref, id, amount) {
    const player = findPlayer(ref);
    if (!player) throw new Error("player not found");
    addProfileItem(player.profile, Number(id), Number(amount) || 1);
    saveProfileByNickname(rootDir, player.profile);
    return true;
  }

  function giveProp(ref, id, amount) {
    const player = findPlayer(ref);
    if (!player) throw new Error("player not found");
    const propId = String(id);
    if (!propDefinitions.has(propId)) throw new Error("unknown prop");
    player.profile.warehouse.props[propId] = (player.profile.warehouse.props[propId] || 0) + Math.max(1, Math.floor(Number(amount) || 1));
    saveProfileByNickname(rootDir, player.profile);
    return true;
  }
}

function reject(socket, message) {
  sendWsJson(socket, { type: "join_error", message });
  socket.end();
  return true;
}

function rejectWs(socket, message) {
  sendWsJson(socket, { type: "error", message });
  socket.end();
  return true;
}

function defaultCarriedProps(profile, propDefinitions) {
  const saved = normalizeLoadout(profile.settings?.propLoadout, propDefinitions);
  if (validatePropCounts(profile, saved).ok && saved.some(Boolean)) return saved;
  const ids = Object.entries(profile.warehouse.props).filter(([, count]) => count > 0).map(([id]) => id).slice(0, 2);
  return Array.from({ length: 5 }, (_, index) => (ids[index] ? normalizePropSelection(ids[index], propDefinitions) : null));
}

function normalizeLoadout(props, propDefinitions) {
  return Array.from({ length: 5 }, (_, index) => normalizePropSelection(props?.[index], propDefinitions));
}

function normalizePostGameProps(props, propDefinitions) {
  return Array.from({ length: 5 }, (_, index) => {
    const prop = props?.[index];
    if (!prop || prop.temporary || prop.exclusive) return null;
    return normalizePropSelection(prop, propDefinitions);
  });
}

function normalizePropSelection(value, propDefinitions) {
  if (!value) return null;
  const id = typeof value === "string" ? value : String(value.id || "");
  if (!id) return null;
  const definition = propDefinitions.get(id) || {};
  return { id, level: Number(definition.level || value.level) || 1 };
}

function validatePropCounts(profile, props) {
  const counts = new Map();
  for (const prop of props) {
    if (!prop) continue;
    counts.set(prop.id, (counts.get(prop.id) || 0) + 1);
  }
  for (const [id, count] of counts) {
    if ((profile.warehouse.props[id] || 0) < count) return { ok: false, message: `道具数量不足: ${id}` };
  }
  return { ok: true };
}

function readJson(buffer) {
  const text = decodeWsText(buffer);
  if (!text) return { type: "ws_close" };
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstKey(map) {
  return map.keys().next().value;
}

function normalizeNickname(nickname) {
  return String(nickname || "").trim().slice(0, 20);
}

function isSocketClosed(socket) {
  return !socket || socket.destroyed || socket.closed;
}

function loadMaxPlayers(rootDir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(rootDir, "config.json"), "utf8"));
    const value = Math.floor(Number(config.game?.max_players) || MAX_PLAYERS);
    return Math.max(1, Math.min(6, value));
  } catch {
    return MAX_PLAYERS;
  }
}

function loadLotteryRaw(rootDir) {
  const filePath = path.join(rootDir, "lottery.json");
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function publicLotteryRecipes(recipes) {
  return recipes.map((recipe) => ({
    recipe_id: recipe.recipe_id,
    consume: recipe.consume,
    outcome: recipe.outcome,
    pool: recipe.poolText,
  }));
}

function mergeLotteryResults(results) {
  const merged = [];
  for (const result of results) {
    const existing = merged.find((entry) => entry.class === result.class && String(entry.id) === String(result.id));
    if (existing) existing.count += result.count;
    else merged.push({ ...result });
  }
  return merged;
}

function productionRequirementIds(recipes) {
  return [...new Set(recipes.flatMap((recipe) => recipe.recipe || []).map(Number).filter(Boolean))];
}

function takeProfileItemWithoutNormalizing(profile, itemId, count = 1) {
  const id = Number(itemId);
  const amount = Math.max(1, Math.floor(Number(count) || 1));
  const key = String(id);
  const entry = profile.warehouse?.items?.[key];
  if (!entry || entry.count < amount) throw new Error(`物品数量不足: ${id}`);
  entry.count -= amount;
  if (entry.count <= 0) delete profile.warehouse.items[key];
}

function clearWarehouseNotification(player, kind) {
  if (!player.profile.settings || typeof player.profile.settings !== "object") player.profile.settings = {};
  if (!player.profile.settings.warehouseNotifications || typeof player.profile.settings.warehouseNotifications !== "object") {
    player.profile.settings.warehouseNotifications = {};
  }
  if (kind === "production" || kind === "lottery") player.profile.settings.warehouseNotifications[kind] = false;
}

function clampProductionPage(value) {
  const page = Math.floor(Number(value) || 1);
  return Math.max(1, Math.min(PRODUCTION_MAX_PAGES, page));
}

function loadContainers(rootDir) {
  const config = JSON.parse(fs.readFileSync(path.join(rootDir, "config.json"), "utf8"));
  const entries = Object.entries(config.containers || {});
  if (!entries.length) return [{ name: "大型箱子", k: 1, entryFee: entryFeeForK(1) }];
  return entries.map(([name, k]) => {
    const number = Number(k);
    const value = Number.isFinite(number) ? number : 1;
    return { name, k: value, entryFee: entryFeeForK(value) };
  });
}

function pickContainer(containers) {
  return containers[Math.floor(Math.random() * containers.length)];
}

function entryFeeForK(k) {
  const value = Math.max(0, Math.min(2, Number(k) || 0));
  const delta = value - 1;
  return Math.ceil(30000 - 30000 * delta + 75000 * delta ** 2 - 65000 * delta ** 3);
}


