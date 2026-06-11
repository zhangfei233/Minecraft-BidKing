import fs from "node:fs";
import path from "node:path";
import { Warehouse } from "./Warehouse.js";
import { createCharacter } from "./characters.js";
import { createProp } from "./props.js";
import { loadDefinitions } from "./definitions.js";
import {
  addMoney,
  addProfileItem,
  addWarehouseItemsToProfile,
  deductMoneyAllowDebt,
  saveProfileByNickname,
  sellProfileItemCounts,
} from "../player/profile.js";
import { loadConfig, loadItemsById } from "../items/items.js";
import { decodeWsText, sendWsJson } from "../net/websocket.js";
import { itemFullInfoKnown, itemOutlineKnown, itemRarityKnown, splitTypes } from "./hints.js";
import { error as logError, info as logInfo } from "../net/logger.js";
import { loadProductionRecipes, runProduction } from "../production/production.js";
import { loadLotteryRecipes, lotteryConsumableIds } from "../lottery/lottery.js";
import { AdvantageTracker, requiredPairRatio } from "./advantage.js";
import { advanceAchievement, loadAchievements, normalizeAchievementState } from "../achievement/achievement.js";

const ROUND_COUNT = 5;
const ROUND_MS = 62_000;
const INTERMISSION_MS = 3_000;
const WIN_RATIOS = [2, 1.6, 1.3, 1.1, 1];
const ANIMATION_SECONDS = {
  1: 14,
  2: 10,
  3: 12,
  4: 4,
  5: 2,
  6: 8.75,
  7: 5.25,
  8: 10.25,
  9: 10,
  10: 5,
};
const HEARTBEAT_TIMEOUT_MS = 45_000;
const GAME_RECONNECT_GRACE_MS = 60_000;
const RARITIES = ["gray", "green", "blue", "purple", "gold", "red"];
const RARITY_LABELS = { gray: "\u767d", green: "\u7eff", blue: "\u84dd", purple: "\u7d2b", gold: "\u91d1", red: "\u7ea2" };
const SYSTEM_HINT_TITLE = "\u516c\u5f00\u7684\u6218\u5229\u54c1\u4fe1\u606f";
const PROP_USE_REWARD_ITEM_ID = 2715;
const WINNER_REWARD_ITEM_ID = 2716;

