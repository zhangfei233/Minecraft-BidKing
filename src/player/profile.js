import fs from "node:fs";
import path from "node:path";
import { normalizeLotteryState } from "../lottery/lottery.js";
import { normalizeProductionState } from "../production/production.js";

export const INITIAL_MONEY = 5_000_000;
const DEFAULT_PROPS = {};
const DEFAULT_ITEMS = {
  681: { count: 1, collected: false },
  2718: { count: 1, collected: false },
  2721: { count: 1, collected: false },
};

export function ensureProfile(rootDir, nickname) {
  const savesDir = path.join(rootDir, "saves");
  fs.mkdirSync(savesDir, { recursive: true });
  const profilePath = path.join(savesDir, `${safeSaveName(nickname)}.json`);

  if (!fs.existsSync(profilePath)) {
    const profile = createProfile(nickname);
    saveProfile(profilePath, profile);
    return profile;
  }

  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    normalizeProfile(profile, nickname);
    saveProfile(profilePath, profile);
    return profile;
  } catch {
    const profile = createProfile(nickname);
    saveProfile(profilePath, profile);
    return profile;
  }
}

export function saveProfileByNickname(rootDir, profile) {
  const savesDir = path.join(rootDir, "saves");
  fs.mkdirSync(savesDir, { recursive: true });
  saveProfile(path.join(savesDir, `${safeSaveName(profile.nickname)}.json`), profile);
}

export function addWarehouseItemsToProfile(profile, warehouseItems) {
  normalizeProfile(profile, profile.nickname);
  for (const item of warehouseItems) {
    if (!item || item.id === 0) continue;
    const key = String(item.id);
    if (!profile.warehouse.items[key]) profile.warehouse.items[key] = { count: 0, collected: false };
    profile.warehouse.items[key].count += 1;
  }
}

export function addProfileItem(profile, itemId, count = 1) {
  normalizeProfile(profile, profile.nickname);
  const id = Number(itemId);
  const amount = Math.max(1, Math.floor(Number(count) || 1));
  const key = String(id);
  if (!profile.warehouse.items[key]) profile.warehouse.items[key] = { count: 0, collected: false };
  profile.warehouse.items[key].count += amount;
}

export function removeProfileItem(profile, itemId, count = 1) {
  normalizeProfile(profile, profile.nickname);
  const id = Number(itemId);
  const amount = Math.max(1, Math.floor(Number(count) || 1));
  const key = String(id);
  const entry = profile.warehouse.items[key];
  if (!entry || entry.count < amount) throw new Error(`物品数量不足: ${id}`);
  entry.count -= amount;
  if (entry.count <= 0) delete profile.warehouse.items[key];
}

export function addMoney(profile, amount) {
  normalizeProfile(profile, profile.nickname);
  profile.money += Math.max(0, Math.floor(Number(amount) || 0));
}

export function deductMoney(profile, amount) {
  normalizeProfile(profile, profile.nickname);
  const value = Math.max(0, Math.floor(Number(amount) || 0));
  if (profile.money < value) return false;
  profile.money -= value;
  return true;
}

export function toggleFavorite(profile, itemId) {
  normalizeProfile(profile, profile.nickname);
  const key = String(itemId);
  if (!profile.warehouse.items[key]) profile.warehouse.items[key] = { count: 0, collected: false };
  profile.warehouse.items[key].collected = !profile.warehouse.items[key].collected;
  return profile.warehouse.items[key].collected;
}

export function setFavorite(profile, itemId, collected) {
  normalizeProfile(profile, profile.nickname);
  const key = String(itemId);
  if (!profile.warehouse.items[key]) profile.warehouse.items[key] = { count: 0, collected: false };
  profile.warehouse.items[key].collected = Boolean(collected);
}

