export function makeHintPackage({ title, text, show = true, message = [] }) {
  return {
    type: "hint",
    title,
    text,
    show,
    message,
  };
}

export function randomItemIndexes(warehouse, predicate, count, random = Math.random) {
  const candidates = warehouse.items
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => index > 0 && predicate(item, index));
  shuffle(candidates, random);
  return candidates.slice(0, count).map((entry) => entry.index);
}

export function itemHasAnyNewType(item, usedTypes) {
  return (item.types || splitTypes(item.type)).some((type) => !usedTypes.has(type));
}

export function firstUnknownCellForItem(warehouse, view, index) {
  const item = warehouse.getItemByIndex(index);
  if (!item) return null;
  for (let y = item.y; y < item.y + item.height; y += 1) {
    for (let x = item.x; x < item.x + item.width; x += 1) {
      if (!view.rarityKnown[y][x]) return { x, y };
    }
  }
  return null;
}

export function itemOutlineKnown(view, item) {
  for (let y = item.y; y < item.y + item.height; y += 1) {
    for (let x = item.x; x < item.x + item.width; x += 1) {
      if (!view.outlineKnown[y][x]) return false;
    }
  }
  return true;
}

export function itemRarityKnown(view, item) {
  for (let y = item.y; y < item.y + item.height; y += 1) {
    for (let x = item.x; x < item.x + item.width; x += 1) {
      if (view.rarityKnown[y][x]) return true;
    }
  }
  return false;
}

export function itemFullyKnown(view, item) {
  return itemOutlineKnown(view, item) && itemRarityKnown(view, item);
}

export function itemFullInfoKnown(view, item) {
  return (view.hint || []).some((hint) => hint.type === "item_full" && Number(hint.itemIndex) === Number(item.index));
}

export function splitTypes(typeText) {
  return String(typeText || "")
    .split(";")
    .map((type) => type.trim())
    .filter(Boolean);
}

function shuffle(items, random) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}
