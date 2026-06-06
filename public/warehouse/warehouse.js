const rarityColors = { red: "#ff6060", gold: "#faff75", purple: "#964aca", blue: "#7b8afc", green: "#95de93", gray: "#c7c7c7" };
const levelRarities = ["gray", "green", "blue", "purple", "gold", "red"];
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

const state = {
  allItems: [],
  itemMap: new Map(),
  profileItems: {},
  profileProps: {},
  propDefinitions: {},
  production: { slots: [] },
  productionRecipes: [],
  lottery: { slot: null, results: [] },
  lotteryRecipes: [],
  notifications: { production: false, lottery: false },
  selected: new Set(),
  kind: "items",
};

const itemsGrid = document.querySelector("#itemsGrid");
const productionGrid = document.querySelector("#productionGrid");
const lotteryPanel = document.querySelector("#lotteryPanel");
const moneyValue = document.querySelector("#moneyValue");
const message = document.querySelector("#message");
const selectedTotal = document.querySelector("#selectedTotal");
const kindSelect = document.querySelector("#kindSelect");
const contentBackButton = document.querySelector("#contentBackButton");
const sortSelect = document.querySelector("#sortSelect");
const searchInput = document.querySelector("#searchInput");
const recipeDialog = document.querySelector("#recipeDialog");
const recipeDetailGrid = document.querySelector("#recipeDetailGrid");
const outputBubble = document.querySelector("#outputBubble");

const audioCache = new Map();
let socket = null;
let heartbeatTimer = null;

preloadSound("click");
document.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button, a, select")) playSound("click");
}, true);

buildFilters();
loadItems().then(loadProductionJson).then(connectWarehouse);

document.querySelector("#backButton").addEventListener("click", () => {
  const playerId = new URLSearchParams(location.search).get("playerId") || "";
  location.href = `/room${playerId ? `?playerId=${encodeURIComponent(playerId)}` : ""}`;
});
contentBackButton?.addEventListener("click", () => {
  const playerId = new URLSearchParams(location.search).get("playerId") || "";
  location.href = `/room${playerId ? `?playerId=${encodeURIComponent(playerId)}` : ""}`;
});
document.querySelector("#queryButton").addEventListener("click", render);
kindSelect.addEventListener("change", () => {
  state.kind = kindSelect.value;
  state.selected.clear();
  outputBubble.hidden = true;
  if ((state.kind === "production" || state.kind === "lottery") && state.notifications[state.kind]) {
    state.notifications[state.kind] = false;
    socket?.send(JSON.stringify({ type: "warehouse_clear_notification", kind: state.kind }));
  }
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
      state.production = msg.body.production || { slots: [] };
      if (Array.isArray(msg.body.productionRecipes) && msg.body.productionRecipes.length) state.productionRecipes = normalizeRecipes(msg.body.productionRecipes);
      state.lottery = msg.body.lottery || { slot: null, results: [] };
      state.lotteryRecipes = msg.body.lotteryRecipes || state.lotteryRecipes;
      state.notifications = msg.body.notifications || { production: false, lottery: false };
      moneyValue.textContent = formatNumber(msg.body.money);
      render();
    }
    if (msg.type === "favorite_updated") {
      applyFavoriteState(Number(msg.body.itemId), Boolean(msg.body.collected));
    }
    if (msg.type === "sell_result") showMessage(`出售获得 $${formatNumber(msg.body.total)}`);
    if (msg.type === "production_collect_result") {
      const body = msg.body || {};
      showMessage(body.mode === "sell" ? `出售获得了 $${formatNumber(body.total)}` : `将 ${body.itemName} * ${formatNumber(body.count)} 存入了仓库`);
    }
    if (msg.type === "lottery_result") showMessage("抽奖完成");
    if (msg.type === "lottery_collect_result") {
      const body = msg.body || {};
      showMessage(body.mode === "take" ? "抽奖结果已存入仓库" : `出售获得了 $${formatNumber(body.total || 0)}`);
    }
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
  state.itemMap = new Map(state.allItems.map((item) => [item.id, item]));
}

