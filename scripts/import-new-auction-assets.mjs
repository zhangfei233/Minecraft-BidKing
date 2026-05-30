import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { csvEscape, loadItems } from "../src/items/items.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "resource", "原版");
const auctionDir = path.join(root, "resource", "auction");
const itemsPath = path.join(root, "items.csv");
const header = "id,name,type,description,rarity,height,width,price";

const rarityRank = { gray: 0, green: 1, blue: 2, purple: 3, gold: 4 };

const translations = new Map([
  ["Osmium Ingot", "锇锭"],
  ["Osmium Nugget", "锇粒"],
  ["Osmium Dust", "锇粉"],
  ["Osmium Ore", "锇矿石"],
  ["Raw Osmium", "粗锇"],
  ["Steel Ingot", "钢锭"],
  ["Steel Casing", "钢制机壳"],
  ["Enriched Alloy", "富集合金"],
  ["Reinforced Alloy", "强化合金"],
  ["Atomic Alloy", "原子合金"],
  ["Basic Control Circuit", "基础控制电路"],
  ["Advanced Control Circuit", "高级控制电路"],
  ["Elite Control Circuit", "精英控制电路"],
  ["Ultimate Control Circuit", "终极控制电路"],
  ["Metallurgic Infuser", "冶金灌注机"],
  ["Crusher", "粉碎机"],
  ["Enrichment Chamber", "富集仓"],
  ["Digital Miner", "数字型采矿机"],
  ["Energy Tablet", "能量板"],
  ["Twilight Forest Portal", "暮色森林传送门"],
  ["Naga", "娜迦"],
  ["Lich", "巫妖"],
  ["Minoshroom", "米诺菇"],
  ["Hydra", "九头蛇"],
  ["Ur-Ghast", "暮色恶魂"],
  ["Snow Queen", "冰雪女王"],
  ["Questing Ram", "谜题羊"],
]);

const exactPrices = new Map([
  ["铁锭", 3200],
  ["金锭", 6300],
  ["钻石", 16000],
  ["绿宝石", 11000],
  ["锇锭", 4200],
  ["钢锭", 5200],
]);

const structurePrices = new Map([
  ["下界传送门", 42000],
  ["下界要塞", 90000],
  ["丛林神庙", 52000],
  ["末地传送门", 120000],
  ["林地府邸", 120000],
  ["沙漠神殿", 48000],
  ["沼泽小屋", 36000],
  ["海底神殿", 110000],
  ["潮涌核心", 76000],
  ["雪屋", 30000],
]);

const structureSizes = new Map([
  ["下界传送门", [4, 3]],
  ["末地传送门", [3, 3]],
  ["潮涌核心", [3, 3]],
  ["下界要塞", [5, 5]],
  ["林地府邸", [5, 6]],
  ["海底神殿", [5, 5]],
  ["丛林神庙", [4, 4]],
  ["沙漠神殿", [4, 4]],
  ["沼泽小屋", [3, 3]],
  ["雪屋", [3, 3]],
]);

const twilightMobs = new Set(["娜迦", "巫妖", "米诺菇", "九头蛇", "暮色恶魂", "冰雪女王", "谜题羊"]);

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(fullPath);
    if (entry.isFile() && /\.(png|gif|jpg|jpeg|webp)$/i.test(entry.name)) return [fullPath];
    return [];
  });
}

