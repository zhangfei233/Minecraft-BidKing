export function loadLotteryRecipes(rawRecipes, itemsById, propDefinitions) {
  const recipes = (Array.isArray(rawRecipes) ? rawRecipes : rawRecipes ? [rawRecipes] : [])
    .map((entry, index) => normalizeLotteryRecipe(entry, index + 1, itemsById, propDefinitions))
    .filter(Boolean);
  return recipes;
}

export function normalizeLotteryState(state) {
  return {
    slot: normalizeLotteryStack(state?.slot),
    results: Array.isArray(state?.results) ? state.results.map(normalizeLotteryResult).filter(Boolean).slice(0, 9) : [],
  };
}

export function lotteryConsumableIds(recipes) {
  return [...new Set(recipes.map((recipe) => recipe.consume))];
}

export function drawLottery(recipe, random = Math.random) {
  const results = [];
  for (let i = 0; i < recipe.outcome; i += 1) {
    const picked = recipe.pool[Math.floor(random() * recipe.pool.length)];
    if (picked) results.push({ class: picked.class, id: picked.id, count: 1 });
  }
  return results;
}

function normalizeLotteryRecipe(entry, fallbackId, itemsById, propDefinitions) {
  const consume = Number(entry?.consume);
  const outcome = Math.max(1, Math.min(9, Math.floor(Number(entry?.outcome) || 1)));
  if (!itemsById.has(consume)) return null;
  const poolText = normalizePoolText(String(entry?.pool || ""));
  const predicate = parsePoolExpression(poolText);
  const pool = [
    ...[...itemsById.values()].map((item) => ({ class: "item", id: item.id, rarity: item.rarity, types: item.types || [], type: item.type })),
    ...[...propDefinitions.values()].map((prop) => ({ class: "prop", id: prop.id, rarity: prop.rarity || levelToRarity(prop.level), types: [], type: "" })),
  ].filter(predicate);
  if (!pool.length) return null;
  return {
    recipe_id: Number(entry.recipe_id || fallbackId),
    consume,
    outcome,
    poolText,
    pool,
  };
}

function parsePoolExpression(text) {
  const tokens = tokenize(text);
  let index = 0;
  const parseExpression = () => {
    let node = parseTerm();
    while (tokens[index] === "||") {
      index += 1;
      const right = parseTerm();
      const left = node;
      node = (entry) => left(entry) || right(entry);
    }
    return node;
  };
  const parseTerm = () => {
    let node = parseFactor();
    while (tokens[index] === "&&") {
      index += 1;
      const right = parseFactor();
      const left = node;
      node = (entry) => left(entry) && right(entry);
    }
    return node;
  };
  const parseFactor = () => {
    if (tokens[index] === "(") {
      index += 1;
      const node = parseExpression();
      if (tokens[index] === ")") index += 1;
      return node;
    }
    const token = tokens[index++] || "";
    const [key, value] = token.split("=");
    return (entry) => matchCondition(entry, key, value);
  };
  return parseExpression();
}

function tokenize(text) {
  return String(text || "").match(/\|\||&&|\(|\)|[^&|()]+/g)?.map((token) => token.trim()).filter(Boolean) || [];
}

function matchCondition(entry, key, value) {
  const normalizedValue = key === "class" ? String(value || "").toLowerCase() : value;
  if (key === "class") return entry.class === normalizedValue;
  if (key === "rarity") return entry.rarity === value;
  if (key === "type") return entry.class === "item" && entry.types.includes(value);
  return false;
}

function levelToRarity(level) {
  return ["gray", "green", "blue", "purple", "gold", "red"][Math.max(0, Math.min(5, (Number(level) || 1) - 1))];
}

function normalizeLotteryStack(value) {
  if (!value) return null;
  const id = Number(typeof value === "object" ? value.id : value);
  return Number.isInteger(id) && id > 0 ? { id, count: 1 } : null;
}

function normalizeLotteryResult(value) {
  if (!value) return null;
  const className = String(value.class || "").toLowerCase() === "prop" ? "prop" : "item";
  const id = className === "prop" ? String(value.id) : Number(value.id);
  const count = Math.max(1, Math.floor(Number(value.count) || 1));
  return id ? { class: className, id, count } : null;
}

function normalizePoolText(text) {
  return String(text || "")
    .replaceAll("class=Item", "class=item")
    .replaceAll("class=Prop", "class=prop");
}
