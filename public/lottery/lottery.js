const rarityColors = { red: "#ff6060", gold: "#faff75", purple: "#964aca", blue: "#7b8afc", green: "#95de93", gray: "#c7c7c7" };
const levelRarities = ["gray", "green", "blue", "purple", "gold", "red"];
const state = {
  itemMap: new Map(),
  profileItems: {},
  profileProps: {},
  propDefinitions: {},
  lottery: { slot: null, results: [] },
  recipes: [],
};

let socket = null;
let heartbeatTimer = null;
let batchSelection = new Set();

const lotteryPanel = document.querySelector("#lotteryPanel");
const message = document.querySelector("#message");
const moneyValue = document.querySelector("#moneyValue");

document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button, a")) playSound("click");
}, true);
document.querySelector("#backButton").addEventListener("click", () => backToRoom());

loadItems().then(connect);

function connect() {
  const playerId = new URLSearchParams(location.search).get("playerId") || "";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/lottery-ws?playerId=${encodeURIComponent(playerId)}`);
  socket.addEventListener("open", () => {
    heartbeatTimer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "heartbeat" })), 10_000);
    socket.send(JSON.stringify({ type: "warehouse_clear_notification", kind: "lottery" }));
  });
  socket.addEventListener("close", () => clearInterval(heartbeatTimer));
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "lottery_state") {
      state.profileItems = msg.body.items || {};
      state.profileProps = msg.body.props || {};
      state.propDefinitions = msg.body.propDefinitions || {};
      state.lottery = msg.body.lottery || { slot: null, results: [] };
      state.recipes = msg.body.lotteryRecipes || [];
      moneyValue.textContent = formatNumber(msg.body.money || 0);
      render();
    }
    if (msg.type === "lottery_result") showMessage("抽奖完成");
    if (msg.type === "lottery_collect_result") {
      showMessage(msg.body?.mode === "take" ? "抽奖结果已存入仓库" : `出售获得了 $${formatNumber(msg.body?.total || 0)}`);
    }
    if (msg.type === "lottery_batch_result") {
      closeBatchDialog();
      const total = Number(msg.body?.total || 0);
      const resultCount = (msg.body?.results || []).reduce((sum, entry) => sum + Number(entry.count || 0), 0);
      showMessage(batchResultText(msg.body?.mode, resultCount, total));
    }
    if (msg.type === "error") showMessage(msg.message || "操作失败");
  });
}

function render() {
  const hasResults = (state.lottery.results || []).length > 0;
  const consumables = consumableEntries();
  const heldCount = consumables.reduce((sum, entry) => sum + entry.count, 0);
  const slotItem = state.lottery.slot ? itemById(state.lottery.slot.id) : null;
  const totalValue = lotteryResultTotalValue(state.lottery.results || []);
  lotteryPanel.innerHTML = `
    <section class="lottery-left">
      <button id="favoriteLotteryButton" type="button">一键收藏抽奖道具</button>
      <p>${heldCount > 0 ? `当前有 ${formatNumber(heldCount)} 个抽奖道具` : "当前无抽奖道具"}</p>
      <div class="lottery-consume-slot">${slotItem ? `<img src="${slotItem.image}" alt="" /><strong>${escapeHtml(slotItem.name)}</strong>` : "<span>+</span>"}</div>
      <button id="drawLotteryButton" type="button" ${!state.lottery.slot || hasResults ? "disabled" : ""}>抽奖</button>
      <button id="refillLotteryButton" type="button" ${heldCount <= 0 || state.lottery.slot || hasResults ? "disabled" : ""}>补充道具</button>
      <button id="batchLotteryButton" type="button" ${heldCount <= 0 || hasResults ? "disabled" : ""}>批量抽奖</button>
    </section>
    <section class="lottery-results">
      <div class="lottery-result-grid">${(state.lottery.results || []).map(lotteryResultCard).join("")}</div>
      <footer>
        <strong>总价值 ${formatNumber(totalValue)}</strong>
        <button id="takeLotteryButton" type="button" ${hasResults ? "" : "disabled"}>领取</button>
        <button id="sellLotteryButton" type="button" ${hasResults ? "" : "disabled"}>出售</button>
        <button id="sellUnfavoriteLotteryButton" type="button" ${hasResults ? "" : "disabled"}>出售非收藏</button>
      </footer>
    </section>
  `;
  document.querySelector("#favoriteLotteryButton").addEventListener("click", () => {
    socket?.send(JSON.stringify({ type: "lottery_favorite_consumes" }));
    alert("已收藏所有抽奖道具");
  });
  document.querySelector("#drawLotteryButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "lottery_draw" })));
  document.querySelector("#refillLotteryButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "lottery_refill" })));
  document.querySelector("#batchLotteryButton").addEventListener("click", openBatchDialog);
  document.querySelector("#takeLotteryButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "lottery_collect", mode: "take" })));
  document.querySelector("#sellLotteryButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "lottery_collect", mode: "sell" })));
  document.querySelector("#sellUnfavoriteLotteryButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "lottery_collect", mode: "sell_unfavorite" })));
}

function openBatchDialog() {
  const entries = consumableEntries();
  if (!entries.length) return;
  batchSelection = new Set(entries.map((entry) => String(entry.id)));
  const overlay = document.createElement("div");
  overlay.className = "lottery-dialog-backdrop";
  overlay.id = "batchLotteryDialog";
  overlay.innerHTML = `
    <section class="lottery-dialog">
      <button class="lottery-dialog-close" type="button" aria-label="关闭">×</button>
      <h2>批量抽奖</h2>
      <div class="batch-lottery-grid">${entries.map(batchConsumableCard).join("")}</div>
      <footer>
        <button type="button" data-batch-mode="take">抽取并领取全部</button>
        <button type="button" data-batch-mode="sell">抽取并出售全部</button>
        <button type="button" data-batch-mode="sell_unfavorite">抽取并出售非收藏</button>
      </footer>
    </section>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector(".lottery-dialog-close").addEventListener("click", closeBatchDialog);
  for (const card of overlay.querySelectorAll(".batch-consumable-card")) {
    card.addEventListener("click", () => {
      const id = card.dataset.id;
      if (batchSelection.has(id)) batchSelection.delete(id);
      else batchSelection.add(id);
      card.classList.toggle("selected", batchSelection.has(id));
      updateBatchButtons();
    });
  }
  for (const button of overlay.querySelectorAll("[data-batch-mode]")) {
    button.addEventListener("click", () => {
      if (!batchSelection.size) return;
      socket?.send(JSON.stringify({ type: "lottery_batch", itemIds: [...batchSelection].map(Number), mode: button.dataset.batchMode }));
      overlay.querySelectorAll("button").forEach((entry) => (entry.disabled = true));
    });
  }
  updateBatchButtons();
}

