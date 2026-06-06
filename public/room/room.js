const loginView = document.querySelector("#loginView");
const roomView = document.querySelector("#roomView");
const loginForm = document.querySelector("#loginForm");
const nicknameInput = document.querySelector("#nicknameInput");
const loginMessage = document.querySelector("#loginMessage");
const myNickname = document.querySelector("#myNickname");
const myMoney = document.querySelector("#myMoney");
const playerList = document.querySelector("#playerList");
const readyButton = document.querySelector("#readyButton");
const characterChoices = document.querySelector("#characterChoices");
const characterAvatar = document.querySelector("#characterAvatar");
const characterDescription = document.querySelector("#characterDescription");
const characterPicker = document.querySelector("#characterPicker");
const inventory = document.querySelector("#inventory");
const propPicker = document.querySelector("#propPicker");
const propGrid = document.querySelector("#propGrid");
const containerName = document.querySelector("#containerName");
const entryFee = document.querySelector("#entryFee");

let socket = null;
let heartbeatTimer = null;
let myId = null;
let room = null;
let editingSlot = 0;
let selection = { characterId: "", props: [null, null, null, null, null] };
const levelRarities = ["gray", "green", "blue", "purple", "gold", "red"];
const rarityColors = { red: "#ff6060", gold: "#faff75", purple: "#964aca", blue: "#7b8afc", green: "#95de93", gray: "#c7c7c7" };
const audioCache = new Map();

preloadSound("click");
document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button, a")) playSound("click");
}, true);

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const nickname = nicknameInput.value.trim();
  if (nickname) joinRoom(nickname);
});

readyButton.addEventListener("click", () => {
  if (!socket || !room) return;
  const me = room.players.find((player) => player.id === myId);
  if (!me) return;
  if (room.hostId === myId) socket.send(JSON.stringify({ type: "start_game", selection }));
  else socket.send(JSON.stringify({ type: "set_ready", ready: !me.ready, selection }));
});

document.querySelector("#warehouseButton").addEventListener("click", () => {
  if (myId) openSidePage(`/warehouse?playerId=${encodeURIComponent(myId)}`);
});
document.querySelector("#shopButton").addEventListener("click", () => {
  if (myId) openSidePage(`/shop?playerId=${encodeURIComponent(myId)}`);
});
document.querySelector("#saveLoadoutButton").addEventListener("click", () => {
  socket?.send(JSON.stringify({ type: "save_loadout", props: selection.props }));
});
document.querySelector("#useLoadoutButton").addEventListener("click", () => {
  socket?.send(JSON.stringify({ type: "use_loadout" }));
});
document.querySelector("#changeCharacterButton").addEventListener("click", () => {
  renderCharacterPicker();
  characterPicker.showModal();
});

function joinRoom(nickname) {
  loginMessage.textContent = "正在加入房间...";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/room-ws?nickname=${encodeURIComponent(nickname)}`);
  socket.addEventListener("open", () => {
    heartbeatTimer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "heartbeat" })), 10_000);
  });
  socket.addEventListener("message", (event) => handleServerMessage(JSON.parse(event.data)));
  socket.addEventListener("close", () => {
    clearInterval(heartbeatTimer);
    if (!roomView.hidden) {
      loginMessage.textContent = "连接已断开";
      roomView.hidden = true;
      loginView.hidden = false;
    }
  });
  socket.addEventListener("error", () => {
    loginMessage.textContent = "连接失败";
  });
}

const resumePlayerId = new URLSearchParams(location.search).get("playerId");
if (resumePlayerId) resumeRoom(resumePlayerId);

function resumeRoom(playerId) {
  loginMessage.textContent = "正在返回房间...";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/room-ws?playerId=${encodeURIComponent(playerId)}`);
  socket.addEventListener("open", () => {
    heartbeatTimer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "heartbeat" })), 10_000);
  });
  socket.addEventListener("message", (event) => handleServerMessage(JSON.parse(event.data)));
  socket.addEventListener("close", () => clearInterval(heartbeatTimer));
}

function handleServerMessage(message) {
  if (message.type === "join_error" || message.type === "error") {
    alert(message.message || "操作失败");
    loginMessage.textContent = message.message || "操作失败";
    return;
  }
  if (message.type === "join_success") {
    myId = message.body.id;
    loginMessage.textContent = `${message.message}，临时ID：${myId}`;
    selection.characterId = message.body.player.characterId;
    selection.props = message.body.player.props || selection.props;
    enterRoom(message.body.room);
    return;
  }
  if (message.type === "room_state") {
    renderRoom(message.body);
    return;
  }
  if (message.type === "loadout_saved") alert(message.message || "配置已保存");
  if (message.type === "loadout_used") {
    selection.props = message.body.props || selection.props;
    renderRoom(room);
  }
  if (message.type === "game_starting") {
    readyButton.textContent = "即将开始";
    readyButton.disabled = true;
    location.href = `${message.body?.url || "/game"}?playerId=${encodeURIComponent(myId)}`;
  }
}

function enterRoom(nextRoom) {
  loginView.hidden = true;
  roomView.hidden = false;
  renderRoom(nextRoom);
}

