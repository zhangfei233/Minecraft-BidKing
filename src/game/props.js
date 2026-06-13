import {
  firstUnknownCellForItem,
  itemFullInfoKnown,
  itemFullyKnown,
  itemOutlineKnown,
  itemRarityKnown,
  makeHintPackage,
  randomItemIndexes,
  splitTypes,
} from "./hints.js";

export class Prop {
  constructor(definition = {}, level = 1) {
    this.definition = definition;
    this.level = Math.max(1, Number(level || definition.level) || 1);
  }

  get name() {
    return this.definition.name || "\u9053\u5177";
  }

  get description() {
    return this.definition.description || "";
  }

  use() {
    return null;
  }

  package(text, message) {
    return makeHintPackage({
      title: `\u9053\u5177\u3010${this.name}\u3011`,
      text,
      show: message.length > 0,
      message,
    });
  }
}

export class RevealOneItemProp extends Prop {
  use({ warehouse, viewNumber, view, random }) {
    const [itemIndex] = randomItemIndexes(warehouse, (item) => !itemFullInfoKnown(view, item), 1, random);
    const message = itemIndex ? [warehouse.addHint(viewNumber, { type: "item_full", itemIndex })] : [];
    return this.package(this.description || "\u663e\u793a\u4e00\u4ef6\u968f\u673a\u6218\u5229\u54c1", message);
  }
}

class RevealRarityProp extends Prop {
  constructor(definition, level, count) {
    super(definition, level);
    this.count = count;
  }

  use({ warehouse, viewNumber, view, random }) {
    const indexes = randomItemIndexes(
      warehouse,
      (item, index) => !itemRarityKnown(view, item) && firstUnknownCellForItem(warehouse, view, index),
      this.count,
      random,
    );
    const message = indexes
      .map((itemIndex) => firstUnknownCellForItem(warehouse, view, itemIndex))
      .filter(Boolean)
      .map((cell) => warehouse.addHint(viewNumber, { type: "cell_rarity", ...cell }));
    return this.package(this.description || `\u968f\u673a\u663e\u793a${this.count}\u4ef6\u6218\u5229\u54c1\u7684\u54c1\u8d28`, message);
  }
}

class RevealOutlineProp extends Prop {
  constructor(definition, level, count) {
    super(definition, level);
    this.count = count;
  }

  use({ warehouse, viewNumber, view, random }) {
    const indexes = randomItemIndexes(warehouse, (item) => !itemOutlineKnown(view, item), this.count, random);
    const message = indexes.map((itemIndex) => warehouse.addHint(viewNumber, { type: "item_outline", itemIndex }));
    return this.package(this.description || `\u968f\u673a\u663e\u793a${this.count}\u4ef6\u6218\u5229\u54c1\u7684\u8f6e\u5ed3`, message);
  }
}

class RevealTypeOutlineRarityProp extends Prop {
  constructor(definition, level, types, count) {
    super(definition, level);
    this.types = new Set(types);
    this.count = count;
  }

  use({ warehouse, viewNumber, view, random }) {
    const indexes = randomItemIndexes(
      warehouse,
      (item) => splitTypes(item.type).some((type) => this.types.has(type)) && !itemFullyKnown(view, item),
      this.count,
      random,
    );
    const message = indexes.map((itemIndex) => warehouse.addHint(viewNumber, { type: "item_outline_rarity", itemIndex }));
    return this.package(this.description || `\u968f\u673a\u663e\u793a${this.count}\u4ef6\u6307\u5b9a\u7c7b\u6218\u5229\u54c1\u7684\u8f6e\u5ed3\u548c\u54c1\u8d28`, message);
  }
}

class RevealAllMultiblockOutlineProp extends Prop {
  use({ warehouse, viewNumber, view }) {
    const indexes = warehouse.items
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => index > 0 && splitTypes(item.type).includes("multiblock") && !itemOutlineKnown(view, item))
      .map(({ index }) => index);
    const message = indexes.map((itemIndex) => warehouse.addHint(viewNumber, { type: "item_outline", itemIndex }));
    return this.package(this.description || "\u663e\u793a\u6240\u6709\u591a\u65b9\u5757\u7c7b\u6218\u5229\u54c1\u7684\u8f6e\u5ed3", message);
  }
}

class RevealHighestUnknownValueProp extends Prop {
  use({ warehouse, viewNumber, view, random }) {
    const candidates = warehouse.items
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => index > 0 && !itemOutlineKnown(view, item) && !itemRarityKnown(view, item) && !itemFullInfoKnown(view, item));
    const maxPrice = candidates.reduce((max, { item }) => Math.max(max, Number(item.price || 0)), 0);
    const indexes = candidates.filter(({ item }) => Number(item.price || 0) === maxPrice).map(({ index }) => index);
    const [itemIndex] = randomItemIndexes(warehouse, (_item, index) => indexes.includes(index), 1, random);
    const message = itemIndex ? [warehouse.addHint(viewNumber, { type: "item_full", itemIndex })] : [];
    return this.package(this.description || "\u663e\u793a\u5b8c\u5168\u672a\u77e5\u7684\u6218\u5229\u54c1\u4e2d\u4ef7\u503c\u6700\u9ad8\u7684\u6218\u5229\u54c1", message);
  }
}

class RevealRarityOutlineProp extends Prop {
  constructor(definition, level, rarity, count = null) {
    super(definition, level);
    this.rarity = rarity;
    this.count = count;
  }

  use({ warehouse, viewNumber, view, random }) {
    const indexes = pickRarityIndexesDescending(warehouse, view, this.rarity, this.count, random);
    const message = indexes.map((itemIndex) => warehouse.addHint(viewNumber, { type: "item_outline_rarity", itemIndex }));
    return this.package(this.description || "\u663e\u793a\u6307\u5b9a\u54c1\u8d28\u6218\u5229\u54c1\u7684\u8f6e\u5ed3", message);
  }
}

