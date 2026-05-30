const rarityColors = { red: "#ff6060", gold: "#faff75", purple: "#964aca", blue: "#7b8afc", green: "#95de93", gray: "#c7c7c7" };
const levelRarities = ["gray", "green", "blue", "purple", "gold", "red"];

const state = { props: {}, selected: new Set() };
const list = document.querySelector("#shopList");
const moneyValue = document.querySelector("#moneyValue");
const messageEl = document.querySelector("#message");
const audioCache = new Map();
let socket = null;
let heartbeatTimer = null;

preloadSound("click");
document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button, a")) playSound("click");
}, true);

document.querySelector("#backButton").addEventListener("click", () => {
  const playerId = new URLSearchParams(location.search).get("playerId") || "";
  location.href = `/room${playerId ? `?playerId=${encodeURIComponent(playerId)}` : ""}`;
});
document.querySelector("#buyButton").addEventListener("click", () => buy(1));
document.querySelector("#buyQuantityButton").addEventListener("click", () => {
  const quantity = Number(prompt("购买多少个？"));
  if (Number.isInteger(quantity) && quantity > 0) buy(quantity);
});

connect();

function connect() {
  const playerId = new URLSearchParams(location.search).get("playerId") || "";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/shop-ws?playerId=${encodeURIComponent(playerId)}`);
  socket.addEventListener("open", () => {
    heartbeatTimer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "heartbeat" })), 10_000);
  });
  socket.addEventListener("close", () => clearInterval(heartbeatTimer));
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "shop_state") {
      state.props = msg.body.props || {};
      moneyValue.textContent = formatNumber(msg.body.money);
      render();
    }
    if (msg.type === "buy_result") showMessage(`购买成功，花费 ${formatNumber(msg.body.results.reduce((sum, item) => sum + item.total, 0))}`);
    if (msg.type === "error") showMessage(msg.message || "操作失败");
  });
}

function render() {
  list.innerHTML = Object.values(state.props)
    .map((prop) => {
      const rarity = levelRarities[(Number(prop.level) || 1) - 1] || "gray";
      return `
        <article class="prop-row ${state.selected.has(prop.id) ? "selected" : ""}" data-id="${prop.id}">
          <div class="prop-icon" style="--rarity-color:${rarityColors[rarity]}">${prop.image ? `<img src="${prop.image}" alt="" />` : ""}</div>
          <div class="prop-name"><div class="prop-title"><strong>${escapeHtml(prop.name)}</strong><i class="selected-check">✓</i></div><span>Lv.${prop.level || 1}</span></div>
          <div class="prop-desc">${escapeHtml(prop.description || "")}</div>
          <div class="price">${formatNumber(prop.price || 0)}</div>
        </article>
      `;
    })
    .join("");
  for (const row of list.querySelectorAll(".prop-row")) {
    row.addEventListener("click", () => {
      const id = row.dataset.id;
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      render();
    });
  }
}

function buy(quantity) {
  if (!state.selected.size) return showMessage("请选择道具");
  socket?.send(JSON.stringify({ type: "buy_props", propIds: [...state.selected], quantity }));
}

function showMessage(text) {
  messageEl.textContent = text;
  setTimeout(() => (messageEl.textContent = ""), 3000);
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
