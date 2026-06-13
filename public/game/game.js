import { WarehouseCanvas, loadClientItems } from "/common/warehouseCanvas.js";

const playersEl = document.querySelector("#players");
const noticeList = document.querySelector("#noticeList");
const canvas = document.querySelector("#warehouseCanvas");
const tooltip = document.querySelector("#canvasTooltip");
const warehouseTitle = document.querySelector(".warehouse-head h1");
const gameMoney = document.querySelector("#gameMoney");
const knownLootValue = document.querySelector("#knownLootValue");
const roundNumber = document.querySelector("#roundNumber");
const propDialog = document.querySelector("#propDialog");
const propChoices = document.querySelector("#propChoices");
const settlementPanel = document.querySelector("#settlementPanel");
const settlementActions = document.querySelector("#settlementActions");
const topOverlay = document.querySelector("#topOverlay");
const predictButton = document.querySelector("#predictButton");
const transformButton = document.querySelector("#transformButton");
const transformCountdown = document.querySelector("#transformCountdown");
const renderer = new WarehouseCanvas(canvas, { cellSize: 54 });

let socket = null;
let myId = new URLSearchParams(location.search).get("playerId") || "";
let currentPlayers = [];
let currentRound = 1;
let countdownTimer = null;
let heartbeatTimer = null;
let remainingSeconds = 0;
let bidInput = "";
let propDefinitions = {};
let carriedProps = [];
let characterDefinitions = {};
let clientItems = new Map();
let currentMoney = 0;
let settlementFinalBid = 0;
let hasBidThisRound = false;
let propUsesThisRound = 0;
let maxPropUsesThisRound = 1;
let pendingTargetUse = null;
let settlementTimer = null;
let showRoundResults = false;
let roundResultTimer = null;
let predictionAvailable = null;
let predictionSubmittedThisRound = false;
let isMakora = false;
let isReiner = false;
let reinerTransformed = false;
let actionLockedThisRound = false;
let roundInitialSeconds = 60;
let countdownEndsAt = 0;
let bellPlayedAt = new Set();
let animationDepth = 0;
let queuedMessages = [];
let currentAnimationOverlay = null;
let currentAnimationAudio = null;
let animationRunToken = 0;
let roundEndAnimationToken = 0;
let propUsePending = false;
let activeConfirmResolve = null;

const levelRarities = ["gray", "green", "blue", "purple", "gold", "red"];
const rarityLabels = { gray: "\u767d", green: "\u7eff", blue: "\u84dd", purple: "\u7d2b", gold: "\u91d1", red: "\u7ea2" };
const rarityColors = { red: "#ff6060", gold: "#faff75", purple: "#964aca", blue: "#7b8afc", green: "#95de93", gray: "#c7c7c7" };
const selectedSettlementRarities = new Set();
const audioCache = new Map();
const animationDurations = { 1: 13.92, 2: 9.2, 3: 12, 4: 3.5, 5: 2, 6: 8.75, 7: 5.25, 8: 10.25, 9: 10, 10: 5 };
const animationImageCache = new Map();
const animationAudioCache = new Map();
const animationPreloadPromises = new Map();
const animationPreloadLinks = new Set();
const animationAssetUrlCache = new Map();
const animationAssetFetchPromises = new Map();

for (const [name, ext] of [["click", "mp3"], ["chest", "mp3"], ["orb", "mp3"], ["firework", "mp3"], ["splash", "ogg"], ["bell", "ogg"]]) preloadSound(name, ext);

document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button, a, select")) playSound("click");
}, true);
document.addEventListener("warehouse-image-loaded", () => renderer.render());

loadClientItems().then((items) => {
  clientItems = items;
  renderer.setItems(items);
});
renderer.onValueChange = updateKnownLootValue;
connectGameSocket();
setupBidPanel();
buildSettlementRarityFilter();

