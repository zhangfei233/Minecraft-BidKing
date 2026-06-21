export const WAREHOUSE_WIDTH = 10;
export const WAREHOUSE_MAX_ROWS = 40;
export const rarityColors = {
  red: "#ff6060",
  gold: "#faff75",
  purple: "#964aca",
  blue: "#7b8afc",
  green: "#95de93",
  gray: "#c7c7c7",
};

export class WarehouseCanvas {
  constructor(canvas, { cellSize = 54, items = new Map() } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cellSize = cellSize;
    this.items = items;
    this.knownItems = new Map();
    this.cellRarities = new Map();
    this.fullItems = new Map();
    this.highlightCells = [];
    this.temporaryCells = [];
    this.highlightTimer = null;
    this.onValueChange = null;
    this.favoriteItemIds = new Set();
    this.setRows(WAREHOUSE_MAX_ROWS);
    this.animationFrame = null;
    this.startOutlineAnimation();
  }

  setItems(items) {
    this.items = items;
    this.render();
    this.emitValueChange();
  }

  setRows(rows) {
    this.rows = Math.max(1, Math.min(WAREHOUSE_MAX_ROWS, rows || WAREHOUSE_MAX_ROWS));
    this.canvas.width = WAREHOUSE_WIDTH * this.cellSize;
    this.canvas.height = this.rows * this.cellSize;
    this.render();
    this.emitValueChange();
  }

  setFavoriteItemIds(ids) {
    this.favoriteItemIds = new Set((ids || []).map(Number));
    this.render();
  }

  reset() {
    this.knownItems.clear();
    this.cellRarities.clear();
    this.fullItems.clear();
    this.highlightCells = [];
    this.temporaryCells = [];
    this.render();
  }

  loadFullWarehouse(items, { outlineOnly = false } = {}) {
    this.reset();
    const realItems = items.filter((item) => item.id !== 0);
    const rows = realItems.reduce((max, item) => Math.max(max, item.y + item.height), 1);
    this.setRows(rows);
    for (const item of realItems) {
      this.knownItems.set(itemKey(item), item);
      if (!outlineOnly) this.fullItems.set(itemKey(item), item);
      if (!outlineOnly && item.rarity) this.markItemRarity(item, item.rarity);
    }
    this.render();
    this.emitValueChange();
  }

  async animateFullWarehouse(items, durationMs = 10000) {
    const realItems = items.filter((item) => item.id !== 0).sort((a, b) => a.y - b.y || a.x - b.x);
    this.loadFullWarehouse(items, { outlineOnly: true });
    if (!realItems.length) return;

    const start = performance.now();
    return new Promise((resolve) => {
      const step = (now) => {
        const progress = Math.min(1, (now - start) / durationMs);
        const count = Math.floor(progress * realItems.length);
        for (let i = 0; i < count; i += 1) {
          const item = realItems[i];
          this.fullItems.set(itemKey(item), item);
          if (item.rarity) this.markItemRarity(item, item.rarity);
        }
        this.render();
        this.emitValueChange();
        if (progress < 1) requestAnimationFrame(step);
        else {
          for (const item of realItems) {
            this.fullItems.set(itemKey(item), item);
            if (item.rarity) this.markItemRarity(item, item.rarity);
          }
          this.render();
          this.emitValueChange();
          resolve();
        }
      };
      requestAnimationFrame(step);
    });
  }

  applyHint(hint) {
    const messages = hint.message || [hint];
    for (const message of messages) this.applySingleHint(message);
    this.render();
    this.emitValueChange();
  }

  revealedValue() {
    let total = 0;
    for (const item of this.fullItems.values()) total += Number(item.price || 0);
    return total;
  }

  emitValueChange() {
    this.onValueChange?.(this.revealedValue());
  }

  applySingleHint(hint) {
    if (hint.type === "cell_rarity") {
      this.cellRarities.set(cellKey(hint.x, hint.y), hint.rarity);
      const item = this.findKnownItemAt(hint.x, hint.y);
      if (item) this.markItemRarity(item, hint.rarity);
      return;
    }

    if (hint.type === "item_outline" || hint.type === "item_outline_rarity" || hint.type === "item_full") {
      const item = normalizeHintItem(hint, this.items);
      this.knownItems.set(itemKey(item), item);
      const knownRarity = hint.rarity || this.findKnownRarityInside(item);
      if (knownRarity) this.markItemRarity(item, knownRarity);
      if (hint.type === "item_full") {
        this.fullItems.set(itemKey(item), item);
        if (item.rarity) this.markItemRarity(item, item.rarity);
      }
    }
  }

