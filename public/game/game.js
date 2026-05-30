import { WarehouseCanvas, loadClientItems } from "/common/warehouseCanvas.js";

const playersEl = document.querySelector("#players");
const noticeList = document.querySelector("#noticeList");
const canvas = document.querySelector("#warehouseCanvas");
const tooltip = document.querySelector("#canvasTooltip");
const warehouseTitle = document.querySelector(".warehouse-head h1");
const roundNumber = document.querySelector("#roundNumber");
const propDialog = document.querySelector("#propDialog");
const propChoices = document.querySelector("#propChoices");
const settlementPanel = document.querySelector("#settlementPanel");
const settlementActions = document.querySelector("#settlementActions");
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
let currentMoney = 0;
let settlementFinalBid = 0;
let hasBidThisRound = false;
let hasUsedPropThisRound = false;
let settlementTimer = null;
let showRoundResults = false;
let roundResultTimer = null;
const levelRarities = ["gray", "green", "blue", "purple", "gold", "red"];
const rarityLabels = { gray: "白", green: "绿", blue: "蓝", purple: "紫", gold: "金", red: "红" };
const rarityColors = { red: "#ff6060", gold: "#faff75", purple: "#964aca", blue: "#7b8afc", green: "#95de93", gray: "#c7c7c7" };
const audioCache = new Map();
const selectedSettlementRarities = new Set();

for (const [name, ext] of [["click", "mp3"], ["chest", "mp3"], ["orb", "mp3"], ["firework", "mp3"], ["splash", "ogg"]]) preloadSound(name, ext);
document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button, a")) playSound("click");
}, true);
document.addEventListener("warehouse-image-loaded", () => renderer.render());
loadClientItems().then((items) => renderer.setItems(items));
connectGameSocket();
setupBidPanel();
buildSettlementRarityFilter();

document.querySelector("#useItemButton").addEventListener("click", openPropDialog);
document.querySelector("#bidButton").addEventListener("click", openBidPanel);
document.querySelector("#sellAllLootButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "settlement_sell", mode: "all" })));
document.querySelector("#sellUnfavoriteLootButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "settlement_sell", mode: "unfavorite" })));
document.querySelector("#sellRarityLootButton").addEventListener("click", () => {
  if (!selectedSettlementRarities.size) {
    alert("请至少选择一种品质");
    return;
  }
  socket?.send(JSON.stringify({ type: "settlement_sell", mode: "rarity", rarities: [...selectedSettlementRarities] }));
});
document.querySelector("#returnRoomButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "return_room" })));

canvas.addEventListener("click", (event) => {
  const cell = renderer.cellFromEvent(event);
  if (!cell) return;
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
  tooltip.innerHTML = `
    <strong>${escapeHtml(data.name)}</strong>
    <span>${escapeHtml(data.typeLabel)}</span>
    <span>价值 ${formatNumber(data.price)}</span>
  `;
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
    heartbeatTimer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "heartbeat" })), 10_000);
  });
  socket.addEventListener("close", () => clearInterval(heartbeatTimer));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "game_init") renderInit(message.body);
    if (message.type === "hint") handleHint(message);
    if (message.type === "notice") addNotice(message);
    if (message.type === "round_start") handleRoundStart(message.body);
    if (message.type === "bid_submitted") handleBidSubmitted(message.body);
    if (message.type === "round_end") handleRoundEnd(message.body);
    if (message.type === "public_state") handlePublicState(message.body);
    if (message.type === "game_over") handleGameOver(message.body);
    if (message.type === "settlement_sell_result") handleSettlementSellResult(message.body);
    if (message.type === "return_room") location.href = message.body?.url || `/room?playerId=${encodeURIComponent(myId)}`;
    if (message.type === "error") addNotice({ title: "操作失败", text: message.message || "未知错误", show: false, message: [] });
  });
}

function renderInit(data) {
  myId = data.playerId || myId;
  propDefinitions = data.propDefinitions || {};
  characterDefinitions = data.characterDefinitions || {};
  carriedProps = data.carriedProps || [];
  currentMoney = Number(data.money || 0);
  currentRound = data.round ?? 1;
  roundNumber.textContent = currentRound;
  warehouseTitle.textContent = data.warehouseName || "战利品仓";
  noticeList.innerHTML = "";
  renderPlayers(data.players || []);
  for (const notice of data.notices || []) addNotice(notice);
  playSound("chest");
}