async function loadProductionJson() {
  const text = await fetch("/production.json", { cache: "no-cache" }).then((r) => r.text()).catch(() => "[]");
  const raw = JSON.parse(text || "[]");
  const productOrderByRecipe = extractProductOrder(text);
  state.productionRecipes = normalizeRecipes(Array.isArray(raw) ? raw : raw?.recipe_id ? [raw] : Object.values(raw || {}));
  for (const recipe of state.productionRecipes) {
    const order = productOrderByRecipe.get(recipe.recipe_id);
    if (order?.length) {
      const rawRecipe = findRawRecipe(raw, recipe.recipe_id);
      recipe.products = order
        .map((id) => ({ id, probability: Number(rawRecipe?.product?.[id] ?? rawRecipe?.product?.[String(id)] ?? 0) }))
        .filter((product) => state.itemMap.has(product.id))
        .slice(0, 2);
      recipe.label = `${recipe.recipe.map(itemName).join(", ")} - ${recipe.products.map((product) => itemName(product.id)).join(", ")}`;
    }
  }
}

function currentEntries() {
  if (state.kind === "props") {
    return Object.entries(state.profileProps)
      .filter(([, count]) => count > 0)
      .map(([id, count]) => ({
        id,
        name: state.propDefinitions[id]?.name || id,
        typeLabel: "道具",
        rarity: levelRarities[Math.max(0, Math.min(5, (Number(state.propDefinitions[id]?.level) || 1) - 1))] || "gray",
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
  const productionMode = state.kind === "production";
  const lotteryMode = state.kind === "lottery";
  document.querySelector(".warehouse-page").classList.toggle("production-mode", productionMode || lotteryMode);
  document.querySelector(".filters").hidden = productionMode || lotteryMode;
  itemsGrid.hidden = productionMode || lotteryMode;
  productionGrid.hidden = !productionMode;
  lotteryPanel.hidden = !lotteryMode;
  if (contentBackButton) contentBackButton.hidden = !(productionMode || lotteryMode);
  updateKindOptions();
  document.querySelectorAll("#sortSelect, #selectAllButton, #clearSelectionButton, #selectUnfavoriteButton, #sellAllButton, #sellPartialButton, #toggleFavoriteButton")
    .forEach((element) => (element.hidden = productionMode || lotteryMode));
  if (productionMode) {
    selectedTotal.textContent = "";
    renderProduction();
  } else if (lotteryMode) {
    selectedTotal.textContent = "";
    renderLottery();
  } else {
    renderInventory();
  }
}

function updateKindOptions() {
  const labels = {
    items: "\u6218\u5229\u54c1",
    props: "\u9053\u5177",
    production: "\u8f66\u95f4",
    lottery: "\u62bd\u5956",
  };
  for (const option of kindSelect.options) {
    const value = option.value;
    const marked = (value === "production" && state.notifications.production) || (value === "lottery" && state.notifications.lottery);
    option.textContent = marked ? `*${labels[value] || value}*` : labels[value] || value;
    option.classList.toggle("has-update", marked);
  }
}

function renderLottery() {
  const hasResults = (state.lottery.results || []).length > 0;
  const consumables = lotteryConsumableIds();
  const heldCount = consumables.reduce((sum, id) => sum + Number(state.profileItems[id]?.count || 0), 0);
  const slotItem = state.lottery.slot ? itemById(state.lottery.slot.id) : null;
  const totalValue = lotteryResultTotalValue(state.lottery.results || []);
  lotteryPanel.innerHTML = `
    <section class="lottery-left">
      <button id="favoriteLotteryButton" type="button">一键收藏抽奖道具</button>
      <p>${heldCount > 0 ? `当前有 ${formatNumber(heldCount)} 个抽奖道具` : "当前无抽奖道具"}</p>
      <div class="lottery-consume-slot">${slotItem ? `<img src="${slotItem.image}" alt="" /><strong>${escapeHtml(slotItem.name)}</strong>` : "<span>+</span>"}</div>
      <button id="drawLotteryButton" type="button" ${!state.lottery.slot || hasResults ? "disabled" : ""}>抽奖</button>
      <button id="refillLotteryButton" type="button" ${heldCount <= 0 || state.lottery.slot || hasResults ? "disabled" : ""}>补充道具</button>
    </section>
    <section class="lottery-results">
      <div class="lottery-result-grid">${(state.lottery.results || []).map(lotteryResultCard).join("")}</div>
      <footer>
        <strong>总价值: ${formatNumber(totalValue)}</strong>
        <button id="takeLotteryButton" type="button" ${hasResults ? "" : "disabled"}>领取</button>
        <button id="sellLotteryButton" type="button" ${hasResults ? "" : "disabled"}>出售</button>
        <button id="sellUnfavoriteLotteryButton" type="button" ${hasResults ? "" : "disabled"}>出售非收藏</button>
      </footer>
    </section>
  `;
  document.querySelector("#favoriteLotteryButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "lottery_favorite_consumes" })));
  document.querySelector("#drawLotteryButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "lottery_draw" })));
  document.querySelector("#refillLotteryButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "lottery_refill" })));
  document.querySelector("#takeLotteryButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "lottery_collect", mode: "take" })));
  document.querySelector("#sellLotteryButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "lottery_collect", mode: "sell" })));
  document.querySelector("#sellUnfavoriteLotteryButton").addEventListener("click", () => socket?.send(JSON.stringify({ type: "lottery_collect", mode: "sell_unfavorite" })));
}

function lotteryResultCard(result) {
  const data = lotteryResultData(result);
  return `
    <article class="lottery-result-card" style="--rarity-color:${rarityColors[data.rarity] || rarityColors.gray}">
      ${data.image ? `<img src="${data.image}" alt="" />` : ""}
      <strong>${escapeHtml(data.name)}</strong>
      <small>${formatNumber(data.price)}</small>
      <span class="count">x${formatNumber(result.count)}</span>
    </article>
  `;
}

function lotteryResultData(result) {
  if (String(result.class).toLowerCase() === "prop") {
    const prop = state.propDefinitions[result.id] || {};
    return { name: prop.name || result.id, image: prop.image || "", rarity: prop.rarity || levelRarities[Math.max(0, Math.min(5, (Number(prop.level) || 1) - 1))], price: Number(prop.price || 0) };
  }
  const item = itemById(result.id);
  return { name: item.name, image: item.image, rarity: item.rarity, price: Number(item.price || 0), collected: state.profileItems[result.id]?.collected };
}

function lotteryResultTotalValue(results) {
  return results.reduce((sum, result) => sum + lotteryResultData(result).price * Number(result.count || 0), 0);
}

function lotteryConsumableIds() {
  return [...new Set((state.lotteryRecipes || []).map((recipe) => Number(recipe.consume)).filter(Boolean))];
}

function renderInventory() {
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
  bindHeartButtons(itemsGrid);
}

function renderProduction() {
  const slots = Array.from({ length: 3 }, (_, index) => state.production.slots?.[index] || { recipeId: null, inputs: [], outputs: [] });
  productionGrid.innerHTML = `
    <div class="production-title">
      <h2>生产车间</h2>
      <p>利用战利品产生更多战利品!</p>
    </div>
    <button class="production-favorite-button" id="favoriteProductionButton" type="button">&#x4e00;&#x952e;&#x6536;&#x85cf;</button>
    ${slots.map((slot, slotIndex) => productionSlotHtml(slot, slotIndex)).join("")}
  `;
  productionGrid.querySelector("#favoriteProductionButton")?.addEventListener("click", () => socket?.send(JSON.stringify({ type: "production_favorite_inputs" })));
  for (const select of productionGrid.querySelectorAll(".recipe-select")) {
    select.addEventListener("change", () => socket?.send(JSON.stringify({ type: "production_set_recipe", slot: Number(select.dataset.slot), recipeId: Number(select.value) })));
  }
  for (const button of productionGrid.querySelectorAll("[data-input]")) {
    button.addEventListener("click", (event) => {
      if (event.target.closest(".remove-input")) {
        socket?.send(JSON.stringify({ type: "production_remove_input", slot: Number(button.dataset.slot), inputIndex: Number(button.dataset.input) }));
      } else {
        socket?.send(JSON.stringify({ type: "production_place_input", slot: Number(button.dataset.slot), inputIndex: Number(button.dataset.input) }));
      }
    });
  }
  for (const button of productionGrid.querySelectorAll("[data-output]")) {
    button.addEventListener("click", () => showOutputBubble(button, Number(button.dataset.slot), Number(button.dataset.output)));
  }
  for (const button of productionGrid.querySelectorAll(".detail-button")) {
    button.addEventListener("click", () => openRecipeDetail(Number(button.dataset.slot)));
  }
}

function productionSlotHtml(slot, slotIndex) {
  const recipe = recipeById(slot.recipeId);
  const hasOutput = (slot.outputs || []).some(Boolean);
  return `
    <article class="production-slot">
      <label>配方选择
        <select class="recipe-select" data-slot="${slotIndex}" ${hasOutput ? "disabled" : ""} title="${hasOutput ? "请先处理产物格中的物品" : ""}">
          <option value="">未选择</option>
          ${state.productionRecipes.map((entry) => `<option value="${entry.recipe_id}" ${entry.recipe_id === slot.recipeId ? "selected" : ""}>${escapeHtml(entry.label)}</option>`).join("")}
        </select>
      </label>
      <div class="recipe-info">
        <strong>物品信息</strong>
        ${recipe ? `<ul>${recipe.recipe.map((id) => `<li>${escapeHtml(itemName(id))}</li>`).join("")}</ul><button class="detail-button" type="button" data-slot="${slotIndex}">详细视图</button>` : "<p>请选择配方</p>"}
      </div>
      <div class="input-grid">
        ${Array.from({ length: 4 }, (_, inputIndex) => productionInputHtml(slot, recipe, slotIndex, inputIndex)).join("")}
      </div>
      <div class="output-grid">
        ${Array.from({ length: 2 }, (_, outputIndex) => productionOutputHtml(slot, slotIndex, outputIndex)).join("")}
      </div>
      <div class="production-status">${productionStatus(slot, recipe)}</div>
    </article>
  `;
}

function productionInputHtml(slot, recipe, slotIndex, inputIndex) {
  const input = slot.inputs?.[inputIndex];
  const requiredId = recipe?.recipe?.[inputIndex];
  const disabled = !requiredId ? "disabled" : "";
  const item = input ? itemById(input.id) : requiredId ? itemById(requiredId) : null;
  return `
    <button class="production-cell input-cell" type="button" data-slot="${slotIndex}" data-input="${inputIndex}" ${disabled}>
      ${input ? `<span class="remove-input" title="取出">×</span><img src="${item.image}" alt="" /><small>${escapeHtml(item.name)}</small>` : requiredId ? `<span class="plus">+</span><small>${escapeHtml(item.name)}</small>` : ""}
    </button>
  `;
}

function productionOutputHtml(slot, slotIndex, outputIndex) {
  const output = slot.outputs?.[outputIndex];
  const item = output ? itemById(output.id) : null;
  return `
    <button class="production-cell output-cell" type="button" data-slot="${slotIndex}" data-output="${outputIndex}" ${output ? "" : "disabled"}>
      ${output ? `<img src="${item.image}" alt="" /><small>${escapeHtml(item.name)} x${formatNumber(output.count)}</small>` : ""}
    </button>
  `;
}

function productionStatus(slot, recipe) {
  if (!recipe) return "";
  const ready = recipe.recipe.every((id, index) => slot.inputs?.[index]?.id === id);
  if (!ready) return "放齐需求物品后开始生产";
  const products = recipe.products.filter(Boolean).map((product) => `${itemName(product.id)}: ${Math.round(product.probability * 100)}%`).join(", ");
  return `配方生效，生产中。${products}`;
}

function openRecipeDetail(slotIndex) {
  const recipe = recipeById(state.production.slots?.[slotIndex]?.recipeId);
  if (!recipe) return;
  recipeDetailGrid.innerHTML = recipe.recipe.map((id) => {
    const item = itemById(id);
    const entry = state.profileItems[id] || {};
    return `
      <article class="item-card detail-card" style="--rarity-color:${rarityColors[item.rarity] || rarityColors.gray}">
        <div class="item-heading"><span class="item-name">${escapeHtml(item.name)}</span><span class="item-type">${escapeHtml(item.typeLabel)}</span></div>
        <img class="item-image" src="${item.image}" alt="" />
        <button class="heart ${entry.collected ? "collected" : ""}" data-heart="${id}">♥</button>
        <div class="count">x${formatNumber(entry.count || 0)}</div>
      </article>
    `;
  }).join("");
  bindHeartButtons(recipeDetailGrid);
  recipeDialog.showModal();
}

function bindHeartButtons(root) {
  for (const heart of root.querySelectorAll(".heart")) {
    heart.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      socket?.send(JSON.stringify({ type: "toggle_favorite", itemId: Number(heart.dataset.heart) }));
    });
  }
}

function applyFavoriteState(itemId, collected) {
  const key = String(itemId);
  if (!state.profileItems[key]) state.profileItems[key] = { count: 0, collected: false };
  state.profileItems[key].collected = collected;
  for (const heart of document.querySelectorAll(`.heart[data-heart="${CSS.escape(key)}"]`)) {
    heart.classList.toggle("collected", collected);
  }
}

function showOutputBubble(anchor, slot, outputIndex) {
  const output = state.production.slots?.[slot]?.outputs?.[outputIndex];
  if (!output) return;
  const item = itemById(output.id);
  outputBubble.innerHTML = `
    <button class="bubble-close" type="button">×</button>
    <strong>${escapeHtml(item.name)} x${formatNumber(output.count)}</strong>
    <div class="bubble-actions">
      <button type="button" data-mode="take">拿去</button>
      <button type="button" data-mode="sell">出售</button>
    </div>
  `;
  const rect = anchor.getBoundingClientRect();
  outputBubble.style.left = `${rect.left + rect.width / 2}px`;
  outputBubble.style.top = `${rect.top - 8}px`;
  outputBubble.hidden = false;
  outputBubble.querySelector(".bubble-close").addEventListener("click", () => (outputBubble.hidden = true));
  for (const button of outputBubble.querySelectorAll("[data-mode]")) {
    button.addEventListener("click", () => {
      outputBubble.hidden = true;
      socket?.send(JSON.stringify({ type: "production_collect", slot, outputIndex, mode: button.dataset.mode }));
    });
  }
}

function sellSelected(quantity) {
  if (state.kind !== "items") {
    showMessage("道具暂不支持出售");
    return;
  }
  socket?.send(JSON.stringify({ type: "sell_items", itemIds: [...state.selected].map(Number), quantity }));
}

function normalizeRecipes(entries) {
  return entries
    .map((entry) => {
      const recipe = (entry.recipe || []).map(Number).filter((id) => state.itemMap.has(id)).slice(0, 4);
      const products = Array.isArray(entry.products)
        ? entry.products
        : Object.entries(entry.product || {}).slice(0, 2).map(([id, probability]) => ({ id: Number(id), probability: Number(probability) || 0 }));
      const normalizedProducts = products.filter((product) => product && state.itemMap.has(Number(product.id))).map((product) => ({ id: Number(product.id), probability: Math.max(0, Math.min(1, Number(product.probability) || 0)) }));
      const label = entry.label || `${recipe.map(itemName).join(", ")} - ${normalizedProducts.map((product) => itemName(product.id)).join(", ")}`;
      return { recipe_id: Number(entry.recipe_id), recipe, products: normalizedProducts, label };
    })
    .filter((entry) => Number.isInteger(entry.recipe_id) && entry.recipe.length && entry.products.length)
    .sort((a, b) => a.recipe_id - b.recipe_id);
}

function findRawRecipe(raw, recipeId) {
  if (Array.isArray(raw)) return raw.find((entry) => Number(entry.recipe_id) === recipeId);
  if (Number(raw?.recipe_id) === recipeId) return raw;
  return Object.values(raw || {}).find((entry) => Number(entry.recipe_id) === recipeId);
}

function extractProductOrder(text) {
  const result = new Map();
  const pattern = /"recipe_id"\s*:\s*(\d+)[\s\S]*?"product"\s*:\s*\{([\s\S]*?)\}/g;
  for (const match of text.matchAll(pattern)) {
    result.set(Number(match[1]), [...match[2].matchAll(/"([^"]+)"\s*:/g)].map((entry) => Number(entry[1])).filter(Number.isInteger));
  }
  return result;
}

function recipeById(id) {
  return state.productionRecipes.find((entry) => entry.recipe_id === Number(id));
}

function itemById(id) {
  return state.itemMap.get(Number(id)) || { id, name: `#${id}`, typeLabel: "", rarity: "gray", price: 0, image: `/resource/auction/${id}.png` };
}

function itemName(id) {
  return itemById(id).name;
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
