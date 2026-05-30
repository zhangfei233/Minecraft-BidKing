const rarityOrder = ["gray", "green", "blue", "purple", "gold", "red"];
const rarityColors = { red: "#ff6060", gold: "#faff75", purple: "#964aca", blue: "#7b8afc", green: "#95de93", gray: "#c7c7c7" };
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

const form = document.querySelector("#filterForm");
const kindSelect = document.querySelector("#kindSelect");
const rarityFilters = document.querySelector("#rarityFilters");
const typeFilters = document.querySelector("#typeFilters");
const sizeFilters = document.querySelector("#sizeFilters");
const averagePrice = document.querySelector("#averagePrice");
const itemsGrid = document.querySelector("#itemsGrid");

let allItems = [];
let allProps = [];

function makeDiamond(color) {
  return `<svg viewBox="0 0 24 32" aria-hidden="true"><path d="M12 1 22 16 12 31 2 16Z" fill="rgba(0,0,0,0.22)" stroke="${color}" stroke-width="2"/><path d="M12 5 18.5 16 12 27 5.5 16Z" fill="${color}" opacity="0.35"/></svg>`;
}

function makeSizeIcon(width, height) {
  const cells = [];
  for (let y = 1; y <= 5; y += 1) {
    for (let x = 1; x <= 5; x += 1) {
      cells.push(`<rect x="${(x - 1) * 10 + 1}" y="${(y - 1) * 10 + 1}" width="8" height="8" fill="${x <= width && y <= height ? "var(--gray-cell)" : "var(--black-cell)"}"/>`);
    }
  }
  return `<svg viewBox="0 0 50 50" aria-hidden="true">${cells.join("")}</svg>`;
}

function buildFilters() {
  rarityFilters.innerHTML = rarityOrder.map((rarity) => `<label class="rarity-option"><input type="radio" name="rarity" value="${rarity}" />${makeDiamond(rarityColors[rarity])}</label>`).join("");
  typeFilters.innerHTML = itemTypes.map((type) => `<label class="type-option"><input type="radio" name="type" value="${type}" /><span>${typeLabels[type] || type}</span></label>`).join("");
  const sizes = [];
  for (let height = 1; height <= 5; height += 1) for (let width = 1; width <= 5; width += 1) sizes.push({ width, height });
  sizeFilters.innerHTML = sizes.map(({ width, height }) => `<label class="size-option" title="${width}x${height}">${makeSizeIcon(width, height)}<input type="radio" name="size" value="${width}x${height}" /></label>`).join("");
}

async function loadData() {
  const [itemsText, propsText] = await Promise.all([
    fetch("/items.csv", { cache: "no-cache" }).then((r) => r.text()),
    fetch("/props.csv", { cache: "no-cache" }).then((r) => r.text()),
  ]);
  allItems = parseCsv(itemsText).map((item) => {
    const id = Number(item.id);
    const types = splitTypes(item.type);
    return { ...item, id, types, typeLabel: types.map((type) => typeLabels[type] || type).join(";"), rarity: item.rarity, width: Number(item.width), height: Number(item.height), price: Number(item.price), image: `/resource/auction/${id}.png` };
  });
  allProps = parseCsv(propsText).map((prop) => {
    const level = Number(prop.level || 1);
    const rarity = rarityOrder[level - 1] || "gray";
    return { ...prop, id: prop.id, level, rarity, typeLabel: `道具 Lv.${level}`, width: 1, height: 1, price: Number(prop.price || 0), image: prop.image };
  });
}

function currentFormParams() {
  const data = new FormData(form);
  const params = new URLSearchParams();
  params.set("kind", kindSelect.value);
  for (const name of ["rarity", "type", "size"]) {
    const value = data.get(name);
    if (value) params.set(name, value);
  }
  return params;
}

function setInitialFilters() {
  const params = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : "");
  kindSelect.value = params.get("kind") || "items";
  for (const name of ["rarity", "type", "size"]) {
    const value = params.get(name) || "";
    const input = form.querySelector(`input[name="${name}"][value="${CSS.escape(value)}"]`);
    if (input) input.checked = true;
  }
}

function query(params) {
  const kind = params.get("kind") || "items";
  const rarity = params.get("rarity");
  const type = params.get("type");
  const size = params.get("size");
  let entries = kind === "props" ? allProps : allItems;
  if (rarity) entries = entries.filter((item) => item.rarity === rarity);
  if (kind === "items" && type) entries = entries.filter((item) => item.types.includes(type));
  if (kind === "items" && size) entries = entries.filter((item) => `${item.width}x${item.height}` === size);
  const total = entries.reduce((sum, item) => sum + item.price, 0);
  return { kind, averagePrice: entries.length ? Math.round(total / entries.length) : 0, items: entries };
}

function renderResults(data) {
  averagePrice.textContent = `当前筛选${data.kind === "props" ? "道具" : "藏品"}平均价值为 ${formatNumber(data.averagePrice)}`;
  if (!data.items.length) {
    itemsGrid.innerHTML = '<div class="empty-state">没有符合条件的物品</div>';
    return;
  }
  itemsGrid.innerHTML = data.items.map((item) => `
    <article class="item-card" style="--rarity-color:${rarityColors[item.rarity] || rarityColors.gray}">
      <div class="item-heading"><span class="item-name">${escapeHtml(item.name)}</span><span class="item-type">${escapeHtml(item.typeLabel)}</span></div>
      <img class="item-image" src="${item.image}" alt="${escapeHtml(item.name)}" />
      ${data.kind === "items" ? `<div class="card-size">${makeSizeIcon(item.width, item.height)}</div>` : ""}
      <div class="item-footer"><span class="coin">$</span>${formatNumber(item.price)}</div>
      ${item.description?.trim() ? `<div class="item-description">${escapeHtml(item.description)}</div>` : ""}
    </article>
  `).join("");
}

function renderFromForm(pushHash) {
  const params = currentFormParams();
  if (pushHash) location.hash = params.toString();
  renderResults(query(params));
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
    const char = line[i], next = line[i + 1];
    if (char === '"' && quoted && next === '"') { value += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { cells.push(value.trim()); value = ""; }
    else value += char;
  }
  cells.push(value.trim());
  return cells;
}

function splitTypes(typeText) {
  return String(typeText || "").split(";").map((type) => type.trim()).filter(Boolean);
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  renderFromForm(true);
});
kindSelect.addEventListener("change", () => renderFromForm(true));
window.addEventListener("hashchange", () => {
  setInitialFilters();
  renderResults(query(new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : "")));
});

buildFilters();
loadData().then(() => {
  setInitialFilters();
  renderFromForm(false);
});
