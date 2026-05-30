import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { csvEscape, loadItems } from "../src/items/items.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [
  { dir: path.join(root, "resource", "暮色森林"), mod: "twilight" },
  { dir: path.join(root, "resource", "mekanism"), mod: "mekanism" },
];
const auctionDir = path.join(root, "resource", "auction");
const itemsPath = path.join(root, "items.csv");
const header = "id,name,type,description,rarity,height,width,price";
const rarityRank = { gray: 0, green: 1, blue: 2, purple: 3, gold: 4 };

const englishTranslations = new Map([
  ["Advanced Circuit", "高级电路"],
  ["Advanced Control Circuit", "高级控制电路"],
  ["Advanced Tier Installer", "高级工厂安装器"],
  ["Basic Circuit", "基础电路"],
  ["Basic Control Circuit", "基础控制电路"],
  ["Basic Tier Installer", "基础工厂安装器"],
  ["Black Diamond", "黑钻石"],
  ["Bronze Ingot", "青铜锭"],
  ["Creative Bin", "创造箱柜"],
  ["Creative Chemical Tank", "创造化学品储罐"],
  ["Creative Fluid Tank", "创造液体储罐"],
  ["Elite Circuit", "精英电路"],
  ["Elite Control Circuit", "精英控制电路"],
  ["Elite Tier Installer", "精英工厂安装器"],
  ["Ferrous Alloy Ingot", "黑色合金锭"],
  ["Osmium Ingot", "锇锭"],
  ["Ultimate Circuit", "终极电路"],
  ["Ultimate Control Circuit", "终极控制电路"],
  ["Ultimate Tier Installer", "终极工厂安装器"],
]);

const wordTranslations = [
  [/\bOsmium\b/g, "锇"],
  [/\bSteel\b/g, "钢"],
  [/\bBronze\b/g, "青铜"],
  [/\bCopper\b/g, "铜"],
  [/\bTin\b/g, "锡"],
  [/\bLead\b/g, "铅"],
  [/\bUranium\b/g, "铀"],
  [/\bFluorite\b/g, "氟石"],
  [/\bRefined Obsidian\b/g, "精炼黑曜石"],
  [/\bRefined Glowstone\b/g, "精炼荧石"],
  [/\bBasic\b/g, "基础"],
  [/\bAdvanced\b/g, "高级"],
  [/\bElite\b/g, "精英"],
  [/\bUltimate\b/g, "终极"],
  [/\bCreative\b/g, "创造"],
  [/\bControl Circuit\b/g, "控制电路"],
  [/\bCircuit\b/g, "电路"],
  [/\bTier Installer\b/g, "工厂安装器"],
  [/\bChemical Tank\b/g, "化学品储罐"],
  [/\bFluid Tank\b/g, "液体储罐"],
  [/\bBin\b/g, "箱柜"],
  [/\bIngot\b/g, "锭"],
  [/\bNugget\b/g, "粒"],
  [/\bDust\b/g, "粉"],
  [/\bOre\b/g, "矿石"],
  [/\bBlock\b/g, "块"],
  [/\bSword\b/g, "剑"],
  [/\bPickaxe\b/g, "镐"],
  [/\bAxe\b/g, "斧"],
  [/\bShovel\b/g, "锹"],
  [/\bHoe\b/g, "锄"],
  [/\bHelmet\b/g, "头盔"],
  [/\bChestplate\b/g, "胸甲"],
  [/\bLeggings\b/g, "护腿"],
  [/\bBoots\b/g, "靴子"],
  [/\bPlastic\b/g, "塑料"],
  [/\bGlow\b/g, "发光"],
  [/\bTransparent\b/g, "透明"],
  [/\bSlab\b/g, "台阶"],
  [/\bStairs\b/g, "楼梯"],
  [/\bBarrier\b/g, "栅栏"],
  [/\bGate\b/g, "栅栏门"],
  [/\bPanel\b/g, "板"],
  [/\bWhite\b/g, "白色"],
  [/\bOrange\b/g, "橙色"],
  [/\bMagenta\b/g, "品红色"],
  [/\bLight Blue\b/g, "淡蓝色"],
  [/\bYellow\b/g, "黄色"],
  [/\bLime\b/g, "黄绿色"],
  [/\bPink\b/g, "粉色"],
  [/\bGray\b/g, "灰色"],
  [/\bLight Gray\b/g, "淡灰色"],
  [/\bCyan\b/g, "青色"],
  [/\bPurple\b/g, "紫色"],
  [/\bBlue\b/g, "蓝色"],
  [/\bBrown\b/g, "棕色"],
  [/\bGreen\b/g, "绿色"],
  [/\bRed\b/g, "红色"],
  [/\bBlack\b/g, "黑色"],
];

