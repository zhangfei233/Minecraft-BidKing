const state = {
  items: [],
  itemMap: new Map(),
  profileItems: {},
  production: { currentPage: 1, pages: [] },
  recipes: [],
};

const rarityColors = { red: "#ff6060", gold: "#faff75", purple: "#964aca", blue: "#7b8afc", green: "#95de93", gray: "#c7c7c7" };
const picker = { page: 1, pageSize: 5, search: "", onlyAvailable: false, targetPage: 1, targetSlot: 0 };
let socket = null;
let heartbeatTimer = null;

const productionGrid = document.querySelector("#productionGrid");
const message = document.querySelector("#message");
const moneyValue = document.querySelector("#moneyValue");
const pageSelect = document.querySelector("#pageSelect");
const pagePrice = document.querySelector("#pagePrice");
const recipeDialog = document.querySelector("#recipeDialog");
const recipeDetailGrid = document.querySelector("#recipeDetailGrid");
const recipePickerDialog = document.querySelector("#recipePickerDialog");
const recipePickerList = document.querySelector("#recipePickerList");
const recipeSearchInput = document.querySelector("#recipeSearchInput");
const recipePageText = document.querySelector("#recipePageText");
const outputBubble = document.querySelector("#outputBubble");

document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button, a, select")) playSound("click");
}, true);
document.querySelector("#backButton").addEventListener("click", () => backToRoom());
document.querySelector("#buyPageButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "production_buy_page" })));
document.querySelector("#collectAllButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "production_collect_all", mode: "take" })));
document.querySelector("#sellAllOutputsButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "production_collect_all", mode: "sell" })));
document.querySelector("#favoriteProductionButton").addEventListener("click", () => {
  socket?.send(JSON.stringify({ type: "production_favorite_inputs" }));
  alert("已收藏所有生产配方需求物品");
});
document.querySelector("#recipeSearchButton").addEventListener("click", () => {
  picker.search = recipeSearchInput.value.trim();
  picker.page = 1;
  renderRecipePicker();
});
document.querySelector("#recipePrevButton").addEventListener("click", () => {
  picker.page = Math.max(1, picker.page - 1);
  renderRecipePicker();
});
document.querySelector("#recipeNextButton").addEventListener("click", () => {
  picker.page += 1;
  renderRecipePicker();
});
document.querySelector("#recipeAvailableButton").addEventListener("click", () => {
  picker.onlyAvailable = !picker.onlyAvailable;
  picker.page = 1;
  renderRecipePicker();
});
recipeSearchInput.addEventListener("input", () => {
  picker.search = recipeSearchInput.value.trim();
  picker.page = 1;
  renderRecipePicker();
});
pageSelect.addEventListener("change", () => socket?.send(JSON.stringify({ type: "production_set_page", page: Number(pageSelect.value) })));

loadItems().then(loadProductionJson).then(connect);

function connect() {
  const playerId = new URLSearchParams(location.search).get("playerId") || "";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/production-ws?playerId=${encodeURIComponent(playerId)}`);
  socket.addEventListener("open", () => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "heartbeat" })), 10_000);
    socket.send(JSON.stringify({ type: "warehouse_clear_notification", kind: "production" }));
  });
  socket.addEventListener("close", () => clearInterval(heartbeatTimer));
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "production_state") {
      state.profileItems = msg.body.items || {};
      state.production = normalizeProduction(msg.body.production);
      if (Array.isArray(msg.body.productionRecipes)) {
        const recipes = normalizeRecipes(msg.body.productionRecipes);
        if (recipes.length) state.recipes = recipes;
      }
      moneyValue.textContent = formatNumber(msg.body.money || 0);
      render();
    }
    if (msg.type === "production_collect_result") showCollectResult(msg.body);
    if (msg.type === "production_collect_all_result") showCollectAllResult(msg.body);
    if (msg.type === "production_buy_result") showMessage(`已开通第 ${msg.body.page} 页车间`);
    if (msg.type === "favorite_updated") applyFavoriteState(Number(msg.body.itemId), Boolean(msg.body.collected));
    if (msg.type === "error") showMessage(msg.message || "操作失败");
  });
}

function render() {
  renderPageSelect();
  const page = currentPage();
  const slots = page.slots || [];
  productionGrid.innerHTML = `
    <div class="production-title"><h2>生产车间</h2><p>利用战利品产生更多战利品!</p></div>
    ${slots.map((slot, index) => productionSlotHtml(slot, index, page.page)).join("")}
  `;
  productionGrid.querySelectorAll(".recipe-picker-button").forEach((button) => {
    button.addEventListener("click", () => openRecipePicker(Number(button.dataset.page), Number(button.dataset.slot)));
  });
  productionGrid.querySelectorAll("[data-input]").forEach((button) => {
    button.addEventListener("click", (event) => {
      const payload = { page: Number(button.dataset.page), slot: Number(button.dataset.slot), inputIndex: Number(button.dataset.input) };
      if (event.target.closest(".remove-input")) socket?.send(JSON.stringify({ type: "production_remove_input", ...payload }));
      else socket?.send(JSON.stringify({ type: "production_place_input", ...payload }));
    });
  });
  productionGrid.querySelectorAll("[data-output]").forEach((button) => {
    button.addEventListener("click", () => showOutputBubble(button, Number(button.dataset.page), Number(button.dataset.slot), Number(button.dataset.output)));
  });
  productionGrid.querySelectorAll(".detail-button").forEach((button) => {
    button.addEventListener("click", () => openRecipeDetail(Number(button.dataset.slot)));
  });
}

function renderPageSelect() {
  const pages = state.production.pages || [];
  pageSelect.innerHTML = pages
    .filter((page) => page.open)
    .map((page) => `<option value="${page.page}" ${page.page === state.production.currentPage ? "selected" : ""}>第 ${page.page} 页</option>`)
    .join("");
  const opened = pages.filter((page) => page.open).length || 1;
  const canBuy = opened < 10;
  document.querySelector("#buyPageButton").disabled = !canBuy;
  pagePrice.textContent = canBuy ? `价格: ${formatNumber(opened * 1000000)}` : "已开通全部车间";
}

function productionSlotHtml(slot, slotIndex, pageNumber) {
  const recipe = recipeById(slot.recipeId);
  const hasOutput = (slot.outputs || []).some(Boolean);
  return `
    <article class="production-slot">
      <label>配方选择
        <button class="recipe-picker-button" type="button" data-page="${pageNumber}" data-slot="${slotIndex}" ${hasOutput ? "disabled" : ""} title="${hasOutput ? "请先处理产物格中的物品" : ""}">
          ${recipe ? escapeHtml(recipe.label) : "选择配方"}
        </button>
      </label>
      <div class="recipe-info">
        <strong>物品信息</strong>
        ${recipe ? `<ul>${recipe.recipe.map((id) => `<li>${escapeHtml(itemName(id))}</li>`).join("")}</ul><button class="detail-button" type="button" data-slot="${slotIndex}">详细视图</button>` : "<p>请选择配方</p>"}
      </div>
      <div class="input-grid">${Array.from({ length: 4 }, (_, index) => productionInputHtml(slot, recipe, pageNumber, slotIndex, index)).join("")}</div>
      <div class="output-grid">${Array.from({ length: 2 }, (_, index) => productionOutputHtml(slot, pageNumber, slotIndex, index)).join("")}</div>
      <div class="production-status">${productionStatus(slot, recipe)}</div>
    </article>
  `;
}

function productionInputHtml(slot, recipe, pageNumber, slotIndex, inputIndex) {
  const input = slot.inputs?.[inputIndex];
  const requiredId = recipe?.recipe?.[inputIndex];
  const item = input ? itemById(input.id) : requiredId ? itemById(requiredId) : null;
  return `<button class="production-cell input-cell" type="button" data-page="${pageNumber}" data-slot="${slotIndex}" data-input="${inputIndex}" ${requiredId ? "" : "disabled"}>
    ${input ? `<span class="remove-input" title="取出">×</span><img src="${item.image}" alt="" /><small>${escapeHtml(item.name)}</small>` : requiredId ? `<span class="plus">+</span><small>${escapeHtml(item.name)}</small>` : ""}
  </button>`;
}

function productionOutputHtml(slot, pageNumber, slotIndex, outputIndex) {
  const output = slot.outputs?.[outputIndex];
  const item = output ? itemById(output.id) : null;
  return `<button class="production-cell output-cell" type="button" data-page="${pageNumber}" data-slot="${slotIndex}" data-output="${outputIndex}" ${output ? "" : "disabled"}>
    ${output ? `<img src="${item.image}" alt="" /><small>${escapeHtml(item.name)} x${formatNumber(output.count)}</small>` : ""}
  </button>`;
}

function productionStatus(slot, recipe) {
  if (!recipe) return "";
  const ready = recipe.recipe.every((id, index) => slot.inputs?.[index]?.id === id);
  if (!ready) return "放齐需求物品后开始生产";
  return `配方生效, 生产中. ${recipe.products.filter(Boolean).map((product) => `${itemName(product.id)}: ${Math.round(product.probability * 100)}%`).join(", ")}`;
}

function openRecipePicker(page, slot) {
  picker.targetPage = page;
  picker.targetSlot = slot;
  picker.page = 1;
  picker.search = "";
  picker.onlyAvailable = false;
  recipeSearchInput.value = "";
  renderRecipePicker();
  recipePickerDialog.showModal();
}

function renderRecipePicker() {
  const entries = filteredRecipes();
  const totalPages = Math.max(1, Math.ceil(entries.length / picker.pageSize));
  picker.page = Math.max(1, Math.min(totalPages, picker.page));
  const pageEntries = entries.slice((picker.page - 1) * picker.pageSize, picker.page * picker.pageSize);
  recipePageText.textContent = `${picker.page}/${totalPages}`;
  document.querySelector("#recipePrevButton").disabled = picker.page <= 1;
  document.querySelector("#recipeNextButton").disabled = picker.page >= totalPages;
  document.querySelector("#recipeAvailableButton").classList.toggle("active", picker.onlyAvailable);
  recipePickerList.innerHTML = `
    <button class="recipe-row clear-recipe-row" type="button" data-recipe="">不选择配方</button>
    ${pageEntries.map((recipe) => `<button class="recipe-row" type="button" data-recipe="${recipe.recipe_id}">${escapeHtml(recipe.label)}</button>`).join("")}
  `;
  recipePickerList.querySelectorAll(".recipe-row").forEach((button) => {
    button.addEventListener("click", () => {
      socket?.send(JSON.stringify({
        type: "production_set_recipe",
        page: picker.targetPage,
        slot: picker.targetSlot,
        recipeId: Number(button.dataset.recipe || 0),
      }));
      recipePickerDialog.close();
    });
  });
}

function filteredRecipes() {
  const query = picker.search.toLowerCase();
  return state.recipes.filter((recipe) => {
    if (query && !recipe.label.toLowerCase().includes(query)) return false;
    if (picker.onlyAvailable && !recipeAvailable(recipe)) return false;
    return true;
  });
}

function recipeAvailable(recipe) {
  const counts = {};
  for (const id of recipe.recipe) counts[id] = (counts[id] || 0) + 1;
  return Object.entries(counts).every(([id, count]) => Number(state.profileItems[id]?.count || 0) >= count);
}

function openRecipeDetail(slotIndex) {
  const recipe = recipeById(currentPage().slots?.[slotIndex]?.recipeId);
  if (!recipe) return;
  recipeDetailGrid.innerHTML = recipe.recipe.map((id) => {
    const item = itemById(id);
    const entry = state.profileItems[id] || {};
    return `<article class="item-card detail-card" style="--rarity-color:${rarityColors[item.rarity] || rarityColors.gray}">
      <div class="item-heading"><span class="item-name">${escapeHtml(item.name)}</span><span class="item-type">${escapeHtml(item.typeLabel)}</span></div>
      <img class="item-image" src="${item.image}" alt="" />
      <button class="heart ${entry.collected ? "collected" : ""}" data-heart="${id}">♥</button>
      <div class="count">x${formatNumber(entry.count || 0)}</div>
    </article>`;
  }).join("");
  recipeDetailGrid.querySelectorAll(".heart").forEach((heart) => {
    heart.addEventListener("click", (event) => {
      event.stopPropagation();
      socket?.send(JSON.stringify({ type: "toggle_favorite", itemId: Number(heart.dataset.heart) }));
    });
  });
  recipeDialog.showModal();
}

function showOutputBubble(anchor, page, slot, outputIndex) {
  const pageState = state.production.pages.find((entry) => entry.page === page) || currentPage();
  const output = pageState.slots?.[slot]?.outputs?.[outputIndex];
  if (!output) return;
  const item = itemById(output.id);
  outputBubble.innerHTML = `<button class="bubble-close" type="button">×</button><strong>${escapeHtml(item.name)} x${formatNumber(output.count)}</strong><div class="bubble-actions"><button type="button" data-mode="take">拿取</button><button type="button" data-mode="sell">出售</button></div>`;
  const rect = anchor.getBoundingClientRect();
  outputBubble.style.left = `${rect.left + rect.width / 2}px`;
  outputBubble.style.top = `${rect.top - 8}px`;
  outputBubble.hidden = false;
  outputBubble.querySelector(".bubble-close").addEventListener("click", () => (outputBubble.hidden = true));
  outputBubble.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      outputBubble.hidden = true;
      socket?.send(JSON.stringify({ type: "production_collect", page, slot, outputIndex, mode: button.dataset.mode }));
    });
  });
}

function showCollectResult(body = {}) {
  showMessage(body.mode === "sell" ? `出售获得了 $${formatNumber(body.total)}` : `将 ${body.itemName} * ${formatNumber(body.count)} 存入了仓库`);
}

function showCollectAllResult(body = {}) {
  const names = (body.handled || []).map((entry) => `${entry.name} x${formatNumber(entry.count)}`).join(", ") || "无";
  alert(body.mode === "sell" ? `一键出售 ${names}\n总价值 ${formatNumber(body.total || 0)}` : `一键领取 ${names}`);
}

async function loadItems() {
  const csv = await fetch("/items.csv", { cache: "no-cache" }).then((r) => r.text());
  state.items = parseCsv(csv).map((item) => {
    const id = Number(item.id);
    return { ...item, id, price: Number(item.price), image: `/resource/auction/${id}.png`, typeLabel: item.type || "" };
  });
  state.itemMap = new Map(state.items.map((item) => [item.id, item]));
}

async function loadProductionJson() {
  const text = await fetch("/production.json", { cache: "no-cache" }).then((r) => r.text()).catch(() => "[]");
  const raw = JSON.parse(text || "[]");
  state.recipes = normalizeRecipes(Array.isArray(raw) ? raw : raw?.recipe_id ? [raw] : Object.values(raw || {}));
}

function normalizeRecipes(entries) {
  return entries
    .map((entry) => {
      const recipe = (entry.recipe || []).map(Number).filter((id) => state.itemMap.has(id)).slice(0, 4);
      const productSource = Array.isArray(entry.products)
        ? entry.products
        : Object.entries(entry.product || {}).map(([id, probability]) => ({ id: Number(id), probability: Number(probability) || 0 }));
      const products = productSource
        .map((product) => ({ id: Number(product.id), probability: Math.max(0, Math.min(1, Number(product.probability) || 0)) }))
        .filter((product) => state.itemMap.has(product.id))
        .slice(0, 2);
      const label = entry.label || `${recipe.map(itemName).join(", ")} - ${products.map((product) => itemName(product.id)).join(", ")}`;
      return { recipe_id: Number(entry.recipe_id), recipe, products, label };
    })
    .filter((entry) => Number.isInteger(entry.recipe_id) && entry.recipe.length && entry.products.length)
    .sort((a, b) => a.recipe_id - b.recipe_id);
}

function normalizeProduction(value) {
  const pages = Array.isArray(value?.pages) ? value.pages : [{ page: 1, open: true, slots: value?.slots || [] }];
  return { currentPage: Number(value?.currentPage || 1), pages };
}

function currentPage() {
  return state.production.pages.find((page) => page.page === state.production.currentPage) || state.production.pages.find((page) => page.open) || { page: 1, slots: [] };
}

function recipeById(id) {
  return state.recipes.find((entry) => entry.recipe_id === Number(id));
}

function itemById(id) {
  return state.itemMap.get(Number(id)) || { id, name: `#${id}`, rarity: "gray", price: 0, image: `/resource/auction/${id}.png`, typeLabel: "" };
}

function itemName(id) {
  return itemById(id).name;
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

function applyFavoriteState(itemId, collected) {
  const entry = state.profileItems[String(itemId)] || { count: 0 };
  entry.collected = collected;
  state.profileItems[String(itemId)] = entry;
  render();
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
  return lines.map((line) => Object.fromEntries(parseCsvLine(line).map((cell, i) => [headers[i], cell])));
}

function parseCsvLine(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    const n = line[i + 1];
    if (c === '"' && quoted && n === '"') {
      value += '"';
      i += 1;
    } else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) {
      cells.push(value.trim());
      value = "";
    } else value += c;
  }
  cells.push(value.trim());
  return cells;
}

function playSound(name) {
  const audio = new Audio(`/resource/audio/${name}.mp3`);
  audio.play().catch(() => {});
}
