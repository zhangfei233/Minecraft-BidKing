import fs from "node:fs";
import path from "node:path";

export const ITEM_TYPES = [
  "decoration",
  "ore",
  "tool",
  "equipment",
  "natural",
  "food",
  "tech",
  "magic",
  "mob",
  "book",
  "multiblock",
  "loot",
];

export const FALLBACK_TYPE_LABELS = {
  decoration: "装饰",
  ore: "矿物",
  tool: "工具",
  equipment: "装备",
  natural: "自然",
  food: "食物",
  tech: "科技",
  magic: "魔法",
  mob: "生物",
  book: "书",
  multiblock: "多方块",
  loot: "战利品",
};

export const RARITIES = {
  red: "#ff6060",
  gold: "#faff75",
  purple: "#964aca",
  blue: "#7b8afc",
  green: "#95de93",
  gray: "#c7c7c7",
};

export const RARITY_ORDER_LOW_TO_HIGH = ["gray", "green", "blue", "purple", "gold", "red"];

export function loadConfig(rootDir) {
  const configPath = path.join(rootDir, "config.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

export function loadTypeLabels(rootDir) {
  try {
    const note = fs.readFileSync(path.join(rootDir, "note.txt"), "utf8");
    const line = note
      .split(/\r?\n/)
      .find((entry) => entry.trim().startsWith("物品种类:"));
    if (!line) return FALLBACK_TYPE_LABELS;

    const labels = line
      .slice(line.indexOf(":") + 1)
      .split(";")
      .map((label) => label.trim())
      .filter(Boolean);

    if (labels.length !== ITEM_TYPES.length) return FALLBACK_TYPE_LABELS;
    return Object.fromEntries(ITEM_TYPES.map((type, index) => [type, labels[index]]));
  } catch {
    return FALLBACK_TYPE_LABELS;
  }
}

export function loadItems(rootDir) {
  const itemsPath = path.join(rootDir, "items.csv");
  const csv = fs.readFileSync(itemsPath, "utf8").trim();
  const [headerLine, ...rows] = csv.split(/\r?\n/);
  const headers = parseCsvLine(headerLine);
  const typeLabels = loadTypeLabels(rootDir);

  return rows
    .filter(Boolean)
    .map((row) => {
      const cells = parseCsvLine(row);
      const item = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
      return normalizeItem(item, typeLabels);
    })
    .filter((item) => Number.isInteger(item.id) && item.id > 0);
}

export function loadItemsById(rootDir) {
  return new Map(loadItems(rootDir).map((item) => [item.id, item]));
}

export function parseCsvLine(line) {
  const cells = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && quoted && next === '"') {
      value += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(value.trim());
      value = "";
    } else {
      value += char;
    }
  }

  cells.push(value.trim());
  return cells;
}

export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function normalizeItem(item, typeLabels) {
  const id = Number(item.id);
  const types = splitTypes(item.type);
  return {
    id,
    name: item.name,
    type: item.type,
    types,
    typeLabel: types.map((type) => typeLabels[type] || type).join(";"),
    description: item.description,
    rarity: item.rarity,
    height: Number(item.height),
    width: Number(item.width),
    price: Number(item.price),
    image: `/resource/auction/${id}.png`,
  };
}

export function splitTypes(typeText) {
  return String(typeText || "")
    .split(";")
    .map((type) => type.trim())
    .filter(Boolean);
}
