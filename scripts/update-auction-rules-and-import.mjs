import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { csvEscape, loadItems } from "../src/items/items.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vanillaDir = path.join(root, "resource", "原版");
const auctionDir = path.join(root, "resource", "auction");
const itemsPath = path.join(root, "items.csv");
const header = "id,name,type,description,rarity,height,width,price";
const oldItemCount = loadItems(root).length;

const rarityRank = { gray: 0, green: 1, blue: 2, purple: 3, gold: 4 };
const exactBasePrices = new Map([
  ["铜粒", 140],
  ["铜锭", 1260],
  ["粗铜", 1260],
  ["铁粒", 360],
  ["铁锭", 3200],
  ["粗铁", 3200],
  ["金粒", 700],
  ["金锭", 6300],
  ["粗金", 6300],
  ["煤炭", 900],
  ["木炭", 800],
  ["青金石", 1700],
  ["红石粉", 1200],
  ["下界石英", 1800],
  ["石英", 1800],
  ["绿宝石", 11000],
  ["钻石", 16000],
  ["下界合金碎片", 22000],
  ["下界合金锭", 100000],
  ["紫水晶碎片", 1800],
  ["海晶碎片", 2600],
  ["海晶砂粒", 1800],
  ["木棍", 200],
  ["沙子", 200],
  ["红沙", 220],
  ["沙砾", 180],
  ["石头", 450],
  ["圆石", 400],
  ["深板岩", 550],
  ["黑曜石", 5200],
  ["哭泣的黑曜石", 7600],
  ["基岩", 500000],
  ["下界岩", 280],
  ["末地石", 1500],
  ["苹果", 800],
  ["金苹果", 51200],
  ["附魔金苹果", 550000],
]);

const passiveMobPrices = {
  牛: 3200,
  猪: 2600,
  绵羊: 3000,
  鸡: 1800,
  兔子: 1600,
  马: 4800,
  驴: 4300,
  骡: 4600,
  骆驼: 5600,
  狼: 3600,
  猫: 3200,
  豹猫: 3600,
  狐狸: 3400,
  熊猫: 5200,
  海龟: 4200,
  青蛙: 2400,
  蝙蝠: 1400,
  村民: 5200,
  流浪商人: 6200,
  哞菇: 5200,
  嗅探兽: 9000,
  悦灵: 9000,
  美西螈: 4200,
  热带鱼: 1400,
  鳕鱼: 1000,
  鲑鱼: 1200,
  河豚: 1800,
  鱿鱼: 2400,
  发光鱿鱼: 4200,
  海豚: 6200,
  山羊: 4200,
  羊驼: 4200,
  行商羊驼: 4800,
  僵尸马: 5200,
  骷髅马: 5600,
};

const hostileMobPrices = {
  凋灵骷髅: 6300,
  僵尸: 2200,
  骷髅: 2400,
  苦力怕: 3600,
  蜘蛛: 2400,
  洞穴蜘蛛: 3000,
  末影人: 5600,
  女巫: 5200,
  烈焰人: 5000,
  恶魂: 6200,
  史莱姆: 2800,
  岩浆怪: 3600,
  守卫者: 4400,
  远古守卫者: 9000,
  潜影贝: 7600,
  监守者: 26000,
  凋灵: 42000,
  末影龙: 65000,
  劫掠兽: 12000,
  唤魔者: 9000,
  卫道士: 5200,
  掠夺者: 4600,
  猪灵蛮兵: 7800,
  猪灵: 4600,
  僵尸猪灵: 4200,
  疣猪兽: 6200,
  僵尸疣猪兽: 5200,
  旋风人: 7000,
  幻翼: 6200,
  恼鬼: 4800,
  末影螨: 2400,
  蠹虫: 1800,
  溺尸: 2800,
  尸壳: 2600,
  流浪者: 3000,
  沼骸: 3200,
  焦骸: 3400,
  闪电苦力怕: 7600,
};

