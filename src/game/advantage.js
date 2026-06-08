export class AdvantageTracker {
  constructor() {
    this.values = new Map();
  }

  key(sourceId, targetId) {
    return `${sourceId}=>${targetId}`;
  }

  add(sourceId, targetId, amount) {
    const key = this.key(sourceId, targetId);
    const next = (this.values.get(key) || 0) + Number(amount || 0);
    this.values.set(key, next);
    return next;
  }

  get(sourceId, targetId) {
    return this.values.get(this.key(sourceId, targetId)) || 0;
  }

  entries() {
    return [...this.values.entries()].map(([key, value]) => {
      const [sourceId, targetId] = key.split("=>");
      return { sourceId, targetId, value };
    });
  }
}

export function requiredPairRatio(baseRatio, candidateAdvantage, opponentAdvantage) {
  return Math.max(0, Number(baseRatio || 0) - Number(candidateAdvantage || 0) + Number(opponentAdvantage || 0));
}