function normalizeName(rawName) {
  const withoutParen = rawName
    .replace(/\s*[（(][^（）()]*[）)]\s*/g, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (translations.has(withoutParen)) return translations.get(withoutParen);
  if (/^[A-Za-z0-9 ']+$/.test(withoutParen)) return translateEnglishName(withoutParen);
  return withoutParen;
}

function translateEnglishName(name) {
  const direct = translations.get(name);
  if (direct) return direct;
  return name
    .replace(/\bOsmium\b/g, "锇")
    .replace(/\bSteel\b/g, "钢")
    .replace(/\bCopper\b/g, "铜")
    .replace(/\bTin\b/g, "锡")
    .replace(/\bLead\b/g, "铅")
    .replace(/\bUranium\b/g, "铀")
    .replace(/\bIngot\b/g, "锭")
    .replace(/\bNugget\b/g, "粒")
    .replace(/\bDust\b/g, "粉")
    .replace(/\bOre\b/g, "矿石")
    .replace(/\bBlock\b/g, "块")
    .replace(/\bSword\b/g, "剑")
    .replace(/\bPickaxe\b/g, "镐")
    .replace(/\bAxe\b/g, "斧")
    .replace(/\bShovel\b/g, "锹")
    .replace(/\bHoe\b/g, "锄")
    .replace(/\bHelmet\b/g, "头盔")
    .replace(/\bChestplate\b/g, "胸甲")
    .replace(/\bLeggings\b/g, "护腿")
    .replace(/\bBoots\b/g, "靴子")
    .replace(/\s+/g, "")
    .trim();
}

function pathTags(file) {
  return path.relative(sourceDir, file).split(path.sep).slice(0, -1);
}

function hasFolder(folders, pattern) {
  return folders.some((folder) => pattern.test(folder));
}

function inferTypes(name, folders) {
  const types = new Set();
  const isStructure = hasFolder(folders, /结构/) || /传送门|神庙|神殿|要塞|府邸|小屋|雪屋/.test(name);
  const isTwilight = hasFolder(folders, /暮色森林|twilight/i);
  const isMekanism = hasFolder(folders, /mekanism/i);

  if (isStructure) types.add("multiblock");
  if (/[书册典笔记]/.test(name)) types.add("book");
  if (/矿石|锭$|粒$|粉$|粗/.test(name)) types.add("ore");
  if (/剑|镐|斧|锹|锄|弓|头盔|胸甲|护腿|靴子/.test(name)) types.add("equipment");
  if (/传送门|神庙|神殿|要塞|府邸|小屋|雪屋|核心|块|砖|玻璃|板/.test(name)) types.add("decoration");
  if (/电路|机器|机|管道|线缆|能量|反应堆|涡轮|工厂|灌注|粉碎|富集|采矿|控制|合金/.test(name)) types.add("tech");
  if (/魔|巫|妖|暮色|娜迦|九头蛇|恶魂|女王|传送门|符文|护符|权杖|法杖|迷宫|奖杯/.test(name)) types.add("magic");
  if (isTwilight && /娜迦|巫妖|米诺菇|九头蛇|恶魂|女王|羊|哥布林|巨魔|蜘蛛|狼|鹿|鸟|企鹅|乌鸦|野猪|亡灵/.test(name)) types.add("mob");
  if (twilightMobs.has(name)) types.add("mob");
  if (isMekanism && !/矿石|锭$|粒$|粉$|粗/.test(name)) types.add("tech");

  if (!types.size) types.add("decoration");
  return [...types].join(";");
}

function inferRarity(name, types) {
  let rarity = "gray";
  const bump = (candidate) => {
    if (rarityRank[candidate] > rarityRank[rarity]) rarity = candidate;
  };
  if (/终极|反物质|传送门|末地传送门|林地府邸|下界要塞|海底神殿|九头蛇|冰雪女王/.test(name)) bump("gold");
  else if (/精英|原子|下界|末地|数字型采矿机|娜迦|巫妖|米诺菇|暮色恶魂|钻石|绿宝石/.test(name)) bump("purple");
  else if (/高级|强化|锇|钢|金|红石|青金石|富集|神庙|神殿|要塞|小屋/.test(name)) bump("blue");
  else if (/基础|铜|铁|煤|锡|铅|铀|雪屋/.test(name)) bump("green");
  if (types.includes("mob") && rarity === "gray") bump("green");
  return rarity;
}

function inferSize(name, types) {
  if (structureSizes.has(name)) {
    const [height, width] = structureSizes.get(name);
    return { height, width };
  }
  if (types.includes("mob")) {
    if (/九头蛇|暮色恶魂/.test(name)) return { height: 4, width: 4 };
    if (/娜迦/.test(name)) return { height: 2, width: 5 };
    if (/巫妖|冰雪女王/.test(name)) return { height: 3, width: 1 };
    return { height: 2, width: 2 };
  }
  if (/剑|镐|斧|锹|锄/.test(name)) return { height: 3, width: 1 };
  if (/锭$|粒$|粉$|电路|合金|笔记|书|册|典/.test(name)) return { height: 1, width: 1 };
  return { height: 2, width: 2 };
}

function inferPrice(name, types, rarity, size) {
  if (structurePrices.has(name)) return structurePrices.get(name);
  if (exactPrices.has(name)) return exactPrices.get(name);
  const byRarity = { gray: 1200, green: 4200, blue: 12000, purple: 42000, gold: 140000 };
  const multipliers = { decoration: 1, ore: 1.35, tool: 1.2, equipment: 1.35, natural: 0.75, food: 0.65, tech: 1.35, magic: 1.9, loot: 1.8, book: 1.25, multiblock: 1.8, mob: 1.35 };
  const strongest = types.split(";").reduce((best, type) => (multipliers[type] ?? 1) > (multipliers[best] ?? 1) ? type : best, "decoration");
  const areaFactor = Math.sqrt((size.height * size.width) / 4);
  return Math.round(byRarity[rarity] * (multipliers[strongest] ?? 1) * areaFactor);
}

function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name));
  }
  if (dir !== sourceDir && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

const items = loadItems(root);
const existingNames = new Set(items.map((item) => item.name));
const rows = [header];
for (const item of items) {
  const types = new Set(String(item.type).split(";").filter(Boolean));
  if (/[书册典笔记]/.test(item.name)) types.add("book");
  else types.delete("book");
  rows.push([item.id, csvEscape(item.name), [...types].join(";") || "decoration", csvEscape(item.description), item.rarity, item.height, item.width, item.price].join(","));
}

let nextId = items.length + 1;
let imported = 0;
let skipped = 0;
const skippedNames = [];
const importedNames = [];

for (const file of walkFiles(sourceDir).sort((a, b) => path.relative(sourceDir, a).localeCompare(path.relative(sourceDir, b), "zh-CN"))) {
  const rawName = path.basename(file, path.extname(file));
  const name = normalizeName(rawName);
  if (existingNames.has(name)) {
    fs.rmSync(file, { force: true });
    skipped += 1;
    skippedNames.push(name);
    continue;
  }
  const folders = pathTags(file);
  const types = inferTypes(name, folders);
  const rarity = inferRarity(name, types);
  const size = inferSize(name, types);
  const price = inferPrice(name, types, rarity, size);
  fs.renameSync(file, path.join(auctionDir, `${nextId}.png`));
  rows.push([nextId, csvEscape(name), types, "", rarity, size.height, size.width, price].join(","));
  existingNames.add(name);
  importedNames.push(name);
  imported += 1;
  nextId += 1;
}

fs.writeFileSync(itemsPath, `${rows.join("\n")}\n`, "utf8");
removeEmptyDirs(sourceDir);

console.log(JSON.stringify({ imported, skipped, total: rows.length - 1, importedNames, skippedNames }, null, 2));
