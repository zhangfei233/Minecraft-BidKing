import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vanillaDir = path.join(root, "resource", "原版");
const auctionDir = path.join(root, "resource", "auction");
const itemsPath = path.join(root, "items.csv");
const header = "id,name,type,description,rarity,height,width,price";

const rarityRank = { gray: 0, green: 1, blue: 2, purple: 3, gold: 4 };
const materialRarity = [
  [/下界合金/, "gold"],
  [/钻石|绿宝石|远古残骸|沉重核心|龙蛋|鞘翅|不祥试炼钥匙|附魔金苹果/, "purple"],
  [/金|青金石|红石|紫水晶|海洋之心|潮涌核心|信标|末影水晶|三叉戟|重锤|下界合金升级/, "blue"],
  [/铁|铜|石英|烈焰|末影|幽匿|海晶|兔子脚|幻翼膜|恶魂之泪|潜影壳|试炼钥匙/, "green"],
  [/煤|木|石|皮革|锁链|粗|沙|泥|土|草|花|树|小麦|胡萝卜|马铃薯/, "gray"],
];

const basePrices = {
  煤炭: 90,
  木炭: 80,
  铜粒: 14,
  铜锭: 126,
  粗铜: 126,
  铁锭: 320,
  粗铁: 320,
  金粒: 70,
  金锭: 630,
  粗金: 630,
  青金石: 170,
  红石粉: 120,
  石英: 180,
  绿宝石: 1100,
  钻石: 1600,
  下界合金碎片: 2200,
  下界合金锭: 10000,
  紫水晶碎片: 180,
  海晶碎片: 260,
  海晶砂粒: 180,
  木棍: 20,
  沙子: 20,
  红沙: 22,
  沙砾: 18,
  石头: 45,
  深板岩: 55,
  黑曜石: 520,
  哭泣的黑曜石: 760,
  基岩: 50000,
  下界岩: 28,
  末地石: 150,
  苹果: 80,
  金苹果: 5120,
  附魔金苹果: 55000,
};

const craftedPriceRules = [
  [/^煤炭块$/, () => 9 * priceOf("煤炭")],
  [/^铜块$|^粗铜块$/, () => 9 * priceOf("铜锭")],
  [/^铁块$|^粗铁块$/, () => 9 * priceOf("铁锭")],
  [/^金块$|^粗金块$/, () => 9 * priceOf("金锭")],
  [/^青金石块$/, () => 9 * priceOf("青金石")],
  [/^绿宝石块$/, () => 9 * priceOf("绿宝石")],
  [/^钻石块$/, () => 9 * priceOf("钻石")],
  [/^下界合金块$/, () => 9 * priceOf("下界合金锭")],
  [/^紫水晶块$/, () => 4 * priceOf("紫水晶碎片")],
  [/^砂岩$|^錾制砂岩$|^切制砂岩$|^平滑砂岩$/, () => 4 * priceOf("沙子")],
  [/^红砂岩$|^錾制红砂岩$|^切制红砂岩$|^平滑红砂岩$/, () => 4 * priceOf("红沙")],
  [/^石砖$|^錾制石砖$|^裂纹石砖$|^苔石砖$/, () => 4 * priceOf("石头")],
  [/^深板岩砖$|^深板岩瓦$|^裂纹深板岩砖$|^裂纹深板岩瓦$/, () => 4 * priceOf("深板岩")],
  [/^金苹果$/, () => priceOf("苹果") + 8 * priceOf("金锭")],
  [/^附魔金苹果$/, () => priceOf("金苹果") + 8 * priceOf("金块")],
];

function priceOf(name) {
  if (basePrices[name] != null) return basePrices[name];
  for (const [pattern, price] of craftedPriceRules) {
    if (pattern.test(name)) return price();
  }
  return null;
}