const twilightMobNames = new Set([
  "九头蛇",
  "冰雪女王",
  "娜迦",
  "巫妖",
  "巫妖的仆从",
  "幻影骑士",
  "暮色恶魂",
  "米诺菇",
  "雪怪首领",
  "乌鸦",
  "企鹅",
  "大角山羊",
  "小兔子",
  "小鸟",
  "松鼠",
  "谜题羊",
  "野猪",
  "野鹿",
]);

const mobSizes = new Map([
  ["九头蛇", [4, 4]],
  ["暮色恶魂", [4, 4]],
  ["娜迦", [2, 5]],
  ["巫妖", [3, 1]],
  ["冰雪女王", [3, 1]],
  ["雪怪首领", [4, 3]],
  ["米诺菇", [3, 2]],
  ["幻影骑士", [3, 1]],
  ["巫妖的仆从", [2, 1]],
  ["大角山羊", [2, 3]],
  ["谜题羊", [2, 3]],
  ["野猪", [2, 2]],
  ["野鹿", [2, 3]],
  ["企鹅", [1, 1]],
  ["乌鸦", [1, 1]],
  ["小鸟", [1, 1]],
  ["松鼠", [1, 1]],
  ["小兔子", [1, 1]],
  ["机器人", [2, 1]],
]);

const exactPrices = new Map([
  ["铜粒", 140],
  ["铜锭", 1260],
  ["铁锭", 3200],
  ["金锭", 6300],
  ["钻石", 16000],
  ["绿宝石", 11000],
  ["锇锭", 4200],
  ["青铜锭", 3600],
  ["钢锭", 5200],
  ["炽铁锭", 9000],
  ["铁树锭", 5200],
  ["骑士金属锭", 7600],
]);

function walkSource({ dir, mod }) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkSource({ dir: fullPath, mod });
    if (entry.isFile() && /\.(png|gif|jpg|jpeg|webp)$/i.test(entry.name)) return [{ file: fullPath, sourceRoot: sourceRootFor(fullPath, mod), mod }];
    return [];
  });
}

function sourceRootFor(file, mod) {
  return sourceRoots.find((rootInfo) => rootInfo.mod === mod && (file === rootInfo.dir || file.startsWith(rootInfo.dir + path.sep)))?.dir;
}

function foldersFor(file, sourceRoot) {
  return path.relative(sourceRoot, file).split(path.sep).slice(0, -1);
}

