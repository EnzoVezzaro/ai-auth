// Agent cursors: named workers that make their own decisions about which
// element to work on next. The visitor keeps the native cursor.
import { createBrain } from "./brain.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const small = () => innerWidth < 900;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Section reveals and the scroll progress bar stay independent of the agents.
const io = new IntersectionObserver(
  (entries) => {
    for (const entry of entries)
      if (entry.isIntersecting) {
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      }
  },
  { threshold: 0.18 },
);
for (const el of document.querySelectorAll("[data-reveal]")) io.observe(el);
const progress = document.querySelector(".scroll-progress span");

const BUILT_SELECTOR =
  ".hero-canvas, .stack-canvas, .role-card, .step.accent-yellow, .step.accent-blue, .step.accent-orange";
const buildAll = () => {
  for (const el of document.querySelectorAll(BUILT_SELECTOR))
    el.classList.add("built");
};

const plans = [
  { id: "agent-a", color: "#3ddc84", goals: ["review", "build"] },
  { id: "agent-b", color: "#5b8cff", goals: ["review", "verify"] },
  { id: "agent-c", color: "#f5c542", goals: ["assemble", "handoff"] },
];

const BUILD_TARGETS = new Map([
  [".flow-card.c1", ".hero-canvas"],
  [".flow-card.c2", ".hero-canvas"],
  [".flow-card.c3", ".hero-canvas"],
  [".stack-row .stack-card:nth-child(1)", ".stack-canvas"],
  [".stack-row .stack-card:nth-child(2)", ".stack-canvas"],
  [".stack-row .stack-card:nth-child(3)", ".stack-canvas"],
]);

const stage = document.querySelector(".agents-stage");
if (reduced || small() || !stage) {
  buildAll();
  if (stage) stage.remove();
} else {
  const brain = createBrain();
  const agents = plans
    .map((plan) => {
      const el = document.getElementById(plan.id);
      if (!el) return null;
      const note = document.createElement("em");
      note.className = "agent-action";
      el.append(note);
      return {
        plan,
        el,
        note,
        x: innerWidth / 2,
        y: innerHeight * 0.7,
        visits: new Map(),
        last: null,
        target: null,
        task: null,
        waitUntil: 0,
      };
    })
    .filter(Boolean);

  const release = (agent) => {
    if (!agent.task?.el) return;
    agent.task.el.classList.remove("agent-hover", "agent-active");
  };

  const announce = (agent, text) => {
    agent.note.textContent = text;
  };

  const pointFor = (el) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  };

  const buildFor = (el) => {
    for (const [selector, built] of BUILD_TARGETS)
      if (el.matches(selector)) return document.querySelector(built);
    if (el.matches(".role-card, .step")) return el;
    if (el.matches(".stack-card"))
      return document.querySelector(".stack-canvas");
    if (el.matches(".flow-card")) return document.querySelector(".hero-canvas");
    return null;
  };

  const startTask = (agent, now) => {
    const el = agent.target;
    if (!el) return;
    agent.task = { el, at: now, stage: -1, phrase: brain.phraseFor(agent, el) };
    agent.last = el;
    agent.visits.set(el, (agent.visits.get(el) ?? 0) + 1);
  };

  const advanceTask = (agent, now) => {
    const task = agent.task;
    const elapsed = now - task.at;
    if (elapsed > 2100) {
      release(agent);
      announce(agent, "");
      agent.task = null;
      agent.target = null;
      agent.waitUntil = now + 260;
      return;
    }
    if (elapsed > 1400 && task.stage < 2) {
      task.stage = 2;
      announce(agent, "handing off");
      return;
    }
    if (elapsed > 700 && task.stage < 1) {
      task.stage = 1;
      task.el.classList.add("agent-active");
      announce(agent, task.phrase);
      const built = buildFor(task.el);
      if (built) built.classList.add("built");
      return;
    }
    if (task.stage < 0) {
      task.stage = 0;
      task.el.classList.add("agent-hover");
      announce(agent, "inspecting");
    }
  };

  const frame = (now) => {
    const max = Math.max(
      1,
      document.documentElement.scrollHeight - innerHeight,
    );
    progress.style.width = `${(scrollY / max) * 100}%`;

    for (const agent of agents) {
      if (agent.task) advanceTask(agent, now);

      if (!agent.task && now >= agent.waitUntil) {
        agent.target = brain.choose(agent, agents);
      }

      const point = agent.task
        ? pointFor(agent.task.el)
        : pointFor(agent.target);
      const wander = !point;
      const desiredX = wander
        ? clamp(agent.x + Math.sin(now / 900) * 18, 40, innerWidth - 140)
        : point.x;
      const desiredY = wander
        ? clamp(
            innerHeight * 0.62 + Math.cos(now / 1100) * 24,
            100,
            innerHeight - 120,
          )
        : clamp(point.y, 96, innerHeight - 96);

      agent.x += (desiredX - agent.x) * 0.08;
      agent.y += (desiredY - agent.y) * 0.08;
      agent.el.style.transform = `translate3d(${agent.x}px, ${agent.y}px, 0)`;

      const near =
        !wander && Math.hypot(desiredX - agent.x, desiredY - agent.y) < 30;
      if (near && !agent.task && agent.target) startTask(agent, now);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