document.querySelector("#useItemButton").addEventListener("click", openPropDialog);
document.querySelector("#bidButton").addEventListener("click", openBidPanel);
predictButton?.addEventListener("click", () => {
  if (!predictionAvailable || hasBidThisRound) return;
  showMegumiPrediction(predictionAvailable, { closable: true });
});
transformButton?.addEventListener("click", () => {
  if (!canUseReinerTransform()) return;
  socket?.send(JSON.stringify({ type: "reiner_transform" }));
  transformButton.disabled = true;
});
document.querySelector("#sellAllLootButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "settlement_sell", mode: "all" })));
document.querySelector("#sellUnfavoriteLootButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "settlement_sell", mode: "unfavorite" })));
document.querySelector("#sellRarityLootButton").addEventListener("click", () => {
  if (!selectedSettlementRarities.size) return alert("\u8bf7\u81f3\u5c11\u9009\u62e9\u4e00\u79cd\u54c1\u8d28");
  socket?.send(JSON.stringify({ type: "settlement_sell", mode: "rarity", rarities: [...selectedSettlementRarities] }));
});
document.querySelector("#returnRoomButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "return_room" })));

canvas.addEventListener("click", (event) => {
  const cell = renderer.cellFromEvent(event);
  if (!cell) return;
  if (pendingTargetUse) {
    completeTargetUse(cell);
    return;
  }
  const hash = renderer.queryForCell(cell.x, cell.y);
  if (hash) window.open(`/wiki#${hash}`, "_blank", "noopener,noreferrer");
});

canvas.addEventListener("mousemove", (event) => {
  const cell = renderer.cellFromEvent(event);
  const data = cell ? renderer.tooltipForCell(cell.x, cell.y) : null;
  if (!data) {
    tooltip.hidden = true;
    return;
  }
  tooltip.innerHTML = `<strong>${escapeHtml(data.name)}</strong><span>${escapeHtml(data.typeLabel)}</span><span>\u4ef7\u503c ${formatNumber(data.price)}</span>`;
  tooltip.style.left = `${event.clientX + 14}px`;
  tooltip.style.top = `${event.clientY + 14}px`;
  tooltip.hidden = false;
});
canvas.addEventListener("mouseleave", () => {
  tooltip.hidden = true;
});

function connectGameSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/game-ws?playerId=${encodeURIComponent(myId)}`);
  socket.addEventListener("open", () => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "heartbeat" })), 10_000);
  });
  socket.addEventListener("close", () => clearInterval(heartbeatTimer));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (animationDepth > 0 && message.type !== "round_pause") {
      queuedMessages.push(message);
      return;
    }
    dispatchMessage(message);
  });
}

function dispatchMessage(message) {
  if (message.type === "error") {
    propUsePending = false;
    updateActionButtons();
  }
  if (message.type === "game_init") renderInit(message.body);
  if (message.type === "prop_slots") handlePropSlots(message.body);
  if (message.type === "hint") handleHint(message);
  if (message.type === "notice") addNotice(message);
  if (message.type === "round_start") handleRoundStart(message.body);
  if (message.type === "bid_submitted") handleBidSubmitted(message.body);
  if (message.type === "round_end") handleRoundEnd(message.body);
  if (message.type === "set_round_timer") handleSetRoundTimer(message.body);
  if (message.type === "round_pause") handleRoundPause(message.body);
  if (message.type === "preload_animations") preloadAnimations(message.body?.animations || []);
  if (message.type === "timer_style") handleTimerStyle(message.body);
  if (message.type === "megumi_choice_request") showMegumiChoice(message.body);
  if (message.type === "megumi_prediction_request") {
    predictionAvailable = message.body;
    predictionSubmittedThisRound = false;
    showMegumiPrediction(message.body, { closable: false });
    updateActionButtons();
  }
  if (message.type === "megumi_prediction_available") {
    predictionAvailable = message.body;
    predictionSubmittedThisRound = false;
    updateActionButtons();
  }
  if (message.type === "public_state") handlePublicState(message.body);
  if (message.type === "game_over") handleGameOver(message.body);
  if (message.type === "settlement_sell_result") handleSettlementSellResult(message.body);
  if (message.type === "return_room") location.href = message.body?.url || `/room?playerId=${encodeURIComponent(myId)}`;
  if (message.type === "error") addNotice({ title: "\u64cd\u4f5c\u5931\u8d25", text: message.message || "\u672a\u77e5\u9519\u8bef", show: false, message: [] });
}

function flushQueuedMessages() {
  if (animationDepth > 0) return;
  const pending = queuedMessages;
  queuedMessages = [];
  for (const message of pending) dispatchMessage(message);
}

function renderInit(data) {
  myId = data.playerId || myId;
  propDefinitions = data.propDefinitions || {};
  characterDefinitions = data.characterDefinitions || {};
  carriedProps = data.carriedProps || [];
  maxPropUsesThisRound = Number(data.maxPropUses || 1);
  propUsesThisRound = Number(data.propUses || 0);
  propUsePending = false;
  currentMoney = Number(data.money || 0);
  gameMoney.textContent = formatNumber(currentMoney);
  currentRound = data.round ?? 1;
  actionLockedThisRound = Boolean(data.actionLocked);
  hasBidThisRound = actionLockedThisRound;
  roundNumber.textContent = currentRound;
  warehouseTitle.textContent = data.warehouseName || "\u6218\u5229\u54c1\u4ed3";
  noticeList.innerHTML = "";
  renderer.reset();
  if (Array.isArray(data.hints) && data.hints.length) renderer.applyHint({ message: data.hints });
  updateKnownLootValue(renderer.revealedValue());
  handleTimerStyle({ madeInHeaven: Boolean(data.madeInHeavenActive) });
  roundInitialSeconds = Number(data.roundInitialSeconds || data.countdownSeconds || 60);
  renderPlayers(data.players || []);
  for (const notice of data.notices || []) addNotice(notice);
  if (Number(data.countdownSeconds) > 0) startCountdown(Number(data.countdownSeconds));
  else if (!data.reconnect) playSound("chest");
}

function renderPlayers(players) {
  const sorted = [...players].sort((a, b) => {
    if (a.id === myId) return 1;
    if (b.id === myId) return -1;
    return a.nickname.localeCompare(b.nickname, "zh-CN");
  });
  currentPlayers = sorted;
  const me = sorted.find((player) => player.id === myId);
  isMakora = Boolean(me?.characterId === "character_21" && me?.characterImageOverride);
  isReiner = Boolean(me?.characterId === "character_22");
  reinerTransformed = Boolean(me?.reinerTransformed || me?.characterImageOverride?.includes("ArmoredTitan"));
  if (me?.submitted?.[currentRound - 1]) hasBidThisRound = true;
  updateActionButtons();
  playersEl.innerHTML = sorted.map((player, index) => `
    <article class="player-card ${player.disconnected ? "is-offline" : ""}">
      <div class="player-top">
        ${renderPlayerAvatar(player)}
        <div class="player-meta">
          <div class="player-name">${index + 1} ${escapeHtml(player.nickname)}${player.disconnected ? "\uff08\u6389\u7ebf\uff09" : ""}</div>
          ${renderEffectIcons(player.effectIcons || [])}
          ${player.title ? `<div class="title">${escapeHtml(player.title)}</div>` : ""}
        </div>
        <div class="last-bid">${renderBidStatus(player)}</div>
      </div>
      <div class="round-items">
        ${Array.from({ length: 5 }, (_, round) => renderRoundSlot(player, round)).join("")}
      </div>
    </article>
  `).join("");
  bindEffectIconTooltips();
}

function renderEffectIcons(icons) {
  if (!icons.length) return "";
  return `<span class="effect-icons">${icons.map((icon) => `
    <span class="effect-icon" data-effect-text="${escapeHtml(icon.text || "")}">
      <img src="${escapeHtml(icon.icon || "")}" alt="" />
    </span>
  `).join("")}</span>`;
}

function bindEffectIconTooltips() {
  for (const icon of playersEl.querySelectorAll(".effect-icon")) {
    icon.addEventListener("mousemove", (event) => {
      const text = icon.dataset.effectText || "";
      if (!text) return;
      tooltip.innerHTML = `<strong>${escapeHtml(text)}</strong>`;
      tooltip.style.left = `${event.clientX + 14}px`;
      tooltip.style.top = `${event.clientY + 14}px`;
      tooltip.hidden = false;
    });
    icon.addEventListener("mouseleave", () => {
      tooltip.hidden = true;
    });
  }
}

function renderRoundSlot(player, round) {
  const bid = player.roundBids?.[round];
  const prop = player.usedProps?.[round];
  const def = prop ? (propDefinitions[prop.id] || {}) : null;
  const propName = prop ? (def.name || prop.id) : "\u672a\u4f7f\u7528\u9053\u5177";
  const title = `${prop ? `${propName} Lv.${def.level || prop.level || 1}` : propName}${bid == null ? "" : `\n\u51c6\u786e\u51fa\u4ef7 ${formatNumber(bid)}`}`;
  return `<div class="round-slot" title="${escapeHtml(title)}"><i style="--prop-bg:${propColor(def)}">${def?.image ? `<img src="${def.image}" alt="" />` : prop ? "\u9053\u5177" : ""}</i><span>${round + 1}</span><small>${bid == null ? "" : shortNumber(bid)}</small></div>`;
}

function renderBidStatus(player) {
  if (showRoundResults && player.lastBid != null) return formatNumber(player.lastBid);
  if (player.bidPending) return "\u5df2\u51fa\u4ef7";
  return "";
}

function renderPlayerAvatar(player) {
  const character = characterDefinitions[player.characterId] || {};
  const description = character.description || character.text || character.skill || "";
  const imagePath = player.characterImageOverride || character.image;
  const image = imagePath ? `<img src="${escapeHtml(imagePath)}" alt="${escapeHtml(character.name || player.characterId || "")}" />` : "";
  return `<div class="avatar" title="${escapeHtml(description)}">${image}</div>`;
}

function openPropDialog() {
  if (hasBidThisRound || actionLockedThisRound || propUsesThisRound >= maxPropUsesThisRound) {
    addNotice({
      title: "\u64cd\u4f5c\u5931\u8d25",
      text: hasBidThisRound ? "\u51fa\u4ef7\u540e\u4e0d\u80fd\u4f7f\u7528\u9053\u5177" : "\u672c\u56de\u5408\u5df2\u8fbe\u5230\u9053\u5177\u4f7f\u7528\u6b21\u6570\u4e0a\u9650",
      show: false,
      message: [],
    });
    return;
  }
  propChoices.innerHTML = carriedProps.map((prop, index) => {
    if (!prop) return "";
    const def = propDefinitions[prop.id] || {};
    const name = def.name || prop.id;
    const description = def.description || "\u6682\u65e0\u8bf4\u660e";
    return `
      <button class="prop-choice" type="button" data-slot="${index}" title="${escapeHtml(description)}" style="--prop-bg:${propColor(def)}">
        ${def.image ? `<img src="${def.image}" alt="${escapeHtml(name)}" />` : "<span></span>"}
        <span><strong>${escapeHtml(name)} Lv.${prop.level || def.level || 1}</strong><span>${escapeHtml(description)}</span>${prop.temporary ? '<em class="temporary-label">\u4e34\u65f6</em>' : ""}</span>
        <span>\u7b2c${index + 1}\u683c</span>
      </button>
    `;
  }).join("") || "<p>\u6ca1\u6709\u53ef\u7528\u9053\u5177</p>";
  for (const button of propChoices.querySelectorAll(".prop-choice")) {
    button.addEventListener("click", async () => {
      const slot = Number(button.dataset.slot);
      const prop = carriedProps[slot];
      const def = propDefinitions[prop.id] || {};
      const name = def.name || prop.id;
      if (propDialog.open) propDialog.close();
      const confirmed = await showConfirmDialog({
        title: `\u786e\u8ba4\u4f7f\u7528\u9053\u5177\u3010${name}\u3011\u5417\uff1f`,
        text: def.description || "",
        confirmText: "\u4f7f\u7528",
        cancelText: "\u53d6\u6d88",
      });
      if (!confirmed) {
        if (!hasBidThisRound && !actionLockedThisRound && propUsesThisRound < maxPropUsesThisRound && animationDepth === 0) {
          propDialog.showModal();
        }
        return;
      }
      if (hasBidThisRound || actionLockedThisRound || animationDepth > 0) return;
      playSound("splash", "ogg");
      if (requiresTarget(prop.id)) {
        pendingTargetUse = { slot, propId: prop.id };
        addNotice({ title: "\u9053\u5177\u76ee\u6807", text: "\u8bf7\u9009\u62e9\u4e00\u4e2a\u6218\u5229\u54c1\u4ed3\u683c\u5b50", show: false, message: [] });
      } else {
        sendUseProp(slot);
      }
    });
  }
  propDialog.showModal();
}

function handleRoundStart(body) {
  forceEndCurrentAnimation();
  currentRound = body.round;
  actionLockedThisRound = Boolean(body.actionLocked);
  hasBidThisRound = actionLockedThisRound;
  propUsesThisRound = 0;
  propUsePending = false;
  pendingTargetUse = null;
  predictionAvailable = null;
  predictionSubmittedThisRound = false;
  bellPlayedAt = new Set();
  roundNumber.textContent = currentRound;
  showRoundResults = false;
  clearTimeout(roundResultTimer);
  for (const player of currentPlayers) {
    player.bidPending = false;
    player.lastBid = null;
  }
  renderPlayers(currentPlayers);
  updateActionButtons();
  roundInitialSeconds = Number(body.roundInitialSeconds || body.countdownSeconds || 60);
  startCountdown(roundInitialSeconds);
}

function handleBidSubmitted(body) {
  const player = currentPlayers.find((entry) => entry.id === body.playerId);
  if (body.playerId === myId) {
    hasBidThisRound = true;
    document.querySelector("#bidPanel").hidden = true;
    if (propDialog.open) propDialog.close();
    updateActionButtons();
  }
  if (player) {
    player.bidPending = true;
    renderPlayers(currentPlayers);
  }
}

function handleRoundEnd(body) {
  playSound("orb");
  stopCountdown();
  closeTopOverlay();
  showRoundResults = true;
  clearTimeout(roundResultTimer);
  hasBidThisRound = true;
  updateActionButtons();
  if (Array.isArray(body.players)) {
    const transientIconsById = new Map(currentPlayers.map((player) => [
      player.id,
      (player.effectIcons || []).filter((icon) => icon.transient),
    ]));
    currentPlayers = body.players.map((player) => ({
      ...player,
      effectIcons: [...(player.effectIcons || []), ...(transientIconsById.get(player.id) || [])],
    }));
  }
  for (const bid of body.bids || []) {
    const player = currentPlayers.find((entry) => entry.id === bid.playerId);
    if (!player) continue;
    player.bidPending = false;
    player.lastBid = bid.bid;
    player.roundBids = player.roundBids || [];
    player.roundBids[body.round - 1] = bid.bid;
    player.usedProps = player.usedProps || [];
    player.usedProps[body.round - 1] = bid.usedProp;
  }
  addTransientEffectIcons(body.effectIconsByPlayer || {});
  renderPlayers(currentPlayers);
  if (Object.keys(body.effectIconsByPlayer || {}).length) {
    setTimeout(() => {
      clearTransientEffectIcons();
      renderPlayers(currentPlayers);
    }, 3000);
  }
  playRoundEndAnimations(body.animations || []);
  const pauseMs = Math.max(0, Number(body.pauseSeconds || 3) * 1000);
  roundResultTimer = setTimeout(() => {
    showRoundResults = false;
    renderPlayers(currentPlayers);
  }, pauseMs);
}

function addTransientEffectIcons(effectIconsByPlayer) {
  for (const [playerId, icons] of Object.entries(effectIconsByPlayer || {})) {
    const player = currentPlayers.find((entry) => entry.id === playerId);
    if (!player) continue;
    const existing = Array.isArray(player.effectIcons) ? player.effectIcons.filter((icon) => !icon.transient) : [];
    player.effectIcons = existing.concat((icons || []).map((icon) => ({ ...icon, transient: true })));
  }
}

function clearTransientEffectIcons() {
  for (const player of currentPlayers) {
    player.effectIcons = Array.isArray(player.effectIcons) ? player.effectIcons.filter((icon) => !icon.transient) : [];
  }
}

function handleSetRoundTimer(body) {
  if (Number(body.countdownSeconds) >= 0) startCountdown(Number(body.countdownSeconds));
}

function handleRoundPause(body) {
  forceEndCurrentAnimation();
  stopCountdown();
  const animations = Array.isArray(body.animations) ? body.animations : [];
  const fallbackSeconds = Math.max(0, Number(body.pauseSeconds || 0));
  const playback = animations.length ? playAnimationSequence(animations) : showTimedOverlay("\u56de\u5408\u65f6\u95f4\u6682\u505c", fallbackSeconds);
  playback.finally(() => {
    if (Number(body.countdownSeconds) >= 0) startCountdown(Number(body.countdownSeconds));
  });
}

function handleTimerStyle(body) {
  document.querySelector("#timer").classList.toggle("made-in-heaven", Boolean(body?.madeInHeaven));
}

function handlePublicState(body) {
  currentRound = body.round || currentRound;
  roundNumber.textContent = currentRound;
  const players = body.players || currentPlayers;
  if (body.clearBidState) for (const player of players) player.bidPending = Boolean(player.submitted?.[currentRound - 1]);
  else for (const player of players) player.bidPending = Boolean(player.submitted?.[currentRound - 1]);
  renderPlayers(players);
}

function handleGameOver(body) {
  stopCountdown();
  clearTimeout(settlementTimer);
  hasBidThisRound = true;
  updateActionButtons();
  showSettlement(body);
}

function showSettlement(body) {
  playersEl.hidden = true;
  noticeList.innerHTML = "";
  document.querySelector(".notice-panel").hidden = true;
  document.querySelector(".action-panel").hidden = true;
  settlementPanel.hidden = false;
  settlementActions.hidden = true;
  settlementFinalBid = Number(body.finalBid || 0);
  renderer.setFavoriteItemIds(body.favoritesByPlayer?.[myId] || []);
  renderer.onValueChange = (value) => updateSettlementValues(value);
  renderSettlementInfo(body);
  renderCopiedItems(body.copiedItems || []);
  renderExtraRewards(body.extraRewardsByPlayer?.[myId] || []);
  playSound("firework");
  renderer.animateFullWarehouse(body.warehouseItems || [], 10000).then(() => {
    renderChairReplacement(body.chairReplacement);
    revealDividend(body);
  });
}

function handleSettlementSellResult(body) {
  alert(`\u51fa\u552e\u83b7\u5f97\u4e86 ${formatNumber(body.total || 0)}`);
  socket?.send(JSON.stringify({ type: "return_room" }));
}

function buildSettlementRarityFilter() {
  const filter = document.querySelector("#settlementRarityFilter");
  if (!filter) return;
  filter.innerHTML = levelRarities.map((rarity) => `
    <button class="rarity-diamond" type="button" data-rarity="${rarity}" title="${rarityLabels[rarity]}\u8272\u54c1\u8d28" style="--rarity-color:${rarityColors[rarity]}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 21 12 12 22 3 12Z"></path></svg>
    </button>
  `).join("");
  for (const button of filter.querySelectorAll(".rarity-diamond")) {
    button.addEventListener("click", () => {
      const rarity = button.dataset.rarity;
      if (selectedSettlementRarities.has(rarity)) selectedSettlementRarities.delete(rarity);
      else selectedSettlementRarities.add(rarity);
      button.classList.toggle("is-selected", selectedSettlementRarities.has(rarity));
    });
  }
}

function renderSettlementInfo(body) {
  selectedSettlementRarities.clear();
  for (const button of document.querySelectorAll("#settlementRarityFilter .rarity-diamond")) button.classList.remove("is-selected");
  const winner = body.winner;
  document.querySelector("#finalBidValue").textContent = formatNumber(body.finalBid || 0);
  document.querySelector("#revealedLootValue").textContent = "0";
  updateSettlementValues(0);
  const winnerBox = document.querySelector("#settlementWinner");
  const sellActions = document.querySelector("#winnerSellActions");
  document.querySelector("#dividendText").textContent = "";
  if (!winner) {
    winnerBox.innerHTML = "<p>\u6d41\u62cd\uff0c\u65e0\u4eba\u5f97\u62cd</p>";
    document.querySelector("#finalBidValue").textContent = "-";
    sellActions.hidden = true;
    return;
  }
  const character = characterDefinitions[winner.characterId] || {};
  winnerBox.innerHTML = `<div class="settlement-winner-card">${character.image ? `<img src="${character.image}" alt="" />` : ""}<strong>${escapeHtml(winner.nickname)}</strong><span>${escapeHtml(character.name || winner.characterId || "")}</span></div>`;
  sellActions.hidden = winner.id !== myId;
}

function renderCopiedItems(copiedItems) {
  if (!copiedItems.length) return;
  document.querySelector(".notice-panel").hidden = false;
  const grouped = new Map();
  for (const entry of copiedItems) {
    if (!grouped.has(entry.nickname)) grouped.set(entry.nickname, []);
    grouped.get(entry.nickname).push(entry.item);
  }
  for (const [nickname, items] of grouped) {
    const totalValue = items.reduce((sum, item) => sum + Number(item.price || 0), 0);
    const el = document.createElement("article");
    el.className = "notice copied-loot-notice";
    el.innerHTML = `
      <div class="notice-icon"><img src="/resource/system_message.png" alt="" /></div>
      <div>
        <strong>${escapeHtml(nickname)}\u590d\u5236\u4e86\u4ee5\u4e0b\u7269\u54c1\uff1a</strong>
        <span>\u603b\u4ef7\u503c ${formatNumber(totalValue)}</span>
        <div class="copied-loot-grid">
          ${items.map((item) => `<div class="copied-loot-card" style="--rarity-color:${rarityColors[item.rarity] || rarityColors.gray}"><span>${escapeHtml(item.name || `#${item.id}`)}</span><img src="/resource/auction/${item.id}.png" alt="" /></div>`).join("")}
        </div>
      </div>
    `;
    noticeList.appendChild(el);
  }
}

function renderChairReplacement(chairReplacement) {
  if (!chairReplacement || !Array.isArray(chairReplacement.replacedItems) || !chairReplacement.replacedItems.length) return;
  document.querySelector(".notice-panel").hidden = false;
  const chair = chairReplacement.chairItem || {};
  const el = document.createElement("article");
  el.className = "notice copied-loot-notice";
  el.innerHTML = `
    <div class="notice-icon"><img src="/resource/system_message.png" alt="" /></div>
    <div>
      <strong>\u4ee5\u4e0b\u7269\u54c1\u88ab\u66ff\u6362\u4e3a\u4e86\u6905\u5b50\uff0c\u4f7f\u603b\u4ef7\u503c\u53d8\u5316\u4e86${formatNumber(chairReplacement.delta || 0)}</strong>
      <span>${escapeHtml(chair.name || "\u6905\u5b50")}</span>
      <div class="copied-loot-grid">
        ${chairReplacement.replacedItems.map((item) => copiedLootCard(item)).join("")}
        ${copiedLootCard(chair)}
      </div>
    </div>
  `;
  noticeList.appendChild(el);
}

function copiedLootCard(item) {
  const name = item.name || `#${item.id}`;
  const price = Number(item.price || 0);
  return `<div class="copied-loot-card" title="${escapeHtml(`${name}\n\u4ef7\u503c ${formatNumber(price)}`)}" style="--rarity-color:${rarityColors[item.rarity] || rarityColors.gray}"><span>${escapeHtml(name)}</span><img src="/resource/auction/${item.id}.png" alt="" /></div>`;
}

function renderExtraRewards(rewards) {
  const returnButton = document.querySelector("#returnRoomButton");
  if (!returnButton) return;
  let el = document.querySelector("#extraRewardText");
  if (!el) {
    el = document.createElement("p");
    el.id = "extraRewardText";
    el.className = "extra-reward-text";
    returnButton.insertAdjacentElement("afterend", el);
  }
  const names = (rewards || []).map((item) => item.name || clientItems.get(Number(item.id))?.name || `#${item.id}`);
  el.textContent = names.length ? `\u989d\u5916\u83b7\u5f97\u5956\u52b1\uff1a${names.join(", ")}` : "";
}

function revealDividend(body) {
  document.querySelector("#dividendText").textContent = body.dividend > 0 ? `\u672c\u5c40\u83b7\u5f97\u5206\u7ea2 ${formatNumber(body.dividend || 0)}` : "";
  settlementActions.hidden = false;
}

function updateSettlementValues(value) {
  const loot = Number(value || 0);
  const profit = loot - settlementFinalBid;
  document.querySelector("#revealedLootValue").textContent = formatNumber(loot);
  const profitEl = document.querySelector("#profitValue");
  profitEl.textContent = formatNumber(profit);
  profitEl.classList.toggle("positive", profit > 0);
  profitEl.classList.toggle("negative", profit <= 0);
}

function updateKnownLootValue(value) {
  knownLootValue.textContent = formatNumber(Math.max(0, Number(value || 0)));
}

function addNotice(entry) {
  const el = document.createElement("article");
  el.className = "notice";
  el.innerHTML = `<div class="notice-icon">${entry.icon ? `<img src="${escapeHtml(entry.icon)}" alt="" />` : ""}</div><div><strong>${escapeHtml(entry.title)}</strong><span>${escapeHtml(entry.text)}</span></div>${entry.show ? '<button type="button">\u663e\u793a</button>' : ""}`;
  const button = el.querySelector("button");
  if (button) button.addEventListener("click", () => renderer.showHighlight(entry.message || []));
  noticeList.appendChild(el);
}

function handleHint(entry) {
  renderer.applyHint(entry);
  addNotice(entry);
}

function showMegumiChoice(body) {
  topOverlay.hidden = false;
  const canChooseDomain = body.canChooseDomain !== false;
  topOverlay.innerHTML = `
    <div class="overlay-card choice-card">
      <strong>Megumi \u6289\u62e9</strong>
      <span>${escapeHtml(body.text || "\u8bf7\u9009\u62e9\u672c\u5c40\u6280\u80fd\u8def\u7ebf")}</span>
      <div class="overlay-actions">
        <button type="button" data-choice="domain" ${canChooseDomain ? "" : "disabled"} title="${canChooseDomain ? "" : "\u672c\u5c40\u73a9\u5bb6\u5c11\u4e8e3\u4eba\uff0c\u4e0d\u80fd\u9009\u62e9\u9886\u57df\u5c55\u5f00"}">\u9886\u57df\u5c55\u5f00</button>
        <button type="button" data-choice="makora">\u8ddf\u4f60\u7206\u4e86</button>
      </div>
    </div>
  `;
  topOverlay.querySelectorAll("[data-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      socket?.send(JSON.stringify({ type: "megumi_choice", choice: button.dataset.choice }));
      closeTopOverlay();
    });
  });
}

function showMegumiPrediction(body, { closable = true } = {}) {
  const predictions = {};
  const rows = body.players || [];
  for (const player of rows) predictions[player.id] = "equal";
  topOverlay.hidden = false;
  topOverlay.innerHTML = `
    <div class="overlay-card prediction-card">
      <strong>Makora \u51fa\u4ef7\u9884\u6d4b</strong>
      ${closable ? '<button class="overlay-close" type="button" aria-label="\u5173\u95ed">\u00d7</button>' : ""}
      <table>
        <thead><tr><th>\u73a9\u5bb6\u6635\u79f0</th><th>\u4e0a\u56de\u5408\u51fa\u4ef7</th><th>\u4f60\u7684\u9884\u6d4b</th></tr></thead>
        <tbody>${rows.map((player) => `<tr data-player="${escapeHtml(player.id)}"><td>${escapeHtml(player.nickname)}</td><td>${formatNumber(player.lastBid || 0)}</td><td><button type="button" data-pick="up">\u2191</button><button class="selected" type="button" data-pick="equal">=</button><button type="button" data-pick="down">\u2193</button></td></tr>`).join("")}</tbody>
      </table>
      <button type="button" id="submitPredictionButton">\u63d0\u4ea4</button>
    </div>
  `;
  topOverlay.querySelector(".overlay-close")?.addEventListener("click", closeTopOverlay);
  topOverlay.querySelectorAll("tr[data-player]").forEach((row) => {
    row.querySelectorAll("[data-pick]").forEach((button) => {
      button.addEventListener("click", () => {
        predictions[row.dataset.player] = button.dataset.pick;
        row.querySelectorAll("[data-pick]").forEach((entry) => entry.classList.toggle("selected", entry === button));
      });
    });
  });
  topOverlay.querySelector("#submitPredictionButton")?.addEventListener("click", () => {
    socket?.send(JSON.stringify({ type: "megumi_prediction", predictions }));
    predictionSubmittedThisRound = true;
    updateActionButtons();
    closeTopOverlay();
  });
}

function closeTopOverlay(resolveConfirm = true) {
  if (resolveConfirm && activeConfirmResolve) {
    const resolve = activeConfirmResolve;
    activeConfirmResolve = null;
    resolve(false);
  }
  topOverlay.hidden = true;
  topOverlay.innerHTML = "";
}

function showConfirmDialog({ title, text = "", confirmText = "\u786e\u8ba4", cancelText = "\u53d6\u6d88" }) {
  closeTopOverlay();
  topOverlay.hidden = false;
  topOverlay.innerHTML = `
    <div class="overlay-card confirm-card">
      <strong>${escapeHtml(title)}</strong>
      ${text ? `<span>${escapeHtml(text)}</span>` : ""}
      <div class="overlay-actions">
        <button type="button" data-confirm="yes">${escapeHtml(confirmText)}</button>
        <button type="button" data-confirm="no">${escapeHtml(cancelText)}</button>
      </div>
    </div>
  `;
  return new Promise((resolve) => {
    activeConfirmResolve = resolve;
    topOverlay.querySelectorAll("[data-confirm]").forEach((button) => {
      button.addEventListener("click", () => {
        const result = button.dataset.confirm === "yes";
        if (activeConfirmResolve === resolve) activeConfirmResolve = null;
        closeTopOverlay(false);
        resolve(result);
      });
    });
  });
}

function startCountdown(seconds) {
  stopCountdown();
  remainingSeconds = Math.max(0, Math.ceil(Number(seconds) || 0));
  countdownEndsAt = Date.now() + remainingSeconds * 1000;
  updateTimer();
  countdownTimer = setInterval(() => {
    remainingSeconds = Math.max(0, Math.ceil((countdownEndsAt - Date.now()) / 1000));
    updateTimer();
    if (remainingSeconds <= 0) {
      stopCountdown();
      closeTopOverlay();
      if (pendingTargetUse) completeTargetUse({ x: 0, y: 0 });
      sendBid(0, { skipPredictionConfirm: true });
    }
  }, 1000);
}

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  countdownEndsAt = 0;
}