const mobSizes = {
  末影龙: [6, 8],
  凋灵: [4, 4],
  监守者: [4, 3],
  巨人: [6, 4],
  恶魂: [4, 4],
  劫掠兽: [3, 4],
  铁傀儡: [4, 2],
  骆驼: [3, 4],
  马: [3, 3],
  僵尸马: [3, 3],
  骷髅马: [3, 3],
  驴: [3, 3],
  骡: [3, 3],
  牛: [2, 3],
  哞菇: [2, 3],
  猪: [2, 2],
  绵羊: [2, 2],
  狼: [2, 2],
  猫: [1, 2],
  狐狸: [1, 2],
  豹猫: [1, 2],
  兔子: [1, 1],
  鸡: [1, 1],
  蜜蜂: [1, 1],
  蝙蝠: [1, 1],
  村民: [2, 1],
  流浪商人: [2, 1],
  僵尸: [2, 1],
  僵尸村民: [2, 1],
  骷髅: [2, 1],
  凋灵骷髅: [3, 1],
  末影人: [3, 1],
  苦力怕: [2, 1],
  女巫: [2, 1],
  猪灵: [2, 1],
  僵尸猪灵: [2, 1],
  猪灵蛮兵: [2, 1],
  守卫者: [2, 2],
  远古守卫者: [3, 3],
  潜影贝: [2, 2],
  蜘蛛: [1, 3],
  洞穴蜘蛛: [1, 2],
  海豚: [1, 3],
  海龟: [1, 2],
  鱿鱼: [2, 2],
  发光鱿鱼: [2, 2],
  鳕鱼: [1, 1],
  鲑鱼: [1, 1],
  热带鱼: [1, 1],
  河豚: [1, 1],
  蝌蚪: [1, 1],
  美西螈: [1, 2],
  史莱姆: [2, 2],
  岩浆怪: [2, 2],
  恼鬼: [1, 1],
  末影螨: [1, 1],
  蠹虫: [1, 1],
  幻翼: [1, 3],
};

const mobNames = new Set([
  "红石虫",
  "设德兰矮种马",
  "钻石鸡",
  "马",
  "粉红凋灵",
  "月球牛",
  "凋灵",
  "末影龙",
  "僵尸猪灵",
  "僵尸鹦鹉螺",
  "北极熊",
  "末影人",
  "洞穴蜘蛛",
  "海豚",
  "熊猫",
  "狼",
  "猪灵",
  "羊驼",
  "蜘蛛",
  "蜜蜂",
  "行商羊驼",
  "鹦鹉螺",
  "铁傀儡",
  "铜傀儡",
  "雪傀儡",
  "僵尸",
  "僵尸村民",
  "僵尸疣猪兽",
  "凋灵骷髅",
  "劫掠兽",
  "卫道士",
  "史莱姆",
  "唤魔者",
  "嘎枝",
  "女巫",
  "守卫者",
  "尸壳",
  "岩浆怪",
  "幻翼",
  "恶魂",
  "恼鬼",
  "掠夺者",
  "旋风人",
  "末影螨",
  "沼骸",
  "流浪者",
  "溺尸",
  "潜影贝",
  "烈焰人",
  "焦骸",
  "猪灵蛮兵",
  "疣猪兽",
  "监守者",
  "苦力怕",
  "蜘蛛骑士",
  "蠹虫",
  "远古守卫者",
  "闪电苦力怕",
  "骷髅",
  "骷髅骑手",
  "鸡骑士",
  "山羊",
  "河豚",
  "巨人",
  "幻术师",
  "杀手兔",
  "僵尸马",
  "兔子",
  "发光鱿鱼",
  "哞菇",
  "嗅探兽",
  "快乐恶魂",
  "悦灵",
  "村民",
  "流浪商人",
  "海龟",
  "炽足兽",
  "热带鱼",
  "牛",
  "犰狳",
  "狐狸",
  "猪",
  "猫",
  "绵羊",
  "美西螈",
  "蝌蚪",
  "蝙蝠",
  "豹猫",
  "青蛙",
  "驴",
  "骆驼",
  "骡",
  "骷髅马",
  "鱿鱼",
  "鲑鱼",
  "鳕鱼",
  "鸡",
  "鹦鹉",
]);

