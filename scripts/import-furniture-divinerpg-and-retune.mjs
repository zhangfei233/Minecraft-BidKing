import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { csvEscape, loadItems } from "../src/items/items.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const auctionDir = path.join(root, "resource", "auction");
const itemsPath = path.join(root, "items.csv");
const header = "id,name,type,description,rarity,height,width,price";
const sourceRoots = [
  { dir: path.join(root, "resource", "家具"), mod: "furniture" },
  { dir: path.join(root, "resource", "神圣RPG"), mod: "divinerpg" },
];

const rarityOrder = ["gray", "green", "blue", "purple", "gold", "red"];
const rarityBasePrice = { gray: 1200, green: 4200, blue: 12000, purple: 42000, gold: 140000, red: 360000 };
const rarityTargets = [
  ["gray", 0.25],
  ["green", 0.25],
  ["blue", 0.2],
  ["purple", 0.15],
  ["gold", 0.1],
  ["red", 0.05],
];

const divineEnglish = new Map([
  ["Aquatic Maul", "水域巨锤"],
  ["Bedrock Sword", "基岩剑"],
  ["Bloodgem Sword", "血晶剑"],
  ["Divine Sword", "神圣剑"],
  ["Eden Blade", "伊甸利刃"],
  ["Halite Blade", "岩盐利刃"],
  ["Inferno Sword", "炼狱剑"],
  ["Skythern Sword", "天境剑"],
  ["Wildwood Sword", "野木剑"],
]);

function walkSource({ dir, mod }) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkSource({ dir: fullPath, mod });
    if (entry.isFile() && /\.(png|gif|jpg|jpeg|webp)$/i.test(entry.name)) {
      const sourceRoot = sourceRoots.find((source) => source.mod === mod).dir;
      return [{ file: fullPath, sourceRoot, mod }];
    }
    return [];
  });
}

function normalizeName(rawName) {
  const stripped = rawName
    .replace(/\s*[（(][^（）()]*[）)]\s*/g, "")
    .replace(/【[^【】]*】/g, "")
    .replace(/\s+_/g, "_")
    .replace(/_\s+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (divineEnglish.has(stripped)) return divineEnglish.get(stripped);
  if (/^[A-Za-z0-9 ']+$/.test(stripped)) return translateEnglish(stripped);
  return stripped;
}

function translateEnglish(name) {
  return name
    .replace(/\bDivine\b/g, "神圣")
    .replace(/\bAquatic\b/g, "水域")
    .replace(/\bInferno\b/g, "炼狱")
    .replace(/\bBedrock\b/g, "基岩")
    .replace(/\bBloodgem\b/g, "血晶")
    .replace(/\bSword\b/g, "剑")
    .replace(/\bAxe\b/g, "斧")
    .replace(/\bPickaxe\b/g, "镐")
    .replace(/\bShovel\b/g, "铲")
    .replace(/\bHoe\b/g, "锄")
    .replace(/\bHelmet\b/g, "头盔")
    .replace(/\bChestplate\b/g, "胸甲")
    .replace(/\bLeggings\b/g, "护腿")
    .replace(/\bBoots\b/g, "靴子")
    .replace(/\bShield\b/g, "盾牌")
    .replace(/\bIngot\b/g, "锭")
    .replace(/\bOre\b/g, "矿石")
    .replace(/\bBlock\b/g, "块")
    .replace(/\s+/g, "")
    .trim();
}

function foldersFor(entry) {
  return path.relative(entry.sourceRoot, entry.file).split(path.sep).slice(0, -1);
}

function hasFolder(folders, pattern) {
  return folders.some((folder) => pattern.test(folder));
}

function inferNewTypes(name, folders, mod) {
  const types = new Set();
  const folderText = folders.join("/");

  if (/[书册典笔记日记手册]/.test(name)) types.add("book");
  if (mod === "furniture") types.add("decoration");
  if (mod === "furniture" && /电器|照明/.test(folderText)) types.add("tech");
  if (mod === "furniture" && /食物/.test(folderText)) types.add("food");
  if (mod === "furniture" && /存储|家具|厨房|卫生间|外饰|窗户|节日装饰/.test(folderText)) types.add("decoration");

  if (mod === "divinerpg") {
    if (/BOSS/.test(folderText)) {
      types.add("magic");
      if (/召唤方块|祭台|陷阱/.test(folderText)) types.add("multiblock");
    }
    if (/召唤物/.test(folderText)) types.add("loot");
    if (/工具/.test(folderText) || /镐|铲|锹|斧|锄/.test(name)) types.add("tool");
    if (/武器|盾牌|装备/.test(folderText) || /剑|弓|权杖|盾牌|头盔|胸甲|护腿|裤子|靴/.test(name)) types.add("equipment");
    if (/材料|货币/.test(folderText) || /锭$|粒$|矿石|碎片|宝石|水晶|货币|币/.test(name)) types.add("ore");
    if (/食物/.test(folderText) || /肉|汤|苹果|浆果|食物/.test(name)) types.add("food");
    if (/祭台|神圣|秘银|暗影|炼狱|血晶|梦魇|弧光|熔岩|天境|伊甸|荒野|水域/.test(name)) types.add("magic");
  }

  if (!types.size) types.add("decoration");
  return [...types].join(";");
}

function importNewAssets() {
  const items = loadItems(root);
  const existingNames = new Set(items.map((item) => item.name));
  let nextId = items.length + 1;
  const imported = [];
  const skipped = [];
  let translated = 0;

  const files = sourceRoots.flatMap(walkSource).sort((a, b) => a.file.localeCompare(b.file, "zh-CN"));
  for (const entry of files) {
    const rawName = path.basename(entry.file, path.extname(entry.file));
    const name = normalizeName(rawName);
    if (name !== rawName) translated += 1;
    if (existingNames.has(name)) {
      fs.rmSync(entry.file, { force: true });
      skipped.push(name);
      continue;
    }
    const folders = foldersFor(entry);
    const type = inferNewTypes(name, folders, entry.mod);
    const provisional = {
      id: nextId,
      name,
      type,
      description: "",
      rarity: "gray",
      height: 2,
      width: 2,
      price: 0,
      sourceMod: entry.mod,
      sourceFolders: folders,
    };
    fs.renameSync(entry.file, path.join(auctionDir, `${nextId}.png`));
    imported.push(provisional);
    existingNames.add(name);
    nextId += 1;
  }

  for (const source of sourceRoots) removeEmptyDirs(source.dir);
  return { baseItems: items, imported, skipped, translated };
}

function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name));
  }
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

