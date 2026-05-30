import {
  firstUnknownCellForItem,
  itemFullInfoKnown,
  itemOutlineKnown,
  itemRarityKnown,
  makeHintPackage,
  randomItemIndexes,
  splitTypes,
} from "./hints.js";

const RARITY_ORDER = ["gray", "green", "blue", "purple", "gold", "red"];
const RARITY_LABELS = { gray: "白", green: "绿", blue: "蓝", purple: "紫", gold: "金", red: "红" };

export class Character {
  constructor(definition = {}) {
    this.definition = definition;
  }

  onGameStart() {
    return null;
  }

  onRoundStart() {
    return null;
  }
}

export class SteveCharacter extends Character {
  onGameStart({ warehouse, viewNumber, view, random }) {
    const allTypes = new Set();
    for (const { item } of realItems(warehouse)) {
      for (const type of splitTypes(item.type)) allTypes.add(type);
    }
    const pickedTypes = shuffle([...allTypes], random).slice(0, 5);
    const picked = new Set(pickedTypes);
    const indexes = realItems(warehouse)
      .filter(({ item }) => !itemOutlineKnown(view, item) && splitTypes(item.type).some((type) => picked.has(type)))
      .map(({ index }) => index);
    return itemPackage(warehouse, viewNumber, {
      text: `抽取${pickedTypes.length}个类别，显示所有包含这些类别的战利品轮廓`,
      indexes,
      hintType: "item_outline",
    });
  }

  onRoundStart({ warehouse, viewNumber, view, round }) {
    const indexes =
      round === 5
        ? realItems(warehouse)
            .filter(({ item }) => !itemOutlineKnown(view, item))
            .map(({ index }) => index)
        : realItems(warehouse)
            .filter(({ item }) => itemRarityKnown(view, item) && !itemOutlineKnown(view, item))
            .map(({ index }) => index);
    return itemPackage(warehouse, viewNumber, {
      text: round === 5 ? `显示所有战利品的轮廓` : `显示${indexes.length}件已知品质战利品的轮廓`,
      indexes,
      hintType: "item_outline",
    });
  }
}

export class AlexCharacter extends Character {
  onGameStart({ warehouse, viewNumber, view, random }) {
    return revealUnknownRarity(warehouse, viewNumber, view, 5, random, "显示5件不同战利品的品质");
  }

  onRoundStart({ warehouse, viewNumber, view, random }) {
    return revealUnknownRarity(warehouse, viewNumber, view, 2, random, "揭示2件品质未知战利品的品质");
  }
}

class SequentialTypeCharacter extends Character {
  constructor(definition, type, typeLabel) {
    super(definition);
    this.type = type;
    this.typeLabel = typeLabel;
  }

  onRoundStart({ warehouse, viewNumber, view, round, random }) {
    const indexes = itemsWithAnyType(warehouse, [this.type]).map(({ index }) => index);
    const fullCandidates = itemsWithAnyType(warehouse, [this.type])
      .filter(({ item }) => !itemFullInfoKnown(view, item))
      .map(({ index }) => index);
    const fullCount = Math.ceil(indexes.length / 3);
    if (round === 1) {
      return textPackage(`所有${this.typeLabel}类战利品的数量为${indexes.length}`);
    }
    if (round === 2) {
      return itemPackage(warehouse, viewNumber, {
        text: `显示所有${this.typeLabel}类战利品的轮廓`,
        indexes,
        hintType: "item_outline",
      });
    }
    if (round === 3) {
      return rarityPackage(warehouse, viewNumber, indexes, `显示所有${this.typeLabel}类战利品的品质`);
    }
    if (round === 4 || round === 5) {
      return itemPackage(warehouse, viewNumber, {
        text: `显示1/3${this.typeLabel}类战利品的完整信息`,
        indexes: sample(fullCandidates, fullCount, random),
        hintType: "item_full",
      });
    }
    return textPackage(`${this.typeLabel}类战利品信息已全部发动`);
  }
}

export class HarperCharacter extends Character {
  onGameStart({ warehouse, viewNumber }) {
    const indexes = itemsWithRarities(warehouse, ["gray", "green", "blue"]).map(({ index }) => index);
    const total = indexes.reduce((sum, index) => sum + Number(warehouse.getItemByIndex(index)?.price || 0), 0);
    const hint = rarityPackage(warehouse, viewNumber, indexes, `白色、绿色和蓝色品质战利品的总价值为${total}`);
    hint.show = hint.message.length > 0;
    return hint;
  }
}