export class GameSession {
  constructor({ rootDir, players, container = { name: "大型箱子", k: 1 }, random = Math.random, onFinish = null }) {
    this.rootDir = rootDir;
    this.random = random;
    this.container = container;
    this.onFinish = onFinish;
    this.characterDefinitions = loadDefinitions(rootDir, "characters.csv");
    this.propDefinitions = loadDefinitions(rootDir, "props.csv");
    this.specialPropDefinitions = loadDefinitions(rootDir, "sp_props.csv");
    this.allPropDefinitions = new Map([...this.propDefinitions, ...normalizeSpecialProps(this.specialPropDefinitions)]);
    this.itemsById = loadItemsById(rootDir);
    this.productionRecipes = loadProductionRecipes(rootDir, this.itemsById);
    this.lotteryRecipes = loadLotteryRecipes(loadLotteryRaw(rootDir), this.itemsById, this.propDefinitions);
    this.lotteryConsumableIds = lotteryConsumableIds(this.lotteryRecipes).map(Number);
    this.achievements = loadAchievements(rootDir);
    const gameConfig = loadConfig(rootDir).game || {};
    this.systemHintProbability = Number(gameConfig.system_hint_probability ?? 0.3);
    this.dividendRatio = Number(gameConfig.dividend_ratio ?? 0.1);
    this.chairItemId = Number(gameConfig.chair_item_id ?? 2253);
    this.warehouse = new Warehouse({ rootDir, random, viewCount: players.length });
    this.warehouse.generate(container.k, { entryFee: container.entryFee });
    this.systemHintPool = this.createSystemHintPool();
    this.usedSystemHintIds = new Set();
    this.publicKnown = {
      fullItems: new Set(),
      outlineItems: new Set(),
      rarityItems: new Set(),
    };
    this.players = players.map((player, index) => ({
      ...player,
      gameIndex: index + 1,
      characterId: player.characterId || "character_1",
      props: normalizeSelectedProps(player.props),
      gameSocket: null,
      connected: false,
      disconnected: false,
      lastSeen: Date.now(),
      bids: Array(ROUND_COUNT).fill(null),
      submitted: Array(ROUND_COUNT).fill(false),
      usedProps: Array(ROUND_COUNT).fill(null),
      propUsesThisRound: 0,
      disconnectTimer: null,
      characterState: {},
      pendingMessages: [],
      pendingExclusiveProps: [],
      copiedItems: [],
    }));
    for (const player of this.players) normalizeAchievementState(player.profile, this.achievements);
    this.playersById = new Map(this.players.map((player) => [player.id, player]));
    this.settlementOpen = false;
    this.roomCompleted = false;
    this.wonItemCounts = {};
    this.round = 0;
    this.roundTimer = null;
    this.intermissionTimer = null;
    this.pauseTimer = null;
    this.endedRounds = new Set();
    this.roundEndsAt = null;
    this.roundPaused = false;
    this.currentRoundDurationMs = ROUND_MS;
    this.actionLockedPlayerIds = new Set();
    this.roundStartAnimations = [];
    this.started = false;
    this.finished = false;
    this.advantages = new AdvantageTracker();
    this.roundFiveDomainClash = null;
    this.reserveCarriedProps();
    this.initializeNewCharacterStates();
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 15_000);
    this.heartbeatTimer.unref?.();
  }

  reserveCarriedProps() {
    for (const player of this.players) {
      for (const prop of player.props) {
        if (!prop) continue;
        if (prop.temporary || prop.exclusive) continue;
        player.profile.warehouse.props[prop.id] -= 1;
      }
      saveProfileByNickname(this.rootDir, player.profile);
    }
  }

  connect(playerId, socket) {
    const player = this.players.find((entry) => entry.id === playerId);
    if (!player) {
      sendWsJson(socket, { type: "error", message: "游戏不存在或玩家不在本局游戏中" });
      socket.end();
      return;
    }

    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
    const previousSocket = player.gameSocket;
    player.gameSocket = socket;
    player.connected = true;
    player.disconnected = false;
    player.lastSeen = Date.now();
    socket.on("data", (buffer) => this.handleMessage(player, buffer));
    socket.on("close", () => this.scheduleDisconnect(player, socket));
    socket.on("error", () => this.scheduleDisconnect(player, socket));
    if (previousSocket && previousSocket !== socket) previousSocket.destroy();

    this.sendInit(player);
    for (const payload of player.pendingMessages.splice(0)) this.send(player, payload);
    if (!this.started && this.players.every((entry) => entry.connected || entry.disconnected)) this.start();
  }

  scheduleDisconnect(player, socket) {
    if (this.finished || player.disconnected || player.gameSocket !== socket) return;
    player.connected = false;
    player.gameSocket = null;
    player.lastSeen = Date.now();
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = setTimeout(() => this.markDisconnected(player), GAME_RECONNECT_GRACE_MS);
    player.disconnectTimer.unref?.();
  }

  markDisconnected(player) {
    if (this.finished) return;
    if (player.disconnected) return;
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
    player.connected = false;
    player.disconnected = true;
    player.gameSocket = null;

    const startIndex = Math.max(0, this.round - 1);
    for (let index = startIndex; index < ROUND_COUNT; index += 1) {
      if (!player.submitted[index]) {
        player.bids[index] = 0;
        player.submitted[index] = true;
      }
    }
    this.broadcastPublicState({ clearBidState: false });
    const roundIndex = this.round - 1;
    if (roundIndex >= 0 && this.players.every((entry) => entry.submitted[roundIndex] || entry.disconnected)) this.endRound();
  }

  checkHeartbeats() {
    if (this.finished) return;
    const now = Date.now();
    for (const player of this.players) {
      if (player.connected && now - player.lastSeen > HEARTBEAT_TIMEOUT_MS) this.scheduleDisconnect(player, player.gameSocket);
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.emitSystemPublicHint({ force: true });
    this.startRound(1);
  }

  initializeNewCharacterStates() {
    const realItemIndexes = this.warehouse.items
      .map((item, index) => (index > 0 && item.id !== 0 ? index : 0))
      .filter(Boolean);
    for (const player of this.players) {
      if (player.characterId === "character_20" && realItemIndexes.length) {
        player.characterState.pucciTargetIndex = realItemIndexes[Math.floor(this.random() * realItemIndexes.length)];
        player.characterState.madeInHeaven = false;
      }
      if (player.characterId === "character_21") {
        player.characterState.megumiMode = null;
        player.characterState.megumiPredictions = {};
      }
      if (player.characterId === "character_19") {
        player.characterState.omenTotalByPlayer = {};
        player.characterState.omenActive = {};
      }
    }
  }

  createOpeningPublicHint() {
    const items = this.sampleWarehouseItems(5);
    const average = items.length ? Math.round(items.reduce((sum, item) => sum + Number(item.price || 0), 0) / items.length) : 0;
    return {
      type: "hint",
      title: "公开的战利品信息",
      text: `随机选择的${items.length}项物品的平均价值为${average}`,
      icon: "/resource/system_message.png",
      show: false,
      message: [],
    };
  }

  sampleWarehouseItems(count) {
    const items = this.warehouse.items.filter((item) => item.id !== 0);
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items.slice(0, count);
  }

  startRound(round) {
    if (this.finished) return;
    this.round = round;
    this.roundStartedAt = Date.now();
    const roundMs = this.roundDurationMsFor(round);
    this.currentRoundDurationMs = roundMs;
    this.roundEndsAt = Date.now() + roundMs;
    this.roundPaused = false;
    this.actionLockedPlayerIds = new Set();
    this.roundStartAnimations = [];
    this.deferredRoundStartPayloads = [];
    for (const player of this.players) {
      player.propUsesThisRound = 0;
      player.submitted[round - 1] = Boolean(player.disconnected);
      player.bids[round - 1] = player.disconnected ? 0 : null;
      this.applyRoundStartCharacterProps(player, round);
    }
    if (round === 5) {
      for (const player of this.players) {
        if (player.characterId === "character_15") this.emitGojoRoundHint(player);
      }
    }
    this.applyRoundStartDomains(round);
    for (const player of this.players) {
      this.send(player, {
        type: "round_start",
        body: {
          round,
          countdownSeconds: this.clientCountdownSecondsFor(roundMs),
          roundInitialSeconds: this.clientCountdownSecondsFor(roundMs),
          actionLocked: this.actionLockedPlayerIds.has(player.id),
        },
      });
    }
    if (this.roundStartAnimations.length) {
      const seconds = this.roundStartAnimations.reduce((sum, animation) => sum + Number(animation.durationSeconds || 0), 0);
      this.pauseRoundTime({ seconds, animations: this.roundStartAnimations });
    }
    for (const entry of this.deferredRoundStartPayloads) this.send(entry.player, entry.payload);
    this.deferredRoundStartPayloads = [];
    this.broadcastPublicState({ clearBidState: true });
    if (round > 1) this.emitSystemPublicHint({ force: false });
    for (const player of this.players) {
      if (round === 1) {
        this.emitCharacterStartHint(player);
        if (characterHasRoundOneEffect(player.characterId)) this.emitCharacterRoundHint(player);
      } else {
        if (round === 5 && player.characterId === "character_15") continue;
        this.emitCharacterRoundHint(player);
      }
    }
    this.sendRoundStartChoiceRequests(round);
    if (round === 1) this.broadcastAnimationPreloadList();
    this.scheduleRoundTimer();
  }

  broadcastAnimationPreloadList() {
    const ids = new Set();
    const characterIds = new Set(this.players.map((player) => player.characterId));
    if (characterIds.has("character_21")) {
      ids.add(1);
      ids.add(3);
    }
    if (characterIds.has("character_20")) {
      ids.add(2);
      ids.add(4);
    }
    if (characterIds.has("character_14")) {
      ids.add(5);
      ids.add(9);
    }
    if (characterIds.has("character_15")) ids.add(8);
    if (characterIds.has("character_22")) {
      ids.add(6);
      ids.add(7);
    }
    if (characterIds.has("character_14") && characterIds.has("character_15")) ids.add(10);
    if (!ids.size) return;
    this.broadcast({
      type: "preload_animations",
      body: {
        animations: [...ids].sort((a, b) => a - b).map((id) => ({ id, durationSeconds: ANIMATION_SECONDS[id] || 1 })),
      },
    });
  }

  roundDurationMsFor() {
    const madeInHeavenCount = this.players.filter((player) => player.characterState.madeInHeaven).length;
    return Math.max(5_000, Math.ceil(ROUND_MS * 0.5 ** madeInHeavenCount));
  }

  clientCountdownSecondsFor(ms) {
    return Math.max(0, Math.ceil(ms / 1000) - 2);
  }

  scheduleRoundTimer() {
    clearTimeout(this.roundTimer);
    if (this.finished || this.roundPaused || !this.roundEndsAt) return;
    const ms = Math.max(0, this.roundEndsAt - Date.now());
    this.roundTimer = setTimeout(() => this.endRound(), ms);
    this.roundTimer.unref?.();
  }

  setRoundRemainingMs(ms) {
    if (this.finished || !this.round) return;
    const clamped = Math.max(0, Math.floor(Number(ms) || 0));
    this.roundEndsAt = Date.now() + clamped;
    this.scheduleRoundTimer();
    this.broadcast({ type: "set_round_timer", body: { countdownSeconds: this.clientCountdownSecondsFor(clamped) } });
  }

  pauseRoundTime({ seconds, animations = [], resumeRemainingMs = null } = {}) {
    if (this.finished || !this.roundEndsAt) return;
    const ms = Math.max(0, Math.floor(Number(seconds || 0) * 1000));
    if (!ms) return;
    clearTimeout(this.roundTimer);
    clearTimeout(this.pauseTimer);
    this.roundPaused = true;
    const resumeMs = resumeRemainingMs == null ? null : Math.max(0, Math.floor(Number(resumeRemainingMs) || 0));
    this.roundEndsAt = resumeMs == null ? this.roundEndsAt + ms : Date.now() + ms + resumeMs;
    const countdownAfterPause = this.clientCountdownSecondsFor(Math.max(0, this.roundEndsAt - Date.now() - ms));
    this.broadcast({
      type: "round_pause",
      body: {
        pauseSeconds: Math.ceil(ms / 1000),
        countdownSeconds: countdownAfterPause,
        animations,
      },
    });
    this.pauseTimer = setTimeout(() => {
      this.roundPaused = false;
      this.scheduleRoundTimer();
      this.broadcast({ type: "set_round_timer", body: { countdownSeconds: this.currentCountdownSeconds() } });
    }, ms);
    this.pauseTimer.unref?.();
  }

  emitSystemPublicHint({ force = false } = {}) {
    if (!force && this.random() >= this.systemHintProbability) return;
    const remaining = this.systemHintPool.filter((entry) => !this.usedSystemHintIds.has(entry.id));
    if (!remaining.length) return;
    for (const entry of sample(remaining, remaining.length, this.random)) {
      const rawHints = this.filterPublicRawHints(entry.rawHints);
      this.usedSystemHintIds.add(entry.id);
      if (entry.show && !rawHints.length) continue;
      this.markPublicRawHints(rawHints);
      for (const player of this.players) {
        const message = rawHints.map((hint) => this.warehouse.addHint(player.gameIndex, hint));
        this.send(player, {
          type: "hint",
          title: SYSTEM_HINT_TITLE,
          text: entry.text,
          icon: "/resource/system_message.png",
          show: entry.show && message.length > 0,
          message,
        });
      }
      return;
    }
  }

  filterPublicRawHints(rawHints) {
    return rawHints.filter((hint) => {
      const index = publicHintItemIndex(this.warehouse, hint);
      if (!index) return false;
      if (hint.type === "item_full") return !this.publicKnown.fullItems.has(index);
      if (hint.type === "item_outline") return !this.publicKnown.outlineItems.has(index);
      if (hint.type === "item_outline_rarity") {
        return !this.publicKnown.outlineItems.has(index) || !this.publicKnown.rarityItems.has(index);
      }
      if (hint.type === "cell_rarity") return !this.publicKnown.rarityItems.has(index);
      return true;
    });
  }

  markPublicRawHints(rawHints) {
    for (const hint of rawHints) {
      const index = publicHintItemIndex(this.warehouse, hint);
      if (!index) continue;
      if (hint.type === "item_full") {
        this.publicKnown.fullItems.add(index);
        this.publicKnown.outlineItems.add(index);
        this.publicKnown.rarityItems.add(index);
      } else if (hint.type === "item_outline") {
        this.publicKnown.outlineItems.add(index);
      } else if (hint.type === "item_outline_rarity") {
        this.publicKnown.outlineItems.add(index);
        this.publicKnown.rarityItems.add(index);
      } else if (hint.type === "cell_rarity") {
        this.publicKnown.rarityItems.add(index);
      }
    }
  }

  createSystemHintPool() {
    const indexedItems = this.warehouse.items
      .map((item, index) => ({ ...item, itemIndex: index }))
      .filter((item) => item.itemIndex > 0);
    const x = randomInt(this.random, 1, 7);
    const y = RARITIES[Math.floor(this.random() * RARITIES.length)];
    const z = randomInt(this.random, 3, 9);
    const t = randomInt(this.random, 1, 5);
    const yItems = indexedItems.filter((item) => item.rarity === y);
    const totalCells = sumCells(indexedItems);
    const typeNames = [...new Set(indexedItems.flatMap((item) => splitTypes(item.type)))];
    const pickedTypes = sample(typeNames, t, this.random);
    const pickedTypeSet = new Set(pickedTypes);
    const randomXItems = sample(indexedItems, x, this.random);
    const randomZItems = sample(indexedItems, z, this.random);
    const randomZValueItems = sample(indexedItems, z, this.random);
    const randomDistinctItems = sample(uniqueItemsById(indexedItems), t, this.random);
    const maxCells = indexedItems.reduce((max, item) => Math.max(max, itemCells(item)), 0);
    const largestItems = indexedItems.filter((item) => itemCells(item) === maxCells);
    const largest = largestItems[Math.floor(this.random() * Math.max(1, largestItems.length))];
    const typeRarityItems = indexedItems.filter((item) => splitTypes(item.type).some((type) => pickedTypeSet.has(type)));

    return [
      systemNumberHint("total-cells", `\u6240\u6709\u6218\u5229\u54c1\u603b\u5360\u7528\u7684\u683c\u5b50\u6570\u91cf\u4e3a${totalCells}\u683c`),
      systemNumberHint("avg-cells", `\u6bcf\u4ef6\u6218\u5229\u54c1\u5e73\u5747\u5360\u7528\u7684\u683c\u5b50\u6570\u91cf\u4e3a${averageCells(totalCells, indexedItems.length)}\u683c`),
      systemItemHint("random-full-x", `\u968f\u673a\u663e\u793a${randomXItems.length}\u4ef6\u6218\u5229\u54c1`, randomXItems, "item_full"),
      systemItemHint("largest-full", "\u968f\u673a\u663e\u793a\u4e00\u4ef6\u5360\u4f4d\u683c\u6570\u6700\u9ad8\u7684\u6218\u5229\u54c1", largest ? [largest] : [], "item_full"),
      systemNumberHint("rarity-total-cells", `${RARITY_LABELS[y]}\u8272\u54c1\u8d28\u7684\u6218\u5229\u54c1\u603b\u5360\u7528\u7684\u683c\u5b50\u6570\u91cf\u4e3a${sumCells(yItems)}\u683c`),
      systemNumberHint("rarity-avg-cells", `${RARITY_LABELS[y]}\u8272\u54c1\u8d28\u7684\u6218\u5229\u54c1\u5e73\u5747\u5360\u7528\u7684\u683c\u5b50\u6570\u91cf\u4e3a${averageCells(sumCells(yItems), yItems.length)}\u683c`),
      systemNumberHint("random-z-avg-value", `\u968f\u673a\u9009\u62e9\u7684${randomZValueItems.length}\u4ef6\u6218\u5229\u54c1\u7684\u5e73\u5747\u4ef7\u503c\u4e3a${averageValue(randomZValueItems)}`),
      systemNumberHint("random-t-kind-avg-value", `\u968f\u673a\u9009\u62e9\u7684${randomDistinctItems.length}\u79cd\u6218\u5229\u54c1\u7684\u5e73\u5747\u4ef7\u503c\u4e3a${averageValue(randomDistinctItems)}`),
      systemNumberHint("rarity-count", `\u672c\u6b21\u7684\u6218\u5229\u54c1\u4ed3\u5171\u6709${RARITY_LABELS[y]}\u8272\u54c1\u8d28\u7684\u6218\u5229\u54c1${yItems.length}\u4ef6`),
      systemCellRarityHint("type-rarity", `\u968f\u673a\u663e\u793a${pickedTypes.length}\u79cd\u7c7b\u578b\u7684\u6218\u5229\u54c1\u7684\u54c1\u8d28`, typeRarityItems),
      systemCellRarityHint("random-z-rarity", `\u968f\u673a\u663e\u793a${randomZItems.length}\u4ef6\u6218\u5229\u54c1\u7684\u54c1\u8d28`, randomZItems),
      systemItemHint("rarity-outline", `\u663e\u793a\u6240\u6709${RARITY_LABELS[y]}\u8272\u6218\u5229\u54c1\u7684\u8f6e\u5ed3`, yItems, "item_outline_rarity"),
      systemNumberHint("rarity-avg-value", `${RARITY_LABELS[y]}\u8272\u6218\u5229\u54c1\u7684\u5e73\u5747\u4ef7\u503c\u662f${averageValue(yItems)}`),
    ];
  }

  endRound() {
    if (this.finished) return;
    const roundIndex = this.round - 1;
    if (this.endedRounds.has(roundIndex)) return;
    this.endedRounds.add(roundIndex);
    clearTimeout(this.roundTimer);
    for (const player of this.players) {
      if (!player.submitted[roundIndex]) player.bids[roundIndex] = 0;
      player.submitted[roundIndex] = true;
    }

    this.applyMegumiRoundEndForAll(roundIndex);
    const result = this.evaluateWinner(roundIndex);
    this.applyRoundEndCharacterProps(roundIndex);
    const roundEndAnimations = this.roundEndAnimations(roundIndex);
    const roundEndPauseMs = INTERMISSION_MS + roundEndAnimations.reduce((sum, animation) => sum + Math.ceil(Number(animation.durationSeconds || 0) * 1000), 0);
    for (const player of this.players) player.publicRound = this.round + 1;
    this.broadcast({
      type: "round_end",
      body: {
        round: this.round,
        bids: this.players.map((player) => ({
          playerId: player.id,
          bid: player.bids[roundIndex],
          usedProp: player.usedProps[roundIndex],
        })),
        winnerId: result.winnerId,
        finished: result.finished,
        passed: !result.finished,
        pauseSeconds: Math.ceil(roundEndPauseMs / 1000),
        animations: roundEndAnimations,
      },
    });

    if (result.finished || this.round >= ROUND_COUNT) {
      clearTimeout(this.intermissionTimer);
      this.intermissionTimer = setTimeout(() => this.finishGame(result.winnerId), roundEndPauseMs);
      this.intermissionTimer.unref?.();
      return;
    }

    clearTimeout(this.intermissionTimer);
    this.intermissionTimer = setTimeout(() => this.startRound(this.round + 1), roundEndPauseMs);
    this.intermissionTimer.unref?.();
  }

  roundEndAnimations(roundIndex) {
    if (roundIndex !== 3) return [];
    const triggered = this.players.filter((player) => (
      player.characterId === "character_14"
      && [0, 1, 2].every((index) => (player.bids[index] || 0) === 0)
    ));
    return triggered.map((_, index) => ({
      id: 5,
      delaySeconds: index === 0 ? Math.ceil(INTERMISSION_MS / 1000) : 0,
      durationSeconds: ANIMATION_SECONDS[5],
    }));
  }

  handleMessage(player, buffer) {
    player.lastSeen = Date.now();
    const text = decodeWsText(buffer);
    if (!text) {
      this.markDisconnected(player);
      return;
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.send(player, { type: "error", message: "角色技能执行失败" });
      return;
    }
    if (message.type === "heartbeat") return;

    if (message.type === "settlement_sell") {
      this.sellSettlementItems(player, message.mode, message);
      return;
    }

    if (message.type === "return_room") {
      if (!this.roomCompleted) {
        this.roomCompleted = true;
        this.onFinish?.(this.players);
      }
      this.send(player, { type: "return_room", body: { url: `/room?playerId=${encodeURIComponent(player.id)}` } });
      return;
    }

    if (this.finished) return;

    if (message.type === "bid") {
      this.receiveBid(player, message.amount);
      return;
    }

    if (message.type === "use_prop") {
      this.useProp(player, Number(message.slot), message.target);
      return;
    }

    if (message.type === "megumi_choice") {
      this.receiveMegumiChoice(player, message.choice);
      return;
    }

    if (message.type === "megumi_prediction") {
      this.receiveMegumiPrediction(player, message.predictions);
      return;
    }

    if (message.type === "reiner_transform") {
      this.receiveReinerTransform(player);
      return;
    }

  }

  receiveBid(player, amount) {
    if (this.roundPaused) return;
    const roundIndex = this.round - 1;
    if (this.actionLockedPlayerIds.has(player.id)) return;
    if (roundIndex < 0 || roundIndex >= ROUND_COUNT || player.submitted[roundIndex]) return;
    const bid = Math.max(0, Math.floor(Number(amount) || 0));
    player.bids[roundIndex] = bid;
    player.submitted[roundIndex] = true;
    this.broadcast({ type: "bid_submitted", body: { playerId: player.id, round: this.round } });
    this.broadcastPublicState({ clearBidState: false });
    if (this.players.every((entry) => entry.submitted[roundIndex] || entry.disconnected)) this.endRound();
  }

  useProp(player, slot, target = null) {
    if (this.roundPaused) return;
    const roundIndex = this.round - 1;
    if (this.actionLockedPlayerIds.has(player.id)) {
      this.send(player, { type: "error", message: "本回合无法使用道具" });
      return;
    }
    if (!Number.isInteger(slot) || slot < 0 || slot >= 5) {
      this.send(player, { type: "error", message: "角色技能执行失败" });
      return;
    }
    if (player.propUsesThisRound >= maxPropUsesFor(player)) {
      this.send(player, { type: "error", message: "角色技能执行失败" });
      return;
    }
    if (player.submitted[roundIndex]) {
      this.send(player, { type: "error", message: "角色技能执行失败" });
      return;
    }
    const selected = player.props[slot];
    if (!selected) {
      this.send(player, { type: "error", message: "角色技能执行失败" });
      return;
    }

    let hint = null;
    if (isSpecialProp(selected.id)) {
      hint = this.useSpecialProp(player, selected, normalizeTarget(target));
    } else {
      const prop = createProp(selected.id, this.propDefinitions.get(selected.id), selected.level);
      hint = prop.use({
        warehouse: this.warehouse,
        viewNumber: player.gameIndex,
        view: this.warehouse.getView(player.gameIndex),
        random: this.random,
      });
    }

    player.propUsesThisRound += 1;
    player.usedProps[roundIndex] = selected;
    player.props[slot] = null;
    if (player.characterId === "character_17") this.tryGrantPendingExclusive(player);
    this.send(player, { type: "prop_slots", body: { props: player.props, uses: player.propUsesThisRound, maxUses: maxPropUsesFor(player) } });
    if (hint) hint.icon = this.allPropDefinitions.get(selected.id)?.image || "";
    this.send(player, hint);
  }

  useSpecialProp(player, selected, target) {
    if (selected.id === "sp_prop1") return this.useTntProp(player, target);
    if (selected.id === "sp_prop2") return this.useCopyProp(player, target);
    if (selected.id === "sp_prop3") return this.useMoonProp(player, target);
    return { type: "hint", title: `\u9053\u5177\u3010${selected.id}\u3011`, text: "\u8be5\u4e13\u5c5e\u9053\u5177\u5c1a\u672a\u5b9e\u73b0", show: false, message: [] };
  }

  receiveReinerTransform(player) {
    if (player.characterId !== "character_22") return;
    if (this.roundPaused || this.actionLockedPlayerIds.has(player.id)) return;
    if (player.characterState.reinerTransformed) return;
    const roundIndex = this.round - 1;
    if (roundIndex < 0 || player.submitted[roundIndex]) return;
    const remaining = Math.max(0, this.roundEndsAt - Date.now());
    if (remaining <= this.currentRoundDurationMs / 2) {
      this.send(player, { type: "error", message: "已超过本回合前半段，无法变身" });
      return;
    }

    player.characterState.reinerTransformed = true;
    player.characterState.reinerTransformRound = this.round;
    player.characterState.reinerChairCount = Number(player.characterState.reinerChairCount || 0);
    const largeEntries = realItemEntries(this.warehouse).filter(({ item }) => itemCells(item) > 9);
    const highestValue = largeEntries.reduce((best, entry) => {
      if (!best) return entry;
      const price = Number(entry.item.price || 0);
      const bestPrice = Number(best.item.price || 0);
      return price > bestPrice ? entry : best;
    }, null);
    const rawHints = largeEntries.map(({ index }) => ({ type: "item_outline", itemIndex: index }));
    const publicHints = highestValue ? [{ type: "item_full", itemIndex: highestValue.index }] : [];

    this.pauseRoundTime({
      seconds: ANIMATION_SECONDS[6] + ANIMATION_SECONDS[7],
      animations: [
        { id: 6, durationSeconds: ANIMATION_SECONDS[6] },
        { id: 7, durationSeconds: ANIMATION_SECONDS[7] },
      ],
    });

    const privateMessage = rawHints.map((hint) => this.warehouse.addHint(player.gameIndex, hint));
    this.send(player, {
      type: "hint",
      title: "\u89d2\u8272\u6280\u80fd",
      text: "Reiner变身铠之巨人，显示所有占格数大于9的战利品轮廓。",
      icon: this.characterDefinitions.get(player.characterId)?.image || "",
      show: privateMessage.length > 0,
      message: privateMessage,
    });
    for (const target of this.players) {
      const message = publicHints.map((hint) => this.warehouse.addHint(target.gameIndex, hint));
      this.send(target, {
        type: "hint",
        title: "\u89d2\u8272\u6280\u80fd",
        text: `Reiner玩家${player.nickname}变身铠之巨人，向全体揭示一件高价值物品`,
        icon: this.characterDefinitions.get(player.characterId)?.image || "",
        show: message.length > 0,
        message,
      });
    }
    this.broadcastPublicState({ clearBidState: false });
  }

  applyRoundStartCharacterProps(player, round) {
    if (player.characterId === "character_17") this.tryGrantPendingExclusive(player);
    if (player.characterId === "character_18" && round % 2 === 1 && !player.props.some((prop) => prop?.id === "sp_prop2")) {
      const candidates = player.props.map((prop, slot) => ({ prop, slot })).filter(({ prop }) => prop && !prop.exclusive);
      if (candidates.length) {
        const picked = candidates[Math.floor(this.random() * candidates.length)];
        player.props[picked.slot] = makeTemporaryProp("sp_prop2", this.allPropDefinitions.get("sp_prop2"), { exclusive: true });
        this.send(player, characterTextHint(`\u5947\u6570\u56de\u5408\u5f00\u59cb\uff0c\u5c06\u9053\u5177\u3010${this.allPropDefinitions.get(picked.prop.id)?.name || picked.prop.id}\u3011\u66ff\u6362\u4e3a\u4e34\u65f6\u4e13\u5c5e\u9053\u5177\u3010\u590d\u5236\u673a\u3011\u3002`, this.characterDefinitions.get(player.characterId)?.image));
        this.send(player, { type: "prop_slots", body: { props: player.props, uses: player.propUsesThisRound || 0, maxUses: maxPropUsesFor(player) } });
      } else {
        this.send(player, characterTextHint("\u5947\u6570\u56de\u5408\u5f00\u59cb\uff0c\u4f46\u6ca1\u6709\u53ef\u66ff\u6362\u7684\u666e\u901a\u9053\u5177\u3002", this.characterDefinitions.get(player.characterId)?.image));
      }
    }
    if (player.characterId === "character_20" && !player.characterState.madeInHeaven && !player.props.some((prop) => prop?.id === "sp_prop3")) {
      const slot = firstEmptyPropSlot(player);
      if (slot >= 0) {
        player.props[slot] = makeTemporaryProp("sp_prop3", this.allPropDefinitions.get("sp_prop3"), { exclusive: true });
        this.send(player, characterTextHint("获得临时专属道具【新月】。", this.characterDefinitions.get(player.characterId)?.image));
        this.send(player, { type: "prop_slots", body: { props: player.props, uses: player.propUsesThisRound || 0, maxUses: maxPropUsesFor(player) } });
      }
    }
  }

  applyRoundStartDomains(round) {
    if (round !== 5) return;
    const activeDomains = [];
    for (const player of this.players) {
      player.characterState.ryoiki = false;
      if (player.characterId === "character_14" && this.shouldTriggerSukunaDomain(player)) {
        player.characterState.ryoiki = true;
        activeDomains.push({ source: player, type: "sukuna", name: "伏魔御厨子" });
      }
      if (player.characterId === "character_15" && player.characterState.gojoPurpleTriggered) {
        player.characterState.ryoiki = true;
        activeDomains.push({ source: player, type: "gojo", name: "无量空处" });
      }
    }
    if (!activeDomains.length) return;
    const gojoCount = activeDomains.filter((domain) => domain.type === "gojo").length;
    const sukunaCount = activeDomains.filter((domain) => domain.type === "sukuna").length;
    if (gojoCount > 0 && sukunaCount > 0) {
      this.roundFiveDomainClash = {
        gojoIds: activeDomains.filter((domain) => domain.type === "gojo").map((domain) => domain.source.id),
        sukunaIds: activeDomains.filter((domain) => domain.type === "sukuna").map((domain) => domain.source.id),
      };
    }
    if (gojoCount > 0 && sukunaCount > 0) {
      this.roundStartAnimations = [{ id: 10, durationSeconds: ANIMATION_SECONDS[10] }];
    } else if (gojoCount > 0) {
      this.roundStartAnimations = Array.from({ length: gojoCount }, () => ({ id: 8, durationSeconds: ANIMATION_SECONDS[8] }));
    } else if (sukunaCount > 0) {
      this.roundStartAnimations = Array.from({ length: sukunaCount }, () => ({ id: 9, durationSeconds: ANIMATION_SECONDS[9] }));
    }

    for (const domain of activeDomains) {
      this.deferRoundStartCharacterTextToAll(domain.source, `触发【${domain.name}】。`);
    }

    for (const domain of activeDomains) {
      for (const target of this.players) {
        if (target.id === domain.source.id) continue;
        if (target.characterState.ryoiki) {
          this.deferRoundStartPayload(target, characterTextHint(`抵消了${domain.source.nickname}玩家的领域【${domain.name}】的效果。`, this.characterDefinitions.get(target.characterId)?.image));
          continue;
        }
        if (domain.type === "sukuna") this.applySukunaDomainEffect(domain.source, target, round);
        if (domain.type === "gojo") this.applyGojoDomainEffect(domain.source, target, round);
      }
    }
  }

  shouldTriggerSukunaDomain(player) {
    const view = this.warehouse.getView(player.gameIndex);
    const items = realItemEntries(this.warehouse);
    const knownCount = items.filter(({ item }) => itemOutlineKnown(view, item) || itemRarityKnown(view, item) || itemFullInfoKnown(view, item)).length;
    return knownCount >= Math.ceil(items.length * 2 / 3);
  }

  applySukunaDomainEffect(source, target, round) {
    const occupiedSlots = target.props.map((prop, slot) => ({ prop, slot })).filter(({ prop }) => prop);
    const removeCount = Math.ceil(occupiedSlots.length / 2);
    for (const entry of sample(occupiedSlots, removeCount, this.random)) target.props[entry.slot] = null;
    if (!target.characterState.domainBidMultiplier) target.characterState.domainBidMultiplier = {};
    target.characterState.domainBidMultiplier[round - 1] = Number(target.characterState.domainBidMultiplier[round - 1] || 1) * 0.8;
    this.send(target, { type: "prop_slots", body: { props: target.props, uses: target.propUsesThisRound || 0, maxUses: maxPropUsesFor(target) } });
    this.deferRoundStartPayload(target, characterTextHint(`受到${source.nickname}玩家的领域【伏魔御厨子】的效果。`, this.characterDefinitions.get(source.characterId)?.image));
  }

  applyGojoDomainEffect(source, target, round) {
    const roundIndex = round - 1;
    const previousBid = target.bids[roundIndex - 1] || 0;
    target.bids[roundIndex] = previousBid;
    target.submitted[roundIndex] = true;
    this.actionLockedPlayerIds.add(target.id);
    this.deferRoundStartPayload(target, characterTextHint(`受到${source.nickname}玩家的领域【无量空处】的效果。`, this.characterDefinitions.get(source.characterId)?.image));
  }

  applyRoundEndCharacterProps(roundIndex) {
    for (const player of this.players) {
      if (player.characterId === "character_17") this.applyCreeperRoundEnd(player, roundIndex);
      if (player.characterId === "character_16") this.applyLuxunRoundEnd(player, roundIndex);
      if (player.characterId === "character_19") this.applyRaidCapRoundEnd(player, roundIndex);
      if (player.characterId === "character_22") this.applyReinerRoundEnd(player, roundIndex);
    }
  }

  applyReinerRoundEnd(player, roundIndex) {
    if (!player.characterState.reinerTransformed) return;
    const ownBid = player.bids[roundIndex] || 0;
    const higherCount = this.players.filter((entry) => entry.id !== player.id && (entry.bids[roundIndex] || 0) > ownBid).length;
    if (higherCount > 0) {
      player.characterState.reinerChairCount = Number(player.characterState.reinerChairCount || 0) + higherCount;
    }
  }

  applyMegumiRoundEndForAll(roundIndex) {
    for (const player of this.players) {
      if (player.characterId === "character_21") this.applyMegumiRoundEnd(player, roundIndex);
    }
  }

  applyCreeperRoundEnd(player, roundIndex) {
    const ownBid = player.bids[roundIndex] || 0;
    if (ownBid <= 0) return;
    const matched = this.players.some((entry) => entry.id !== player.id && (entry.bids[roundIndex] || 0) >= ownBid * 0.9 && (entry.bids[roundIndex] || 0) <= ownBid * 1.1);
    if (!matched) return;
    if (!player.characterState.creeperMatchedRounds) player.characterState.creeperMatchedRounds = [];
    if (player.characterState.creeperMatchedRounds.includes(roundIndex)) return;
    player.characterState.creeperMatchedRounds.push(roundIndex);
    player.characterState.creeperMatches = (player.characterState.creeperMatches || 0) + 1;
    const progress = player.characterState.creeperMatches % 2 || 2;
    this.send(player, characterTextHint(`\u76f8\u8fd1\u51fa\u4ef7\u6761\u4ef6\u8fbe\u6210\uff0c\u8fdb\u5ea6 ${progress}/2\u3002`, this.characterDefinitions.get(player.characterId)?.image));
    const deserved = Math.floor(player.characterState.creeperMatches / 2);
    const granted = player.characterState.creeperGranted || 0;
    for (let i = granted; i < deserved; i += 1) player.pendingExclusiveProps.push("sp_prop1");
    player.characterState.creeperGranted = deserved;
  }

  applyLuxunRoundEnd(player, roundIndex) {
    if (roundIndex <= 0) return;
    const bid = player.bids[roundIndex] || 0;
    const previous = player.bids[roundIndex - 1] || 0;
    if (bid !== previous) {
      player.characterState.luxunChain = 1;
      return;
    }
    player.characterState.luxunChain = (player.characterState.luxunChain || 1) + 1;
    const count = player.characterState.luxunChain;
    const pool = [...this.propDefinitions.keys()];
    let granted = 0;
    for (let i = 0; i < count; i += 1) {
      const slot = firstEmptyPropSlot(player);
      if (slot < 0 || !pool.length) break;
      const id = pool[Math.floor(this.random() * pool.length)];
      player.props[slot] = makeTemporaryProp(id, this.propDefinitions.get(id));
      granted += 1;
    }
    if (granted > 0) this.send(player, characterTextHint(`\u8fde\u7eed\u51fa\u4ef7\u76f8\u540c\uff0c\u83b7\u5f97 ${granted} \u4ef6\u4e34\u65f6\u9053\u5177\u3002`, this.characterDefinitions.get(player.characterId)?.image));
    this.send(player, { type: "prop_slots", body: { props: player.props, uses: player.propUsesThisRound || 0, maxUses: maxPropUsesFor(player) } });
  }

  applyRaidCapRoundEnd(player, roundIndex) {
    player.characterState.omenActive = {};
    const ownBid = player.bids[roundIndex] || 0;
    const allBids = this.players.map((entry) => entry.bids[roundIndex] || 0);
    if (ownBid <= Math.min(...allBids)) return;
    for (const target of this.players) {
      if (target.id === player.id) continue;
      if ((target.bids[roundIndex] || 0) <= ownBid) continue;
      const state = player.characterState;
      state.omenTotalByPlayer[target.id] = (state.omenTotalByPlayer[target.id] || 0) + 1;
      state.omenActive[target.id] = state.omenTotalByPlayer[target.id];
      this.send(target, characterTextHint(`受到 RaidCap 的不详之兆影响，下回合竞价出价视为减少 ${state.omenActive[target.id] * 5}%。`, this.characterDefinitions.get(player.characterId)?.image));
    }
  }

  sendRoundStartChoiceRequests(round) {
    for (const player of this.players) {
      if (player.characterId !== "character_21" || player.disconnected) continue;
      if (this.actionLockedPlayerIds.has(player.id)) continue;
      if (round === 2 && !player.characterState.megumiMode) {
        this.send(player, {
          type: "megumi_choice_request",
          body: { round, text: "请选择本局技能路线。", canChooseDomain: this.players.length >= 3 },
        });
      } else if (round >= 2 && player.characterState.megumiMode === "makora") {
        this.sendMegumiPredictionAvailable(player);
      }
    }
  }

  receiveMegumiChoice(player, choice) {
    if (player.characterId !== "character_21" || this.round < 2 || player.characterState.megumiMode) return;
    const normalized = choice === "makora" ? "makora" : "domain";
    if (normalized === "domain" && this.players.length < 3) {
      this.send(player, { type: "error", message: "本局玩家少于3人，不能选择领域展开" });
      return;
    }
    player.characterState.megumiMode = normalized;
    if (normalized === "makora") {
      this.pauseRoundTime({ seconds: ANIMATION_SECONDS[1], animations: [{ id: 1, durationSeconds: ANIMATION_SECONDS[1] }] });
    } else {
      this.pauseRoundTime({ seconds: ANIMATION_SECONDS[3], animations: [{ id: 3, durationSeconds: ANIMATION_SECONDS[3] }] });
    }
    const text = normalized === "domain"
      ? `Megumi玩家${player.nickname}选择了领域展开：嵌合暗翳庭`
      : `Megumi玩家${player.nickname}选择了跟你爆了：召唤魔虚罗Makora`;
    this.broadcastCharacterText(player, text);
    this.broadcastPublicState({ clearBidState: false });
    if (normalized === "makora") this.sendMegumiPredictionAvailable(player);
  }

  sendMegumiPredictionAvailable(player) {
    const previousRoundIndex = Math.max(0, this.round - 2);
    const targets = this.players
      .filter((entry) => entry.id !== player.id)
      .map((entry) => ({ id: entry.id, nickname: entry.nickname, lastBid: entry.bids[previousRoundIndex] || 0 }));
    if (!player.characterState.megumiPredictions[this.round]) {
      player.characterState.megumiPredictions[this.round] = Object.fromEntries(targets.map((target) => [target.id, "equal"]));
    }
    this.send(player, { type: "megumi_prediction_available", body: { round: this.round, players: targets } });
  }

  receiveMegumiPrediction(player, predictions) {
    if (player.characterId !== "character_21" || player.characterState.megumiMode !== "makora") return;
    if (this.roundPaused) return;
    if (this.actionLockedPlayerIds.has(player.id)) return;
    if (player.submitted?.[this.round - 1]) return;
    const normalized = {};
    for (const target of this.players) {
      if (target.id === player.id) continue;
      const value = predictions?.[target.id];
      normalized[target.id] = value === "up" || value === "down" ? value : "equal";
    }
    player.characterState.megumiPredictions[this.round] = normalized;
    this.send(player, characterTextHint("本回合预测已提交。", this.characterDefinitions.get(player.characterId)?.image));
  }

  applyMegumiRoundEnd(player, roundIndex) {
    if (roundIndex < 1) return;
    if (!player.characterState.megumiMode) {
      player.characterState.megumiMode = "blank";
      this.broadcastCharacterText(player, `Megumi玩家${player.nickname}选择了摆烂：已经。。。无所谓了。`);
      return;
    }
    if (player.characterState.megumiMode !== "makora") return;
    const previousRoundIndex = Math.max(0, roundIndex - 1);
    const predictions = player.characterState.megumiPredictions[this.round] || {};
    const correctTargets = [];
    for (const target of this.players) {
      if (target.id === player.id) continue;
      const previous = target.bids[previousRoundIndex] || 0;
      const current = target.bids[roundIndex] || 0;
      const actual = current > previous ? "up" : current < previous ? "down" : "equal";
      if ((predictions[target.id] || "equal") !== actual) continue;
      this.advantages.add(player.id, target.id, 0.05);
      correctTargets.push(target);
      this.send(target, characterTextHint(`Makora玩家${player.nickname}对你进一步适应了。`, "/resource/characters/Makora.png"));
    }
    if (correctTargets.length) {
      this.send(player, characterTextHint(`对${correctTargets.map((target) => target.nickname).join("，")}玩家积累了5%的优势。`, "/resource/characters/Makora.png"));
    }
  }

  broadcastCharacterText(player, text) {
    for (const target of this.players) {
      this.send(target, characterTextHint(text, this.characterDefinitions.get(player.characterId)?.image));
    }
  }

  deferRoundStartPayload(player, payload) {
    if (!this.deferredRoundStartPayloads) this.deferredRoundStartPayloads = [];
    this.deferredRoundStartPayloads.push({ player, payload });
  }

  deferRoundStartCharacterTextToAll(player, text) {
    for (const target of this.players) {
      this.deferRoundStartPayload(target, characterTextHint(text, this.characterDefinitions.get(player.characterId)?.image));
    }
  }

  tryGrantPendingExclusive(player) {
    while (player.pendingExclusiveProps.length) {
      const slot = firstEmptyPropSlot(player);
      if (slot < 0) return;
      const id = player.pendingExclusiveProps.shift();
      player.props[slot] = makeTemporaryProp(id, this.allPropDefinitions.get(id), { exclusive: true });
      this.send(player, characterTextHint("\u7d2f\u8ba1\u6ee1\u8db3\u6761\u4ef6\uff0c\u83b7\u5f97\u4e34\u65f6\u4e13\u5c5e\u9053\u5177\u3010TNT\u3011\u3002", this.characterDefinitions.get(player.characterId)?.image));
    }
    this.send(player, { type: "prop_slots", body: { props: player.props, uses: player.propUsesThisRound || 0, maxUses: maxPropUsesFor(player) } });
  }

  useTntProp(player, target) {
    const radius = Math.max(1, this.round || 1);
    const indexes = new Set();
    for (let y = 0; y < this.warehouse.maxRows; y += 1) {
      for (let x = 0; x < this.warehouse.width; x += 1) {
        if (Math.abs(x - target.x) + Math.abs(y - target.y) > radius) continue;
        const index = this.warehouse.getIndexAt(x, y);
        if (index > 0 && !itemFullInfoKnown(this.warehouse.getView(player.gameIndex), this.warehouse.getItemByIndex(index))) indexes.add(index);
      }
    }
    const message = [...indexes].map((itemIndex) => this.warehouse.addHint(player.gameIndex, { type: "item_full", itemIndex }));
    return {
      type: "hint",
      title: "\u9053\u5177\u3010TNT\u3011",
      text: `\u663e\u793a\u76ee\u6807\u683c\u66fc\u54c8\u987f\u8ddd\u79bb ${radius} \u4ee5\u5185\u7684\u6218\u5229\u54c1`,
      show: message.length > 0,
      message,
    };
  }

  useCopyProp(player, target) {
    const view = this.warehouse.getView(player.gameIndex);
    if (cellHasDirectKnownInfo(view, target.x, target.y)) {
      return { type: "hint", title: "\u9053\u5177\u3010\u590d\u5236\u673a\u3011", text: "\u590d\u5236\u5931\u8d25\uff1a\u8be5\u683c\u5df2\u6709\u4fe1\u606f", show: false, message: [] };
    }
    const itemIndex = this.warehouse.getIndexAt(target.x, target.y);
    if (!itemIndex) {
      return { type: "hint", title: "\u9053\u5177\u3010\u590d\u5236\u673a\u3011", text: "\u590d\u5236\u5931\u8d25\uff1a\u8be5\u683c\u6ca1\u6709\u7269\u54c1", show: false, message: [] };
    }
    const item = this.warehouse.getItemByIndex(itemIndex);
    player.copiedItems.push({ itemId: item.id, itemIndex, item: { ...item }, nickname: player.nickname, playerId: player.id });
    return { type: "hint", title: "\u9053\u5177\u3010\u590d\u5236\u673a\u3011", text: "\u590d\u5236\u6210\u529f\uff0c\u5c06\u4e8e\u7ed3\u7b97\u9636\u6bb5\u63ed\u793a", show: false, message: [] };
  }

  useMoonProp(player, target) {
    const itemIndex = this.warehouse.getIndexAt(target.x, target.y);
    if (!itemIndex) {
      const neighborIndexes = new Set();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = Number(target.x) + dx;
        const ny = Number(target.y) + dy;
        if (nx < 0 || nx >= this.warehouse.width || ny < 0 || ny >= this.warehouse.maxRows) continue;
        const neighborIndex = this.warehouse.getIndexAt(nx, ny);
        if (neighborIndex > 0) neighborIndexes.add(neighborIndex);
      }
      const message = [...neighborIndexes].map((neighborIndex) => this.warehouse.addHint(player.gameIndex, { type: "item_outline", itemIndex: neighborIndex }));
      return { type: "hint", title: "道具【新月】", text: "选定位置没有战利品，已尝试显示相邻战利品轮廓。", show: message.length > 0, message };
    }

    const selectedItem = this.warehouse.getItemByIndex(itemIndex);
    const rawHints = [{ type: "item_full", itemIndex }];
    for (const neighborIndex of this.neighborItemIndexes(itemIndex)) rawHints.push({ type: "item_outline", itemIndex: neighborIndex });
    const message = rawHints.map((hint) => this.warehouse.addHint(player.gameIndex, hint));

    let text = `显示了【${selectedItem.name}】以及相邻战利品的轮廓。`;
    if (player.characterId === "character_20" && !player.characterState.madeInHeaven) {
      if (Number(player.characterState.pucciTargetIndex) === Number(itemIndex)) {
        player.characterState.madeInHeaven = true;
        text += " 目标定位成功，【天堂制造】开始。";
        this.applyMadeInHeavenTimingShift();
      } else {
        text += " 选定位置错误。";
      }
    }

    return { type: "hint", title: "道具【新月】", text, show: message.length > 0, message };
  }

  neighborItemIndexes(itemIndex) {
    const source = this.warehouse.getItemByIndex(itemIndex);
    if (!source) return [];
    const result = [];
    for (let index = 1; index < this.warehouse.items.length; index += 1) {
      if (index === itemIndex) continue;
      const item = this.warehouse.getItemByIndex(index);
      if (itemsShareEdge(source, item)) result.push(index);
    }
    return result;
  }

  applyMadeInHeavenTimingShift() {
    if (!this.roundEndsAt || this.finished) return;
    const remaining = Math.max(0, this.roundEndsAt - Date.now());
    const adjustedRemaining = Math.ceil(remaining * 0.5);
    const pauseSeconds = ANIMATION_SECONDS[2] + ANIMATION_SECONDS[4];
    this.broadcast({ type: "timer_style", body: { madeInHeaven: true } });
    this.pauseRoundTime({
      seconds: pauseSeconds,
      animations: [
        { id: 2, durationSeconds: ANIMATION_SECONDS[2] },
        { id: 4, durationSeconds: ANIMATION_SECONDS[4] },
      ],
      resumeRemainingMs: adjustedRemaining,
    });
  }

  finishGame(winnerId) {
    this.finished = true;
    this.settlementOpen = true;
    for (const player of this.players) clearTimeout(player.disconnectTimer);
    clearTimeout(this.roundTimer);
    clearTimeout(this.intermissionTimer);
    clearTimeout(this.pauseTimer);
    clearInterval(this.heartbeatTimer);

    const warehouseItems = this.warehouse.getSerializableItems();
    const winner = winnerId ? this.players.find((player) => player.id === winnerId) : null;
    const chairReplacement = winner ? this.createChairReplacement(winner, warehouseItems) : null;
    const actualWarehouseItems = chairReplacement?.warehouseItems || warehouseItems;
    const publicTotalValue = warehouseItems.reduce((sum, item) => sum + Number(item.price || 0), 0);
    const actualTotalValue = actualWarehouseItems.reduce((sum, item) => sum + Number(item.price || 0), 0);
    this.lastWinnerId = winner?.id || null;
    const finalBid = winner ? lastBidFor(winner) : 0;
    this.logFinalBidModifiers(this.round - 1);
    const finalProfit = winner ? actualTotalValue - finalBid : 0;
    const dividend = winner && finalProfit < 0 ? Math.ceil(Math.abs(finalProfit) * Math.max(0, this.dividendRatio)) : 0;
    this.wonItemCounts = winner ? countItems(actualWarehouseItems) : {};
    const extraRewardsByPlayer = new Map(this.players.map((player) => [player.id, []]));
    const lotteryCountsBefore = new Map(this.players.map((player) => [player.id, lotteryItemCount(player.profile, this.lotteryConsumableIds)]));
    this.applyFinishAchievements({
      winner,
      winnerId,
      finalBid,
      finalProfit,
      chairReplacement,
      roundIndex: this.round - 1,
    });

    for (const player of this.players) {
      for (let index = 0; index < player.props.length; index += 1) {
        const prop = player.props[index];
        if (!prop) continue;
        const used = player.usedProps.some((entry) => entry && entry.id === prop.id && entry.slot === index);
        if (!used && !prop.temporary && !prop.exclusive) player.profile.warehouse.props[prop.id] = (player.profile.warehouse.props[prop.id] || 0) + 1;
      }
      for (const copied of player.copiedItems) {
        const key = String(copied.itemId);
        if (!player.profile.warehouse.items[key]) player.profile.warehouse.items[key] = { count: 0, collected: false };
        player.profile.warehouse.items[key].count += 1;
      }
      if (player.usedProps.some(Boolean)) {
        addProfileItem(player.profile, PROP_USE_REWARD_ITEM_ID, 1);
        extraRewardsByPlayer.get(player.id).push(rewardItem(this.itemsById, PROP_USE_REWARD_ITEM_ID));
      }
      if (dividend > 0) addMoney(player.profile, dividend);
      saveProfileByNickname(this.rootDir, player.profile);
    }

    if (winner) {
      deductMoneyAllowDebt(winner.profile, finalBid);
      addWarehouseItemsToProfile(winner.profile, actualWarehouseItems);
      addProfileItem(winner.profile, WINNER_REWARD_ITEM_ID, 1);
      extraRewardsByPlayer.get(winner.id).push(rewardItem(this.itemsById, WINNER_REWARD_ITEM_ID));
      saveProfileByNickname(this.rootDir, winner.profile);
    }

    for (const player of this.players) {
      const produced = runProduction(player.profile, this.productionRecipes, this.random);
      if (produced) setWarehouseNotification(player.profile, "production", true);
      if (lotteryItemCount(player.profile, this.lotteryConsumableIds) > (lotteryCountsBefore.get(player.id) || 0)) {
        setWarehouseNotification(player.profile, "lottery", true);
      }
      saveProfileByNickname(this.rootDir, player.profile);
    }

    this.broadcast({
      type: "game_over",
      body: {
        winnerId,
        totalValue: publicTotalValue,
        actualTotalValue,
        actualProfit: finalProfit,
        finalBid,
        dividend,
        warehouseItems,
        players: this.players.map((player) => publicPlayer(player)),
        winner: winner ? publicPlayer(winner) : null,
        favoritesByPlayer: Object.fromEntries(this.players.map((player) => [player.id, favoriteIds(player.profile)])),
        copiedItems: this.players.flatMap((player) => player.copiedItems.map((entry) => ({ ...entry, nickname: player.nickname }))),
        chairReplacement: chairReplacement ? {
          nickname: winner.nickname,
          delta: chairReplacement.delta,
          replacedItems: chairReplacement.replacedItems,
          chairItem: chairReplacement.chairItem,
        } : null,
        extraRewardsByPlayer: Object.fromEntries(extraRewardsByPlayer),
      },
    });
  }

  applyFinishAchievements({ winner, winnerId, finalBid, finalProfit, chairReplacement, roundIndex }) {
    if (!this.achievements.length) return;
    for (const player of this.players) normalizeAchievementState(player.profile, this.achievements);
    const winnerIsSukunaDomain = Boolean(winnerId && this.roundFiveDomainClash?.sukunaIds?.includes(winnerId));
    const winnerIsGojoDomain = Boolean(winnerId && this.roundFiveDomainClash?.gojoIds?.includes(winnerId));
    const hasDomainClash = Boolean(this.roundFiveDomainClash?.gojoIds?.length && this.roundFiveDomainClash?.sukunaIds?.length);

    for (const player of this.players) {
      if (winner && player.id === winner.id && this.round === 1 && finalProfit > 0) this.awardAchievement(player, "1");
      if (this.playerKnowsAllItems(player)) this.awardAchievement(player, "2");
      if (winner && player.id === winner.id && this.isMinusOneLoss(winner, roundIndex)) this.awardAchievement(player, "3");
      if (winner && player.id === winner.id && this.isMultiplierRequired(winner, roundIndex)) this.awardAchievement(player, "4");

      if (hasDomainClash && player.characterId === "character_15") {
        if (winnerIsSukunaDomain) this.awardAchievement(player, "5");
        if (player.id === winnerId) this.awardAchievement(player, "6");
        if (winnerIsGojoDomain) this.awardAchievement(player, "7");
      }
      if (hasDomainClash && player.characterId === "character_14" && player.id === winnerId) this.awardAchievement(player, "8");

      if (
        winner
        && player.id === winner.id
        && player.characterId === "character_22"
        && player.characterState.reinerTransformed
        && Number(player.characterState.reinerTransformRound) === this.round
        && finalProfit > 0
      ) {
        this.awardAchievement(player, "9");
      }
      if (
        winner
        && player.id === winner.id
        && player.characterId === "character_22"
        && player.characterState.reinerTransformed
        && (chairReplacement?.replacedItems?.length || 0) > 5
      ) {
        this.awardAchievement(player, "10");
      }
    }
  }

  awardAchievement(player, id, amount = 1) {
    advanceAchievement(player.profile, this.achievements, id, amount);
  }

  playerKnowsAllItems(player) {
    const view = this.warehouse.getView(player.gameIndex);
    return realItemEntries(this.warehouse).every(({ index }) => itemIndexFullKnown(view, index));
  }

  isMinusOneLoss(winner, roundIndex) {
    if (!winner || (winner.bids[roundIndex] || 0) <= 0) return false;
    winner.bids[roundIndex] -= 1;
    try {
      return this.evaluateWinner(roundIndex).winnerId !== winner.id;
    } finally {
      winner.bids[roundIndex] += 1;
    }
  }

  isMultiplierRequired(winner, roundIndex) {
    if (!winner) return false;
    const actualWinner = this.evaluateWinner(roundIndex).winnerId;
    if (actualWinner !== winner.id) return false;
    const rawWinner = this.evaluateWinnerFromBids(roundIndex, this.players.map((player) => ({
      player,
      bid: player.bids[roundIndex] || 0,
    }))).winnerId;
    return rawWinner !== winner.id;
  }

  createChairReplacement(winner, publicWarehouseItems) {
    if (winner.characterId !== "character_22" || !winner.characterState.reinerTransformed) return null;
    const chairCount = Math.max(0, Math.floor(Number(winner.characterState.reinerChairCount || 0)));
    if (!chairCount) return null;
    const chairItem = this.itemsById.get(this.chairItemId);
    if (!chairItem) return null;
    const actual = publicWarehouseItems.map((item) => ({ ...item }));
    const candidates = actual
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item && item.id !== 0 && Number(item.id) !== Number(this.chairItemId));
    const picked = sample(candidates, Math.min(chairCount, candidates.length), this.random);
    const replacedItems = [];
    let delta = 0;
    for (const { item, index } of picked) {
      replacedItems.push({ ...item });
      delta += Number(chairItem.price || 0) - Number(item.price || 0);
      actual[index] = {
        ...item,
        ...chairItem,
        id: this.chairItemId,
        width: item.width,
        height: item.height,
        x: item.x,
        y: item.y,
      };
    }
    if (!replacedItems.length) return null;
    return {
      warehouseItems: actual,
      delta,
      replacedItems,
      chairItem: {
        id: this.chairItemId,
        name: chairItem.name || `#${this.chairItemId}`,
        price: Number(chairItem.price || 0),
        rarity: chairItem.rarity || "gray",
      },
    };
  }

  sellSettlementItems(player, mode, options = {}) {
    if (!this.settlementOpen) return;
    const winner = this.players.find((entry) => entry.id === this.lastWinnerId);
    if (winner && player.id !== winner.id) return this.send(player, { type: "error", message: "角色技能执行失败" });
    if (!Object.keys(this.wonItemCounts).length) return;
    const counts = {};
    const selectedRarities = new Set(Array.isArray(options.rarities) ? options.rarities : []);
    for (const [id, count] of Object.entries(this.wonItemCounts)) {
      if (mode === "unfavorite" && player.profile.warehouse.items[id]?.collected) continue;
      if (mode === "rarity" && !selectedRarities.has(this.itemsById.get(Number(id))?.rarity)) continue;
      counts[id] = count;
    }
    try {
      const result = sellProfileItemCounts(player.profile, counts, this.itemsById);
      for (const id of Object.keys(counts)) this.wonItemCounts[id] = 0;
      saveProfileByNickname(this.rootDir, player.profile);
      this.send(player, { type: "settlement_sell_result", body: result });
    } catch (error) {
      this.send(player, { type: "error", message: "角色技能执行失败" });
    }
  }

  sendInit(player) {
    this.send(player, {
      type: "game_init",
      body: {
        playerId: player.id,
        round: this.round || 1,
        warehouseName: this.container.name,
        money: player.profile.money,
        players: this.players.map((entry) => publicPlayer(entry)),
        carriedProps: player.props,
        propDefinitions: Object.fromEntries(this.allPropDefinitions),
        characterDefinitions: Object.fromEntries(this.characterDefinitions),
        maxPropUses: maxPropUsesFor(player),
        countdownSeconds: this.currentCountdownSeconds(),
        roundInitialSeconds: this.started ? this.clientCountdownSecondsFor(this.currentRoundDurationMs || ROUND_MS) : 0,
        actionLocked: this.actionLockedPlayerIds.has(player.id),
        madeInHeavenActive: this.players.some((entry) => entry.characterState.madeInHeaven),
        hints: this.warehouse.getView(player.gameIndex).hint,
      },
    });
    if (player.characterId === "character_21" && player.characterState.megumiMode === "makora" && this.round >= 2) {
      this.sendMegumiPredictionAvailable(player);
    }
  }

  emitCharacterStartHint(player) {
    try {
      if (player.characterId === "character_15") {
        this.emitGojoStartHint(player);
        return;
      }
      const character = createCharacter(player.characterId, this.characterDefinitions.get(player.characterId));
      const hints = character.onGameStart({
        warehouse: this.warehouse,
        viewNumber: player.gameIndex,
        view: this.warehouse.getView(player.gameIndex),
        random: this.random,
        round: this.round,
        player,
        players: this.players,
        state: player.characterState,
      });
      this.sendCharacterHints(player, hints);
    } catch (err) {
      logError("character start skill failed", err, { playerId: player.id, characterId: player.characterId, round: this.round });
      this.send(player, { type: "error", message: "角色技能执行失败" });
    }
  }

  emitCharacterRoundHint(player) {
    try {
      if (player.characterId === "character_20") {
        this.emitPucciTargetHint(player);
        return;
      }
      if (player.characterId === "character_15") {
        this.emitGojoRoundHint(player);
        return;
      }
      const character = createCharacter(player.characterId, this.characterDefinitions.get(player.characterId));
      const hints = character.onRoundStart({
        warehouse: this.warehouse,
        viewNumber: player.gameIndex,
        view: this.warehouse.getView(player.gameIndex),
        random: this.random,
        round: this.round,
        player,
        players: this.players,
        state: player.characterState,
      });
      this.sendCharacterHints(player, hints);
    } catch (err) {
      logError("character round skill failed", err, { playerId: player.id, characterId: player.characterId, round: this.round });
      this.send(player, { type: "error", message: "角色技能执行失败" });
    }
  }

  emitPucciTargetHint(player) {
    if (player.characterState.madeInHeaven) return;
    const target = this.warehouse.getItemByIndex(player.characterState.pucciTargetIndex);
    if (!target) return;
    const round = this.round;
    let text = "";
    if (round === 1) text = `目标战利品的类别包含: ${target.typeLabel || target.type || "未知"}`;
    else if (round === 2) text = `目标战利品高度为${target.height}格，宽度为${target.width}格`;
    else if (round === 3) text = `目标战利品品质为${RARITY_LABELS[target.rarity] || target.rarity}色`;
    else if (round === 4) text = `目标战利品名称为【${target.name}】`;
    else return;
    this.send(player, characterTextHint(text, this.characterDefinitions.get(player.characterId)?.image));
  }

  emitGojoStartHint(player) {
    player.characterState.gojoMode = "blue";
    player.characterState.gojoPurpleTriggered = false;
    const view = this.warehouse.getView(player.gameIndex);
    const candidates = realItemEntries(this.warehouse)
      .filter(({ item }) => item.rarity === "blue" && !itemFullInfoKnown(view, item))
      .map(({ index }) => index);
    const [itemIndex] = sample(candidates, 1, this.random);
    const message = itemIndex ? [this.warehouse.addHint(player.gameIndex, { type: "item_full", itemIndex })] : [];
    this.send(player, {
      type: "hint",
      title: "\u89d2\u8272\u6280\u80fd",
      text: "开局显示一件蓝色品质战利品，并进入【苍】阶段。",
      icon: this.characterDefinitions.get(player.characterId)?.image || "",
      show: message.length > 0,
      message,
    });
  }

  emitGojoRoundHint(player) {
    if (!player.characterState.gojoMode) player.characterState.gojoMode = "blue";
    const previousRoundIndex = this.round - 2;
    if (previousRoundIndex < 0) return;
    const ownBid = player.bids[previousRoundIndex] || 0;
    const allBids = this.players.map((entry) => entry.bids[previousRoundIndex] || 0);
    const view = this.warehouse.getView(player.gameIndex);
    const mode = player.characterState.gojoMode;

    if (mode === "blue" && ownBid === Math.max(...allBids)) {
      const knownFull = realItemEntries(this.warehouse).filter(({ item }) => itemFullInfoKnown(view, item));
      const adjacent = new Set();
      for (const { index } of knownFull) {
        for (const neighbor of this.neighborItemIndexes(index)) {
          const item = this.warehouse.getItemByIndex(neighbor);
          if (item && !itemFullInfoKnown(view, item)) adjacent.add(neighbor);
        }
      }
      const message = [...adjacent].map((itemIndex) => this.warehouse.addHint(player.gameIndex, { type: "item_full", itemIndex }));
      player.characterState.gojoMode = "red";
      this.send(player, {
        type: "hint",
        title: "\u89d2\u8272\u6280\u80fd",
        text: "【苍】效果触发，显示所有与完全已知战利品相邻的战利品，并进入【赫】阶段。",
        icon: this.characterDefinitions.get(player.characterId)?.image || "",
        show: message.length > 0,
        message,
      });
      return;
    }

    if (mode === "red" && ownBid === Math.min(...allBids)) {
      const itemIndex = this.pickGojoRedTarget(view);
      const message = itemIndex ? [this.warehouse.addHint(player.gameIndex, { type: "item_full", itemIndex })] : [];
      player.characterState.gojoMode = "purple";
      this.send(player, {
        type: "hint",
        title: "\u89d2\u8272\u6280\u80fd",
        text: "【赫】效果触发，随机显示一件高品质战利品，并进入【茈】阶段。",
        icon: this.characterDefinitions.get(player.characterId)?.image || "",
        show: message.length > 0,
        message,
      });
      return;
    }

    if (mode === "purple" && ownBid === Math.max(...allBids)) {
      const indexes = new Set();
      const purple = realItemEntries(this.warehouse).filter(({ item }) => item.rarity === "purple");
      for (const { index } of purple) {
        indexes.add(index);
        for (const neighbor of this.neighborItemIndexes(index)) indexes.add(neighbor);
      }
      const message = [...indexes]
        .filter((itemIndex) => !itemFullInfoKnown(view, this.warehouse.getItemByIndex(itemIndex)))
        .map((itemIndex) => this.warehouse.addHint(player.gameIndex, { type: "item_full", itemIndex }));
      player.characterState.gojoPurpleTriggered = true;
      this.send(player, {
        type: "hint",
        title: "\u89d2\u8272\u6280\u80fd",
        text: "【茈】效果触发，显示所有紫色品质战利品以及与它们相邻的战利品。",
        icon: this.characterDefinitions.get(player.characterId)?.image || "",
        show: message.length > 0,
        message,
      });
    }
  }

  pickGojoRedTarget(view) {
    for (const rarity of ["red", "gold", "purple", "blue", "green", "gray"]) {
      const candidates = realItemEntries(this.warehouse)
        .filter(({ item }) => item.rarity === rarity && !itemFullInfoKnown(view, item))
        .map(({ index }) => index);
      if (candidates.length) return sample(candidates, 1, this.random)[0];
    }
    return null;
  }

  sendCharacterHints(player, hints) {
    for (const hint of [hints].flat().filter(Boolean)) {
      hint.icon = this.characterDefinitions.get(player.characterId)?.image || "";
      this.send(player, hint);
    }
  }

  evaluateWinner(roundIndex) {
    const bids = this.players.map((player) => ({
      player,
      rawBid: player.bids[roundIndex] || 0,
      bid: Math.ceil((player.bids[roundIndex] || 0) * this.bidMultiplierFor(player, roundIndex)),
    }));
    return this.evaluateWinnerFromBids(roundIndex, bids);
  }

  evaluateWinnerFromBids(roundIndex, bids) {
    bids.sort((a, b) => b.bid - a.bid);
    const ratio = WIN_RATIOS[roundIndex];
    const distinctBids = [...new Set(bids.map((entry) => entry.bid).filter((bid) => bid > 0))].sort((a, b) => b - a);
    const secondBid = distinctBids.length > 1 ? distinctBids[1] : 0;
    const secondPlaceOpponents = bids.filter((entry) => entry.bid === secondBid);
    const winners = bids.filter((candidate) => {
      if (candidate.bid <= 0) return false;
      if (!secondPlaceOpponents.length) return true;
      return secondPlaceOpponents.every((opponent) => {
        if (opponent.player.id === candidate.player.id) return false;
        const candidateAdvantage = this.advantages.get(candidate.player.id, opponent.player.id);
        const opponentAdvantage = this.advantages.get(opponent.player.id, candidate.player.id);
        const required = requiredPairRatio(ratio, candidateAdvantage, opponentAdvantage);
        return candidate.bid > opponent.bid * required;
      });
    }).sort((a, b) => b.bid - a.bid);
    if (!winners.length) return { finished: roundIndex === ROUND_COUNT - 1, winnerId: null };
    const highestWinnerBid = winners[0].bid;
    const tiedWinners = winners.filter((entry) => entry.bid === highestWinnerBid);
    if (tiedWinners.length !== 1) return { finished: roundIndex === ROUND_COUNT - 1, winnerId: null };
    return { finished: true, winnerId: tiedWinners[0].player.id };
  }

  bidMultiplierFor(player, roundIndex) {
    let multiplier = 1;
    if (player.characterState.madeInHeaven) multiplier *= 1.3;
    if (player.characterState.reinerTransformed) multiplier *= Math.max(0, 1.6 - (roundIndex + 1) / 10);
    if (player.characterState.domainBidMultiplier?.[roundIndex]) multiplier *= Number(player.characterState.domainBidMultiplier[roundIndex]) || 1;
    if (player.characterId === "character_19") {
      for (const raidCap of this.players) {
        const omen = Number(raidCap.characterState?.omenActive?.[player.id] || 0);
        if (omen > 0) multiplier *= Math.max(0, 1 - omen * 0.05);
      }
    }
    if (player.characterId === "character_21" && player.characterState.megumiMode === "domain" && roundIndex >= 1) {
      const others = this.players.filter((entry) => entry.id !== player.id).map((entry) => entry.bids[roundIndex - 1] || 0);
      if (others.length) {
        const low = Math.min(...others);
        const high = Math.max(...others);
        const bid = player.bids[roundIndex] || 0;
        if (bid > low && bid < high) multiplier *= 1.2;
      }
    }
    if (roundIndex === 3) {
      for (const sukuna of this.players) {
        if (sukuna.characterId !== "character_14" || sukuna.id === player.id) continue;
        if (![0, 1, 2].every((index) => (sukuna.bids[index] || 0) === 0)) continue;
        const otherBids = this.players.filter((entry) => entry.id !== sukuna.id).map((entry) => entry.bids[roundIndex] || 0);
        const highest = Math.max(...otherBids);
        if ((player.bids[roundIndex] || 0) === highest && highest > 0) multiplier *= 0.5;
      }
    }
    return multiplier;
  }

  logFinalBidModifiers(roundIndex) {
    if (roundIndex < 0) return;
    const players = this.players.map((player) => {
      const rawBid = player.bids[roundIndex] || 0;
      const multiplier = this.bidMultiplierFor(player, roundIndex);
      return {
        id: player.id,
        nickname: player.nickname,
        rawBid,
        multiplier,
        adjustedBid: Math.ceil(rawBid * multiplier),
      };
    });
    const advantages = this.advantages.entries()
      .filter((entry) => Number(entry.value) > 0)
      .map((entry) => ({
        sourceId: entry.sourceId,
        source: this.players.find((player) => player.id === entry.sourceId)?.nickname || entry.sourceId,
        targetId: entry.targetId,
        target: this.players.find((player) => player.id === entry.targetId)?.nickname || entry.targetId,
        advantage: entry.value,
      }));
    if (!players.some((player) => player.multiplier !== 1) && !advantages.length) return;
    const lines = [
      `Final round bid modifiers, round ${roundIndex + 1}:`,
      ...players.map((player) => `  ${player.nickname}(${player.id}) raw=${player.rawBid} multiplier=${player.multiplier} adjusted=${player.adjustedBid}`),
      ...(advantages.length ? ["  advantages:", ...advantages.map((entry) => `    ${entry.source} -> ${entry.target}: ${entry.advantage}`)] : []),
    ];
    console.log(lines.join("\n"));
    logInfo("final round bid modifiers", { round: roundIndex + 1, players, advantages });
  }

  broadcastPublicState({ clearBidState }) {
    for (const player of this.players) player.publicRound = this.round;
    this.broadcast({
      type: "public_state",
      body: {
        round: this.round,
        clearBidState,
        players: this.players.map((player) => publicPlayer(player)),
      },
    });
  }

  currentCountdownSeconds() {
    if (!this.started || this.finished || !this.roundEndsAt) return null;
    return Math.max(0, Math.ceil(Math.max(0, this.roundEndsAt - Date.now()) / 1000) - 2);
  }

  send(player, payload) {
    if (!payload || player.disconnected) return;
    if (player.gameSocket) sendWsJson(player.gameSocket, payload);
    else player.pendingMessages.push(payload);
  }

  broadcast(payload) {
    for (const player of this.players) this.send(player, payload);
  }
}