function updateTimer() {
  const value = Math.max(0, remainingSeconds);
  document.querySelector("#timer").textContent = value;
  updateTransformCountdown();
  if ((value === 10 || value === 5) && !bellPlayedAt.has(value)) {
    bellPlayedAt.add(value);
    playSound("bell", "ogg");
  }
}

function handlePropSlots(body) {
  carriedProps = body.props || carriedProps;
  propUsesThisRound = Number(body.uses || 0);
  maxPropUsesThisRound = Number(body.maxUses || maxPropUsesThisRound || 1);
  propUsePending = false;
  updateActionButtons();
}

function sendUseProp(slot, target = null) {
  if (propUsePending || hasBidThisRound || actionLockedThisRound || animationDepth > 0) return;
  propUsePending = true;
  updateActionButtons();
  socket?.send(JSON.stringify({ type: "use_prop", slot, target }));
}

function completeTargetUse(cell) {
  const pending = pendingTargetUse;
  pendingTargetUse = null;
  if (!pending) return;
  sendUseProp(pending.slot, cell);
}

function requiresTarget(id) {
  return id === "sp_prop1" || id === "sp_prop2" || id === "sp_prop3";
}

async function sendBid(amount, { skipPredictionConfirm = false } = {}) {
  if (hasBidThisRound || actionLockedThisRound) return;
  if (isMakora && predictionAvailable && !predictionSubmittedThisRound && !skipPredictionConfirm) {
    const confirmed = await showConfirmDialog({
      title: "确认直接出价？",
      text: "你还没有提交本回合预测。不发动预测将使用默认预测结果。",
      confirmText: "继续出价",
      cancelText: "返回",
    });
    if (!confirmed || hasBidThisRound || actionLockedThisRound) return;
  }
  const value = Math.max(0, Math.floor(Number(amount) || 0));
  hasBidThisRound = true;
  updateActionButtons();
  if (propDialog.open) propDialog.close();
  socket?.send(JSON.stringify({ type: "bid", amount: value }));
}