function renderPlayers(players) {
  const sorted = [...players].sort((a, b) => {
    if (a.id === myId) return 1;
    if (b.id === myId) return -1;
    return a.nickname.localeCompare(b.nickname, "zh-CN");
  });
  currentPlayers = sorted;
  playersEl.innerHTML = sorted
    .map((player, index) => `
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
          ${Array.from({ length: 5 }, (_, round) => {
            const bid = player.roundBids?.[round];
            const prop = player.usedProps?.[round];
            const def = prop ? (propDefinitions[prop.id] || {}) : null;
            const propName = prop ? (def.name || prop.id) : "未使用道具";
            const title = `${prop ? `${propName} Lv.${def.level || prop.level || 1}` : propName}${bid == null ? "" : `\n准确出价 ${formatNumber(bid)}`}`;
            return `<div class="round-slot" title="${escapeHtml(title)}"><i style="--prop-bg:${propColor(def)}">${def?.image ? `<img src="${def.image}" alt="" />` : prop ? "道" : ""}</i><span>${round + 1}</span><small>${bid == null ? "" : shortNumber(bid)}</small></div>`;
          }).join("")}
        </div>
      </article>
    `)
    .join("");
}

function renderBidStatus(player) {
  if (showRoundResults && player.lastBid != null) return formatNumber(player.lastBid);
  if (player.bidPending) return "\u5df2\u51fa\u4ef7";
  return "";
}

function renderPlayerAvatar(player) {
  const character = characterDefinitions[player.characterId] || {};
  const description = character.description || character.text || character.skill || "";
  const image = character.image ? `<img src="${escapeHtml(character.image)}" alt="${escapeHtml(character.name || player.characterId || "")}" />` : "";
  return `<div class="avatar" title="${escapeHtml(description)}">${image}</div>`;
}

function openPropDialog() {
  if (hasBidThisRound || hasUsedPropThisRound) {
    addNotice({ title: "操作失败", text: hasBidThisRound ? "出价后不能使用道具" : "本回合已经使用过道具", show: false, message: [] });
    return;
  }
  propChoices.innerHTML = carriedProps
    .map((prop, index) => {
      if (!prop) return "";
      const def = propDefinitions[prop.id] || {};
      const name = def.name || prop.id;
      const description = def.description || "暂无说明";
      return `
        <button class="prop-choice" type="button" data-slot="${index}" title="${escapeHtml(description)}" style="--prop-bg:${propColor(def)}">
          ${def.image ? `<img src="${def.image}" alt="${escapeHtml(name)}" />` : "<span></span>"}
          <span><strong>${escapeHtml(name)} Lv.${prop.level || 1}</strong><span>${escapeHtml(description)}</span></span>
          <span>第${index + 1}格</span>
        </button>
      `;
    })
    .join("") || "<p>没有可用道具</p>";
  for (const button of propChoices.querySelectorAll(".prop-choice")) {
    button.addEventListener("click", () => {
      const slot = Number(button.dataset.slot);
      const prop = carriedProps[slot];
      const def = propDefinitions[prop.id] || {};
      const name = def.name || prop.id;
      if (confirm(`确认使用道具【${name}】吗？\n${def.description || ""}`)) {
        hasUsedPropThisRound = true;
        document.querySelector("#useItemButton").disabled = true;
        playSound("splash", "ogg");
        socket?.send(JSON.stringify({ type: "use_prop", slot }));
        propDialog.close();
      }
    });
  }
  propDialog.showModal();
}

function handleRoundStart(body) {
  currentRound = body.round;
  hasBidThisRound = false;
  hasUsedPropThisRound = false;
  document.querySelector("#bidButton").disabled = false;
  document.querySelector("#useItemButton").disabled = false;
  roundNumber.textContent = currentRound;
  showRoundResults = false;
  clearTimeout(roundResultTimer);
  for (const player of currentPlayers) {
    player.bidPending = false;
    player.lastBid = null;
  }
  renderPlayers(currentPlayers);
  startCountdown(body.countdownSeconds || 60);
}

function handleBidSubmitted(body) {
  const player = currentPlayers.find((entry) => entry.id === body.playerId);
  if (body.playerId === myId) {
    hasBidThisRound = true;
    document.querySelector("#bidButton").disabled = true;
    document.querySelector("#useItemButton").disabled = true;
    document.querySelector("#bidPanel").hidden = true;
    propDialog.close();
  }
  if (player) {
    player.bidPending = true;
    renderPlayers(currentPlayers);
  }
}

function handleRoundEnd(body) {
  playSound("orb");
  stopCountdown();
  showRoundResults = true;
  clearTimeout(roundResultTimer);
  hasBidThisRound = true;
  document.querySelector("#bidButton").disabled = true;
  document.querySelector("#useItemButton").disabled = true;
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
  roundResultTimer = setTimeout(() => {
    showRoundResults = false;
    renderPlayers(currentPlayers);
  }, 3000);
}

function handlePublicState(body) {
  currentRound = body.round || currentRound;
  roundNumber.textContent = currentRound;
  const players = body.players || currentPlayers;
  if (body.clearBidState) for (const player of players) player.bidPending = false;
  else for (const player of players) player.bidPending = Boolean(player.submitted?.[currentRound - 1]);
  renderPlayers(players);
}

function handleGameOver(body) {
  stopCountdown();
  clearTimeout(settlementTimer);
  document.querySelector("#bidButton").disabled = true;
  document.querySelector("#useItemButton").disabled = true;
  settlementTimer = setTimeout(() => showSettlement(body), 3000);
}

