import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";

const HeroCore = lazy(() => import("./scenes/HeroCore.jsx"));
const Network = lazy(() => import("./scenes/Network.jsx"));
const DotMatrix = lazy(() =>
  import("@designcodeio/threeui/components/DotMatrixBackground").then((m) => ({
    default: m.DotMatrixBackground,
  })),
);
const OrbitalSphere = lazy(() =>
  import("@designcodeio/threeui/components/OrbitalSphereBackground").then(
    (m) => ({
      default: m.OrbitalSphereBackground,
    }),
  ),
);

const SCENES = {
  hero: HeroCore,
  network: Network,
  flow: () => <DotMatrix gridScale={72} opacity={0.34} speed={0.55} />,
  grid: () => <DotMatrix gridScale={44} opacity={0.5} speed={0.8} />,
  closing: () => (
    <OrbitalSphere
      speed={0.65}
      particleSize={0.02}
      particleOpacity={0.75}
      orbitOpacity={0.3}
      haloOpacity={0.28}
      scale={1.6}
      hue={-65}
    />
  ),
};

function webglAvailable() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2") ||
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl"),
    );
  } catch {
    return false;
  }
}

function mountScenes() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || !webglAvailable()) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const node = entry.target;
        const Component = SCENES[node.dataset.scene];
        if (!Component) continue;
        observer.unobserve(node);
        const fallback = node.querySelector(".scene-fallback");
        if (fallback) fallback.remove();
        createRoot(node).render(
          <Suspense fallback={null}>
            <Component />
          </Suspense>,
        );
      }
    },
    { rootMargin: "320px 0px" },
  );

  document
    .querySelectorAll("[data-scene]")
    .forEach((node) => observer.observe(node));
}

function mountConnection() {
  const root = document.querySelector("[data-connection]");
  if (!root) return;
  const state = root.querySelector("[data-connection-state]");
  const detail = root.querySelector("[data-connection-detail]");
  const button = root.querySelector("[data-connection-next]");
  const steps = [
    ["Identity presented", "agent:7f3c → site.example"],
    ["Capability requested", "site.example → presence.read, tools.invoke"],
    ["Scopes approved", "session signed · owner key stays in the wallet"],
  ];
  let index = 0;
  const render = () => {
    state.textContent = steps[index][0];
    detail.textContent = steps[index][1];
  };
  button.addEventListener("click", () => {
    index = (index + 1) % steps.length;
    render();
  });
  render();
}

const ENVIRONMENTS = {
  "claude-code": [
    "Claude Code",
    "A local MCP server exposes the wallet actions the runtime is allowed to use. Claude Code has been verified end to end.",
  ],
  codex: [
    "Codex",
    "The Codex adapter uses the same local MCP server. Registration is documented; its tool calls have not been verified yet.",
  ],
  opencode: [
    "OpenCode",
    "OpenCode connects through the adapter guide. Registration is documented; its tool calls have not been verified yet.",
  ],
  chatgpt: [
    "ChatGPT desktop",
    "A desktop plugin reaches the local MCP bridge over an HTTPS tunnel. The observed setup needs the tunnel URL added again when it changes.",
  ],
  custom: [
    "Custom SDK",
    "Your own process imports the agent package, unlocks an encrypted keystore, and joins a room with the capabilities you grant.",
  ],
  webmcp: [
    "WebMCP site",
    "A site publishes its own tools through WebMCP and checks capabilities before it runs them. AI Auth supplies the identity and consent layer.",
  ],
};

function mountEnvironments() {
  const title = document.querySelector("[data-env-title]");
  const text = document.querySelector("[data-env-text]");
  if (!title || !text) return;
  document.querySelectorAll("[data-env]").forEach((button) => {
    button.addEventListener("click", () => {
      const entry = ENVIRONMENTS[button.dataset.env];
      if (!entry) return;
      title.textContent = entry[0];
      text.textContent = entry[1];
      document.querySelectorAll("[data-env]").forEach((other) => {
        other.classList.toggle("is-active", other === button);
      });
    });
  });
  const first = document.querySelector('[data-env="claude-code"]');
  if (first) first.classList.add("is-active");
}

