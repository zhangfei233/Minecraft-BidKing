import { Warehouse } from "./Warehouse.js";
import { createCharacter } from "./characters.js";
import { createProp } from "./props.js";
import { loadDefinitions } from "./definitions.js";
import {
  addMoney,
  addWarehouseItemsToProfile,
  deductMoney,
  saveProfileByNickname,
  sellProfileItemCounts,
} from "../player/profile.js";
import { loadConfig, loadItemsById } from "../items/items.js";
import { decodeWsText, sendWsJson } from "../net/websocket.js";
import { splitTypes } from "./hints.js";
import { error as logError } from "../net/logger.js";

const ROUND_COUNT = 5;
const ROUND_MS = 62_000;
const CLIENT_COUNTDOWN_SECONDS = 60;
const INTERMISSION_MS = 3_000;
const WIN_RATIOS = [2, 1.6, 1.3, 1.1, 1];
const HEARTBEAT_TIMEOUT_MS = 45_000;
const RARITIES = ["gray", "green", "blue", "purple", "gold", "red"];
const RARITY_LABELS = { gray: "白", green: "绿", blue: "蓝", purple: "紫", gold: "金", red: "红" };
const SYSTEM_HINT_TITLE = "公开的战利品信息";

export class GameSession {
  constructor({ rootDir, players, container = { name: "大型箱子", k: 1 }, random = Math.random, onFinish = null }) {
    this.rootDir = rootDir;
    this.random = random;
    this.container = container;
    this.onFinish = onFinish;
    this.characterDefinitions = loadDefinitions(rootDir, "characters.csv");
    this.propDefinitions = loadDefinitions(rootDir, "props.csv");
    this.itemsById = loadItemsById(rootDir);
    this.systemHintProbability = Number(loadConfig(rootDir).game?.system_hint_probability ?? 0.3);
    this.warehouse = new Warehouse({ rootDir, random });
    this.warehouse.generate(container.k);
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
      usedPropThisRound: false,
      characterState: {},
      pendingMessages: [],
    }));
    this.playersById = new Map(this.players.map((player) => [player.id, player]));
    this.settlementOpen = false;
    this.roomCompleted = false;
    this.wonItemCounts = {};
    this.round = 0;
    this.roundTimer = null;
    this.intermissionTimer = null;
    this.started = false;
    this.finished = false;
    this.reserveCarriedProps();
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 15_000);
    this.heartbeatTimer.unref?.();
  }

  reserveCarriedProps() {
    for (const player of this.players) {
      for (const prop of player.props) {
        if (!prop) continue;
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
    if (player.disconnected) {
      sendWsJson(socket, { type: "error", message: "本局游戏不支持重连" });
      socket.end();
      return;
    }

    player.gameSocket = socket;
    player.connected = true;
    player.lastSeen = Date.now();
    socket.on("data", (buffer) => this.handleMessage(player, buffer));
    socket.on("close", () => this.markDisconnected(player));
    socket.on("error", () => this.markDisconnected(player));

    this.sendInit(player);
    for (const payload of player.pendingMessages.splice(0)) this.send(player, payload);
    if (!this.started && this.players.every((entry) => entry.connected || entry.disconnected)) this.start();
  }

  markDisconnected(player) {
    if (player.disconnected) return;
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
  }

  checkHeartbeats() {
    if (this.finished) return;
    const now = Date.now();
    for (const player of this.players) {
      if (player.connected && now - player.lastSeen > HEARTBEAT_TIMEOUT_MS) this.markDisconnected(player);
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.emitSystemPublicHint({ force: true });
    this.startRound(1);
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
    for (const player of this.players) {
      player.usedPropThisRound = false;
      player.submitted[round - 1] = Boolean(player.disconnected);
      player.bids[round - 1] = player.disconnected ? 0 : null;
      this.send(player, { type: "round_start", body: { round, countdownSeconds: CLIENT_COUNTDOWN_SECONDS } });
    }
    this.broadcastPublicState({ clearBidState: true });
    if (round > 1) this.emitSystemPublicHint({ force: false });
    for (const player of this.players) {
      if (round === 1) {
        this.emitCharacterStartHint(player);
        if (characterHasRoundOneEffect(player.characterId)) this.emitCharacterRoundHint(player);
      } else {
        this.emitCharacterRoundHint(player);
      }
    }
    clearTimeout(this.roundTimer);
    this.roundTimer = setTimeout(() => this.endRound(), ROUND_MS);
    this.roundTimer.unref?.();
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
      systemNumberHint("total-cells", `所有战利品总占用的格子数量为${totalCells}格`),
      systemNumberHint("avg-cells", `每件战利品平均占用的格子数量为${averageCells(totalCells, indexedItems.length)}格`),
      systemItemHint("random-full-x", `随机显示${randomXItems.length}件战利品`, randomXItems, "item_full"),
      systemItemHint("largest-full", "随机显示一件占位格数最高的战利品", largest ? [largest] : [], "item_full"),
      systemNumberHint("rarity-total-cells", `${RARITY_LABELS[y]}色品质的战利品总占用的格子数量为${sumCells(yItems)}格`),
      systemNumberHint("rarity-avg-cells", `${RARITY_LABELS[y]}色品质的战利品平均占用的格子数量为${averageCells(sumCells(yItems), yItems.length)}格`),
      systemNumberHint("random-z-avg-value", `随机选择的${randomZValueItems.length}件战利品的平均价值为${averageValue(randomZValueItems)}`),
      systemNumberHint("random-t-kind-avg-value", `随机选择的${randomDistinctItems.length}种战利品的平均价值为${averageValue(randomDistinctItems)}`),
      systemNumberHint("rarity-count", `本次的战利品仓共有${RARITY_LABELS[y]}色品质的战利品${yItems.length}件`),
      systemCellRarityHint("type-rarity", `随机显示${pickedTypes.length}种类型的战利品的品质`, typeRarityItems),
      systemCellRarityHint("random-z-rarity", `随机显示${randomZItems.length}件战利品的品质`, randomZItems),
      systemItemHint("rarity-outline", `显示所有${RARITY_LABELS[y]}色战利品的轮廓`, yItems, "item_outline_rarity"),
      systemNumberHint("rarity-avg-value", `${RARITY_LABELS[y]}色战利品的平均价值是${averageValue(yItems)}`),
    ];
  }

  endRound() {
    if (this.finished) return;
    const roundIndex = this.round - 1;
    for (const player of this.players) {
      if (!player.submitted[roundIndex]) player.bids[roundIndex] = 0;
      player.submitted[roundIndex] = true;
    }

    const result = this.evaluateWinner(roundIndex);
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
      },
    });

    if (result.finished || this.round >= ROUND_COUNT) {
      this.finishGame(result.winnerId);
      return;
    }

    clearTimeout(this.intermissionTimer);
    this.intermissionTimer = setTimeout(() => this.startRound(this.round + 1), INTERMISSION_MS);
    this.intermissionTimer.unref?.();
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
      this.send(player, { type: "error", message: "消息格式错误" });
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
        this.onFinish?.();
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
      this.useProp(player, Number(message.slot));
      return;
    }

  }

  receiveBid(player, amount) {
    const roundIndex = this.round - 1;
    if (roundIndex < 0 || roundIndex >= ROUND_COUNT || player.submitted[roundIndex]) return;
    const bid = Math.max(0, Math.floor(Number(amount) || 0));
    if (bid > player.profile.money) {
      this.send(player, { type: "error", message: "出价不能超过当前金钱" });
      return;
    }
    player.bids[roundIndex] = bid;
    player.submitted[roundIndex] = true;
    this.broadcast({ type: "bid_submitted", body: { playerId: player.id, round: this.round } });
    this.broadcastPublicState({ clearBidState: false });
    if (this.players.every((entry) => entry.submitted[roundIndex] || entry.disconnected)) this.endRound();
  }

  useProp(player, slot) {
    const roundIndex = this.round - 1;
    if (!Number.isInteger(slot) || slot < 0 || slot >= 5) {
      this.send(player, { type: "error", message: "道具槽无效" });
      return;
    }
    if (player.usedPropThisRound) {
      this.send(player, { type: "error", message: "本回合已经使用过道具" });
      return;
    }
    if (player.submitted[roundIndex]) {
      this.send(player, { type: "error", message: "出价后不能使用道具" });
      return;
    }
    const selected = player.props[slot];
    if (!selected) {
      this.send(player, { type: "error", message: "该槽位没有携带道具" });
      return;
    }

    player.usedPropThisRound = true;
    player.usedProps[roundIndex] = selected;
    const prop = createProp(selected.id, this.propDefinitions.get(selected.id), selected.level);
    const hint = prop.use({
      warehouse: this.warehouse,
      viewNumber: player.gameIndex,
      view: this.warehouse.getView(player.gameIndex),
      random: this.random,
    });
    if (hint) hint.icon = this.propDefinitions.get(selected.id)?.image || "";
    this.send(player, hint);
  }

  finishGame(winnerId) {
    this.finished = true;
    this.settlementOpen = true;
    clearTimeout(this.roundTimer);
    clearTimeout(this.intermissionTimer);
    clearInterval(this.heartbeatTimer);

    const warehouseItems = this.warehouse.getSerializableItems();
    const totalValue = warehouseItems.reduce((sum, item) => sum + Number(item.price || 0), 0);
    const winner = winnerId ? this.players.find((player) => player.id === winnerId) : null;
    this.lastWinnerId = winner?.id || null;
    const finalBid = winner ? lastBidFor(winner) : 0;
    const finalProfit = winner ? totalValue - finalBid : 0;
    const dividend = winner && finalProfit < 0 ? Math.ceil(Math.abs(finalProfit) / 10) : 0;
    this.wonItemCounts = winner ? countItems(warehouseItems) : {};

    for (const player of this.players) {
      for (let index = 0; index < player.props.length; index += 1) {
        const prop = player.props[index];
        if (!prop) continue;
        const used = player.usedProps.some((entry) => entry && entry.id === prop.id && entry.slot === index);
        if (!used) player.profile.warehouse.props[prop.id] = (player.profile.warehouse.props[prop.id] || 0) + 1;
      }
      if (dividend > 0) addMoney(player.profile, dividend);
      saveProfileByNickname(this.rootDir, player.profile);
    }

    if (winner) {
      deductMoney(winner.profile, finalBid);
      addWarehouseItemsToProfile(winner.profile, warehouseItems);
      saveProfileByNickname(this.rootDir, winner.profile);
    }

    this.broadcast({
      type: "game_over",
      body: {
        winnerId,
        totalValue,
        finalBid,
        dividend,
        warehouseItems,
        players: this.players.map((player) => publicPlayer(player)),
        winner: winner ? publicPlayer(winner) : null,
        favoritesByPlayer: Object.fromEntries(this.players.map((player) => [player.id, favoriteIds(player.profile)])),
      },
    });
  }

  sellSettlementItems(player, mode, options = {}) {
    if (!this.settlementOpen) return;
    const winner = this.players.find((entry) => entry.id === this.lastWinnerId);
    if (winner && player.id !== winner.id) return this.send(player, { type: "error", message: "只有得拍玩家可以出售本局战利品" });
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
      this.send(player, { type: "error", message: error.message });
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
        propDefinitions: Object.fromEntries(this.propDefinitions),
        characterDefinitions: Object.fromEntries(this.characterDefinitions),
      },
    });
  }

  emitCharacterStartHint(player) {
    try {
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
    bids.sort((a, b) => b.bid - a.bid);
    const first = bids[0];
    const second = bids[1] || { bid: 0 };
    if (!first || first.bid <= 0) return { finished: roundIndex === ROUND_COUNT - 1, winnerId: null };

    const tied = bids.filter((entry) => entry.bid === first.bid).length > 1;
    if (roundIndex === ROUND_COUNT - 1) return { finished: true, winnerId: tied ? null : first.player.id };

    const ratio = WIN_RATIOS[roundIndex];
    const thresholdPassed = second.bid === 0 ? first.bid > 0 : first.bid > second.bid * ratio;
    return { finished: thresholdPassed, winnerId: thresholdPassed ? first.player.id : null };
  }

  bidMultiplierFor(player, roundIndex) {
    let multiplier = 1;
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

function publicPlayer(player) {
  const activeRoundIndex = Math.max(0, (player.publicRound || 0) - 1);
  const visibleRoundBids = player.bids.map((bid, index) => (index < activeRoundIndex ? (bid == null ? null : bid) : null));
  const lastVisibleBid = [...visibleRoundBids].reverse().find((bid) => bid != null) || 0;
  return {
    id: player.id,
    nickname: player.nickname,
    title: player.title || "",
    characterId: player.characterId,
    characterName: player.characterId,
    money: player.profile.money,
    disconnected: player.disconnected,
    lastBid: lastVisibleBid,
    roundBids: visibleRoundBids,
    submitted: player.submitted,
    usedProps: player.usedProps,
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

function characterHasRoundOneEffect(characterId) {
  return new Set(["character_3", "character_4", "character_6", "character_8", "character_9", "character_10", "character_11", "character_13", "character_15"]).has(characterId);
}