function updateActionButtons() {
  document.querySelector("#bidButton").disabled = hasBidThisRound || actionLockedThisRound || animationDepth > 0;
  document.querySelector("#useItemButton").disabled = hasBidThisRound || actionLockedThisRound || propUsePending || propUsesThisRound >= maxPropUsesThisRound || animationDepth > 0;
  if (predictButton) {
    predictButton.hidden = !(isMakora && predictionAvailable);
    predictButton.disabled = hasBidThisRound || actionLockedThisRound || !predictionAvailable || predictionSubmittedThisRound || animationDepth > 0;
  }
  if (transformButton) {
    transformButton.hidden = !(isReiner && !reinerTransformed);
    transformButton.disabled = !canUseReinerTransform();
    updateTransformCountdown();
  }
}

function canUseReinerTransform() {
  if (!isReiner || reinerTransformed || hasBidThisRound || actionLockedThisRound || animationDepth > 0) return false;
  return transformRemainingSeconds() > 0;
}

function transformRemainingSeconds() {
  return Math.max(0, Math.floor(remainingSeconds - Math.ceil(roundInitialSeconds / 2)));
}

function updateTransformCountdown() {
  if (!transformCountdown) return;
  transformCountdown.textContent = String(transformRemainingSeconds());
}

async function playRoundEndAnimations(animations) {
  const token = ++roundEndAnimationToken;
  for (const animation of animations) {
    if (token !== roundEndAnimationToken) break;
    const delay = Math.max(0, Number(animation.delaySeconds || 0) * 1000);
    if (delay) await wait(delay);
    if (token !== roundEndAnimationToken) break;
    await playAnimationSequence([animation], { queueMessages: false });
  }
}

