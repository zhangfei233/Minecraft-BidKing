import { loadConfig, loadItems, loadItemsById, RARITY_ORDER_LOW_TO_HIGH } from "../items/items.js";

export class Warehouse {
  static WIDTH = 10;
  static MAX_ROWS = 40;
  static VIEW_COUNT = 4;

  constructor({ rootDir, random = Math.random, viewCount = Warehouse.VIEW_COUNT } = {}) {
    if (!rootDir) throw new Error("Warehouse requires rootDir");
    this.rootDir = rootDir;
    this.random = random;
    this.itemDefinitions = loadItemsById(rootDir);
    this.items = [emptyItem()];
    this.grid = createGrid(0);
    this.viewCount = clampViewCount(viewCount);
    this.resetViews();
  }

  get width() {
    return Warehouse.WIDTH;
  }

  get maxRows() {
    return Warehouse.MAX_ROWS;
  }

  get effectiveRows() {
    for (let y = Warehouse.MAX_ROWS - 1; y >= 0; y -= 1) {
      if (this.grid[y].some((cell) => cell !== 0)) return y + 1;
    }
    return 0;
  }

  getItemDefinition(id) {
    if (id === 0) return emptyItem();
    return this.itemDefinitions.get(id) || null;
  }

  getItemByIndex(index) {
    return this.items[index] || null;
  }

  getItemAt(x, y) {
    this.assertCell(x, y);
    return this.items[this.grid[y][x]];
  }

  getIndexAt(x, y) {
    this.assertCell(x, y);
    return this.grid[y][x];
  }

  getOccupiedCells(index) {
    const item = this.getItemByIndex(index);
    if (!item || item.id === 0) return [];
    const cells = [];
    for (let y = item.y; y < item.y + item.height; y += 1) {
      for (let x = item.x; x < item.x + item.width; x += 1) {
        cells.push({ x, y });
      }
    }
    return cells;
  }

  getSerializableItems() {
    return this.items.map((item) => {
      if (item.id === 0) return emptyItem();
      return {
        id: item.id,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        rarity: item.rarity,
        price: item.price,
        name: item.name,
        type: item.type,
        types: item.types,
        typeLabel: item.typeLabel,
      };
    });
  }

  generate(k = 1.0) {
    const config = loadConfig(this.rootDir).warehouse;
    const pool = buildWeightedPool(loadItems(this.rootDir), config, k);
    const targetVolume = randomNormalInt(
      this.random,
      config.volume_normal_mean,
      config.volume_normal_stddev,
      config.volume_min,
      config.volume_max,
    );
    const selected = [];
    let volume = 0;

    while (volume < targetVolume) {
      const item = weightedPick(pool, this.random);
      selected.push(item);
      volume += item.width * item.height;
    }

    this.items = [emptyItem()];
    this.grid = createGrid(0);

    let placed = this.placeItems(selected, { randomizeLarge: true });
    let removedAfterPacking = this.truncateAfterFirstIncompleteRow();
    if (this.items.length <= 1 || removedAfterPacking > placed * 0.5) {
      this.items = [emptyItem()];
      this.grid = createGrid(0);
      placed = this.placeItems(selected, { randomizeLarge: false });
      removedAfterPacking = this.truncateAfterFirstIncompleteRow();
    }
    this.resetViews();
    this.validate();
    return {
      targetVolume,
      selectedCount: selected.length,
      placedCount: placed,
      removedAfterPacking,
      effectiveRows: this.effectiveRows,
      items: this.getSerializableItems(),
    };
  }

  addHint(viewNumber, hint) {
    const view = this.getView(viewNumber);
    const normalized = this.normalizeHint(hint);
    view.hint.push(normalized);
    this.applyHintToView(view, normalized);
    return normalized;
  }

  getView(viewNumber) {
    const view = this.views[viewNumber - 1];
    if (!view) throw new Error(`Invalid view number: ${viewNumber}`);
    return view;
  }

