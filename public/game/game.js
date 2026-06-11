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
let bellPlayedAt = new Set();
let animationDepth = 0;
let queuedMessages = [];
let currentAnimationOverlay = null;
let currentAnimationAudio = null;

const levelRarities = ["gray", "green", "blue", "purple", "gold", "red"];
const rarityLabels = { gray: "白", green: "绿", blue: "蓝", purple: "紫", gold: "金", red: "红" };
const rarityColors = { red: "#ff6060", gold: "#faff75", purple: "#964aca", blue: "#7b8afc", green: "#95de93", gray: "#c7c7c7" };
const selectedSettlementRarities = new Set();
const audioCache = new Map();
const animationDurations = { 1: 13.92, 2: 9.2, 3: 12, 4: 3.5, 5: 2, 6: 8.75, 7: 5.25, 8: 10.25, 9: 10, 10: 5 };
const animationImageCache = new Map();
const animationAudioCache = new Map();
const animationPreloadPromises = new Map();

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
  if (!selectedSettlementRarities.size) return alert("请至少选择一种品质");
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
  tooltip.innerHTML = `<strong>${escapeHtml(data.name)}</strong><span>${escapeHtml(data.typeLabel)}</span><span>价值 ${formatNumber(data.price)}</span>`;
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
  if (message.type === "error") addNotice({ title: "操作失败", text: message.message || "未知错误", show: false, message: [] });
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
  currentMoney = Number(data.money || 0);
  gameMoney.textContent = formatNumber(currentMoney);
  currentRound = data.round ?? 1;
  actionLockedThisRound = Boolean(data.actionLocked);
  hasBidThisRound = actionLockedThisRound;
  roundNumber.textContent = currentRound;
  warehouseTitle.textContent = data.warehouseName || "战利品仓";
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
        <div>
          <div class="player-name">${index + 1} ${escapeHtml(player.nickname)}${player.disconnected ? "（掉线）" : ""}</div>
          <div class="title">${escapeHtml(player.title || "")}</div>
        </div>
        <div class="last-bid">${renderBidStatus(player)}</div>
      </div>
      <div class="round-items">
        ${Array.from({ length: 5 }, (_, round) => renderRoundSlot(player, round)).join("")}
      </div>
    </article>
  `).join("");
}

function renderRoundSlot(player, round) {
  const bid = player.roundBids?.[round];
  const prop = player.usedProps?.[round];
  const def = prop ? (propDefinitions[prop.id] || {}) : null;
  const propName = prop ? (def.name || prop.id) : "未使用道具";
  const title = `${prop ? `${propName} Lv.${def.level || prop.level || 1}` : propName}${bid == null ? "" : `\n准确出价 ${formatNumber(bid)}`}`;
  return `<div class="round-slot" title="${escapeHtml(title)}"><i style="--prop-bg:${propColor(def)}">${def?.image ? `<img src="${def.image}" alt="" />` : prop ? "道具" : ""}</i><span>${round + 1}</span><small>${bid == null ? "" : shortNumber(bid)}</small></div>`;
}

function renderBidStatus(player) {
  if (showRoundResults && player.lastBid != null) return formatNumber(player.lastBid);
  if (player.bidPending) return "已出价";
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
    addNotice({ title: "操作失败", text: hasBidThisRound ? "出价后不能使用道具" : "本回合已达到道具使用次数上限", show: false, message: [] });
    return;
  }
  propChoices.innerHTML = carriedProps.map((prop, index) => {
    if (!prop) return "";
    const def = propDefinitions[prop.id] || {};
    const name = def.name || prop.id;
    const description = def.description || "暂无说明";
    return `
      <button class="prop-choice" type="button" data-slot="${index}" title="${escapeHtml(description)}" style="--prop-bg:${propColor(def)}">
        ${def.image ? `<img src="${def.image}" alt="${escapeHtml(name)}" />` : "<span></span>"}
        <span><strong>${escapeHtml(name)} Lv.${prop.level || def.level || 1}</strong><span>${escapeHtml(description)}</span>${prop.temporary ? '<em class="temporary-label">临时</em>' : ""}</span>
        <span>第${index + 1}格</span>
      </button>
    `;
  }).join("") || "<p>没有可用道具</p>";
  for (const button of propChoices.querySelectorAll(".prop-choice")) {
    button.addEventListener("click", () => {
      const slot = Number(button.dataset.slot);
      const prop = carriedProps[slot];
      const def = propDefinitions[prop.id] || {};
      const name = def.name || prop.id;
      if (!confirm(`确认使用道具【${name}】吗？\n${def.description || ""}`)) return;
      playSound("splash", "ogg");
      propDialog.close();
      if (requiresTarget(prop.id)) {
        pendingTargetUse = { slot, propId: prop.id };
        addNotice({ title: "道具目标", text: "请选择一个战利品仓格子", show: false, message: [] });
      } else {
        sendUseProp(slot);
      }
    });
  }
  propDialog.showModal();
}

function handleRoundStart(body) {
  currentRound = body.round;
  actionLockedThisRound = Boolean(body.actionLocked);
  hasBidThisRound = actionLockedThisRound;
  propUsesThisRound = 0;
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
  renderPlayers(currentPlayers);
  playRoundEndAnimations(body.animations || []);
  const pauseMs = Math.max(0, Number(body.pauseSeconds || 3) * 1000);
  roundResultTimer = setTimeout(() => {
    showRoundResults = false;
    renderPlayers(currentPlayers);
  }, pauseMs);
}

function handleSetRoundTimer(body) {
  if (Number(body.countdownSeconds) >= 0) startCountdown(Number(body.countdownSeconds));
}

function handleRoundPause(body) {
  stopCountdown();
  const animations = Array.isArray(body.animations) ? body.animations : [];
  const fallbackSeconds = Math.max(0, Number(body.pauseSeconds || 0));
  const playback = animations.length ? playAnimationSequence(animations) : showTimedOverlay("回合时间暂停", fallbackSeconds);
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
  alert(`出售获得了 ${formatNumber(body.total || 0)}`);
  socket?.send(JSON.stringify({ type: "return_room" }));
}

function buildSettlementRarityFilter() {
  const filter = document.querySelector("#settlementRarityFilter");
  if (!filter) return;
  filter.innerHTML = levelRarities.map((rarity) => `
    <button class="rarity-diamond" type="button" data-rarity="${rarity}" title="${rarityLabels[rarity]}色品质" style="--rarity-color:${rarityColors[rarity]}">
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
    winnerBox.innerHTML = "<p>流拍，无人得拍</p>";
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
        <strong>${escapeHtml(nickname)}复制了以下物品：</strong>
        <span>总价值 ${formatNumber(totalValue)}</span>
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
      <strong>以下物品被替换为了椅子，使总价值变化了${formatNumber(chairReplacement.delta || 0)}</strong>
      <span>${escapeHtml(chair.name || "椅子")}</span>
      <div class="copied-loot-grid">
        ${chairReplacement.replacedItems.map((item) => copiedLootCard(item)).join("")}
        ${copiedLootCard(chair)}
      </div>
    </div>
  `;
  noticeList.appendChild(el);
  updateSettlementValues(renderer.revealedValue() + Number(chairReplacement.delta || 0));
}

function copiedLootCard(item) {
  const name = item.name || `#${item.id}`;
  const price = Number(item.price || 0);
  return `<div class="copied-loot-card" title="${escapeHtml(`${name}\n价值 ${formatNumber(price)}`)}" style="--rarity-color:${rarityColors[item.rarity] || rarityColors.gray}"><span>${escapeHtml(name)}</span><img src="/resource/auction/${item.id}.png" alt="" /></div>`;
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
  el.textContent = names.length ? `额外获得奖励：${names.join(", ")}` : "";
}