async function playAnimationSequence(animations, { queueMessages = true } = {}) {
  if (!animations.length) return;
  const token = ++animationRunToken;
  animationDepth += queueMessages ? 1 : 0;
  updateActionButtons();
  try {
    for (const animation of animations) {
      if (token !== animationRunToken) break;
      await playSingleAnimation(Number(animation.id), Number(animation.durationSeconds || animationDurations[animation.id] || 1), token);
    }
  } finally {
    if (queueMessages) animationDepth = Math.max(0, animationDepth - 1);
    if (token === animationRunToken) stopCurrentAnimation();
    updateActionButtons();
    flushQueuedMessages();
  }
}

function showTimedOverlay(text, seconds) {
  const token = ++animationRunToken;
  animationDepth += 1;
  updateActionButtons();
  const overlay = createAnimationOverlay();
  overlay.innerHTML = `<div class="overlay-card"><strong>${escapeHtml(text)}</strong><span>${formatNumber(seconds)} \u79d2</span></div>`;
  return wait(seconds * 1000).finally(() => {
    animationDepth = Math.max(0, animationDepth - 1);
    if (token === animationRunToken) stopCurrentAnimation();
    updateActionButtons();
    flushQueuedMessages();
  });
}

async function playSingleAnimation(id, durationSeconds, token = animationRunToken) {
  stopCurrentAnimation();
  if (token !== animationRunToken) return;
  const overlay = createAnimationOverlay();
  showAnimationLoading(overlay, id);
  if (id === 1 || id === 2 || id === 3 || id === 6 || id === 8 || id === 9) {
    const className = id >= 6 ? "centered-webp" : "fullscreen-animation";
    const [img, audio] = await Promise.all([
      createLoadedAnimationImage(animationImageSrc(id), className),
      createReadyAnimationAudio(id),
    ]);
    if (token !== animationRunToken) return;
    overlay.innerHTML = `<div class="webp-center-stage"></div>`;
    overlay.querySelector(".webp-center-stage").appendChild(img);
    await startPreparedAnimationAudio(audio);
    return wait(durationSeconds * 1000);
  }
  if (id === 7) {
    const [img, audio] = await Promise.all([
      createLoadedAnimationImage(animationImageSrc(7), "slide-image-from-left"),
      createReadyAnimationAudio(id),
    ]);
    if (token !== animationRunToken) return;
    const imageWidth = window.innerHeight * (img.naturalWidth / img.naturalHeight || 1);
    img.style.setProperty("--image-width", `${imageWidth}px`);
    overlay.replaceChildren(img);
    await startPreparedAnimationAudio(audio);
    return wait(durationSeconds * 1000);
  }
  if (id === 10) {
    const [leftImg, rightImg, audio] = await Promise.all([
      createLoadedAnimationImage(animationImageSrc("10_1"), "duel-piece duel-left"),
      createLoadedAnimationImage(animationImageSrc("10_2"), "duel-piece duel-right"),
      createReadyAnimationAudio(id),
    ]);
    if (token !== animationRunToken) return;
    const stage = document.createElement("div");
    stage.className = "duel-stage";
    stage.append(leftImg, rightImg);
    overlay.replaceChildren(stage);
    await startPreparedAnimationAudio(audio);
    return wait(durationSeconds * 1000);
  }
  if (id === 4) {
    const [img, audio] = await Promise.all([
      createLoadedAnimationImage(animationImageSrc(4), "slide-animation-image"),
      createReadyAnimationAudio(id),
    ]);
    if (token !== animationRunToken) return;
    const imageWidth = window.innerHeight * (img.naturalWidth / img.naturalHeight || 1);
    img.style.setProperty("--image-width", `${imageWidth}px`);
    const dim = document.createElement("div");
    dim.className = "animation-dim-layer";
    overlay.replaceChildren(dim, img);
    await startPreparedAnimationAudio(audio);
    return wait(durationSeconds * 1000);
  }
  if (id === 5) {
    const [img, audio] = await Promise.all([
      createLoadedAnimationImage(animationImageSrc(5), "fade-center-animation-image"),
      createReadyAnimationAudio(id),
    ]);
    if (token !== animationRunToken) return;
    const dim = document.createElement("div");
    dim.className = "animation-dim-layer";
    overlay.replaceChildren(dim, img);
    setTimeout(() => currentAnimationOverlay === overlay && startPreparedAnimationAudio(audio), 500);
    return wait(durationSeconds * 1000);
  }
  return wait(durationSeconds * 1000);
}