export class JesseCharacter extends Character {
  onRoundStart({ warehouse, viewNumber, round }) {
    const rarity = RARITY_ORDER[round - 1];
    if (!rarity || round > 4) return null;
    const indexes = itemsWithRarities(warehouse, [rarity]).map(({ index }) => index);
    return itemPackage(warehouse, viewNumber, {
      text: `显示所有${RARITY_LABELS[rarity]}色品质战利品的轮廓和品质`,
      indexes,
      hintType: "item_outline_rarity",
    });
  }
}

export class IsaCharacter extends Character {
  onGameStart({ warehouse }) {
    const count = itemsWithRarities(warehouse, ["purple", "gold", "red"]).length;
    return textPackage(`紫色、金色和红色品质战利品的数量之和为${count}`);
  }
}

export class IvorCharacter extends Character {
  onRoundStart({ warehouse, viewNumber, round }) {
    if (round !== 5) return null;
    const indexes = realItems(warehouse).map(({ index }) => index);
    return rarityPackage(warehouse, viewNumber, indexes, "显示所有战利品的品质");
  }
}

export class LukasCharacter extends Character {
  onGameStart({ warehouse, viewNumber }) {
    const indexes = itemsWithAnyType(warehouse, ["tool", "equipment"]).map(({ index }) => index);
    return itemPackage(warehouse, viewNumber, {
      text: "显示所有工具类和装备类战利品的轮廓",
      indexes,
      hintType: "item_outline",
    });
  }

  onRoundStart({ warehouse, viewNumber, view, random }) {
    const candidates = itemsWithAnyType(warehouse, ["tool", "equipment"])
      .filter(({ item }) => !itemRarityKnown(view, item))
      .map(({ index }) => index);
    return rarityPackage(warehouse, viewNumber, sample(candidates, 1, random), "揭示一件工具或装备类战利品的品质");
  }
}

export class MeviaCharacter extends Character {
  onGameStart({ warehouse, viewNumber }) {
    const indexes = itemsWithAnyType(warehouse, ["food"]).map(({ index }) => index);
    return itemPackage(warehouse, viewNumber, {
      text: "显示所有食物类战利品的轮廓",
      indexes,
      hintType: "item_outline",
    });
  }

  onRoundStart({ warehouse, viewNumber, view, random }) {
    const natural = itemsWithAnyType(warehouse, ["natural"])
      .filter(({ item }) => !itemRarityKnown(view, item))
      .map(({ index }) => index);
    if (natural.length) return rarityPackage(warehouse, viewNumber, sample(natural, 1, random), "显示1个品质未知的自然类战利品的品质");
    const [index] = randomItemIndexes(warehouse, (item) => !itemRarityKnown(view, item) || !itemOutlineKnown(view, item), 1, random);
    return itemPackage(warehouse, viewNumber, {
      text: "没有符合条件的自然类战利品，改为显示1个随机战利品的品质和轮廓",
      indexes: index ? [index] : [],
      hintType: "item_outline_rarity",
    });
  }
}

export class OttoCharacter extends Character {
  onGameStart({ warehouse, viewNumber }) {
    const indexes = itemsWithAnyType(warehouse, ["ore"]).map(({ index }) => index);
    return itemPackage(warehouse, viewNumber, {
      text: "显示所有矿物类战利品的轮廓和品质",
      indexes,
      hintType: "item_outline_rarity",
    });
  }
}

export class PetraCharacter extends Character {
  onRoundStart({ warehouse, viewNumber, view, random }) {
    const indexes = realItems(warehouse)
      .filter(({ item }) => !itemOutlineKnown(view, item) && !itemRarityKnown(view, item))
      .map(({ index }) => index);
    return itemPackage(warehouse, viewNumber, {
      text: "显示两个完全未知战利品的轮廓和品质",
      indexes: sample(indexes, 2, random),
      hintType: "item_outline_rarity",
    });
  }
}

export class SukunaCharacter extends Character {}

export class GojoCharacter extends Character {
  onGameStart({ state }) {
    state.mode = "blue";
    state.redTriggered = false;
    return textPackage("进入【苍】阶段");
  }