  showHighlight(hints, durationMs = 3000) {
    this.highlightCells = hints.flatMap((hint) => hintToCells(hint));
    this.render();
    clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(() => {
      this.highlightCells = [];
      this.render();
    }, durationMs);
  }

  setTemporaryCells(cells = []) {
    this.temporaryCells = Array.isArray(cells) ? cells : [];
    this.render();
  }

  clearTemporaryCells() {
    this.temporaryCells = [];
    this.render();
  }

  queryForCell(x, y) {
    const item = this.findKnownItemAt(x, y);
    const params = new URLSearchParams();
    if (item) params.set("size", `${item.width}x${item.height}`);
    const rarity = item ? this.findKnownRarityInside(item) : this.cellRarities.get(cellKey(x, y));
    if (rarity) params.set("rarity", rarity);
    return params.toString();
  }

  tooltipForCell(x, y) {
    const item = this.findFullItemAt(x, y);
    if (!item) return null;
    return {
      name: item.name || `#${item.id}`,
      typeLabel: item.typeLabel || labelTypes(item.type),
      price: item.price ?? 0,
    };
  }

  cellFromEvent(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const x = Math.floor(((event.clientX - rect.left) * scaleX) / this.cellSize);
    const y = Math.floor(((event.clientY - rect.top) * scaleY) / this.cellSize);
    if (x < 0 || x >= WAREHOUSE_WIDTH || y < 0 || y >= this.rows) return null;
    return { x, y };
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = "#8e8e8e";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.renderGrid();
    this.renderKnownRarities();
    this.renderFullItems();
    this.renderOutlines();
    this.renderHighlights();
  }

  renderKnownRarities() {
    for (const [key, rarity] of this.cellRarities) {
      const [x, y] = key.split(",").map(Number);
      if (y >= this.rows) continue;
      this.ctx.fillStyle = rarityColors[rarity] || "#8e8e8e";
      this.ctx.fillRect(x * this.cellSize, y * this.cellSize, this.cellSize, this.cellSize);
    }
  }

  renderFullItems() {
    for (const item of this.fullItems.values()) {
      if (item.y >= this.rows) continue;
      const x = item.x * this.cellSize;
      const y = item.y * this.cellSize;
      const width = item.width * this.cellSize;
      const height = item.height * this.cellSize;
      this.ctx.fillStyle = rarityColors[item.rarity] || "#8e8e8e";
      this.ctx.fillRect(x, y, width, height);
      const image = getItemImage(item.id);
      if (image.complete && image.naturalWidth) {
        const pad = Math.max(6, this.cellSize * 0.12);
        this.ctx.drawImage(image, x + pad, y + pad, width - pad * 2, height - pad * 2);
      }
      this.renderItemName(item, x, y, width);
      this.renderFavoriteHeart(item, x, y, height);
    }
  }

  renderFavoriteHeart(item, x, y, height) {
    if (!this.favoriteItemIds.has(Number(item.id))) return;
    this.ctx.save();
    this.ctx.fillStyle = "#ff2f55";
    this.ctx.font = `700 ${Math.max(18, Math.floor(this.cellSize * 0.36))}px serif`;
    this.ctx.textBaseline = "bottom";
    this.ctx.fillText("\u2665", x + 6, y + height - 6);
    this.ctx.restore();
  }

  renderItemName(item, x, y, width) {
    const name = item.name || `#${item.id}`;
    this.ctx.save();
    this.ctx.fillStyle = "#050607";
    this.ctx.font = `700 ${Math.max(11, Math.floor(this.cellSize * 0.24))}px "Microsoft YaHei", sans-serif`;
    this.ctx.textBaseline = "top";
    this.ctx.beginPath();
    this.ctx.rect(x + 4, y + 4, Math.max(0, width - 8), this.cellSize * 0.4);
    this.ctx.clip();
    this.ctx.fillText(name, x + 5, y + 5);
    this.ctx.restore();
  }