function createAnimationOverlay() {
  stopCurrentAnimation();
  const overlay = document.createElement("div");
  overlay.className = "animation-overlay";
  document.body.appendChild(overlay);
  currentAnimationOverlay = overlay;
  return overlay;
}

function showAnimationLoading(overlay, id) {
  overlay.innerHTML = `
    <div class="animation-loading">
      <strong>\u52a8\u753b\u52a0\u8f7d\u4e2d</strong>
      <span>\u6b63\u5728\u51c6\u5907\u52a8\u753b ${escapeHtml(String(id))}</span>
    </div>
  `;
}

async function createLoadedAnimationImage(src, className) {
  const playableSrc = await getAnimationAssetUrl(src);
  addPreloadLink(src, "image");
  return new Promise((resolve, reject) => {
    const img = buildAnimationImage(className);
    let done = false;
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`Animation image timed out: ${src}`));
    }, 30000);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      animationImageCache.set(src, img);
      if (typeof img.decode === "function") img.decode().then(() => resolve(img)).catch(() => resolve(img));
      else resolve(img);
    };
    img.addEventListener("load", () => {
      finish();
    }, { once: true });
    img.addEventListener("error", () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      reject(new Error(`Animation image failed: ${src}`));
    }, { once: true });
    img.src = playableSrc;
    if (img.complete && img.naturalWidth > 0) finish();
  });
}