export function validateSelections(players) {
  for (const player of players) {
    const counts = new Map();
    for (const prop of normalizeSelectedProps(player.props)) {
      if (!prop) continue;
      counts.set(prop.id, (counts.get(prop.id) || 0) + 1);
    }
    for (const [id, count] of counts) {
      if ((player.profile.warehouse.props[id] || 0) < count) return { ok: false, message: `${player.nickname} 携带的道具数量不足` };
    }
  }
  return { ok: true };
}

function normalizeSelectedProps(props) {
  return Array.from({ length: 5 }, (_, index) => {
    const value = props?.[index];
    if (!value) return null;
    if (typeof value === "string") return { id: value, level: 1, slot: index };
    return { id: value.id, level: Number(value.level) || 1, slot: index };
  });
}

function normalizeTarget(target) {
  return {
    x: Math.max(0, Math.min(Warehouse.WIDTH - 1, Math.floor(Number(target?.x) || 0))),
    y: Math.max(0, Math.min(Warehouse.MAX_ROWS - 1, Math.floor(Number(target?.y) || 0))),
  };
}

function isSpecialProp(id) {
  return String(id || "").startsWith("sp_prop");
}

function normalizeSpecialProps(definitions) {
  return [...definitions].map(([id, definition]) => [
    id,
    {
      ...definition,
      level: 6,
      price: "???",
      rarity: "red",
      exclusive: true,
      special: true,
    },
  ]);
}