  renderGrid() {
    this.ctx.strokeStyle = "#e0e0e0";
    this.ctx.lineWidth = 2;
    for (let x = 0; x <= WAREHOUSE_WIDTH; x += 1) {
      this.ctx.beginPath();
      this.ctx.moveTo(x * this.cellSize, 0);
      this.ctx.lineTo(x * this.cellSize, this.canvas.height);
      this.ctx.stroke();
    }
    for (let y = 0; y <= this.rows; y += 1) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y * this.cellSize);
      this.ctx.lineTo(this.canvas.width, y * this.cellSize);
      this.ctx.stroke();
    }
  }

  renderOutlines() {
    const now = performance.now();
    for (const item of this.knownItems.values()) {
      this.ctx.save();
      this.ctx.shadowColor = "rgba(0, 229, 255, 0.45)";
      this.ctx.shadowBlur = 10;
      this.ctx.strokeStyle = "#00E5FF";
      this.ctx.lineWidth = 3;
      this.strokeItem(item, 2);
      this.ctx.shadowBlur = 0;
      this.ctx.strokeStyle = "#004A55";
      this.ctx.lineWidth = 3;
      this.strokeItem(item, 4);
      this.drawOutlineGlow(item, now, 0);
      this.drawOutlineGlow(item, now, 1);
      this.ctx.restore();
    }
  }

  renderHighlights() {
    this.ctx.strokeStyle = "#1cff54";
    this.ctx.lineWidth = 5;
    for (const cell of this.highlightCells) {
      this.ctx.strokeRect(cell.x * this.cellSize + 2, cell.y * this.cellSize + 2, this.cellSize - 4, this.cellSize - 4);
    }
    this.ctx.strokeStyle = "#1cff54";
    this.ctx.lineWidth = 4;
    for (const cell of this.temporaryCells) {
      this.ctx.strokeRect(cell.x * this.cellSize + 3, cell.y * this.cellSize + 3, this.cellSize - 6, this.cellSize - 6);
    }
  }

  strokeItem(item, inset = 2) {
    this.ctx.strokeRect(
      item.x * this.cellSize + inset,
      item.y * this.cellSize + inset,
      item.width * this.cellSize - inset * 2,
      item.height * this.cellSize - inset * 2,
    );
  }

  drawOutlineGlow(item, now, offsetIndex) {
    const rect = outlineRect(item, this.cellSize, 2);
    const perimeter = Math.max(1, (rect.width + rect.height) * 2);
    const start = ((now % 3000) / 3000) * perimeter + offsetIndex * perimeter * 0.5;
    this.ctx.save();
    this.ctx.strokeStyle = "#FFF3A0";
    this.ctx.lineWidth = 4;
    this.ctx.lineCap = "round";
    this.ctx.shadowColor = "rgba(255, 243, 160, 0.9)";
    this.ctx.shadowBlur = 8;
    drawRectSegment(this.ctx, rect, start, perimeter * 0.2);
    this.ctx.restore();
  }

  startOutlineAnimation() {
    const tick = () => {
      if (this.knownItems.size > 0 || this.highlightCells.length > 0) this.render();
      this.animationFrame = requestAnimationFrame(tick);
    };
    this.animationFrame = requestAnimationFrame(tick);
  }

  findKnownItemAt(x, y) {
    for (const item of this.knownItems.values()) {
      if (x >= item.x && x < item.x + item.width && y >= item.y && y < item.y + item.height) return item;
    }
    return null;
  }

  findFullItemAt(x, y) {
    for (const item of this.fullItems.values()) {
      if (x >= item.x && x < item.x + item.width && y >= item.y && y < item.y + item.height) return item;
    }
    return null;
  }

  findKnownRarityInside(item) {
    for (let y = item.y; y < item.y + item.height; y += 1) {
      for (let x = item.x; x < item.x + item.width; x += 1) {
        const rarity = this.cellRarities.get(cellKey(x, y));
        if (rarity) return rarity;
      }
    }
    return null;
  }

  markItemRarity(item, rarity) {
    for (let y = item.y; y < item.y + item.height; y += 1) {
      for (let x = item.x; x < item.x + item.width; x += 1) this.cellRarities.set(cellKey(x, y), rarity);
    }
  }
}

export async function loadClientItems() {
  const response = await fetch("/items.csv", { cache: "no-cache" });
  const text = await response.text();
  const rows = parseCsv(text);
  return new Map(rows.map((item) => [Number(item.id), normalizeCsvItem(item)]));
}