function showSettlement(body) {
  document.querySelector("#players").hidden = true;
  document.querySelector(".notice-panel").hidden = true;
  document.querySelector(".action-panel").hidden = true;
  settlementPanel.hidden = false;
  settlementActions.hidden = false;
  settlementFinalBid = Number(body.finalBid || 0);
  renderer.setFavoriteItemIds(body.favoritesByPlayer?.[myId] || []);
  renderer.onValueChange = (value) => updateSettlementValues(value);
  renderSettlementInfo(body);
  playSound("firework");
  renderer.animateFullWarehouse(body.warehouseItems || [], 10000).then(() => revealDividend(body));
}

function handleSettlementSellResult(body) {
  alert(`本次出售所得金额：${formatNumber(body?.total || 0)}`);
  socket?.send(JSON.stringify({ type: "return_room" }));
}

function buildSettlementRarityFilter() {
  const filter = document.querySelector("#settlementRarityFilter");
  if (!filter) return;
  filter.innerHTML = levelRarities
    .map((rarity) => `
      <button class="rarity-diamond" type="button" data-rarity="${rarity}" title="${rarityLabels[rarity]}色品质" style="--rarity-color:${rarityColors[rarity]}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 21 12 12 22 3 12Z"></path></svg>
      </button>
    `)
    .join("");
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
  winnerBox.innerHTML = `
    <div class="settlement-winner-card">
      ${character.image ? `<img src="${character.image}" alt="" />` : ""}
      <strong>${escapeHtml(winner.nickname)}</strong>
      <span>${escapeHtml(character.name || winner.characterId || "")}</span>
    </div>
  `;
  if (winner.id === myId) {
    sellActions.hidden = false;
  } else {
    sellActions.hidden = true;
  }
}

function revealDividend(body) {
  const dividendEl = document.querySelector("#dividendText");
  dividendEl.textContent = body.dividend > 0 ? `本局获得分红 ${formatNumber(body.dividend || 0)}` : "";
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

function addNotice(entry) {
  const el = document.createElement("article");
  el.className = "notice";
  el.innerHTML = `
    <div class="notice-icon">${entry.icon ? `<img src="${escapeHtml(entry.icon)}" alt="" />` : ""}</div>
    <div><strong>${escapeHtml(entry.title)}</strong><span>${escapeHtml(entry.text)}</span></div>
    ${entry.show ? '<button type="button">显示</button>' : ""}
  `;
  const button = el.querySelector("button");
  if (button) button.addEventListener("click", () => renderer.showHighlight(entry.message || []));
  noticeList.appendChild(el);
}

function handleHint(entry) {
  renderer.applyHint(entry);
  addNotice(entry);
}

function startCountdown(seconds) {
  stopCountdown();
  remainingSeconds = seconds;
  updateTimer();
  countdownTimer = setInterval(() => {
    remainingSeconds -= 1;
    updateTimer();
    if (remainingSeconds <= 0) {
      stopCountdown();
      sendBid(0);
    }
  }, 1000);
}

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
}

function updateTimer() {
  document.querySelector("#timer").textContent = Math.max(0, remainingSeconds);
}

function sendBid(amount) {
  const value = Math.max(0, Math.floor(Number(amount) || 0));
  if (value > currentMoney) {
    addNotice({ title: "出价失败", text: "出价不能超过当前金钱", show: false, message: [] });
    return;
  }
  hasBidThisRound = true;
  document.querySelector("#bidButton").disabled = true;
  document.querySelector("#useItemButton").disabled = true;
  propDialog.close();
  socket?.send(JSON.stringify({ type: "bid", amount: value }));
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
    if (action === "last") bidInput = String(myLastBid());
    updateBidPanel();
  });
  document.querySelector("#confirmBidButton").addEventListener("click", () => {
    sendBid(Number(bidInput || 0));
    panel.hidden = true;
  });
  document.querySelector("#closeBidButton").addEventListener("click", () => {
    panel.hidden = true;
  });
}

function openBidPanel() {
  if (hasBidThisRound) return;
  const panel = document.querySelector("#bidPanel");
  bidInput = "";
  panel.hidden = false;
  updateBidPanel();
}

function updateBidPanel() {
  const ratio = currentWinRatio();
  document.querySelector("#ratioButton").textContent = `x${ratio.toFixed(1)}`;
  document.querySelector("#ratioHint").textContent = `注意: 当前出价若高于第二名出价${ratio}倍则直接成交`;
  const value = Number(bidInput || 0);
  document.querySelector("#bidNumber").textContent = formatNumber(value);
  document.querySelector("#bidCn").textContent = chineseUnit(value);
  document.querySelector("#confirmBidButton").disabled = value > currentMoney;
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
  return rarityColors[levelRarities[(Number(prop.level) || 1) - 1] || "gray"];
}
