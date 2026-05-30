const rarityColors = { red: "#ff6060", gold: "#faff75", purple: "#964aca", blue: "#7b8afc", green: "#95de93", gray: "#c7c7c7" };
const levelRarities = ["gray", "green", "blue", "purple", "gold", "red"];
const audioCache = new Map();
const itemTypes = ["decoration", "ore", "tool", "equipment", "natural", "food", "tech", "magic", "mob", "book", "multiblock", "loot"];
const typeLabels = {
  decoration: "装饰",
  ore: "矿物",
  tool: "工具",
  equipment: "装备",
  natural: "自然",
  food: "食物",
  tech: "科技",
  magic: "魔法",
  mob: "生物",
  book: "书籍",
  multiblock: "多方块",
  loot: "战利品",
};

const state = { allItems: [], profileItems: {}, profileProps: {}, propDefinitions: {}, selected: new Set(), kind: "items" };
const itemsGrid = document.querySelector("#itemsGrid");
const moneyValue = document.querySelector("#moneyValue");
const message = document.querySelector("#message");
const selectedTotal = document.querySelector("#selectedTotal");
const kindSelect = document.querySelector("#kindSelect");
const sortSelect = document.querySelector("#sortSelect");

preloadSound("click");
document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button, a")) playSound("click");
}, true);
const searchInput = document.querySelector("#searchInput");

let socket = null;
let heartbeatTimer = null;

buildFilters();
loadItems().then(connectWarehouse);

document.querySelector("#backButton").addEventListener("click", () => {
  const playerId = new URLSearchParams(location.search).get("playerId") || "";
  location.href = `/room${playerId ? `?playerId=${encodeURIComponent(playerId)}` : ""}`;
});
document.querySelector("#queryButton").addEventListener("click", render);
kindSelect.addEventListener("change", () => {
  state.kind = kindSelect.value;
  state.selected.clear();
  render();
});
sortSelect.addEventListener("change", render);
document.querySelector("#selectAllButton").addEventListener("click", () => {
  for (const entry of currentEntries()) state.selected.add(String(entry.id));
  render();
});
document.querySelector("#clearSelectionButton").addEventListener("click", () => {
  state.selected.clear();
  render();
});
document.querySelector("#selectUnfavoriteButton").addEventListener("click", () => {
  state.selected.clear();
  for (const entry of currentEntries()) if (!entry.collected) state.selected.add(String(entry.id));
  render();
});
document.querySelector("#sellAllButton").addEventListener("click", () => sellSelected(null));
document.querySelector("#sellPartialButton").addEventListener("click", () => {
  const quantity = Number(prompt("每种物品出售多少个？"));
  if (Number.isInteger(quantity) && quantity > 0) sellSelected(quantity);
});
document.querySelector("#toggleFavoriteButton").addEventListener("click", () => {
  if (state.kind !== "items") return showMessage("道具不能收藏");
  for (const id of state.selected) socket?.send(JSON.stringify({ type: "toggle_favorite", itemId: Number(id) }));
});