function splitTypes(typeText) {
  return String(typeText || "").split(";").map((type) => type.trim()).filter(Boolean);
}

function itemTypes(item) {
  const types = new Set(splitTypes(item.type));
  if (/[书册典笔记日记手册]/.test(item.name)) types.add("book");
  else types.delete("book");
  if (!types.size) types.add("decoration");
  return types;
}

function difficultyScore(item, types) {
  const name = item.name;
  let score = 0;
  if (types.has("natural") || types.has("food")) score += 4;
  if (types.has("decoration")) score += 8;
  if (types.has("ore")) score += 16;
  if (types.has("tool")) score += 22;
  if (types.has("equipment")) score += 28;
  if (types.has("tech")) score += 36;
  if (types.has("magic")) score += 44;
  if (types.has("loot")) score += 38;
  if (types.has("mob")) score += 34;
  if (types.has("multiblock")) score += 54;
  if (types.has("book")) score += 8;

  if (/泥土|沙子|圆石|石头|木板|树叶|种子|染料|玻璃|纸|木棍|花|草|莓/.test(name)) score -= 12;
  if (/铜|铁|煤|锡|铅|氟石|基础|普通/.test(name)) score += 8;
  if (/金|红石|青金石|锇|钢|青铜|骑士|钢叶|铁树|高级|强化/.test(name)) score += 18;
  if (/钻石|绿宝石|下界|末地|精英|原子|炽铁|娜迦|巫妖|米诺菇|数字型|反应堆/.test(name)) score += 34;
  if (/下界合金|终极|创造|无尽|基岩|命令方块|龙蛋|鞘翅|九头蛇|冰雪女王|暮色恶魂|监守者|末影龙|凋灵|神圣|梦魇|炼狱|聚变|裂变|超临界/.test(name)) score += 60;
  if (/BOSS|Boss|召唤|祭台|战利品|遗物|神器|权杖|护符|符咒|核心/.test(name)) score += 22;
  if (/不可获取|创造|命令方块|基岩|屏障|结构方块|拼图/.test(name)) score += 90;

  return score + Math.log2(Math.max(1, Number(item.price) || 1));
}