  validate() {
    if (this.items[0]?.id !== 0) throw new Error("items[0] must be the empty item");
    const seen = createGrid(null);

    for (let index = 1; index < this.items.length; index += 1) {
      const item = this.items[index];
      if (!this.itemDefinitions.has(item.id)) throw new Error(`Unknown item id ${item.id}`);
      if (item.x < 0 || item.y < 0) throw new Error(`Item ${index} has negative coordinates`);
      if (item.x + item.width > Warehouse.WIDTH) throw new Error(`Item ${index} exceeds width`);
      if (item.y + item.height > Warehouse.MAX_ROWS) throw new Error(`Item ${index} exceeds height`);

      for (let y = item.y; y < item.y + item.height; y += 1) {
        for (let x = item.x; x < item.x + item.width; x += 1) {
          if (seen[y][x] !== null) throw new Error(`Cell ${x},${y} is occupied twice`);
          seen[y][x] = index;
        }
      }
    }

    for (let y = 0; y < Warehouse.MAX_ROWS; y += 1) {
      for (let x = 0; x < Warehouse.WIDTH; x += 1) {
        const expected = seen[y][x] ?? 0;
        if (this.grid[y][x] !== expected) {
          throw new Error(`Grid mismatch at ${x},${y}: expected ${expected}, got ${this.grid[y][x]}`);
        }
      }
    }

    const effectiveRows = this.effectiveRows;
    for (let y = 0; y < Math.max(0, effectiveRows - 1); y += 1) {
      for (let x = 0; x < Warehouse.WIDTH; x += 1) {
        if (this.grid[y][x] === 0) throw new Error(`Unexpected empty cell at ${x},${y}`);
      }
    }
    return true;
  }

  placeItems(selectedItems, { randomizeLarge = true } = {}) {
    const candidates = [...selectedItems].sort((a, b) => {
      const areaDelta = b.width * b.height - a.width * a.height;
      if (areaDelta !== 0) return areaDelta;
      return Math.max(b.width, b.height) - Math.max(a.width, a.height);
    });
    let freeRects = [{ x: 0, y: 0, width: Warehouse.WIDTH, height: Warehouse.MAX_ROWS }];
    let placed = 0;
    const randomCount = randomizeLarge ? Math.max(1, Math.ceil(candidates.length * 0.1)) : 0;
    const randomCandidates = shuffle(candidates.slice(0, randomCount), this.random);
    const remaining = candidates.slice(randomCount);

    for (const definition of randomCandidates) {
      const placement = findRandomPlacement(definition, freeRects, this.random);
      if (!placement) {
        remaining.push(definition);
        continue;
      }
      const item = this.placeDefinition(definition, placement);
      freeRects = splitFreeRects(freeRects, {
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      });
      placed += 1;
    }

    for (const definition of remaining.sort((a, b) => b.width * b.height - a.width * a.height)) {
      const placement = findBestMaxRect(definition, freeRects);
      if (!placement) continue;
      const item = this.placeDefinition(definition, placement);

      freeRects = splitFreeRects(freeRects, {
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      });
      placed += 1;
    }

    return placed;
  }

  placeDefinition(definition, placement) {
    const index = this.items.length;
    const item = {
      ...definition,
      index,
      x: placement.x,
      y: placement.y,
    };
    this.items.push(item);
    for (let y = item.y; y < item.y + item.height; y += 1) {
      for (let x = item.x; x < item.x + item.width; x += 1) {
        this.grid[y][x] = index;
      }
    }
    return item;
  }

  truncateAfterFirstIncompleteRow() {
    let removed = 0;
    while (true) {
      const effectiveRows = this.effectiveRows;
      let lastAllowedRow = effectiveRows - 1;
      for (let y = 0; y < effectiveRows - 1; y += 1) {
        if (this.grid[y].some((cell) => cell === 0)) {
          lastAllowedRow = y;
          break;
        }
      }

      if (lastAllowedRow === effectiveRows - 1) return removed;

      const kept = [emptyItem()];
      for (const item of this.items.slice(1)) {
        if (item.y + item.height - 1 <= lastAllowedRow) kept.push(item);
      }
      removed += this.items.length - kept.length;
      this.items = [emptyItem()];
      this.grid = createGrid(0);
      for (const definition of kept.slice(1)) {
        this.placeDefinition(definition, { x: definition.x, y: definition.y });
      }
    }
  }