function connectWarehouse() {
  const playerId = new URLSearchParams(location.search).get("playerId") || "";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/warehouse-ws?playerId=${encodeURIComponent(playerId)}`);
  socket.addEventListener("open", () => {
    heartbeatTimer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "heartbeat" })), 10_000);
  });
  socket.addEventListener("close", () => clearInterval(heartbeatTimer));
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "warehouse_state") {
      state.profileItems = msg.body.items || {};
      state.profileProps = msg.body.props || {};
      state.propDefinitions = msg.body.propDefinitions || {};
      moneyValue.textContent = formatNumber(msg.body.money);
      render();
    }
    if (msg.type === "sell_result") showMessage(`出售获得 ${formatNumber(msg.body.total)}`);
    if (msg.type === "error") showMessage(msg.message || "操作失败");
  });
}

async function loadItems() {
  const csv = await fetch("/items.csv", { cache: "no-cache" }).then((r) => r.text());
  state.allItems = parseCsv(csv).map((item) => {
    const id = Number(item.id);
    const types = splitTypes(item.type);
    return {
      ...item,
      id,
      types,
      typeLabel: types.map((type) => typeLabels[type] || type).join(";"),
      width: Number(item.width),
      height: Number(item.height),
      price: Number(item.price),
      image: `/resource/auction/${id}.png`,
    };
  });
}

function currentEntries() {
  if (state.kind === "props") {
    return Object.entries(state.profileProps)
      .filter(([, count]) => count > 0)
      .map(([id, count]) => ({
        id,
        name: state.propDefinitions[id]?.name || id,
        typeLabel: "道具",
        rarity: levelRarities[(Number(state.propDefinitions[id]?.level) || 1) - 1] || "gray",
        price: Number(state.propDefinitions[id]?.price || 0),
        count,
        image: state.propDefinitions[id]?.image || "",
        level: Number(state.propDefinitions[id]?.level || 1),
        collected: false,
      }));
  }

  const rarity = document.querySelector('input[name="rarity"]:checked')?.value;
  const type = document.querySelector('input[name="type"]:checked')?.value;
  const search = searchInput.value.trim().toLowerCase();
  let entries = state.allItems
    .map((item) => ({ ...item, ...(state.profileItems[item.id] || {}) }))
    .filter((item) => item.count > 0);
  if (rarity) entries = entries.filter((item) => item.rarity === rarity);
  if (type) entries = entries.filter((item) => item.types.includes(type));
  if (search) entries = entries.filter((item) => item.name.toLowerCase().includes(search));
  const sort = sortSelect.value;
  entries.sort((a, b) => {
    if (sort === "name_asc") return a.name.localeCompare(b.name, "zh-CN");
    if (sort === "name_desc") return b.name.localeCompare(a.name, "zh-CN");
    if (sort === "price_asc") return a.price - b.price;
    return b.price - a.price;
  });
  return entries;
}

function render() {
  const entries = currentEntries();
  const selectedValue = entries
    .filter((item) => state.selected.has(String(item.id)))
    .reduce((sum, item) => sum + Number(item.price || 0) * Number(item.count || 0), 0);
  selectedTotal.textContent = state.selected.size ? `当前选中：${formatNumber(selectedValue)}` : "";
  itemsGrid.innerHTML = entries
    .map((item) => `
      <article class="item-card ${state.selected.has(String(item.id)) ? "selected" : ""}" data-id="${item.id}" style="--rarity-color:${rarityColors[item.rarity] || rarityColors.gray}">
        <div class="item-heading"><span class="item-name">${escapeHtml(item.name)}</span><span class="item-type">${escapeHtml(item.typeLabel)}${item.level ? ` Lv.${item.level}` : ""}</span></div>
        ${item.image ? `<img class="item-image" src="${item.image}" alt="${escapeHtml(item.name)}" />` : ""}
        ${state.kind === "items" ? `<button class="heart ${item.collected ? "collected" : ""}" data-heart="${item.id}">♥</button>` : ""}
        <div class="count">x${formatNumber(item.count)}</div>
        <div class="item-footer">${formatNumber(item.price || 0)}</div>
      </article>
    `)
    .join("");
  for (const card of itemsGrid.querySelectorAll(".item-card")) {
    card.addEventListener("click", (event) => {
      if (event.target.closest(".heart")) return;
      const id = card.dataset.id;
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      render();
    });
  }
  for (const heart of itemsGrid.querySelectorAll(".heart")) {
    heart.addEventListener("click", () => socket?.send(JSON.stringify({ type: "toggle_favorite", itemId: Number(heart.dataset.heart) })));
  }
}

function sellSelected(quantity) {
  if (state.kind !== "items") {
    showMessage("道具暂不支持出售");
    return;
  }
  socket?.send(JSON.stringify({ type: "sell_items", itemIds: [...state.selected].map(Number), quantity }));
}

function buildFilters() {
  document.querySelector("#rarityFilters").innerHTML = Object.keys(rarityColors)
    .map((rarity) => `<label><input type="radio" name="rarity" value="${rarity}" />${rarity}</label>`)
    .join("");
  document.querySelector("#typeFilters").innerHTML = itemTypes
    .map((type) => `<label><input type="radio" name="type" value="${type}" />${typeLabels[type]}</label>`)
    .join("");
}

function showMessage(text) {
  message.textContent = text;
  setTimeout(() => (message.textContent = ""), 3000);
}

function splitTypes(typeText) {
  return String(typeText || "").split(";").map((type) => type.trim()).filter(Boolean);
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

function preloadSound(name) {
  if (audioCache.has(name)) return audioCache.get(name);
  const audio = new Audio(`/resource/audio/${name}.mp3`);
  audio.preload = "auto";
  audioCache.set(name, audio);
  return audio;
}

function playSound(name) {
  const audio = preloadSound(name);
  audio.currentTime = 0;
  audio.play().catch(() => {});
}