function revealDividend(body) {
  document.querySelector("#dividendText").textContent = body.dividend > 0 ? `本局获得分红 ${formatNumber(body.dividend || 0)}` : "";
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
  el.innerHTML = `<div class="notice-icon">${entry.icon ? `<img src="${escapeHtml(entry.icon)}" alt="" />` : ""}</div><div><strong>${escapeHtml(entry.title)}</strong><span>${escapeHtml(entry.text)}</span></div>${entry.show ? '<button type="button">显示</button>' : ""}`;
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
      <strong>Megumi 抉择</strong>
      <span>${escapeHtml(body.text || "请选择本局技能路线。")}</span>
      <div class="overlay-actions">
        <button type="button" data-choice="domain" ${canChooseDomain ? "" : "disabled"} title="${canChooseDomain ? "" : "本局玩家少于3人，不能选择领域展开"}">领域展开</button>
        <button type="button" data-choice="makora">跟你爆了</button>
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
      <strong>Makora 出价预测</strong>
      ${closable ? '<button class="overlay-close" type="button" aria-label="关闭">×</button>' : ""}
      <table>
        <thead><tr><th>玩家昵称</th><th>上回合出价</th><th>你的预测</th></tr></thead>
        <tbody>${rows.map((player) => `<tr data-player="${escapeHtml(player.id)}"><td>${escapeHtml(player.nickname)}</td><td>${formatNumber(player.lastBid || 0)}</td><td><button type="button" data-pick="up">↑</button><button class="selected" type="button" data-pick="equal">=</button><button type="button" data-pick="down">↓</button></td></tr>`).join("")}</tbody>
      </table>
      <button type="button" id="submitPredictionButton">提交</button>
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

function closeTopOverlay() {
  topOverlay.hidden = true;
  topOverlay.innerHTML = "";
}

function startCountdown(seconds) {
  stopCountdown();
  remainingSeconds = Math.max(0, Number(seconds) || 0);
  updateTimer();
  countdownTimer = setInterval(() => {
    remainingSeconds -= 1;
    updateTimer();
    if (remainingSeconds <= 0) {
      stopCountdown();
      if (pendingTargetUse) completeTargetUse({ x: 0, y: 0 });
      sendBid(0, { skipPredictionConfirm: true });
    }
  }, 1000);
}

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
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
  updateActionButtons();
}