function makeTemporaryProp(id, definition = {}, extra = {}) {
  return {
    id,
    level: Number(definition.level || 6) || 6,
    temporary: true,
    ...extra,
  };
}

function characterTextHint(text, icon = "") {
  return { type: "hint", title: "\u89d2\u8272\u6280\u80fd", text, icon, show: false, message: [] };
}

function firstEmptyPropSlot(player) {
  return player.props.findIndex((prop) => !prop);
}

function maxPropUsesFor(player) {
  return player.characterId === "character_16" ? 2 : 1;
}

function cellHasDirectKnownInfo(view, x, y) {
  return (view.hint || []).some((hint) => {
    if (hint.type === "cell_rarity") return hint.x === x && hint.y === y;
    if (hint.type === "item_outline" || hint.type === "item_outline_rarity" || hint.type === "item_full") {
      return x >= hint.x && x < hint.x + hint.width && y >= hint.y && y < hint.y + hint.height;
    }
    return false;
  });
}

function publicPlayer(player) {
  const activeRoundIndex = Math.max(0, (player.publicRound || 0) - 1);
  const visibleRoundBids = player.bids.map((bid, index) => (index < activeRoundIndex ? (bid == null ? null : bid) : null));
  const lastVisibleBid = [...visibleRoundBids].reverse().find((bid) => bid != null) || 0;
  const visibleUsedProps = player.usedProps.map((prop, index) => (index < activeRoundIndex ? prop : null));
  let characterImageOverride = "";
  if (player.characterId === "character_21" && player.characterState.megumiMode === "makora") characterImageOverride = "/resource/characters/Makora.png";
  if (player.characterId === "character_22" && player.characterState.reinerTransformed) characterImageOverride = "/resource/characters/ArmoredTitan.png";
  return {
    id: player.id,
    nickname: player.nickname,
    title: player.title || "",
    characterId: player.characterId,
    characterName: player.characterId,
    characterImageOverride,
    reinerTransformed: Boolean(player.characterState.reinerTransformed),
    money: player.profile.money,
    disconnected: player.disconnected,
    lastBid: lastVisibleBid,
    roundBids: visibleRoundBids,
    submitted: player.submitted,
    usedProps: visibleUsedProps,
  };
}

