import fs from "node:fs";
import path from "node:path";

export const PRODUCTION_SLOT_COUNT = 3;
export const PRODUCTION_INPUT_COUNT = 4;
export const PRODUCTION_OUTPUT_COUNT = 2;

export function loadProductionRecipes(rootDir, itemsById) {
  const filePath = path.join(rootDir, "production.json");
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const raw = JSON.parse(text);
  const productOrderByRecipe = extractProductOrder(text);
  const list = Array.isArray(raw) ? raw : raw?.recipe_id ? [raw] : Object.values(raw || {});
  return list
    .map((entry) => normalizeRecipe(entry, itemsById, productOrderByRecipe.get(Number(entry.recipe_id))))
    .filter(Boolean)
    .sort((a, b) => a.recipe_id - b.recipe_id);
}

export function normalizeProductionState(state) {
  const slots = Array.isArray(state?.slots) ? state.slots : [];
  return {
    slots: Array.from({ length: PRODUCTION_SLOT_COUNT }, (_, index) => normalizeProductionSlot(slots[index])),
  };
}

export function runProduction(profile, recipes, random = Math.random) {
  const production = normalizeProductionState(profile.production);
  let changed = false;
  for (const slot of production.slots) {
    const recipe = recipes.find((entry) => entry.recipe_id === slot.recipeId);
    if (!recipe || !productionInputsSatisfied(slot, recipe)) continue;
    recipe.products.forEach((product, index) => {
      if (!product || random() > product.probability) return;
      const output = slot.outputs[index];
      if (output && output.id !== product.id) return;
      slot.outputs[index] = { id: product.id, count: (output?.count || 0) + 1 };
      changed = true;
    });
  }
  profile.production = production;
  return changed;
}

export function productionInputsSatisfied(slot, recipe) {
  return recipe.recipe.every((itemId, index) => slot.inputs[index]?.id === itemId);
}

function normalizeRecipe(entry, itemsById, orderedProductIds = null) {
  if (!entry || typeof entry !== "object") return null;
  const recipeId = Number(entry.recipe_id);
  const recipe = Array.isArray(entry.recipe) ? entry.recipe.map(Number).filter((id) => itemsById.has(id)).slice(0, PRODUCTION_INPUT_COUNT) : [];
  const productEntries = orderedProductIds?.length
    ? orderedProductIds.map((id) => [String(id), entry.product?.[id] ?? entry.product?.[String(id)]])
    : Object.entries(entry.product || {});
  const products = productEntries.map(([id, probability]) => {
    const itemId = Number(id);
    if (!itemsById.has(itemId)) return null;
    return { id: itemId, probability: Math.max(0, Math.min(1, Number(probability) || 0)) };
  }).slice(0, PRODUCTION_OUTPUT_COUNT);
  if (!Number.isInteger(recipeId) || recipeId <= 0 || !recipe.length || !products.some(Boolean)) return null;
  const requirementNames = recipe.map((id) => itemsById.get(id)?.name || `#${id}`);
  const productNames = products.filter(Boolean).map((product) => itemsById.get(product.id)?.name || `#${product.id}`);
  return {
    recipe_id: recipeId,
    type: Number(entry.type || 1),
    recipe,
    products,
    label: `${requirementNames.join(", ")} - ${productNames.join(", ")}`,
  };
}

function extractProductOrder(text) {
  const result = new Map();
  const pattern = /"recipe_id"\s*:\s*(\d+)[\s\S]*?"product"\s*:\s*\{([\s\S]*?)\}/g;
  for (const match of text.matchAll(pattern)) {
    const recipeId = Number(match[1]);
    const ids = [...match[2].matchAll(/"([^"]+)"\s*:/g)].map((entry) => Number(entry[1])).filter(Number.isInteger);
    result.set(recipeId, ids);
  }
  return result;
}

function normalizeProductionSlot(slot) {
  return {
    recipeId: Number(slot?.recipeId || slot?.recipe_id || 0) || null,
    inputs: Array.from({ length: PRODUCTION_INPUT_COUNT }, (_, index) => normalizeItemStack(slot?.inputs?.[index], 1)),
    outputs: Array.from({ length: PRODUCTION_OUTPUT_COUNT }, (_, index) => normalizeItemStack(slot?.outputs?.[index], null)),
  };
}

function normalizeItemStack(value, forcedCount) {
  if (!value) return null;
  const id = Number(typeof value === "object" ? value.id : value);
  if (!Number.isInteger(id) || id <= 0) return null;
  const count = forcedCount == null ? Math.max(1, Math.floor(Number(value.count) || 1)) : forcedCount;
  return { id, count };
}
