import {
  firstUnknownCellForItem,
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
    const [itemIndex] = randomItemIndexes(warehouse, (item) => !itemFullyKnown(view, item), 1, random);
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
      .filter(({ item, index }) => index > 0 && Number(item.width || 0) * Number(item.height || 0) > 1 && !itemOutlineKnown(view, item))
      .map(({ index }) => index);
    const message = indexes.map((itemIndex) => warehouse.addHint(viewNumber, { type: "item_outline", itemIndex }));
    return this.package(this.description || "\u663e\u793a\u6240\u6709\u591a\u65b9\u5757\u7c7b\u6218\u5229\u54c1\u7684\u8f6e\u5ed3", message);
  }
}

export function createProp(id, definition = {}, level = 1) {
  const map = {
    prop_1: () => new RevealOneItemProp(definition, level),
    prop_2: () => new RevealRarityProp(definition, level, 4),
    prop_3: () => new RevealOutlineProp(definition, level, 3),
    prop_4: () => new RevealOutlineProp(definition, level, 4),
    prop_7: () => new RevealTypeOutlineRarityProp(definition, level, ["natural"], 2),
    prop_8: () => new RevealTypeOutlineRarityProp(definition, level, ["ore"], 2),
    prop_9: () => new RevealTypeOutlineRarityProp(definition, level, ["tech"], 2),
    prop_10: () => new RevealTypeOutlineRarityProp(definition, level, ["magic"], 2),
    prop_11: () => new RevealAllMultiblockOutlineProp(definition, level),
  };
  return (map[id] || map.prop_1)();
}