function normalizeName(rawName) {
  const stripped = rawName
    .replace(/\s*[（(][^（）()]*[）)]\s*/g, "")
    .replace(/【[^【】]*】/g, "")
    .replace(/\s+_/g, "_")
    .replace(/_\s+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (englishTranslations.has(stripped)) return englishTranslations.get(stripped);
  if (/^[A-Za-z0-9 ']+$/.test(stripped)) return translateEnglish(stripped);
  return stripped;
}

function translateEnglish(name) {
  let result = name;
  for (const [pattern, replacement] of wordTranslations) result = result.replace(pattern, replacement);
  return result.replace(/\s+/g, "").trim();
}

function inferTypes(name, folders, mod) {
  const types = new Set();
  const folderText = folders.join("/");
  const isMekanism = mod === "mekanism";
  const isTwilight = mod === "twilight";

  if (/[书册典笔记日记手册]/.test(name) || /手册|笔记/.test(folderText)) types.add("book");
  if (/结构|动态储罐|感应矩阵|涡轮|热力锅炉|盐化塔|聚变反应堆|裂变反应堆|超临界移相器/.test(folderText)) types.add("multiblock");
  if (/BOSS|生物/.test(folderText) || twilightMobNames.has(name) || name === "机器人") types.add("mob");
  if (/资源/.test(folderText) || /矿石|锭$|粒$|粉$|碎片|矿莓|合金|原料|金属环/.test(name)) types.add("ore");
  if (/工具/.test(folderText) || /镐|铲|锹|斧|锄|地图|罗盘|磁铁|感应仪|钥匙|扇|号角|怀表|符咒/.test(name)) types.add("tool");
  if (/武器|装备/.test(folderText) || /剑|弓|弩|权杖|炸弹|战斧|盾|头盔|胸甲|护腿|靴|风帽|皮衣|手套|护目镜|腰带|马甲|王冠|背包/.test(name)) types.add("equipment");
  if (/食物/.test(folderText) || /肉|肉排|面包|莓|薄饼|汤|沙拉|仙贝|食物|液滴/.test(name)) types.add("food");
  if (/建筑方块|装饰品|木材|互动方块/.test(folderText) || /块|砖|木板|树叶|原木|木材|玻璃|楼梯|台阶|栅栏|门|地毯|罐|架|箱|宝座|匣|窗|柱|石|土|泥|灯|板/.test(name)) types.add("decoration");
  if (/树苗|植物/.test(folderText) || /树苗|树叶|草|花|蘑菇|藤|莓丛|根|荆棘|苔藓|蕨|落叶|木板|原木|木材/.test(name)) types.add("natural");
  if (/战利品/.test(folderText) || /战利品|遗物|奖杯|碎片|毛皮|鳞片|羽毛|皮革|钥匙/.test(name)) types.add("loot");
  if (/魔|巫|妖|暮色|娜迦|九头蛇|恶魂|女王|幻影|符咒|权杖|地图核心|迷宫|炽热|余烬|月光|湮灭|灵魂|遗物/.test(name)) types.add("magic");
  if (isTwilight && /BOSS|功效方块|工具|武器|战利品/.test(folderText)) types.add("magic");
  if (isMekanism && !/资源/.test(folderText) && !/矿石|锭$|粒$|粉$|粗/.test(name)) types.add("tech");
  if (isMekanism && /机器|QIO|发电机|存储|升级组件|电力存储|管道|爆炸物|宠物/.test(folderText)) types.add("tech");

  if (types.has("mob")) {
    for (const type of ["decoration", "ore", "tool", "equipment", "natural", "food", "book", "multiblock"]) types.delete(type);
  }
  if (!types.size) types.add("decoration");
  return [...types].join(";");
}

function inferRarity(name, types, mod) {
  let rarity = "gray";
  const bump = (candidate) => {
    if (rarityRank[candidate] > rarityRank[rarity]) rarity = candidate;
  };

  if (/终极|创造|无尽|反物质|聚变|裂变|超临界|九头蛇|冰雪女王|暮色恶魂|湮灭|巨人/.test(name)) bump("gold");
  else if (/精英|原子|数字型|传送|反应堆|娜迦|巫妖|米诺菇|雪怪首领|幻影|钻石|黑钻石|六方金刚石|炽铁|骑士/.test(name)) bump("purple");
  else if (/高级|强化|锇|钢|金|红石|青金石|富集|灌注|能量|电路|控制|魔法|迷宫|炽热|极光|钢叶|铁树/.test(name)) bump("blue");
  else if (/基础|铜|铁|锡|铅|铀|氟石|煤|下界莓|主世界莓/.test(name)) bump("green");

  if (types.includes("tech") && rarity === "gray") bump("green");
  if (types.includes("mob") && rarity === "gray") bump("green");
  if (mod === "twilight" && types.includes("magic") && rarity === "gray") bump("green");
  return rarity;
}

function inferSize(name, types) {
  if (types.includes("mob")) {
    const size = mobSizes.get(name);
    if (size) return { height: size[0], width: size[1] };
    return { height: 2, width: 1 };
  }
  if (types.includes("multiblock")) {
    if (/聚变|裂变|涡轮|锅炉|动态储罐|感应矩阵|超临界/.test(name)) return { height: 4, width: 4 };
    return { height: 3, width: 3 };
  }
  if (/剑|镐|铲|锹|斧|锄|弓|权杖|战斧|链锤/.test(name)) return { height: 3, width: 1 };
  if (/锭$|粒$|粉$|碎片|莓$|羽毛|皮革|鳞片|电路|合金|升级|单元|符咒|钥匙|地图|核心|笔记|日记|手册|书|册|典/.test(name)) return { height: 1, width: 1 };
  if (/门|栅栏|柱|树苗|藤|荆棘|窗户|梯子/.test(name)) return { height: 2, width: 1 };
  return { height: 2, width: 2 };
}

function inferPrice(name, types, rarity, size) {
  if (exactPrices.has(name)) return exactPrices.get(name);
  const base = { gray: 1200, green: 4200, blue: 12000, purple: 42000, gold: 140000 }[rarity] ?? 1200;
  const multipliers = {
    decoration: 1,
    ore: 1.35,
    tool: 1.2,
    equipment: 1.35,
    natural: 0.75,
    food: 0.65,
    tech: 1.45,
    magic: 1.9,
    mob: 1.35,
    book: 1.25,
    multiblock: 1.85,
    loot: 1.8,
  };
  const strongest = types.split(";").reduce((best, type) => (multipliers[type] ?? 1) > (multipliers[best] ?? 1) ? type : best, "decoration");
  const areaFactor = Math.sqrt((size.height * size.width) / 4);
  const hash = [...name].reduce((sum, char) => sum + char.codePointAt(0), 0);
  return Math.round(base * (multipliers[strongest] ?? 1) * areaFactor * (0.94 + (hash % 13) / 100));
}

function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name));
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

const items = loadItems(root);
const existingNames = new Set(items.map((item) => item.name));
const rows = [header];
for (const item of items) {
  const types = new Set(String(item.type).split(";").filter(Boolean));
  if (/[书册典笔记日记手册]/.test(item.name)) types.add("book");
  else types.delete("book");
  rows.push([item.id, csvEscape(item.name), [...types].join(";") || "decoration", csvEscape(item.description), item.rarity, item.height, item.width, item.price].join(","));
}

let nextId = items.length + 1;
let imported = 0;
let skipped = 0;
let translated = 0;
const byMod = { twilight: 0, mekanism: 0 };
const skippedSamples = [];
const importedSamples = [];
const files = sourceRoots.flatMap(walkSource).sort((a, b) => a.file.localeCompare(b.file, "zh-CN"));

for (const entry of files) {
  const rawName = path.basename(entry.file, path.extname(entry.file));
  const name = normalizeName(rawName);
  if (name !== rawName) translated += 1;
  if (existingNames.has(name)) {
    fs.rmSync(entry.file, { force: true });
    skipped += 1;
    if (skippedSamples.length < 20) skippedSamples.push(name);
    continue;
  }
  const folders = foldersFor(entry.file, entry.sourceRoot);
  const types = inferTypes(name, folders, entry.mod);
  const rarity = inferRarity(name, types, entry.mod);
  const size = inferSize(name, types);
  const price = inferPrice(name, types, rarity, size);
  fs.renameSync(entry.file, path.join(auctionDir, `${nextId}.png`));
  rows.push([nextId, csvEscape(name), types, "", rarity, size.height, size.width, price].join(","));
  existingNames.add(name);
  byMod[entry.mod] += 1;
  imported += 1;
  if (importedSamples.length < 20) importedSamples.push(`${name} (${types})`);
  nextId += 1;
}

fs.writeFileSync(itemsPath, `${rows.join("\n")}\n`, "utf8");
for (const source of sourceRoots) removeEmptyDirs(source.dir);

console.log(JSON.stringify({ imported, skipped, translated, byMod, total: rows.length - 1, importedSamples, skippedSamples }, null, 2));