function normalizeCsvItem(item) {
  const id = Number(item.id);
  const types = splitTypes(item.type);
  return {
    id,
    name: item.name,
    type: item.type,
    types,
    typeLabel: labelTypes(item.type),
    description: item.description,
    rarity: item.rarity,
    height: Number(item.height),
    width: Number(item.width),
    price: Number(item.price),
    image: `/resource/auction/${id}.png`,
  };
}

function normalizeHintItem(hint, itemDefinitions) {
  const base = itemDefinitions.get(hint.id) || {};
  return {
    ...base,
    ...hint,
    type: hint.itemType || base.type || hint.type,
    width: Number(hint.width || base.width),
    height: Number(hint.height || base.height),
    rarity: hint.rarity || base.rarity,
  };
}

function splitTypes(typeText) {
  return String(typeText || "")
    .split(";")
    .map((type) => type.trim())
    .filter(Boolean);
}

const typeLabels = {
  decoration: "\u88c5\u9970",
  ore: "\u77ff\u7269",
  tool: "\u5de5\u5177",
  equipment: "\u88c5\u5907",
  natural: "\u81ea\u7136",
  food: "\u98df\u7269",
  tech: "\u79d1\u6280",
  magic: "\u9b54\u6cd5",
  mob: "\u751f\u7269",
  book: "\u4e66\u7c4d",
  multiblock: "\u591a\u65b9\u5757",
  loot: "\u6218\u5229\u54c1",
};

function labelTypes(typeText) {
  return splitTypes(typeText)
    .map((type) => typeLabels[type] || type)
    .join(";");
}

function hintToCells(hint) {
  if (!hint) return [];
  if (hint.type === "cell_highlight") return [{ x: hint.x, y: hint.y }];
  if (hint.type === "cell_rarity") return [{ x: hint.x, y: hint.y }];
  if (Number.isInteger(hint.x) && Number.isInteger(hint.y) && hint.width && hint.height) {
    const cells = [];
    for (let y = hint.y; y < hint.y + hint.height; y += 1) {
      for (let x = hint.x; x < hint.x + hint.width; x += 1) cells.push({ x, y });
    }
    return cells;
  }
  return [];
}

function cellKey(x, y) {
  return `${x},${y}`;
}

function itemKey(item) {
  return `${item.x},${item.y},${item.width},${item.height}`;
}

function outlineRect(item, cellSize, inset = 2) {
  return {
    x: item.x * cellSize + inset,
    y: item.y * cellSize + inset,
    width: item.width * cellSize - inset * 2,
    height: item.height * cellSize - inset * 2,
  };
}

function drawRectSegment(ctx, rect, start, length) {
  const perimeter = (rect.width + rect.height) * 2;
  let remaining = length;
  let cursor = ((start % perimeter) + perimeter) % perimeter;
  while (remaining > 0.01) {
    const edgeLeft = distanceToNextCorner(rect, cursor);
    const step = Math.min(remaining, edgeLeft);
    const from = pointOnRect(rect, cursor);
    const to = pointOnRect(rect, cursor + step);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    remaining -= step;
    cursor = (cursor + step) % perimeter;
  }
}

function distanceToNextCorner(rect, distance) {
  const perimeter = (rect.width + rect.height) * 2;
  const d = ((distance % perimeter) + perimeter) % perimeter;
  if (d < rect.width) return rect.width - d;
  if (d < rect.width + rect.height) return rect.width + rect.height - d;
  if (d < rect.width * 2 + rect.height) return rect.width * 2 + rect.height - d;
  return perimeter - d;
}

function pointOnRect(rect, distance) {
  const perimeter = (rect.width + rect.height) * 2;
  const d = ((distance % perimeter) + perimeter) % perimeter;
  if (d <= rect.width) return { x: rect.x + d, y: rect.y };
  if (d <= rect.width + rect.height) return { x: rect.x + rect.width, y: rect.y + d - rect.width };
  if (d <= rect.width * 2 + rect.height) return { x: rect.x + rect.width - (d - rect.width - rect.height), y: rect.y + rect.height };
  return { x: rect.x, y: rect.y + rect.height - (d - rect.width * 2 - rect.height) };
}

const imageCache = new Map();
function getItemImage(id) {
  if (!imageCache.has(id)) {
    const image = new Image();
    image.src = `/resource/auction/${id}.png`;
    image.onload = () => document.dispatchEvent(new Event("warehouse-image-loaded"));
    imageCache.set(id, image);
  }
  return imageCache.get(id);
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