function assignRarities(items) {
  const decorated = items.map((item, index) => ({ item, index, score: difficultyScore(item, itemTypes(item)) }));
  decorated.sort((a, b) => a.score - b.score || a.index - b.index);

  let cursor = 0;
  const counts = rarityTargets.map(([rarity, ratio], index) => {
    if (index === rarityTargets.length - 1) return [rarity, items.length - cursor];
    const count = Math.round(items.length * ratio);
    cursor += count;
    return [rarity, count];
  });
  const assigned = new Map();
  let offset = 0;
  for (const [rarity, count] of counts) {
    for (const entry of decorated.slice(offset, offset + count)) assigned.set(entry.item.id, rarity);
    offset += count;
  }
  return assigned;
}

function hardSize(item, types) {
  const name = item.name;
  if (/船$|矿车$/.test(name)) return { height: 2, width: 3, locked: true };
  if (/锹镐斧/.test(name)) return { height: 3, width: 2, locked: true };
  if (/胸甲|马甲|皮衣/.test(name)) return { height: 3, width: 3, locked: true };
  if (/裤子|护腿/.test(name)) return { height: 3, width: 2, locked: true };
  if (/头盔|头巾|风帽|角盔|王冠|靴|靴子/.test(name)) return { height: 2, width: 3, locked: true };
  if (/剑|铲|锹/.test(name)) return { height: 3, width: 1, locked: true };
  if (/斧|镐/.test(name)) return { height: 3, width: 2, locked: true };
  if (/盾牌|盾|权杖|法杖|魔杖|钓竿|弓|弩|三叉戟|重锤|链锤|战斧|锤|炮|飞盘|爪|环|钻头|喷气背包|护目镜|腰带/.test(name)) {
    return { height: 3, width: 2, locked: true };
  }
  return null;
}

function baseSize(item, types) {
  const name = item.name;
  const hard = hardSize(item, types);
  if (hard) return hard;

  if (types.has("multiblock")) {
    if (/府邸|神殿|要塞|聚变|裂变|涡轮|锅炉|动态储罐|感应矩阵|超临界/.test(name)) return { height: 5, width: 5 };
    if (/传送门|祭台|反应堆|塔|矩阵|结构/.test(name)) return { height: 4, width: 5 };
    return { height: 4, width: 4 };
  }

  if (types.has("mob")) {
    if (/末影龙|九头蛇/.test(name)) return { height: 5, width: 5 };
    if (/凋灵|暮色恶魂|恶魂|监守者|冰雪女王|雪怪首领|劫掠兽|巨人|BOSS|Boss/.test(name)) return { height: 4, width: 4 };
    if (/娜迦/.test(name)) return { height: 3, width: 5 };
    if (/马|牛|鹿|羊|猪|熊|海豚|羊驼|骆驼|疣猪|蜘蛛|机器人/.test(name)) return { height: 2, width: 3 };
    return { height: 2, width: 2 };
  }

  if (/门$|旗帜|窗户|帘|镜|冰箱|衣柜|书柜|货架|告示牌/.test(name)) return { height: 3, width: 2 };
  if (/矿石$|(?<!碎)块$/.test(name)) return { height: 2, width: 2 };
  if (/沙发|床|长椅|柜台|厨台|橱柜|柜|书桌|桌|餐桌|浴缸|钢琴|电视|灶|烤箱|洗衣机|发电机|机器|工厂|储罐|箱柜|驱动器阵列/.test(name)) {
    const options = [
      { height: 2, width: 3 },
      { height: 2, width: 4 },
      { height: 3, width: 3 },
      { height: 3, width: 4 },
      { height: 4, width: 3 },
    ];
    return options[item.id % options.length];
  }
  if (/椅|凳|灯|水槽|马桶|盆栽|烛台|罐子|垃圾桶|栅栏|柱|树苗|梯子/.test(name)) return { height: 2, width: 1 };
  if (/台阶|半砖|压力板|按钮|地毯|面板|板$|电路|合金|升级|单元|锭$|粒$|粉$|碎片|货币|币|皮革|羽毛|鳞片|钥匙|笔记|日记|手册|书$|册$|典$/.test(name)) {
    return { height: 1, width: 1 };
  }
  if (types.has("tool") && /神圣|水域|炼狱|基岩|血晶|伊甸|天境|野木|幻影|梦魇|弧光|熔岩|阿勒|卢比|现石|空境|死域|腐化|附魔山脉|生成|宝珠|火花|治疗之石|锄/.test(name)) {
    const longSizes = [
      { height: 1, width: 3 },
      { height: 1, width: 4 },
      { height: 1, width: 5 },
      { height: 3, width: 1 },
      { height: 4, width: 1 },
      { height: 5, width: 1 },
    ];
    return longSizes[item.id % longSizes.length];
  }
  if (types.has("equipment") || types.has("tool")) return { height: 2, width: 2 };
  if (types.has("ore") || types.has("food") || types.has("book")) return { height: 1, width: 1 };
  if (types.has("tech") || types.has("magic") || types.has("loot")) return { height: 2, width: 2 };
  return { height: 2, width: 2 };
}