function lastBidFor(player) {
  for (let index = ROUND_COUNT - 1; index >= 0; index -= 1) {
    if (player.bids[index] != null) return player.bids[index];
  }
  return 0;
}

function countItems(items) {
  const counts = {};
  for (const item of items) {
    if (!item || item.id === 0) continue;
    counts[item.id] = (counts[item.id] || 0) + 1;
  }
  return counts;
}

function favoriteIds(profile) {
  return Object.entries(profile.warehouse.items || {})
    .filter(([, entry]) => entry?.collected)
    .map(([id]) => Number(id));
}

function rewardItem(itemsById, id) {
  const item = itemsById.get(Number(id));
  return {
    id: Number(id),
    name: item?.name || `#${id}`,
  };
}

function lotteryItemCount(profile, itemIds) {
  return itemIds.reduce((sum, id) => sum + Number(profile.warehouse.items[String(id)]?.count || 0), 0);
}

function setWarehouseNotification(profile, kind, value) {
  if (!profile.settings || typeof profile.settings !== "object") profile.settings = {};
  if (!profile.settings.warehouseNotifications || typeof profile.settings.warehouseNotifications !== "object") {
    profile.settings.warehouseNotifications = {};
  }
  profile.settings.warehouseNotifications[kind] = Boolean(value);
}