function buildAnimationImage(className) {
  const img = new Image();
  img.className = className;
  img.alt = "";
  img.decoding = "async";
  img.loading = "eager";
  return img;
}

async function createReadyAnimationAudio(id) {
  const src = animationAudioSrc(id);
  const playableSrc = await getAnimationAssetUrl(src);
  addPreloadLink(src, "audio");
  return new Promise((resolve) => {
    const audio = new Audio(playableSrc);
    audio.preload = "auto";
    audio.playsInline = true;
    const finish = () => resolve(audio);
    const timeout = setTimeout(finish, 12000);
    audio.addEventListener("canplaythrough", () => {
      clearTimeout(timeout);
      finish();
    }, { once: true });
    audio.addEventListener("loadeddata", () => {
      clearTimeout(timeout);
      finish();
    }, { once: true });
    audio.addEventListener("error", () => {
      clearTimeout(timeout);
      finish();
    }, { once: true });
    audio.load();
  });
}

async function startPreparedAnimationAudio(audio) {
  currentAnimationAudio = audio;
  currentAnimationAudio.currentTime = 0;
  try {
    await currentAnimationAudio.play();
  } catch {
    await wait(120);
    if (currentAnimationAudio === audio) currentAnimationAudio.play().catch(() => {});
  }
}

function preloadAnimations(animations) {
  const ids = animations.map((entry) => Number(entry.id)).filter(Number.isFinite);
  for (const id of ids) preloadAnimation(id);
}

function ensureAnimationReady(id) {
  return preloadAnimation(id);
}

function preloadAnimation(id) {
  const key = Number(id);
  if (animationPreloadPromises.has(key)) return animationPreloadPromises.get(key);
  addAnimationPreloadLinks(key);
  const promise = Promise.all([
    ...animationImageSources(key).map((src) => preloadAnimationImage(src)),
    preloadAnimationAudio(key),
  ]).then(() => true).catch(() => false);
  animationPreloadPromises.set(key, promise);
  return promise;
}

