// Local decision engine for the page's agent cursors.
//
// A browser micro LLM would need a 120-360 MB download and still invent
// facts at that size, so the shipped policy is a small utility function over
// the page itself. A host page can replace it by setting
// window.__aiAuthAgentPolicy = (state) => elementOrSelector (synchronous).

const SELECTORS = [
  ".flow-card",
  ".role-card",
  ".step",
  ".stack-card",
  ".spec-table > div",
  ".cta .btn",
  ".pile-item",
];

const PHRASES = {
  review: ["reviewing request", "checking scopes", "reading payload"],
  build: ["drawing wire", "placing card", "grading section"],
  assemble: ["linking relay", "assembling node", "checking route"],
  verify: ["verifying claim", "matching signature", "checking receipt"],
  handoff: ["handing off", "offering action", "opening the door"],
  play: ["nudging link", "stacking tile", "pushing item"],
};

export function createBrain({ rand = Math.random } = {}) {
  const goalFor = (el) => {
    if (el.matches(".flow-card, .role-card")) return "review";
    if (el.matches(".step")) return "build";
    if (el.matches(".stack-card")) return "assemble";
    if (el.matches(".spec-table > div")) return "verify";
    if (el.matches(".pile-item")) return "play";
    return "handoff";
  };

  const candidates = () =>
    [...document.querySelectorAll(SELECTORS.join(","))].filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.bottom > 0 && rect.top < innerHeight + 180;
    });

  const score = (agent, el, others) => {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const distance = Math.hypot(x - agent.x, y - agent.y);
    const goal = goalFor(el);
    const relevance = agent.plan.goals.includes(goal) ? 1.6 : 0.5;
    const visits = agent.visits.get(el) ?? 0;
    const novelty = 1 / (1 + visits * 0.9);
    const recent = agent.last === el ? 0.25 : 1;
    let crowd = 0;
    for (const other of others)
      if (other !== agent && other.task?.el === el) crowd += 1;
    return (
      relevance +
      novelty * 1.5 +
      recent * 1.3 +
      rand() * 0.5 -
      distance / 1100 -
      crowd * 1.4
    );
  };

  const choose = (agent, others) => {
    const available = candidates();
    if (!available.length) return null;
    const policy = globalThis.__aiAuthAgentPolicy;
    if (typeof policy === "function") {
      const picked = policy({
        id: agent.plan.id,
        goals: agent.plan.goals,
        x: agent.x,
        y: agent.y,
        candidates: available,
      });
      if (picked instanceof Element && available.includes(picked))
        return picked;
      if (typeof picked === "string") {
        const bySelector = available.find((el) => el.matches(picked));
        if (bySelector) return bySelector;
      }
    }
    let best = null;
    let bestScore = -Infinity;
    for (const el of available) {
      const value = score(agent, el, others);
      if (value > bestScore) {
        best = el;
        bestScore = value;
      }
    }
    return best;
  };

  const phraseFor = (agent, el) => {
    const list = PHRASES[goalFor(el)] ?? PHRASES.review;
    return list[Math.floor(rand() * list.length) % list.length];
  };

  return { choose, candidates, goalFor, phraseFor };
}