function isMobItem(name) {
  return mobNames.has(name) || /刷怪蛋|刷怪笼/.test(name);
}

function assertInside(parent, child) {
  const relative = path.relative(parent, child);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Refusing path outside workspace: ${child}`);
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(fullPath);
    if (entry.isFile() && /\.(png|gif|jpg|jpeg|webp)$/i.test(entry.name)) return [fullPath];
    return [];
  });
}

function compactTypes(types) {
  const result = [...types].filter(Boolean);
  return result.length ? result.join(";") : "decoration";
}

function isMobSource(name, folders) {
  const folderText = folders.join("/");
  return /生物|Boss|无差别攻击|效用生物|2\.0|15w14a|23w13a/.test(folderText) || isMobItem(name);
}

function inferTypes(name, folders, previousType = "") {
  const types = new Set();
  const folderText = folders.join("/");
  const previous = String(previousType).split(";").filter(Boolean);

  if (isMobSource(name, folders) || isMobItem(name)) types.add("mob");
  if (/书|册|典/.test(name)) types.add("book");

  if (/矿石|远古残骸|锭$|粒$|粗(铜|铁|金)$/.test(name) || /^(钻石|绿宝石|青金石|煤炭|木炭|下界石英|石英|下界合金碎片|紫水晶碎片)$/.test(name)) {
    types.add("ore");
  }

  if (/剑|弓|弩|箭|三叉戟|盾牌|头盔|胸甲|护腿|靴子|马铠|狼铠|鞘翅|不死图腾|重锤|风弹/.test(name)) types.add("equipment");
  if (/工具/.test(folderText) || /镐|锹|锄|斧|桶$|地图|指南针|时钟|钓鱼竿|剪刀|刷子|打火石|鞍|船|拴绳|望远镜|收纳袋/.test(name)) types.add("tool");
  if (/食物|作物/.test(folderText) || /苹果|肉|鱼|面包|蛋糕|汤|煲|派|曲奇|海带|浆果|蜂蜜瓶|马铃薯|胡萝卜|西瓜|小麦|甜菜|腐肉|蜘蛛眼|糖/.test(name)) types.add("food");
  if (/植物|自然生成/.test(folderText) || /树苗|树叶|草|花|蘑菇|藤|海草|仙人掌|竹子|根|菌|苔藓|冰|泥巴|原木|珊瑚|染料/.test(name)) types.add("natural");
  if (/红石|铁轨|矿车|活塞|侦测器|发射器|投掷器|漏斗|按钮|拉杆|压力板|绊线|比较器|中继器|阳光探测器|标靶|避雷针|TNT|命令方块|合成器|铜灯|红石灯|红石火把|红石块/.test(name)) {
    types.add("tech");
  }
  if (/建筑方块|人工合成|装饰品/.test(folderText) || /块|砖|板|玻璃|陶瓦|楼梯|台阶|墙|栅栏|旗帜|告示牌|火把|灯笼|蜡烛|地毯|画|花盆|架|染料|书架/.test(name)) {
    types.add("decoration");
  }
  if (/药水|酿造|炼药锅|烈焰|末影|龙息|附魔|信标|重生锚|潮涌核心|末影水晶|幽匿|宝库|试炼|不死图腾|下界之星|回响碎片|魔|凋灵|末影龙/.test(name)) {
    types.add("magic");
  }
  if (/唱片|钥匙|模板|陶片|音乐|命令方块|鞍|命名牌|海洋之心|龙蛋|红宝石|箭袋|火药|骨头|皮革|黏液球|末影珍珠|潜影壳|恶魂之泪|烈焰棒|兔子脚|幻翼膜|海龟鳞甲|犰狳鳞甲/.test(name)) {
    types.add("loot");
  }
  if (/信标|潮涌核心|末地传送门框架/.test(name)) types.add("multiblock");

  for (const type of previous) {
    if (["ore", "tool", "equipment", "natural", "food", "magic", "loot", "decoration"].includes(type)) types.add(type);
  }

  if (!isMobSource(name, folders) && !isMobItem(name)) types.delete("mob");
  if (isMobItem(name)) {
    for (const type of ["decoration", "ore", "tool", "equipment", "natural", "food", "tech", "book", "multiblock"]) {
      types.delete(type);
    }
  }
  if (!/书|册|典/.test(name)) types.delete("book");
  if (!/信标|潮涌核心|末地传送门框架/.test(name)) types.delete("multiblock");
  if (!/红石|铁轨|矿车|活塞|侦测器|发射器|投掷器|漏斗|按钮|拉杆|压力板|绊线|比较器|中继器|阳光探测器|标靶|避雷针|TNT|命令方块|合成器|铜灯|红石灯|红石火把|红石块/.test(name)) types.delete("tech");

  return compactTypes(types);
}

function inferRarity(name, types) {
  let rarity = "gray";
  const bump = (candidate) => {
    if (rarityRank[candidate] > rarityRank[rarity]) rarity = candidate;
  };

  if (/下界合金|龙蛋|鞘翅|附魔金苹果|基岩|命令方块|知识之书|不祥试炼钥匙|沉重核心|末影龙|^凋灵$|粉红凋灵|监守者/.test(name)) bump("gold");
  else if (/钻石|绿宝石|远古残骸|信标|潮涌核心|末影水晶|三叉戟|重锤|下界合金升级|下界之星|不死图腾|远古守卫者|劫掠兽/.test(name)) bump("purple");
  else if (/金|红石|青金石|紫水晶|末影|烈焰|恶魂|幻翼|潜影|海洋之心|刷怪笼|试炼钥匙|附魔|锻造模板|龙息|悦灵|嗅探兽|凋灵骷髅/.test(name)) bump("blue");
  else if (/铁|铜|石英|海晶|黑曜石|幽匿|珊瑚|兔子脚|海龟|不祥之瓶|末影人|女巫|猪灵/.test(name)) bump("green");

  if (types.includes("food") && !/金苹果|金胡萝卜|附魔|谜之炖菜/.test(name) && rarityRank[rarity] > rarityRank.green) rarity = "green";
  if (/木剑|木镐|木锹|木锄|木斧|皮革/.test(name)) rarity = "gray";
  if (/石剑|石镐|石锹|石锄|石斧|铜剑|铜镐|铜锹|铜锄|铜斧|铜头盔|铜胸甲|铜护腿|铜靴子/.test(name)) rarity = "green";
  if (/铁剑|铁镐|铁锹|铁锄|铁斧|铁头盔|铁胸甲|铁护腿|铁靴子|金剑|金镐|金锹|金锄|金斧|金头盔|金胸甲|金护腿|金靴子|锁链/.test(name)) rarity = "blue";
  if (/钻石剑|钻石镐|钻石锹|钻石锄|钻石斧|钻石头盔|钻石胸甲|钻石护腿|钻石靴子/.test(name)) rarity = "purple";
  if (/下界合金剑|下界合金镐|下界合金锹|下界合金锄|下界合金斧|下界合金头盔|下界合金胸甲|下界合金护腿|下界合金靴子/.test(name)) rarity = "gold";

  return rarity;
}

function inferSize(name, types) {
  if (/船$|矿车$/.test(name)) return { height: 2, width: 3 };
  if (types.includes("mob")) {
    const exactMatch = mobSizes[name];
    if (exactMatch) return { height: exactMatch[0], width: exactMatch[1] };
    const match = Object.entries(mobSizes)
      .sort(([a], [b]) => b.length - a.length)
      .find(([mobName]) => name.includes(mobName));
    if (match) return { height: match[1][0], width: match[1][1] };
    if (/Boss|凋灵|龙/.test(name)) return { height: 4, width: 4 };
    return { height: 2, width: 1 };
  }
  if (/床/.test(name)) return { height: 2, width: 3 };
  if (/门$|旗帜|大型垂滴叶|向日葵|丁香|玫瑰丛|牡丹|高草丛|高枯草丛|龙首/.test(name)) return { height: 3, width: 2 };
  if (/剑|镐|锹|锄|斧|弓|弩|三叉戟|重锤|钓鱼竿|胡萝卜钓竿|诡异菌钓竿|矛/.test(name)) return { height: 3, width: 1 };
  if (/活板门|地毯|雪$|压力板|按钮|拉杆|火把|蜡烛|海泡菜|花$|树苗|种子|头颅|蛋$|桶$|瓶$|锭$|粒$|碎片$|染料$|陶片$|鳞甲$|棒$|粉$|球$|眼$|膜$|泪$|壳$|箭$|风弹|唱片|钥匙|模板|书$|纸$|线$|糖$|碗$/.test(name)) {
    return { height: 1, width: 1 };
  }
  if (/栅栏|墙|玻璃板|铁栏杆|锁链|梯子|末地烛|避雷针|甘蔗|竹子|仙人掌/.test(name)) return { height: 2, width: 1 };
  if (types.includes("tool") || types.includes("equipment") || types.includes("food")) return { height: 1, width: 1 };
  return { height: 2, width: 2 };
}

function exactPrice(name) {
  if (exactBasePrices.has(name)) return exactBasePrices.get(name);
  if (/^煤炭块$/.test(name)) return 9 * exactPrice("煤炭");
  if (/^铜块$|^粗铜块$/.test(name)) return 9 * exactPrice("铜锭");
  if (/^铁块$|^粗铁块$/.test(name)) return 9 * exactPrice("铁锭");
  if (/^金块$|^粗金块$/.test(name)) return 9 * exactPrice("金锭");
  if (/^青金石块$/.test(name)) return 9 * exactPrice("青金石");
  if (/^绿宝石块$/.test(name)) return 9 * exactPrice("绿宝石");
  if (/^钻石块$/.test(name)) return 9 * exactPrice("钻石");
  if (/^下界合金块$/.test(name)) return 9 * exactPrice("下界合金锭");
  if (/^紫水晶块$/.test(name)) return 4 * exactPrice("紫水晶碎片");
  if (/^砂岩$|^錾制砂岩$|^切制砂岩$|^平滑砂岩$/.test(name)) return 4 * exactPrice("沙子");
  if (/^红砂岩$|^錾制红砂岩$|^切制红砂岩$|^平滑红砂岩$/.test(name)) return 4 * exactPrice("红沙");
  if (/^石砖$|^錾制石砖$|^裂纹石砖$|^苔石砖$/.test(name)) return 4 * exactPrice("石头");
  if (/^深板岩砖$|^深板岩瓦$|^裂纹深板岩砖$|^裂纹深板岩瓦$/.test(name)) return 4 * exactPrice("深板岩");
  if (/^金苹果$/.test(name)) return exactPrice("苹果") + 8 * exactPrice("金锭");
  if (/^附魔金苹果$/.test(name)) return exactPrice("金苹果") + 8 * exactPrice("金块");
  return null;
}

function inferMobPrice(name, rarity, size) {
  const hostile = Object.entries(hostileMobPrices).find(([mobName]) => name === mobName || name.includes(mobName));
  if (hostile) return hostile[1];
  const passive = Object.entries(passiveMobPrices).find(([mobName]) => name === mobName || name.includes(mobName));
  if (passive) return passive[1];
  const base = { gray: 2200, green: 3600, blue: 6200, purple: 11000, gold: 26000 }[rarity] ?? 3200;
  return Math.round(base * Math.sqrt((size.height * size.width) / 2));
}

function inferPrice(item, isNew, types, rarity, size) {
  const exact = exactPrice(item.name);
  if (exact != null) return exact;
  if (/船$|矿车$/.test(item.name)) return vehiclePrice(item.name);
  if (types.includes("mob")) return inferMobPrice(item.name, rarity, size);
  if (!isNew) return Math.round(Number(item.price || 0));

  const byRarity = { gray: 1200, green: 4200, blue: 12000, purple: 42000, gold: 140000 };
  const multiplier = { decoration: 1, ore: 1.35, tool: 1.2, equipment: 1.35, natural: 0.75, food: 0.65, tech: 1.25, magic: 1.9, loot: 1.8, book: 1.25, multiblock: 1.65, mob: 1.35 };
  const strongest = types.split(";").reduce((best, type) => (multiplier[type] ?? 1) > (multiplier[best] ?? 1) ? type : best, "decoration");
  const hash = [...item.name].reduce((sum, char) => sum + char.codePointAt(0), 0);
  return Math.round(byRarity[rarity] * (multiplier[strongest] ?? 1) * (0.9 + (hash % 21) / 100) * Math.sqrt((size.height * size.width) / 4));
}

function vehiclePrice(name) {
  const baseName = name
    .replace(/^运输矿车$/, "箱子")
    .replace(/^漏斗矿车$/, "漏斗")
    .replace(/^TNT矿车$/, "TNT")
    .replace(/^动力矿车$/, "熔炉")
    .replace(/^命令方块矿车$/, "命令方块")
    .replace(/^刷怪笼矿车$/, "刷怪笼")
    .replace(/^船$/, "木板")
    .replace(/^矿车$/, "铁锭");
  const currentBase = currentPriceByName.has(baseName) ? currentPriceByName.get(baseName) * 10 : null;
  return Math.round((exactPrice(baseName) ?? currentBase ?? 3000) * 1.5);
}

assertInside(root, vanillaDir);
assertInside(root, auctionDir);
assertInside(root, itemsPath);

const currentItems = loadItems(root);
const currentPriceByName = new Map(currentItems.map((item) => [item.name, item.price]));
const nameSet = new Set(currentItems.map((item) => item.name));
const rows = [header];

for (const item of currentItems) {
  const types = inferTypes(item.name, [], item.type);
  const rarity = inferRarity(item.name, types);
  const size = inferSize(item.name, types);
  const price = inferPrice(item, false, types, rarity, size);
  rows.push([item.id, csvEscape(item.name), types, csvEscape(item.description), rarity, size.height, size.width, price].join(","));
}

let nextId = currentItems.length + 1;
let imported = 0;
let skipped = 0;
for (const file of walkFiles(vanillaDir).sort((a, b) => path.relative(vanillaDir, a).localeCompare(path.relative(vanillaDir, b), "zh-CN"))) {
  const name = path.basename(file, path.extname(file));
  if (nameSet.has(name)) {
    fs.rmSync(file, { force: true });
    skipped += 1;
    continue;
  }

  const folders = path.relative(vanillaDir, file).split(path.sep).slice(0, -1);
  const item = { id: nextId, name, description: "", price: 0 };
  const types = inferTypes(name, folders);
  const rarity = inferRarity(name, types);
  const size = inferSize(name, types);
  const price = inferPrice(item, true, types, rarity, size);
  const target = path.join(auctionDir, `${nextId}.png`);
  fs.renameSync(file, target);
  rows.push([nextId, csvEscape(name), types, "", rarity, size.height, size.width, price].join(","));
  nameSet.add(name);
  nextId += 1;
  imported += 1;
}

fs.writeFileSync(itemsPath, `${rows.join("\n")}\n`, "utf8");

function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(dir, entry.name));
  }
  if (dir !== vanillaDir && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}
removeEmptyDirs(vanillaDir);

console.log(JSON.stringify({ oldItemCount, imported, skipped, total: rows.length - 1 }, null, 2));