const promoteSizes = [
  { height: 2, width: 3 },
  { height: 3, width: 2 },
  { height: 3, width: 3 },
  { height: 2, width: 4 },
  { height: 4, width: 2 },
  { height: 3, width: 4 },
  { height: 4, width: 3 },
  { height: 2, width: 5 },
  { height: 5, width: 2 },
  { height: 3, width: 5 },
  { height: 5, width: 3 },
  { height: 4, width: 4 },
  { height: 4, width: 5 },
  { height: 5, width: 4 },
  { height: 5, width: 5 },
];

function isSmall(item) {
  return item.height <= 2 && item.width <= 2;
}

function sizeKey(item) {
  return `${item.height}x${item.width}`;
}

function retuneSizes(items) {
  const locked = new Set();
  for (const item of items) {
    const types = itemTypes(item);
    const hard = hardSize(item, types);
    const size = hard || baseSize(item, types);
    item.height = size.height;
    item.width = size.width;
    if (hard?.locked) locked.add(item.id);
  }

  const targetSmall = Math.round(items.length * 0.65);
  let smallCount = items.filter(isSmall).length;
  if (smallCount > targetSmall) {
    const candidates = items
      .filter((item) => isSmall(item) && !locked.has(item.id))
      .filter((item) => {
        const types = itemTypes(item);
        return types.has("tech") || types.has("magic") || types.has("loot") || types.has("decoration") || types.has("equipment") || types.has("tool");
      })
      .sort((a, b) => difficultyScore(b, itemTypes(b)) - difficultyScore(a, itemTypes(a)));
    let index = 0;
    while (smallCount > targetSmall && index < candidates.length) {
      const item = candidates[index];
      const size = promoteSizes[index % promoteSizes.length];
      item.height = size.height;
      item.width = size.width;
      smallCount -= 1;
      index += 1;
    }
  }

  const requiredSizes = [];
  for (let height = 1; height <= 5; height += 1) {
    for (let width = 1; width <= 5; width += 1) requiredSizes.push(`${height}x${width}`);
  }
  const counts = new Map();
  for (const item of items) counts.set(sizeKey(item), (counts.get(sizeKey(item)) || 0) + 1);
  const flexible = items
    .filter((item) => !locked.has(item.id))
    .filter((item) => !itemTypes(item).has("ore") && !itemTypes(item).has("book"))
    .sort((a, b) => difficultyScore(b, itemTypes(b)) - difficultyScore(a, itemTypes(a)));
  let cursor = 0;
  for (const missing of requiredSizes.filter((key) => !counts.has(key))) {
    const [height, width] = missing.split("x").map(Number);
    const item = flexible[cursor];
    if (!item) break;
    counts.set(sizeKey(item), Math.max(0, (counts.get(sizeKey(item)) || 1) - 1));
    item.height = height;
    item.width = width;
    counts.set(missing, 1);
    cursor += 1;
  }

  const slenderTargets = ["1x3", "1x4", "1x5", "4x1", "5x1"];
  const slenderCandidates = items
    .filter((item) => !locked.has(item.id))
    .filter((item) => itemTypes(item).has("tool") || itemTypes(item).has("equipment"))
    .filter((item) => /神圣|水域|炼狱|基岩|血晶|伊甸|天境|野木|幻影|梦魇|弧光|熔岩|阿勒|卢比|现石|空境|死域|腐化|附魔山脉|生成|宝珠|火花|治疗之石|锄/.test(item.name));
  let slenderCursor = 0;
  for (const target of slenderTargets) {
    while ((counts.get(target) || 0) < 5 && slenderCursor < slenderCandidates.length) {
      const item = slenderCandidates[slenderCursor];
      if (sizeKey(item) === target) {
        slenderCursor += 1;
        continue;
      }
      const [height, width] = target.split("x").map(Number);
      counts.set(sizeKey(item), Math.max(0, (counts.get(sizeKey(item)) || 1) - 1));
      item.height = height;
      item.width = width;
      counts.set(target, (counts.get(target) || 0) + 1);
      slenderCursor += 1;
    }
  }
}