function assertInside(parent, child) {
  const relative = path.relative(parent, child);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to modify path outside workspace: ${child}`);
  }
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function walkFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(fullPath);
    if (entry.isFile() && /\.(png|gif|jpg|jpeg|webp)$/i.test(entry.name)) return [fullPath];
    return [];
  });
}

function relativeParts(file) {
  return path.relative(vanillaDir, file).split(path.sep);
}

function inferTypes(name, folders) {
  const types = new Set();
  const folderText = folders.join("/");

  if (
    /资源/.test(folderText) ||
    /矿石|远古残骸|锭$|粒$|粗(铜|铁|金)$/.test(name) ||
    /^(钻石|绿宝石|青金石|煤炭|石英|紫水晶碎片|下界合金碎片)$/.test(name)
  ) {
    types.add("ore");
  }
  if (/工具/.test(folderText) || /镐|锹|锄|斧|桶|地图|指南针|时钟|钓鱼竿|剪刀|刷子|打火石|鞍|船|拴绳|望远镜|收纳袋/.test(name)) types.add("tool");
  if (/装备|武器/.test(folderText) || /剑|弓|弩|箭|三叉戟|盾牌|头盔|胸甲|护腿|靴子|马铠|狼铠|鞘翅|不死图腾|重锤|风弹/.test(name)) types.add("equipment");
  if (/食物|作物/.test(folderText) || /苹果|肉|鱼|面包|蛋糕|汤|煲|派|曲奇|海带|浆果|蜂蜜瓶|马铃薯|胡萝卜|西瓜|小麦|甜菜|腐肉|蜘蛛眼/.test(name)) types.add("food");
  if (/红石|铁路|装置/.test(folderText) || /红石|活塞|侦测器|发射器|投掷器|漏斗|铁轨|矿车|按钮|拉杆|压力板|门|活板门|TNT|钟|灯|合成器|箱子|熔炉|工作台|铁砧|高炉|烟熏炉|切石机|锻造台|织布机|制图台|制箭台|唱片机|讲台/.test(name)) types.add("tech");
  if (/植物|自然生成/.test(folderText) || /树苗|树叶|草|花|蘑菇|藤|海草|海带|仙人掌|竹子|根|菌|苔藓|冰|泥巴|原木|玄武岩|凝灰岩|珊瑚/.test(name)) types.add("natural");
  if (/建筑方块|人工合成|装饰品/.test(folderText) || /块|砖|板|玻璃|陶瓦|楼梯|墙|栅栏|旗帜|告示牌|火把|灯笼|蜡烛|地毯|画|花盆|架|头颅|蛋|染料/.test(name)) types.add("decoration");
  if (/酿造/.test(folderText) || /药水|酿造|炼药锅|烈焰|末影|龙息|附魔|信标|重生锚|潮涌核心|末影水晶|幽匿|刷怪|宝库|试炼|知识之书|不死图腾/.test(name)) types.add("magic");
  if (/头颅/.test(folderText) || /刷怪蛋|头颅|龙首|猪灵|僵尸|骷髅|苦力怕|嗅探兽蛋|青蛙卵|海龟蛋/.test(name)) types.add("mob");
  if (/书|成书|附魔书|知识之书|书与笔/.test(name)) types.add("book");
  if (/装置|多方块/.test(folderText) || /末地传送门框架|信标|潮涌核心|重生锚|末影水晶|床|门|宝库|试炼刷怪笼/.test(name)) types.add("multiblock");
  if (/杂项|已移除|未使用|仅java版/.test(folderText) || /唱片|钥匙|模板|陶片|音乐|命令方块|刷怪笼|鞍|命名牌|海洋之心|龙蛋|红宝石|箭袋|火药|骨头|皮革|黏液球|末影珍珠|潜影壳|恶魂之泪|烈焰棒|兔子脚|幻翼膜|海龟鳞甲|犰狳鳞甲/.test(name)) types.add("loot");

  if (types.size === 0) types.add("decoration");
  return [...types].join(";");
}

function inferRarity(name, types) {
  let rarity = "gray";
  for (const [pattern, candidate] of materialRarity) {
    if (pattern.test(name) && rarityRank[candidate] > rarityRank[rarity]) rarity = candidate;
  }

  if (/下界合金|龙蛋|鞘翅|附魔金苹果|基岩|命令方块|知识之书|不祥试炼钥匙|沉重核心/.test(name)) rarity = "gold";
  else if (/钻石|绿宝石|远古残骸|信标|潮涌核心|末影水晶|三叉戟|重锤|下界合金升级|下界之星|不死图腾/.test(name)) rarity = "purple";
  else if (/金|红石|青金石|紫水晶|末影|烈焰|恶魂|幻翼|潜影|海洋之心|刷怪笼|试炼钥匙|附魔|锻造模板|龙息/.test(name)) rarity = "blue";
  else if (/铁|铜|石英|海晶|黑曜石|幽匿|珊瑚|兔子脚|海龟|不祥之瓶/.test(name)) rarity = "green";

  if (types.includes("food") && !/金苹果|金胡萝卜|附魔|谜之炖菜/.test(name) && rarityRank[rarity] > rarityRank.green) rarity = "green";
  if (/木剑|木镐|木锹|木锄|木斧|皮革/.test(name)) rarity = "gray";
  if (/石剑|石镐|石锹|石锄|石斧|铜剑|铜镐|铜锹|铜锄|铜斧|铜头盔|铜胸甲|铜护腿|铜靴子/.test(name)) rarity = "green";
  if (/铁剑|铁镐|铁锹|铁锄|铁斧|铁头盔|铁胸甲|铁护腿|铁靴子|金剑|金镐|金锹|金锄|金斧|金头盔|金胸甲|金护腿|金靴子|锁链/.test(name)) rarity = "blue";
  if (/钻石剑|钻石镐|钻石锹|钻石锄|钻石斧|钻石头盔|钻石胸甲|钻石护腿|钻石靴子/.test(name)) rarity = "purple";
  if (/下界合金剑|下界合金镐|下界合金锹|下界合金锄|下界合金斧|下界合金头盔|下界合金胸甲|下界合金护腿|下界合金靴子/.test(name)) rarity = "gold";

  return rarity;
}

function inferSize(name, types) {
  if (/床|运输船|船|矿车/.test(name)) return { height: 2, width: 3 };
  if (/门$|旗帜|大型垂滴叶|向日葵|丁香|玫瑰丛|牡丹|高草丛|高枯草丛|龙首/.test(name)) return { height: 3, width: 2 };
  if (/剑|镐|锹|锄|斧|弓|弩|三叉戟|重锤|钓鱼竿|胡萝卜钓竿|诡异菌钓竿|矛/.test(name)) return { height: 3, width: 1 };
  if (/活板门|地毯|雪$|压力板|按钮|拉杆|火把|蜡烛|海泡菜|花$|树苗|种子|头颅|蛋$|桶$|瓶$|锭$|粒$|碎片$|染料$|陶片$|鳞甲$|棒$|粉$|球$|眼$|膜$|泪$|壳$|箭$|风弹|唱片|钥匙|模板|书$/.test(name)) return { height: 1, width: 1 };
  if (/栅栏|墙|玻璃板|铁栏杆|锁链|梯子|末地烛|避雷针|甘蔗|竹子|仙人掌/.test(name)) return { height: 2, width: 1 };
  if (types.includes("tool") || types.includes("equipment") || types.includes("food")) return { height: 1, width: 1 };
  return { height: 2, width: 2 };
}

function inferPrice(name, types, rarity, size) {
  const exact = priceOf(name);
  if (exact != null) return exact;

  const byRarity = { gray: 120, green: 420, blue: 1200, purple: 4200, gold: 14000 };
  const typeMultiplier = {
    decoration: 1.0,
    ore: 1.35,
    tool: 1.2,
    equipment: 1.35,
    natural: 0.75,
    food: 0.65,
    tech: 1.5,
    magic: 1.9,
    mob: 1.35,
    book: 1.25,
    multiblock: 1.65,
    loot: 1.8,
  };
  const strongestType = types.split(";").reduce((best, type) => {
    return (typeMultiplier[type] ?? 1) > (typeMultiplier[best] ?? 1) ? type : best;
  }, "decoration");
  const hash = [...name].reduce((sum, char) => sum + char.codePointAt(0), 0);
  const variation = 0.9 + (hash % 21) / 100;
  const areaFactor = Math.sqrt((size.height * size.width) / 4);
  return Math.round(byRarity[rarity] * (typeMultiplier[strongestType] ?? 1) * variation * areaFactor);
}

assertInside(root, vanillaDir);
assertInside(root, auctionDir);
assertInside(root, itemsPath);

fs.mkdirSync(auctionDir, { recursive: true });
for (const entry of fs.readdirSync(auctionDir)) {
  fs.rmSync(path.join(auctionDir, entry), { recursive: true, force: true });
}

const files = walkFiles(vanillaDir).sort((a, b) => path.relative(vanillaDir, a).localeCompare(path.relative(vanillaDir, b), "zh-CN"));
if (files.length === 0) {
  throw new Error("No source images found under resource/原版; refusing to clear auction or rewrite items.csv.");
}

const rows = [header];

files.forEach((file, index) => {
  const parts = relativeParts(file);
  const folders = parts.slice(0, -1);
  const name = path.basename(file, path.extname(file));
  const id = index + 1;
  const types = inferTypes(name, folders);
  const rarity = inferRarity(name, types);
  const size = inferSize(name, types);
  const price = inferPrice(name, types, rarity, size);
  const target = path.join(auctionDir, `${id}.png`);

  fs.renameSync(file, target);
  rows.push([id, csvEscape(name), types, "", rarity, size.height, size.width, price].join(","));
});

fs.writeFileSync(itemsPath, `${rows.join("\n")}\n`, "utf8");

function removeEmptyDirs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name));
  }
  if (dir !== vanillaDir && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

removeEmptyDirs(vanillaDir);

console.log(`Reset auction assets: ${files.length} items`);