  resetViews() {
    this.views = Array.from({ length: this.viewCount }, () => createView());
    for (let index = 0; index < this.views.length; index += 1) this[`view${index + 1}`] = this.views[index];
  }

  normalizeHint(hint) {
    if (!hint || typeof hint !== "object") throw new Error("Hint must be an object");

    if (hint.type === "cell_rarity") {
      this.assertCell(hint.x, hint.y);
      const index = this.grid[hint.y][hint.x];
      const item = this.items[index];
      return {
        type: "cell_rarity",
        x: hint.x,
        y: hint.y,
        itemIndex: index,
        id: item.id,
        rarity: item.rarity ?? null,
      };
    }

    const item = this.resolveHintItem(hint);
    if (hint.type === "item_outline") return itemHint("item_outline", item, false, false);
    if (hint.type === "item_outline_rarity") return itemHint("item_outline_rarity", item, true, false);
    if (hint.type === "item_full") return itemHint("item_full", item, true, true);

    throw new Error(`Unknown hint type: ${hint.type}`);
  }

  resolveHintItem(hint) {
    if (Number.isInteger(hint.itemIndex) && this.items[hint.itemIndex]) return this.items[hint.itemIndex];
    if (Number.isInteger(hint.x) && Number.isInteger(hint.y)) return this.getItemAt(hint.x, hint.y);
    throw new Error("Hint must include itemIndex or x/y");
  }

  applyHintToView(view, hint) {
    if (hint.type === "cell_rarity") {
      if (hint.itemIndex > 0) markItem(view.rarityKnown, this.items[hint.itemIndex], true);
      else view.rarityKnown[hint.y][hint.x] = true;
      return;
    }

    const item = this.items[hint.itemIndex];
    markItem(view.outlineKnown, item, true);
    if (hint.rarity) markItem(view.rarityKnown, item, true);
  }

  assertCell(x, y) {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      x >= Warehouse.WIDTH ||
      y < 0 ||
      y >= Warehouse.MAX_ROWS
    ) {
      throw new Error(`Invalid cell: ${x},${y}`);
    }
  }
}

function buildWeightedPool(items, config, k) {
  const rarityWeights = RARITY_ORDER_LOW_TO_HIGH.map((rarity) => ({
    rarity,
    weight: Math.pow(config.rarity_base_weights[rarity] ?? 1, k),
  }));
  const rarityWeightSum = rarityWeights.reduce((sum, entry) => sum + entry.weight, 0);
  const rarityWeightByName = new Map(rarityWeights.map((entry) => [entry.rarity, entry.weight / rarityWeightSum]));
  const byRarity = new Map();

  for (const item of items) {
    if (!byRarity.has(item.rarity)) byRarity.set(item.rarity, []);
    byRarity.get(item.rarity).push(item);
  }

  const pool = [];
  for (const rarity of RARITY_ORDER_LOW_TO_HIGH) {
    const group = (byRarity.get(rarity) || []).sort((a, b) => a.price - b.price);
    if (!group.length) continue;
    const lambda = group.length > 1 ? Math.log(config.price_bias_ratio) / (group.length - 1) : 0;
    const rarityWeight = rarityWeightByName.get(rarity) || 0;

    group.forEach((item, rank) => {
      pool.push({
        ...item,
        weight: Math.exp(-lambda * rank) * rarityWeight,
      });
    });
  }

  if (!pool.length) throw new Error("No items available for warehouse generation");
  return pool;
}

function weightedPick(pool, random) {
  const total = pool.reduce((sum, item) => sum + item.weight, 0);
  let roll = random() * total;
  for (const item of pool) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return pool[pool.length - 1];
}

