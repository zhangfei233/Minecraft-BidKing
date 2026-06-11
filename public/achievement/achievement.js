const listEl = document.querySelector("#achievementList");
const rewardDialog = document.querySelector("#rewardDialog");
const rewardPreview = document.querySelector("#rewardPreview");
const playerId = new URLSearchParams(location.search).get("playerId") || "";
let socket = null;
let achievements = [];
let items = {};
let filter = "all";

const rarityColors = { red: "#ff6060", gold: "#faff75", purple: "#964aca", blue: "#7b8afc", green: "#95de93", gray: "#c7c7c7" };

document.querySelector("#backButton").addEventListener("click", () => {
  location.href = `/room?playerId=${encodeURIComponent(playerId)}`;
});

document.querySelector("#closeRewardDialog").addEventListener("click", () => rewardDialog.close());

for (const button of document.querySelectorAll(".filter")) {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    document.querySelectorAll(".filter").forEach((entry) => entry.classList.toggle("is-active", entry === button));
    render();
  });
}

connect();

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/achievement-ws?playerId=${encodeURIComponent(playerId)}`);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "achievement_state") {
      achievements = message.body.achievements || [];
      items = message.body.items || {};
      render();
    }
    if (message.type === "achievement_claimed") showReward(message.body.reward);
    if (message.type === "error") showInlineMessage(message.message || "成就操作失败");
  });
}

function render() {
  const rows = achievements.filter((entry) => {
    if (filter === "completed") return entry.state?.completed;
    if (filter === "open") return !entry.state?.completed;
    return true;
  });
  listEl.innerHTML = rows.map((entry) => achievementCard(entry)).join("") || "<p>暂无成就。</p>";
  for (const button of listEl.querySelectorAll(".claim-button")) {
    button.addEventListener("click", () => {
      socket?.send(JSON.stringify({ type: "claim_achievement", id: button.dataset.id }));
    });
  }
}

function achievementCard(entry) {
  const state = entry.state || { progress: 0, completed: false, claimed: false };
  const reward = itemName(entry.reward);
  return `
    <article class="achievement-card">
      <div class="achievement-main">
        <div class="achievement-title-row">
          <h2>${escapeHtml(entry.title)}</h2>
          <span class="reward-inline">奖励：${escapeHtml(reward)}</span>
        </div>
        <p>${escapeHtml(entry.description)}</p>
      </div>
      <div class="progress ${state.completed ? "done" : ""}">${state.completed ? "✓" : `${state.progress || 0}/${entry.goal || 1}`}</div>
      <button class="claim-button" type="button" data-id="${escapeHtml(entry.id)}" ${state.completed && !state.claimed ? "" : "disabled"}>${state.claimed ? "已领取" : "领取奖励"}</button>
    </article>
  `;
}

function showReward(itemId) {
  const item = items[String(itemId)] || { id: itemId, name: `#${itemId}`, rarity: "gray" };
  rewardPreview.innerHTML = `
    <div class="reward-item" style="--rarity-color:${rarityColors[item.rarity] || rarityColors.gray}">
      <strong>${escapeHtml(item.name || `#${item.id}`)}</strong>
      <img src="/resource/auction/${item.id}.png" alt="" />
      <span>已加入仓库</span>
    </div>
  `;
  rewardDialog.showModal();
}

function showInlineMessage(text) {
  rewardPreview.innerHTML = `<p>${escapeHtml(text)}</p>`;
  rewardDialog.showModal();
}

function itemName(itemId) {
  return items[String(itemId)]?.name || (itemId ? `#${itemId}` : "无");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