function renderRoom(nextRoom) {
  room = nextRoom;
  const me = room.players.find((player) => player.id === myId);
  if (!me) return;
  myNickname.textContent = me.nickname;
  myMoney.textContent = formatNumber(me.money);
  containerName.textContent = room.container?.name || "-";
  if (entryFee) entryFee.textContent = formatNumber(room.container?.entryFee || 0);
  playerList.innerHTML = room.players.map(renderPlayerRow).join("");
  renderSelectors(me);
  renderInventory(me);
  renderReadyButton(me);
}

function renderSelectors(me) {
  const characters = Object.values(room.characters || {});
  if (!selection.characterId && characters[0]) selection.characterId = characters[0].id;
  const selected = room.characters?.[selection.characterId];
  if (selected?.image) {
    characterAvatar.src = selected.image;
    characterAvatar.alt = selected.name || "";
  }
  characterDescription.innerHTML = selected
    ? `<p><strong>${escapeHtml(selected.name)}</strong></p><p>${escapeHtml(selected.description)}</p>`
    : "";
}

function renderCharacterPicker() {
  const characters = Object.values(room.characters || {});
  characterChoices.innerHTML = characters
    .map((character) => `
      <button class="choice-row" type="button" data-id="${character.id}">
        ${character.image ? `<img src="${character.image}" alt="" />` : "<span></span>"}
        <span><strong>${escapeHtml(character.name)}</strong>${escapeHtml(character.description)}</span>
      </button>
    `)
    .join("");
  for (const button of characterChoices.querySelectorAll(".choice-row")) {
    button.addEventListener("click", () => {
      selection.characterId = button.dataset.id;
      sendSelection();
      renderRoom(room);
      characterPicker.close();
    });
  }
}

function renderInventory(me) {
  inventory.innerHTML = Array.from({ length: 5 }, (_, index) => {
    const prop = selection.props[index];
    const def = prop ? room.props?.[prop.id] : null;
    return `
      <button class="prop-slot" type="button" data-slot="${index}" title="${def?.description || "空"}" style="--prop-bg:${propColor(def)}">
        ${def ? `<span class="clear-prop" data-slot="${index}" title="移除">×</span>` : ""}
        ${def?.image ? `<img src="${def.image}" alt="${escapeHtml(def.name)}" />` : `<span>${index + 1}</span>`}
        ${def ? `<small>Lv.${def.level || 1}</small>` : ""}
      </button>
    `;
  }).join("");
  for (const button of inventory.querySelectorAll(".prop-slot")) {
    button.addEventListener("click", (event) => {
      if (event.target.closest(".clear-prop")) {
        selection.props[Number(button.dataset.slot)] = null;
        sendSelection();
        renderInventory(me);
        return;
      }
      openPropPicker(Number(button.dataset.slot), me);
    });
  }
}

function openSidePage(url) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "enter_side_page" }));
  setTimeout(() => {
    location.href = url;
  }, 60);
}
function openPropPicker(slot, me) {
  editingSlot = slot;
  const propEntries = Object.entries(me.ownedProps || {}).filter(([, count]) => count > 0);
  propGrid.innerHTML = propEntries.map(([id, count]) => {
    const prop = room.props?.[id] || { id, name: id, description: "" };
    return `
      <button class="prop-card" type="button" data-id="${id}" title="${escapeHtml(prop.description || "")}" style="--prop-bg:${propColor(prop)}">
        ${prop.image ? `<img src="${prop.image}" alt="${escapeHtml(prop.name)}" />` : ""}
        <strong>${escapeHtml(prop.name)}</strong>
        <span>Lv.${prop.level || 1} · x${count}</span>
      </button>
    `;
  }).join("") || "<p>没有可携带的道具</p>";
  for (const button of propGrid.querySelectorAll(".prop-card")) {
    button.addEventListener("click", () => {
      selection.props[editingSlot] = { id: button.dataset.id, level: 1 };
      sendSelection();
      propPicker.close();
      renderInventory(me);
    });
  }
  propPicker.showModal();
}

function sendSelection() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "set_selection", selection }));
}

function renderPlayerRow(player) {
  const ready = player.ready ? "✓" : "";
  const role = player.isHost ? "房主" : player.inGame ? "游戏中" : "玩家";
  const character = room.characters?.[player.characterId];
  return `
    <div class="player-row">
      ${character?.image ? `<img class="avatar-small" src="${character.image}" alt="" />` : `<div class="avatar-small"></div>`}
      <div class="player-meta">
        <strong>${escapeHtml(player.nickname)}</strong>
        <span>${role} · ${player.id} · ${escapeHtml(character?.name || player.characterId || "")}</span>
      </div>
      <div class="ready-mark">${ready}</div>
    </div>
  `;
}

function renderReadyButton(me) {
  readyButton.classList.toggle("is-cancel", !me.isHost && me.ready);
  if (me.inGame) {
    readyButton.textContent = "游戏中";
    readyButton.disabled = true;
    return;
  }
  if (me.isHost) {
    readyButton.textContent = "开始";
    readyButton.disabled = !room.canStart;
    return;
  }
  readyButton.textContent = me.ready ? "取消准备" : "准备";
  readyButton.disabled = false;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function propColor(prop) {
  if (!prop) return "rgba(13, 16, 18, 0.7)";
  return rarityColors[prop.rarity || levelRarities[Math.max(0, Math.min(5, (Number(prop.level) || 1) - 1))] || "gray"];
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