class RevealAllOutlineRarityProp extends Prop {
  use({ warehouse, viewNumber, view }) {
    const indexes = warehouse.items
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => index > 0 && !itemFullyKnown(view, item))
      .map(({ index }) => index);
    const message = indexes.map((itemIndex) => warehouse.addHint(viewNumber, { type: "item_outline_rarity", itemIndex }));
    return this.package(this.description || "\u663e\u793a\u5168\u90e8\u6218\u5229\u54c1\u7684\u54c1\u8d28\u548c\u8f6e\u5ed3", message);
  }
}

class RevealAllFullProp extends Prop {
  use({ warehouse, viewNumber, view }) {
    const indexes = warehouse.items
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => index > 0 && !itemFullInfoKnown(view, item))
      .map(({ index }) => index);
    const message = indexes.map((itemIndex) => warehouse.addHint(viewNumber, { type: "item_full", itemIndex }));
    return this.package(this.description || "\u663e\u793a\u5168\u90e8\u7269\u54c1", message);
  }
}

class RevealDecorationFullProp extends Prop {
  constructor(definition, level, maxCells = null) {
    super(definition, level);
    this.maxCells = maxCells;
  }

  use({ warehouse, viewNumber, view }) {
    const indexes = warehouse.items
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => (
        index > 0
        && splitTypes(item.type).includes("decoration")
        && (this.maxCells == null || Number(item.width || 0) * Number(item.height || 0) <= this.maxCells)
        && !itemFullInfoKnown(view, item)
      ))
      .map(({ index }) => index);
    const message = indexes.map((itemIndex) => warehouse.addHint(viewNumber, { type: "item_full", itemIndex }));
    return this.package(this.description || "\u663e\u793a\u88c5\u9970\u7c7b\u6218\u5229\u54c1", message);
  }
}

export function createProp(id, definition = {}, level = 1) {
  const map = {
    prop_1: () => new RevealOneItemProp(definition, level),
    prop_2: () => new RevealRarityProp(definition, level, 4),
    prop_3: () => new RevealOutlineProp(definition, level, 5),
    prop_4: () => new RevealOutlineProp(definition, level, 7),
    prop_5: () => new RevealOutlineProp(definition, level, 9),
    prop_6: () => new RevealOutlineProp(definition, level, 11),
    prop_7: () => new RevealTypeOutlineRarityProp(definition, level, ["natural"], 3),
    prop_8: () => new RevealTypeOutlineRarityProp(definition, level, ["ore"], 3),
    prop_9: () => new RevealTypeOutlineRarityProp(definition, level, ["tech"], 3),
    prop_10: () => new RevealTypeOutlineRarityProp(definition, level, ["magic"], 3),
    prop_11: () => new RevealAllMultiblockOutlineProp(definition, level),
    prop_12: () => new RevealRarityProp(definition, level, 5),
    prop_13: () => new RevealRarityProp(definition, level, 3),
    prop_14: () => new RevealRarityProp(definition, level, 6),
    prop_15: () => new RevealRarityProp(definition, level, 7),
    prop_16: () => new RevealHighestUnknownValueProp(definition, level),
    prop_17: () => new RevealOutlineProp(definition, level, 1),
    prop_18: () => new RevealRarityOutlineProp(definition, level, "gray", 5),
    prop_19: () => new RevealRarityOutlineProp(definition, level, "gray"),
    prop_20: () => new RevealRarityOutlineProp(definition, level, "green", 5),
    prop_21: () => new RevealRarityOutlineProp(definition, level, "green"),
    prop_22: () => new RevealRarityOutlineProp(definition, level, "blue", 4),
    prop_23: () => new RevealRarityOutlineProp(definition, level, "blue"),
    prop_24: () => new RevealRarityOutlineProp(definition, level, "purple", 4),
    prop_25: () => new RevealRarityOutlineProp(definition, level, "purple"),
    prop_26: () => new RevealRarityOutlineProp(definition, level, "gold", 2),
    prop_27: () => new RevealRarityOutlineProp(definition, level, "gold"),
    prop_28: () => new RevealRarityOutlineProp(definition, level, "red", 1),
    prop_29: () => new RevealRarityOutlineProp(definition, level, "red"),
    prop_30: () => new RevealAllOutlineRarityProp(definition, level),
    prop_31: () => new RevealAllFullProp(definition, level),
    prop_32: () => new RevealDecorationFullProp(definition, level, 2),
    prop_33: () => new RevealDecorationFullProp(definition, level, 4),
    prop_34: () => new RevealDecorationFullProp(definition, level),
  };
  return (map[id] || map.prop_1)();
}

const RARITY_LOW_TO_HIGH = ["gray", "green", "blue", "purple", "gold", "red"];

function pickRarityIndexesDescending(warehouse, view, startRarity, count, random) {
  const result = [];
  const startIndex = Math.max(0, RARITY_LOW_TO_HIGH.indexOf(startRarity));
  for (let rarityIndex = startIndex; rarityIndex >= 0; rarityIndex -= 1) {
    const candidates = warehouse.items
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => index > 0 && item.rarity === RARITY_LOW_TO_HIGH[rarityIndex] && !itemFullyKnown(view, item))
      .map(({ index }) => index)
      .filter((index) => !result.includes(index));
    const picked = count == null ? candidates : sample(candidates, Math.max(0, count - result.length), random);
    result.push(...picked);
    if (count != null && result.length >= count) break;
    if (count == null && result.length > 0) break;
  }
  return count == null ? result : result.slice(0, count);
}

function sample(items, count, random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result.slice(0, count);
}