function sendUseProp(slot, target = null) {
  propUsesThisRound += 1;
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

function sendBid(amount, { skipPredictionConfirm = false } = {}) {
  if (hasBidThisRound || actionLockedThisRound) return;
  if (isMakora && predictionAvailable && !predictionSubmittedThisRound && !skipPredictionConfirm) {
    if (!confirm("你还没有提交本回合预测。不发动预测将使用默认预测结果，确定继续出价吗？")) return;
  }
  const value = Math.max(0, Math.floor(Number(amount) || 0));
  hasBidThisRound = true;
  updateActionButtons();
  if (propDialog.open) propDialog.close();
  socket?.send(JSON.stringify({ type: "bid", amount: value }));
}

function updateActionButtons() {
  document.querySelector("#bidButton").disabled = hasBidThisRound || actionLockedThisRound || animationDepth > 0;
  document.querySelector("#useItemButton").disabled = hasBidThisRound || actionLockedThisRound || propUsesThisRound >= maxPropUsesThisRound || animationDepth > 0;
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
  for (const animation of animations) {
    const delay = Math.max(0, Number(animation.delaySeconds || 0) * 1000);
    if (delay) await wait(delay);
    await playAnimationSequence([animation], { queueMessages: false });
  }
}

async function playAnimationSequence(animations, { queueMessages = true } = {}) {
  if (!animations.length) return;
  animationDepth += queueMessages ? 1 : 0;
  updateActionButtons();
  try {
    for (const animation of animations) await playSingleAnimation(Number(animation.id), Number(animation.durationSeconds || animationDurations[animation.id] || 1));
  } finally {
    if (queueMessages) animationDepth -= 1;
    stopCurrentAnimation();
    updateActionButtons();
    flushQueuedMessages();
  }
}

function showTimedOverlay(text, seconds) {
  animationDepth += 1;
  updateActionButtons();
  const overlay = createAnimationOverlay();
  overlay.innerHTML = `<div class="overlay-card"><strong>${escapeHtml(text)}</strong><span>${formatNumber(seconds)} 秒</span></div>`;
  return wait(seconds * 1000).finally(() => {
    animationDepth -= 1;
    stopCurrentAnimation();
    updateActionButtons();
    flushQueuedMessages();
  });
}

async function playSingleAnimation(id, durationSeconds) {
  await ensureAnimationReady(id);
  stopCurrentAnimation();
  const overlay = createAnimationOverlay();
  if (id === 1 || id === 2 || id === 3 || id === 6 || id === 8 || id === 9) {
    const className = id >= 6 ? "centered-webp" : "fullscreen-animation";
    overlay.innerHTML = `<div class="webp-center-stage"><img class="${className}" src="${animationImageSrc(id)}" alt="" /></div>`;
    playAnimationAudio(id);
    return wait(durationSeconds * 1000);
  }
  if (id === 7) {
    overlay.innerHTML = `<img class="slide-image-from-left" src="${animationImageSrc(7)}" alt="" />`;
    const img = overlay.querySelector("img");
    img.addEventListener("load", () => {
      const imageWidth = window.innerHeight * (img.naturalWidth / img.naturalHeight || 1);
      img.style.setProperty("--image-width", `${imageWidth}px`);
    }, { once: true });
    playAnimationAudio(id);
    return wait(durationSeconds * 1000);
  }
  if (id === 10) {
    overlay.innerHTML = `
      <div class="duel-stage">
        <img class="duel-piece duel-left" src="${animationImageSrc("10_1")}" alt="" />
        <img class="duel-piece duel-right" src="${animationImageSrc("10_2")}" alt="" />
      </div>
    `;
    playAnimationAudio(id);
    return wait(durationSeconds * 1000);
  }
  if (id === 4) {
    overlay.innerHTML = `<div class="animation-dim-layer"></div><img class="slide-animation-image" src="${animationImageSrc(4)}" alt="" />`;
    const img = overlay.querySelector("img");
    img.addEventListener("load", () => {
      const imageWidth = window.innerHeight * (img.naturalWidth / img.naturalHeight || 1);
      img.style.setProperty("--image-width", `${imageWidth}px`);
    }, { once: true });
    playAnimationAudio(id);
    return wait(durationSeconds * 1000);
  }
  if (id === 5) {
    overlay.innerHTML = `<div class="animation-dim-layer"></div><img class="fade-center-animation-image" src="${animationImageSrc(5)}" alt="" />`;
    setTimeout(() => currentAnimationOverlay === overlay && playAnimationAudio(id), 500);
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

function playAnimationAudio(id) {
  const cached = animationAudioCache.get(id);
  currentAnimationAudio = cached ? cached.cloneNode(true) : new Audio(animationAudioSrc(id));
  currentAnimationAudio.preload = "auto";
  currentAnimationAudio.currentTime = 0;
  currentAnimationAudio.play().catch(() => {});
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
  const promise = Promise.all([
    ...animationImageSources(key).map((src) => preloadAnimationImage(src)),
    preloadAnimationAudio(key),
  ]).then(() => true).catch(() => false);
  animationPreloadPromises.set(key, promise);
  return promise;
}

function preloadAnimationImage(src) {
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
    if (!img.src) img.src = src;
    else if (img.complete) {
      clearTimeout(timeout);
      finish();
    }
  });
}

function preloadAnimationAudio(id) {
  const existing = animationAudioCache.get(id);
  if (existing && existing.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const audio = existing || new Audio(animationAudioSrc(id));
    audio.preload = "auto";
    animationAudioCache.set(id, audio);
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
  document.querySelector("#ratioHint").textContent = `注意：当前出价若高于第二名出价 ${ratio} 倍则直接成交`;
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
    return `${wan}万${rest ? rest : ""}`;
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