async function preloadAnimationImage(src) {
  addPreloadLink(src, "image");
  const playableSrc = await getAnimationAssetUrl(src);
  const existing = animationImageCache.get(src);
  if (existing?.complete && existing.naturalWidth > 0) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const img = existing || new Image();
    animationImageCache.set(src, img);
    const finish = () => {
      if (typeof img.decode === "function") img.decode().then(() => resolve(img)).catch(() => resolve(img));
      else resolve(img);
    };
    const timeout = setTimeout(() => resolve(img), 8000);
    img.addEventListener("load", () => {
      clearTimeout(timeout);
      finish();
    }, { once: true });
    img.addEventListener("error", () => {
      clearTimeout(timeout);
      resolve(img);
    }, { once: true });
    if (!img.src) img.src = playableSrc;
    else if (img.complete) {
      clearTimeout(timeout);
      finish();
    }
  });
}

async function preloadAnimationAudio(id) {
  const src = animationAudioSrc(id);
  addPreloadLink(src, "audio");
  const playableSrc = await getAnimationAssetUrl(src);
  const existing = animationAudioCache.get(src);
  if (existing && existing.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const audio = existing || new Audio(playableSrc);
    audio.preload = "auto";
    animationAudioCache.set(src, audio);
    const finish = () => resolve(audio);
    const timeout = setTimeout(finish, 8000);
    audio.addEventListener("canplaythrough", () => {
      clearTimeout(timeout);
      finish();
    }, { once: true });
    audio.addEventListener("loadeddata", () => {
      clearTimeout(timeout);
      finish();
    }, { once: true });
    audio.addEventListener("error", () => {
      clearTimeout(timeout);
      finish();
    }, { once: true });
    audio.load();
  });
}

function getAnimationAssetUrl(src) {
  if (animationAssetUrlCache.has(src)) return Promise.resolve(animationAssetUrlCache.get(src));
  if (animationAssetFetchPromises.has(src)) return animationAssetFetchPromises.get(src);
  const promise = fetch(src, { cache: "force-cache" })
    .then((response) => {
      if (!response.ok) throw new Error(`Animation asset fetch failed: ${src}`);
      return response.blob();
    })
    .then((blob) => {
      const objectUrl = URL.createObjectURL(blob);
      animationAssetUrlCache.set(src, objectUrl);
      return objectUrl;
    })
    .catch(() => src);
  animationAssetFetchPromises.set(src, promise);
  return promise;
}

function addAnimationPreloadLinks(id) {
  for (const src of animationImageSources(id)) addPreloadLink(src, "image");
  addPreloadLink(animationAudioSrc(id), "audio");
}

function addPreloadLink(src, asType) {
  const key = `${asType}:${src}`;
  if (animationPreloadLinks.has(key)) return;
  animationPreloadLinks.add(key);
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = asType;
  link.href = src;
  if (asType === "audio") link.type = "audio/mpeg";
  if (asType === "image") link.type = "image/webp";
  document.head.appendChild(link);
}

function animationImageSrc(id) {
  return `/resource/animation/animation_${id}.webp`;
}

function animationImageSources(id) {
  if (Number(id) === 10) return [animationImageSrc("10_1"), animationImageSrc("10_2")];
  return [animationImageSrc(id)];
}

function animationAudioSrc(id) {
  return `/resource/animation/animation_${id}.mp3`;
}

function stopCurrentAnimation() {
  if (currentAnimationOverlay) currentAnimationOverlay.remove();
  currentAnimationOverlay = null;
  if (currentAnimationAudio) {
    currentAnimationAudio.pause();
    currentAnimationAudio.currentTime = 0;
  }
  currentAnimationAudio = null;
}

function forceEndCurrentAnimation() {
  animationRunToken += 1;
  roundEndAnimationToken += 1;
  animationDepth = 0;
  stopCurrentAnimation();
  updateActionButtons();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function preloadSound(name, ext = "mp3") {
  const key = `${name}.${ext}`;
  if (audioCache.has(key)) return audioCache.get(key);
  const audio = new Audio(`/resource/audio/${name}.${ext}`);
  audio.preload = "auto";
  audioCache.set(key, audio);
  return audio;
}

function playSound(name, ext = "mp3") {
  const audio = preloadSound(name, ext);
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

function setupBidPanel() {
  const panel = document.querySelector("#bidPanel");
  panel.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const key = button.dataset.key;
    const action = button.dataset.action;
    if (key) bidInput = String(Number(`${bidInput}${key}` || "0"));
    if (action === "back") bidInput = bidInput.slice(0, -1);
    if (action === "clear") bidInput = "";
    if (action === "ratio") bidInput = String(Math.floor(Number(bidInput || 0) * currentWinRatio()));
    if (action === "divide-ratio") bidInput = String(Math.ceil(Number(bidInput || 0) / currentWinRatio()));
    if (action === "last") bidInput = String(myLastBid());
    updateBidPanel();
  });
  document.querySelector("#confirmBidButton").addEventListener("click", () => {
    sendBid(Number(bidInput || 0));
    if (hasBidThisRound) panel.hidden = true;
  });
  document.querySelector("#closeBidButton").addEventListener("click", () => {
    panel.hidden = true;
  });
}

function openBidPanel() {
  if (hasBidThisRound || animationDepth > 0) return;
  bidInput = "";
  document.querySelector("#bidPanel").hidden = false;
  updateBidPanel();
}

function updateBidPanel() {
  const ratio = currentWinRatio();
  document.querySelector("#ratioButton").textContent = `x${ratio.toFixed(1)}`;
  document.querySelector("#divideRatioButton").textContent = `/${ratio.toFixed(1)}`;
  document.querySelector("#ratioHint").textContent = `\u6ce8\u610f\uff1a\u5f53\u524d\u51fa\u4ef7\u82e5\u9ad8\u4e8e\u7b2c\u4e8c\u540d\u51fa\u4ef7 ${ratio} \u500d\u5219\u76f4\u63a5\u6210\u4ea4`;
  const value = Number(bidInput || 0);
  document.querySelector("#bidNumber").textContent = formatNumber(value);
  document.querySelector("#bidCn").textContent = chineseUnit(value);
  document.querySelector("#confirmBidButton").disabled = false;
}

function currentWinRatio() {
  return [2, 1.6, 1.3, 1.1, 1][Math.max(0, Math.min(4, currentRound - 1))];
}

function myLastBid() {
  const me = currentPlayers.find((player) => player.id === myId);
  if (!me?.roundBids) return 0;
  for (let i = currentRound - 2; i >= 0; i -= 1) if (me.roundBids[i] != null) return me.roundBids[i];
  return 0;
}

function chineseUnit(value) {
  if (value >= 10000) {
    const wan = Math.floor(value / 10000);
    const rest = value % 10000;
    return `${wan}涓?{rest ? rest : ""}`;
  }
  return String(value);
}

function shortNumber(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function propColor(prop) {
  if (!prop) return "rgba(0,0,0,0.42)";
  return rarityColors[prop.rarity || levelRarities[Math.max(0, Math.min(5, (Number(prop.level) || 1) - 1))] || "gray"];
}