function loadLotteryRaw(rootDir) {
  const filePath = path.join(rootDir, "lottery.json");
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function randomInt(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

function sample(items, count, random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result.slice(0, count);
}

function realItemEntries(warehouse) {
  return warehouse.items.map((item, index) => ({ item, index })).filter(({ item, index }) => index > 0 && item?.id !== 0);
}

function itemIndexFullKnown(view, itemIndex) {
  return (view.hint || []).some((hint) => hint.type === "item_full" && Number(hint.itemIndex) === Number(itemIndex));
}

function itemCells(item) {
  return Number(item.width || 0) * Number(item.height || 0);
}

function sumCells(items) {
  return items.reduce((sum, item) => sum + itemCells(item), 0);
}

function average(total, count) {
  return count ? Math.ceil(total / count) : 0;
}

function averageCells(total, count) {
  if (!count) return "0";
  const value = total / count;
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function averageValue(items) {
  return average(items.reduce((sum, item) => sum + Number(item.price || 0), 0), items.length);
}

function uniqueItemsById(items) {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function systemNumberHint(id, text) {
  return { id, text, show: false, rawHints: [] };
}

function systemItemHint(id, text, items, hintType) {
  return {
    id,
    text,
    show: items.length > 0,
    rawHints: items.map((item) => ({ type: hintType, itemIndex: item.itemIndex })),
  };
}

function systemCellRarityHint(id, text, items) {
  return {
    id,
    text,
    show: items.length > 0,
    rawHints: items.map((item) => ({ type: "cell_rarity", x: item.x, y: item.y })),
  };
}

function publicHintItemIndex(warehouse, hint) {
  if (Number.isInteger(hint.itemIndex)) return hint.itemIndex;
  if (Number.isInteger(hint.x) && Number.isInteger(hint.y)) return warehouse.getIndexAt(hint.x, hint.y);
  return 0;
}

function itemsShareEdge(a, b) {
  if (!a || !b) return false;
  const verticalTouch = a.x + a.width === b.x || b.x + b.width === a.x;
  const verticalOverlap = a.y < b.y + b.height && b.y < a.y + a.height;
  const horizontalTouch = a.y + a.height === b.y || b.y + b.height === a.y;
  const horizontalOverlap = a.x < b.x + b.width && b.x < a.x + a.width;
  return (verticalTouch && verticalOverlap) || (horizontalTouch && horizontalOverlap);
}

function characterHasRoundOneEffect(characterId) {
  return new Set(["character_3", "character_4", "character_6", "character_8", "character_9", "character_10", "character_11", "character_13", "character_15", "character_18", "character_20"]).has(characterId);
}