function findRandomPlacement(item, freeRects, random) {
  const fitting = freeRects.filter((rect) => item.width <= rect.width && item.height <= rect.height);
  if (!fitting.length) return null;

  const topY = Math.min(...fitting.map((rect) => rect.y));
  const nearTop = fitting.filter((rect) => rect.y <= topY + 4);
  const rect = nearTop[Math.floor(random() * nearTop.length)];
  const x = randomInt(random, rect.x, rect.x + rect.width - item.width);
  return { x, y: rect.y };
}

function shuffle(items, random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function findBestMaxRect(item, freeRects) {
  let best = null;
  for (const rect of freeRects) {
    if (item.width > rect.width || item.height > rect.height) continue;
    const shortSide = Math.min(rect.width - item.width, rect.height - item.height);
    const longSide = Math.max(rect.width - item.width, rect.height - item.height);
    const score = [rect.y, shortSide, longSide, rect.x];
    if (!best || compareScore(score, best.score) < 0) {
      best = { x: rect.x, y: rect.y, score };
    }
  }
  return best;
}

function splitFreeRects(freeRects, used) {
  const result = [];
  for (const rect of freeRects) {
    if (!intersects(rect, used)) {
      result.push(rect);
      continue;
    }

    if (used.x > rect.x) {
      result.push({ x: rect.x, y: rect.y, width: used.x - rect.x, height: rect.height });
    }
    if (used.x + used.width < rect.x + rect.width) {
      result.push({
        x: used.x + used.width,
        y: rect.y,
        width: rect.x + rect.width - (used.x + used.width),
        height: rect.height,
      });
    }
    if (used.y > rect.y) {
      result.push({ x: rect.x, y: rect.y, width: rect.width, height: used.y - rect.y });
    }
    if (used.y + used.height < rect.y + rect.height) {
      result.push({
        x: rect.x,
        y: used.y + used.height,
        width: rect.width,
        height: rect.y + rect.height - (used.y + used.height),
      });
    }
  }

  return pruneFreeRects(result.filter((rect) => rect.width > 0 && rect.height > 0));
}

function pruneFreeRects(rects) {
  return rects.filter((rect, index) => !rects.some((other, otherIndex) => otherIndex !== index && contains(other, rect)));
}

function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function contains(a, b) {
  return b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
}

function compareScore(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function itemHint(type, item, includeRarity, includeFull) {
  const hint = {
    type,
    itemIndex: item.index ?? 0,
    id: item.id,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
  };
  if (includeRarity) hint.rarity = item.rarity;
  if (includeFull) {
    hint.name = item.name;
    hint.itemType = item.type;
    hint.typeLabel = item.typeLabel;
    hint.price = item.price;
    hint.description = item.description;
    hint.image = item.image;
  }
  return hint;
}

function markItem(grid, item, value) {
  if (!item || item.id === 0) return;
  for (let y = item.y; y < item.y + item.height; y += 1) {
    for (let x = item.x; x < item.x + item.width; x += 1) {
      grid[y][x] = value;
    }
  }
}

function isKnownWholeItem(grid, item) {
  if (!item || item.id === 0) return false;
  for (let y = item.y; y < item.y + item.height; y += 1) {
    for (let x = item.x; x < item.x + item.width; x += 1) {
      if (!grid[y][x]) return false;
    }
  }
  return true;
}

function createView() {
  return {
    hint: [],
    rarityKnown: createGrid(false),
    outlineKnown: createGrid(false),
  };
}

function clampViewCount(value) {
  const count = Math.floor(Number(value) || Warehouse.VIEW_COUNT);
  return Math.max(1, Math.min(6, count));
}

function createGrid(value) {
  return Array.from({ length: Warehouse.MAX_ROWS }, () => Array.from({ length: Warehouse.WIDTH }, () => value));
}

function emptyItem() {
  return { id: 0, x: null, y: null };
}

function randomInt(random, min, max) {
  return Math.floor(random() * (max - min + 1)) + min;
}

function randomNormalInt(random, mean, stddev, min, max) {
  while (true) {
    const u1 = Math.max(Number.EPSILON, random());
    const u2 = random();
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const value = Math.round(mean + z0 * stddev);
    if (value >= min && value <= max) return value;
  }
}
