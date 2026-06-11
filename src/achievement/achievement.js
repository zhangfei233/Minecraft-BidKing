import fs from "node:fs";
import path from "node:path";

export function loadAchievements(rootDir) {
  const filePath = path.join(rootDir, "achievement.json");
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const entries = Array.isArray(raw)
    ? raw
    : Object.entries(raw || {}).map(([id, value]) => ({ id, ...(typeof value === "object" ? value : { description: String(value) }) }));
  return entries.map((entry, index) => {
    const id = String(entry.id ?? entry.achievement_id ?? index + 1);
    const goal = Math.max(1, Math.floor(Number(entry.goal ?? entry.target ?? entry.count ?? 1) || 1));
    return {
      ...entry,
      id,
      title: entry.title || entry.name || `成就 ${id}`,
      description: entry.description || entry.text || "",
      goal,
      reward: Number(entry.reward || entry.reward_id || 0),
    };
  });
}

export function normalizeAchievementState(profile, achievements = []) {
  if (!profile.achievements || typeof profile.achievements !== "object") profile.achievements = {};
  for (const achievement of achievements) {
    const key = String(achievement.id);
    const state = profile.achievements[key] || {};
    const progress = Math.max(0, Math.floor(Number(state.progress || 0)));
    profile.achievements[key] = {
      completed: Boolean(state.completed) || progress >= achievement.goal,
      claimed: Boolean(state.claimed),
      progress: Math.min(Math.max(progress, 0), achievement.goal),
    };
  }
  return profile.achievements;
}

export function publicAchievementState(profile, achievements = []) {
  normalizeAchievementState(profile, achievements);
  return achievements.map((achievement) => ({
    id: achievement.id,
    title: achievement.title,
    description: achievement.description,
    goal: achievement.goal,
    reward: achievement.reward,
    state: profile.achievements[String(achievement.id)] || { completed: false, claimed: false, progress: 0 },
  }));
}

export function advanceAchievement(profile, achievements, id, amount = 1) {
  normalizeAchievementState(profile, achievements);
  const achievement = achievements.find((entry) => String(entry.id) === String(id));
  if (!achievement) return null;
  const state = profile.achievements[String(achievement.id)];
  if (state.completed) return state;
  state.progress = Math.min(achievement.goal, state.progress + Math.max(1, Math.floor(Number(amount) || 1)));
  if (state.progress >= achievement.goal) state.completed = true;
  return state;
}
