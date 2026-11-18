// Agent cursors: named workers that roam the page, interact with real elements
// and assemble each section. The visitor keeps the native cursor.
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
  {
    id: "agent-a",
    color: "#3ddc84",
    route: [
      [".flow-card.c1", ".hero-canvas", "reviewing request"],
      [
        ".role-card.accent-green",
        ".role-card.accent-green",
        "reviewed request",
      ],
      [".step.accent-yellow", ".step.accent-yellow", "room mapped"],
      [".stack-row .stack-card:nth-child(1)", ".stack-canvas", "wallet placed"],
    ],
  },
  {
    id: "agent-b",
    color: "#5b8cff",
    route: [
      [".flow-card.c2", null, "checking consent"],
      [".role-card.accent-blue", ".role-card.accent-blue", "approved scope"],
      [".step.accent-blue", ".step.accent-blue", "consent signed"],
      [".stack-row .stack-card:nth-child(2)", null, "sdk wired"],
    ],
  },
  {
    id: "agent-c",
    color: "#f5c542",
    route: [
      [".flow-card.c3", null, "starting runtime"],
      [".role-card.accent-pink", ".role-card.accent-pink", "signed in"],
      [".step.accent-orange", ".step.accent-orange", "peer connected"],
      [".stack-row .stack-card:nth-child(3)", null, "runtime ready"],
    ],
  },
];

const stage = document.querySelector(".agents-stage");
if (reduced || small() || !stage) {
  buildAll();
  if (stage) stage.remove();
} else {
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
        y: innerHeight / 2,
        index: 0,
        actedAt: 0,
        active: null,
      };
    })
    .filter(Boolean);

  const anchor = (selector, rect) => {
    if (selector.startsWith(".stack-row .stack-card"))
      return { x: rect.right - 26, y: rect.top + scrollY + rect.height - 8 };
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + scrollY + rect.height / 2,
    };
  };

  const release = (agent) => {
    if (!agent.active) return;
    agent.active.el.classList.remove("agent-hover", "agent-active");
    agent.active = null;
  };

  const act = (agent, target, stop) => {
    const [selector, buildSelector, label] = stop;
    const el = document.querySelector(selector);
    if (!el) return;
    release(agent);
    el.style.setProperty("--agent-color", agent.plan.color);
    el.classList.add("agent-hover");
    agent.active = { el };
    agent.note.textContent = label;
    agent.actedAt = performance.now();
    if (buildSelector) {
      const built = document.querySelector(buildSelector);
      if (built) built.classList.add("built");
    }
    // Press state reads as a short click on the element.
    setTimeout(() => {
      if (agent.active?.el === el) el.classList.add("agent-active");
    }, 180);
    setTimeout(() => {
      if (agent.active?.el === el) {
        el.classList.remove("agent-active");
        release(agent);
      }
    }, 1100);
  };

  const frame = (now) => {
    const max = Math.max(
      1,
      document.documentElement.scrollHeight - innerHeight,
    );
    progress.style.width = `${(scrollY / max) * 100}%`;

    for (const agent of agents) {
      const stops = agent.plan.route.map((stop) => {
        const el = document.querySelector(stop[0]);
        const rect = el
          ? el.getBoundingClientRect()
          : {
              left: innerWidth / 2,
              top: scrollY + innerHeight / 2,
              width: 0,
              height: 0,
            };
        const point = anchor(stop[0], rect);
        return {
          ...point,
          stop,
          visible: rect.bottom > 0 && rect.top < innerHeight + 160,
          trigger: clamp(point.y - innerHeight * 0.65, 0, max),
        };
      });

      // Scroll can pull an agent to a later section; otherwise it keeps
      // working through the visible stops on its own clock.
      let index = agent.index;
      while (index < stops.length - 1 && scrollY >= stops[index + 1].trigger)
        index += 1;
      if (index !== agent.index) {
        release(agent);
        agent.index = index;
        agent.actedAt = 0;
      }
      // When the current stop scrolls out of view, step to the next one that
      // is visible, one stop at a time, instead of jumping to the route end.
      if (
        !stops[agent.index].visible &&
        agent.index < stops.length - 1 &&
        stops[agent.index + 1].visible
      ) {
        release(agent);
        agent.index += 1;
        agent.actedAt = 0;
      }
      // Work on the first visible stop at or after the scroll position. If
      // nothing is visible yet, wait near the viewport instead of jumping to
      // the end of the route.
      let targetIndex = stops.findIndex(
        (stop, i) => i >= agent.index && stop.visible,
      );
      if (targetIndex < 0)
        targetIndex = stops.findIndex((stop) => stop.visible);
      const target = targetIndex >= 0 ? stops[targetIndex] : null;
      const desiredX = target ? target.x : agent.x;
      const desiredY = target
        ? clamp(target.y - scrollY, 96, innerHeight - 96)
        : clamp(innerHeight * 0.7, 96, innerHeight - 96);
      agent.x += (desiredX - agent.x) * 0.055;
      agent.y += (desiredY - agent.y) * 0.055;
      agent.el.style.transform = `translate3d(${agent.x}px, ${agent.y}px, 0)`;

      const near =
        target && Math.hypot(desiredX - agent.x, desiredY - agent.y) < 26;
      const settled = now - agent.actedAt > 1500;
      if (
        near &&
        settled &&
        (!agent.active ||
          agent.active.el !== document.querySelector(target.stop[0]))
      )
        act(agent, document.querySelector(target.stop[0]), target.stop);

      // After working a visible stop, roam to the next one even without a
      // scroll, so the agents look like they are doing something on their own.
      if (
        agent.actedAt &&
        now - agent.actedAt > 2000 &&
        targetIndex >= 0 &&
        targetIndex < stops.length - 1 &&
        stops[targetIndex + 1].visible
      ) {
        release(agent);
        agent.index = targetIndex + 1;
        agent.actedAt = 0;
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