export function sellProfileItems(profile, itemIds, quantity, itemsById) {
  normalizeProfile(profile, profile.nickname);
  let total = 0;
  const sold = [];
  for (const id of itemIds) {
    const key = String(id);
    const entry = profile.warehouse.items[key];
    const item = itemsById.get(Number(id));
    if (!item) throw new Error(`未知物品: ${id}`);
    if (!entry || !Number.isInteger(entry.count) || entry.count <= 0) continue;
    const count = quantity == null ? entry.count : Math.min(entry.count, Math.max(0, Math.floor(quantity)));
    if (count <= 0) continue;
    entry.count -= count;
    total += count * item.price;
    sold.push({ id: Number(id), count, subtotal: count * item.price });
    if (entry.count <= 0) delete profile.warehouse.items[key];
  }
  profile.money += total;
  return { total, sold, money: profile.money };
}

export function sellProfileItemCounts(profile, itemCounts, itemsById) {
  normalizeProfile(profile, profile.nickname);
  let total = 0;
  const sold = [];
  for (const [rawId, rawCount] of Object.entries(itemCounts || {})) {
    const id = Number(rawId);
    const key = String(id);
    const count = Math.max(0, Math.floor(Number(rawCount) || 0));
    if (count <= 0) continue;
    const item = itemsById.get(id);
    if (!item) throw new Error(`未知物品: ${id}`);
    const entry = profile.warehouse.items[key];
    if (!entry || entry.count < count) throw new Error(`物品数量不足: ${id}`);
    entry.count -= count;
    if (entry.count <= 0) delete profile.warehouse.items[key];
    const subtotal = count * item.price;
    total += subtotal;
    sold.push({ id, count, subtotal });
  }
  profile.money += total;
  return { total, sold, money: profile.money };
}

export function buyProfileProps(profile, propId, quantity, propDefinitions) {
  normalizeProfile(profile, profile.nickname);
  const prop = propDefinitions.get(String(propId));
  if (!prop) throw new Error(`未知道具: ${propId}`);
  const count = Math.max(1, Math.floor(Number(quantity) || 1));
  const price = Number(prop.price || 0);
  const total = price * count;
  if (profile.money < total) throw new Error("金钱不足");
  profile.money -= total;
  profile.warehouse.props[prop.id] = (profile.warehouse.props[prop.id] || 0) + count;
  return { id: prop.id, count, total, money: profile.money };
}

function createProfile(nickname) {
  return {
    nickname,
    money: INITIAL_MONEY,
    warehouse: {
      items: structuredClone(DEFAULT_ITEMS),
      props: { ...DEFAULT_PROPS },
    },
    production: normalizeProductionState(),
    lottery: normalizeLotteryState(),
    settings: {
      propLoadout: [null, null, null, null, null],
      warehouseNotifications: { production: false, lottery: false },
    },
  };
}

function normalizeProfile(profile, nickname) {
  profile.nickname = profile.nickname || nickname;
  if (!Number.isInteger(profile.money)) profile.money = INITIAL_MONEY;
  if (!profile.warehouse || typeof profile.warehouse !== "object") profile.warehouse = {};
  if (!profile.warehouse.items || typeof profile.warehouse.items !== "object") profile.warehouse.items = {};
  if (!profile.warehouse.props || typeof profile.warehouse.props !== "object") profile.warehouse.props = {};
  profile.production = normalizeProductionState(profile.production);
  profile.lottery = normalizeLotteryState(profile.lottery);
  if (!profile.settings || typeof profile.settings !== "object") profile.settings = {};
  if (!Array.isArray(profile.settings.propLoadout)) profile.settings.propLoadout = [null, null, null, null, null];
  if (!profile.settings.warehouseNotifications || typeof profile.settings.warehouseNotifications !== "object") {
    profile.settings.warehouseNotifications = {};
  }
  profile.settings.warehouseNotifications.production = Boolean(profile.settings.warehouseNotifications.production);
  profile.settings.warehouseNotifications.lottery = Boolean(profile.settings.warehouseNotifications.lottery);
  for (const [id, count] of Object.entries(DEFAULT_PROPS)) {
    if (!Number.isInteger(profile.warehouse.props[id])) profile.warehouse.props[id] = count;
  }
}

function saveProfile(profilePath, profile) {
  fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
}

export function safeSaveName(nickname) {
  return String(nickname || "").trim().slice(0, 20).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}