  onRoundStart({ warehouse, viewNumber, view, player, players, state, round, random }) {
    const hints = [];
    if (!state.mode) state.mode = "blue";
    const previousRound = round - 2;
    if (previousRound >= 0) {
      const bid = player.bids[previousRound] ?? 0;
      const allBids = players.map((entry) => entry.bids[previousRound] ?? 0);
      if (state.mode === "blue" && bid === Math.max(...allBids)) {
        const indexes = itemsWithRarities(warehouse, ["blue"]).map(({ index }) => index);
        hints.push(
          itemPackage(warehouse, viewNumber, {
            text: "【苍】效果触发，随机显示一半蓝色战利品，并进入【赫】阶段",
            indexes: sample(indexes, Math.ceil(indexes.length / 2), random),
            hintType: "item_full",
          }),
        );
        state.mode = "red";
        hints.push(textPackage("进入【赫】阶段"));
      } else if (state.mode === "red" && bid === Math.min(...allBids)) {
    const index = pickHighestAvailableRarityItem(warehouse, view, random);
        hints.push(
          itemPackage(warehouse, viewNumber, {
            text: "【赫】效果触发，随机显示一个高品质战利品，并进入【苍】阶段",
            indexes: index ? [index] : [],
            hintType: "item_full",
          }),
        );
        state.redTriggered = true;
        state.mode = "blue";
        hints.push(textPackage("进入【苍】阶段"));
      }
    }
    if (round === 5 && state.redTriggered) {
      hints.push(
        itemPackage(warehouse, viewNumber, {
          text: "第五回合效果发动，显示所有紫色品质战利品",
          indexes: itemsWithRarities(warehouse, ["purple"]).map(({ index }) => index),
          hintType: "item_full",
        }),
      );
    }
    return hints;
  }
}

export function createCharacter(id, definition = {}) {
  const map = {
    character_1: SteveCharacter,
    character_2: AlexCharacter,
    character_3: class extends SequentialTypeCharacter {
      constructor(def) {
        super(def, "mob", "生物");
      }
    },
    character_4: class extends SequentialTypeCharacter {
      constructor(def) {
        super(def, "decoration", "装饰");
      }
    },
    character_5: HarperCharacter,
    character_6: JesseCharacter,
    character_7: IsaCharacter,
    character_8: IvorCharacter,
    character_9: LukasCharacter,
    character_10: MeviaCharacter,
    character_11: class extends SequentialTypeCharacter {
      constructor(def) {
        super(def, "tech", "科技");
      }
    },
    character_12: OttoCharacter,
    character_13: PetraCharacter,
    character_14: SukunaCharacter,
    character_15: GojoCharacter,
  };
  const ClassName = map[id] || SteveCharacter;
  return new ClassName(definition);
}

function revealUnknownRarity(warehouse, viewNumber, view, count, random, text) {
  const indexes = randomItemIndexes(warehouse, (item) => !itemRarityKnown(view, item), count, random);
  return rarityPackage(warehouse, viewNumber, indexes, text);
}

function textPackage(text) {
  return makeHintPackage({ title: "角色技能", text, show: false, message: [] });
}

function itemPackage(warehouse, viewNumber, { text, indexes, hintType }) {
  const message = indexes.map((itemIndex) => warehouse.addHint(viewNumber, { type: hintType, itemIndex }));
  return makeHintPackage({ title: "角色技能", text, show: message.length > 0, message });
}

function rarityPackage(warehouse, viewNumber, indexes, text) {
  const message = indexes
    .map((itemIndex) => warehouse.getItemByIndex(itemIndex))
    .filter(Boolean)
    .map((item) => warehouse.addHint(viewNumber, { type: "cell_rarity", x: item.x, y: item.y }));
  return makeHintPackage({ title: "角色技能", text, show: message.length > 0, message });
}

function realItems(warehouse) {
  return warehouse.items.map((item, index) => ({ item, index })).filter(({ index }) => index > 0);
}

function itemsWithAnyType(warehouse, types) {
  const wanted = new Set(types.map((type) => type.toLowerCase()));
  return realItems(warehouse).filter(({ item }) => splitTypes(item.type).some((type) => wanted.has(type.toLowerCase())));
}

function itemsWithRarities(warehouse, rarities) {
  const wanted = new Set(rarities);
  return realItems(warehouse).filter(({ item }) => wanted.has(item.rarity));
}

function pickHighestAvailableRarityItem(warehouse, view, random) {
  for (const rarity of [...RARITY_ORDER].reverse()) {
    const indexes = itemsWithRarities(warehouse, [rarity])
      .filter(({ item }) => !itemFullInfoKnown(view, item))
      .map(({ index }) => index);
    if (indexes.length) return sample(indexes, 1, random)[0];
  }
  return null;
}

function sample(items, count, random = Math.random) {
  return shuffle([...items], random).slice(0, count);
}

function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
