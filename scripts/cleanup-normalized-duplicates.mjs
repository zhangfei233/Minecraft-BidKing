import fs from "node:fs";
import path from "node:path";
import { csvEscape, loadItems } from "../src/items/items.js";

const root = process.cwd();
const itemsPath = path.join(root, "items.csv");
const auctionDir = path.join(root, "resource", "auction");
const header = "id,name,type,description,rarity,height,width,price";

function normalizeName(name) {
  return String(name)
    .replace(/\s*[（(][^（）()]*[）)]\s*/g, "")
    .replace(/【[^【】]*】/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const seen = new Set();
const kept = [];
const dropped = [];

for (const item of loadItems(root).sort((a, b) => a.id - b.id)) {
  const normalized = normalizeName(item.name);
  if (seen.has(normalized)) {
    dropped.push({ ...item, normalized });
    continue;
  }
  seen.add(normalized);
  kept.push({ ...item, name: normalized });
}

const tempNames = [];
for (let index = 0; index < kept.length; index += 1) {
  const item = kept[index];
  const newId = index + 1;
  const oldPath = path.join(auctionDir, `${item.id}.png`);
  const tempPath = path.join(auctionDir, `__tmp_${newId}.png`);
  fs.renameSync(oldPath, tempPath);
  tempNames.push({ tempPath, finalPath: path.join(auctionDir, `${newId}.png`) });
  item.id = newId;
}

for (const item of dropped) {
  const imagePath = path.join(auctionDir, `${item.id}.png`);
  if (fs.existsSync(imagePath)) fs.rmSync(imagePath, { force: true });
}

for (const entry of tempNames) fs.renameSync(entry.tempPath, entry.finalPath);

const rows = [header];
for (const item of kept) {
  rows.push([item.id, csvEscape(item.name), item.type, csvEscape(item.description || ""), item.rarity, item.height, item.width, item.price].join(","));
}
fs.writeFileSync(itemsPath, `${rows.join("\n")}\n`, "utf8");

console.log(JSON.stringify({
  kept: kept.length,
  dropped: dropped.length,
  droppedNames: dropped.map((item) => `${item.name} -> ${item.normalized}`),
}, null, 2));