function mountFlow() {
  const stages = [...document.querySelectorAll("[data-stage]")];
  const panels = [...document.querySelectorAll("[data-panel]")];
  const label = document.querySelector("[data-flow-label]");
  if (!stages.length) return;
  stages.forEach((stage) => {
    stage.addEventListener("click", () => {
      const index = Number(stage.dataset.stage);
      stages.forEach((other) => {
        const active = other === stage;
        other.classList.toggle("is-active", active);
        if (active) other.setAttribute("aria-current", "step");
        else other.removeAttribute("aria-current");
      });
      panels.forEach((panel) => {
        panel.hidden = Number(panel.dataset.panel) !== index;
        if (!panel.hidden) {
          panel.style.animation = "none";
          void panel.offsetWidth;
          panel.style.animation = "";
        }
      });
      if (label) label.textContent = ["Connect", "Approve", "Interact"][index];
    });
  });
}

function mountCode() {
  const tabs = [...document.querySelectorAll("[data-code-tab]")];
  const panels = [...document.querySelectorAll("[data-code-panel]")];
  const notes = {
    browser: [
      "walletUrl points to the host where you serve the wallet.",
      "javascript",
    ],
    agent: [
      "Passphrase comes from AI_AUTH_PASSPHRASE or a TTY prompt.",
      "javascript",
    ],
    mcp: ["The MCP server runs locally over stdio.", "shell"],
  };
  const note = document.querySelector("[data-code-note]");
  const lang = document.querySelector("[data-code-lang]");
  const copy = document.querySelector("[data-copy-code]");

  const select = (tab, focus = false) => {
    const key = tab.dataset.codeTab;
    tabs.forEach((other) => {
      const active = other === tab;
      other.setAttribute("aria-selected", String(active));
      other.tabIndex = active ? 0 : -1;
      if (active && focus) other.focus();
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.codePanel !== key;
    });
    if (note) note.textContent = notes[key][0];
    if (lang) lang.textContent = notes[key][1];
  };

  tabs.forEach((tab, index) => {
    tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      let next = null;
      if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
      if (event.key === "ArrowLeft")
        next = tabs[(index - 1 + tabs.length) % tabs.length];
      if (event.key === "Home") next = tabs[0];
      if (event.key === "End") next = tabs[tabs.length - 1];
      if (next) {
        event.preventDefault();
        select(next, true);
      }
    });
  });

  if (copy) {
    copy.addEventListener("click", async () => {
      const active = panels.find((panel) => !panel.hidden);
      if (!active) return;
      try {
        await navigator.clipboard.writeText(active.textContent.trim());
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Select and copy";
      }
      window.setTimeout(() => {
        copy.textContent = "Copy";
      }, 1800);
    });
  }
}

function mountReveals() {
  const items = [...document.querySelectorAll("[data-reveal]")];
  if (!("IntersectionObserver" in window)) {
    items.forEach((item) => item.classList.add("is-visible"));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  items.forEach((item) => observer.observe(item));
}

function mountProgress() {
  const bar = document.querySelector(".scroll-progress span");
  if (!bar) return;
  let queued = false;
  const update = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = `${max > 0 ? (window.scrollY / max) * 100 : 0}%`;
    queued = false;
  };
  window.addEventListener(
    "scroll",
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(update);
    },
    { passive: true },
  );
  update();
}

function mountDemo() {
  const demo = document.querySelector("[data-demo]");
  if (!demo || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    return;
  const events = demo.querySelector("[data-events]");
  const lines = [...demo.querySelectorAll("[data-chat-line]")];
  const samples = [
    "presence.move · agent:7f3c",
    "messages.send · agent:b291",
    "tools.invoke · workspace.summary",
    "presence.read · agent:7f3c",
  ];
  let step = 0;
  let timer = null;
  const tick = () => {
    step += 1;
    if (events && events.firstElementChild) {
      const item = document.createElement("li");
      const time = new Date().toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const stamp = document.createElement("time");
      stamp.textContent = time;
      item.append(
        stamp,
        document.createTextNode(` ${samples[step % samples.length]}`),
      );
      events.prepend(item);
      while (events.children.length > 3) events.lastElementChild.remove();
    }
    if (lines.length) {
      const line = lines[step % lines.length];
      line.style.opacity = "0.35";
      window.setTimeout(() => {
        line.style.opacity = "1";
      }, 180);
    }
  };
  const observer = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting && !timer)
        timer = window.setInterval(tick, 3200);
      if (!entry.isIntersecting && timer) {
        window.clearInterval(timer);
        timer = null;
      }
    },
    { threshold: 0.25 },
  );
  observer.observe(demo);
}

mountConnection();
mountEnvironments();
mountFlow();
mountCode();
mountReveals();
mountProgress();
mountDemo();

// WebGL setup is expensive. The CSS artifact holds the space until the scenes
// are ready, so the page paints and becomes readable before Three.js starts.
window.setTimeout(mountScenes, 1200);