function retunePrices(items) {
  for (const item of items) {
    const types = itemTypes(item);
    const multipliers = { decoration: 1, ore: 1.35, tool: 1.25, equipment: 1.35, natural: 0.75, food: 0.65, tech: 1.45, magic: 1.9, mob: 1.35, book: 1.1, multiblock: 1.85, loot: 1.8 };
    const strongest = [...types].reduce((best, type) => (multipliers[type] ?? 1) > (multipliers[best] ?? 1) ? type : best, "decoration");
    const areaFactor = Math.sqrt((item.height * item.width) / 4);
    const hash = [...item.name].reduce((sum, char) => sum + char.codePointAt(0), 0);
    const formulaPrice = Math.round(rarityBasePrice[item.rarity] * (multipliers[strongest] ?? 1) * areaFactor * (0.94 + (hash % 13) / 100));
    item.price = Math.max(Number(item.price) || 0, formulaPrice);
  }

  const byName = new Map(items.map((item) => [item.name, item]));
  const setPrice = (name, price) => {
    const item = byName.get(name);
    if (item) item.price = price;
  };
  const price = (name) => byName.get(name)?.price;
  if (price("沙子")) setPrice("砂岩", price("沙子") * 4);
  if (price("红沙")) setPrice("红砂岩", price("红沙") * 4);
  for (const [base, block] of [["铁锭", "铁块"], ["金锭", "金块"], ["钻石", "钻石块"], ["绿宝石", "绿宝石块"], ["青金石", "青金石块"], ["煤炭", "煤炭块"]]) {
    if (price(base)) setPrice(block, price(base) * 9);
  }
}

function writeItems(items) {
  const rows = [header];
  for (const item of items.sort((a, b) => a.id - b.id)) {
    const types = [...itemTypes(item)].join(";");
    rows.push([item.id, csvEscape(item.name), types, csvEscape(item.description || ""), item.rarity, item.height, item.width, item.price].join(","));
  }
  fs.writeFileSync(itemsPath, `${rows.join("\n")}\n`, "utf8");
}

const { baseItems, imported, skipped, translated } = importNewAssets();
const allItems = [...baseItems, ...imported].map((item) => ({ ...item }));
const rarityById = assignRarities(allItems);
for (const item of allItems) item.rarity = rarityById.get(item.id) || "gray";
retuneSizes(allItems);
retunePrices(allItems);
writeItems(allItems);

const rarityCounts = Object.fromEntries(rarityOrder.map((rarity) => [rarity, allItems.filter((item) => item.rarity === rarity).length]));
const smallCount = allItems.filter(isSmall).length;
const sizeCounts = {};
for (const item of allItems) sizeCounts[sizeKey(item)] = (sizeCounts[sizeKey(item)] || 0) + 1;

console.log(JSON.stringify({
  imported: imported.length,
  skipped: skipped.length,
  translated,
  total: allItems.length,
  rarityCounts,
  smallCount,
  smallRatio: Number((smallCount / allItems.length).toFixed(3)),
  sizeKinds: Object.keys(sizeCounts).length,
  importedSamples: imported.slice(0, 20).map((item) => item.name),
  skippedSamples: skipped.slice(0, 20),
}, null, 2));