function closeBatchDialog() {
  document.querySelector("#batchLotteryDialog")?.remove();
}

function batchConsumableCard(entry) {
  const item = itemById(entry.id);
  return `
    <button class="batch-consumable-card selected" type="button" data-id="${entry.id}" style="--rarity-color:${rarityColors[item.rarity] || rarityColors.gray}">
      <span class="selected-check">✓</span>
      <img src="${item.image}" alt="" />
      <strong>${escapeHtml(item.name)}</strong>
      <small>x${formatNumber(entry.count)}</small>
    </button>
  `;
}

function updateBatchButtons() {
  const dialog = document.querySelector("#batchLotteryDialog");
  if (!dialog) return;
  for (const button of dialog.querySelectorAll("[data-batch-mode]")) button.disabled = batchSelection.size === 0;
}

function lotteryResultCard(result) {
  const data = lotteryResultData(result);
  return `<article class="lottery-result-card" style="--rarity-color:${rarityColors[data.rarity] || rarityColors.gray}">
    ${data.image ? `<img src="${data.image}" alt="" />` : ""}
    <strong>${escapeHtml(data.name)}</strong>
    <small>${formatNumber(data.price)}</small>
    <span class="count">x${formatNumber(result.count)}</span>
  </article>`;
}

function lotteryResultData(result) {
  if (String(result.class).toLowerCase() === "prop") {
    const prop = state.propDefinitions[result.id] || {};
    return {
      name: prop.name || result.id,
      image: prop.image || "",
      rarity: prop.rarity || levelRarities[Math.max(0, Math.min(5, (Number(prop.level) || 1) - 1))],
      price: Number(prop.price || 0),
    };
  }
  const item = itemById(result.id);
  return { name: item.name, image: item.image, rarity: item.rarity, price: Number(item.price || 0) };
}

function lotteryResultTotalValue(results) {
  return results.reduce((sum, result) => sum + lotteryResultData(result).price * Number(result.count || 0), 0);
}

function lotteryConsumableIds() {
  return [...new Set((state.recipes || []).map((recipe) => Number(recipe.consume)).filter(Boolean))];
}

function consumableEntries() {
  return lotteryConsumableIds()
    .map((id) => ({ id, count: Number(state.profileItems[id]?.count || 0) }))
    .filter((entry) => entry.count > 0);
}

function batchResultText(mode, resultCount, total) {
  if (mode === "take") return `批量抽奖完成，已领取 ${formatNumber(resultCount)} 件结果`;
  if (mode === "sell") return `批量抽奖完成，出售获得了 $${formatNumber(total)}`;
  return `批量抽奖完成，出售非收藏获得了 $${formatNumber(total)}`;
}

async function loadItems() {
  const csv = await fetch("/items.csv", { cache: "no-cache" }).then((response) => response.text());
  state.itemMap = new Map(parseCsv(csv).map((item) => {
    const id = Number(item.id);
    return [id, { ...item, id, price: Number(item.price), image: `/resource/auction/${id}.png` }];
  }));
}

function itemById(id) {
  return state.itemMap.get(Number(id)) || { id, name: `#${id}`, rarity: "gray", price: 0, image: `/resource/auction/${id}.png` };
}

function backToRoom() {
  const id = new URLSearchParams(location.search).get("playerId") || "";
  location.href = `/room${id ? `?playerId=${encodeURIComponent(id)}` : ""}`;
}

function showMessage(text) {
  message.textContent = text;
  setTimeout(() => {
    message.textContent = "";
  }, 3000);
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines.shift());
  return lines.map((line) => Object.fromEntries(parseCsvLine(line).map((cell, index) => [headers[index], cell])));
}

function parseCsvLine(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      value += '"';
      i += 1;
    } else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      cells.push(value.trim());
      value = "";
    } else value += char;
  }
  cells.push(value.trim());
  return cells;
}

function playSound(name) {
  const audio = new Audio(`/resource/audio/${name}.mp3`);
  audio.play().catch(() => {});
}
