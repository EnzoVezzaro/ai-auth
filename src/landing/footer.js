// Footer pile: links fall into the footer, bounce and stay stacked. Inspired
// by the Matter.js physics playground on madewithgsap.com/codrops, but with
// no dependencies and no removal: every item that drops remains on the page.

const ITEMS = [
  ["AI Auth", "./"],
  ["agent id", "./docs/protocol.html"],
  ["did:key", "./docs/DID.html"],
  ["signed envelope", "./docs/protocol.html"],
  ["message/text", "./docs/protocol.html"],
  ["collab/text", "./docs/protocol.html"],
  ["capability", "./docs/BOUNDARIES.html"],
  ["consent", "./docs/site-integration.html"],
  ["grant", "./docs/lifecycle.html"],
  ["receipt", "./docs/protocol.html"],
  ["membership", "./docs/protocol.html"],
  ["revocation", "./docs/lifecycle.html"],
  ["epoch", "./docs/lifecycle.html"],
  ["room", "./docs/ARCHITECTURE.html"],
  ["origin", "./docs/DISCOVERY.html"],
  ["session", "./docs/lifecycle.html"],
  ["resume", "./docs/quickstart.html"],
  ["keystore", "./docs/agents.html"],
  ["site SDK", "./docs/site-integration.html"],
  ["agent runtime", "./docs/agents.html"],
  ["WebMCP", "./docs/site-integration.html"],
  ["Nostr", "./docs/protocol.html"],
  ["presence", "./docs/site-integration.html"],
  ["approval", "./docs/SECURITY.html"],
];

const pile = document.querySelector(".footer-pile");
if (pile) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const small = () => innerWidth < 900;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const nodes = ITEMS.map(([label, href], index) => {
    const el = document.createElement("a");
    el.className = `pile-item pile-${index % 4}`;
    el.href = href;
    el.textContent = label;
    pile.append(el);
    return el;
  });

  if (reduced || small()) {
    pile.classList.add("static-pile");
  } else {
    let width = pile.clientWidth;
    let height = pile.clientHeight;
    const bodies = nodes.map((el, index) => ({
      el,
      x: 60 + ((index * 137) % Math.max(1, width - 160)),
      y: -80 - index * 46,
      vx: (Math.random() - 0.5) * 2.4,
      vy: 1 + Math.random() * 1.4,
      angle: 0,
      va: (Math.random() - 0.5) * 0.05,
      w: el.offsetWidth || 110,
      h: el.offsetHeight || 34,
      live: false,
    }));
    let spawned = 0;
    let nextSpawn = 0;
    let visible = false;

    const measure = () => {
      width = pile.clientWidth;
      height = pile.clientHeight;
      for (const body of bodies) {
        body.w = body.el.offsetWidth || body.w;
        body.h = body.el.offsetHeight || body.h;
      }
    };
    measure();
    addEventListener("resize", measure, { passive: true });

    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries[0]?.isIntersecting ?? false;
      },
      { rootMargin: "120px" },
    );
    observer.observe(pile);

    pile.addEventListener(
      "pointermove",
      (event) => {
        const rect = pile.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        for (const body of bodies) {
          if (!body.live) continue;
          const dx = body.x + body.w / 2 - px;
          const dy = body.y + body.h / 2 - py;
          const dist = Math.hypot(dx, dy);
          if (dist < 150 && dist > 0) {
            const push = (150 - dist) / 150;
            body.vx += (dx / dist) * push * 3.2;
            body.vy += (dy / dist) * push * 2.4 - push * 1.6;
            body.va += (Math.random() - 0.5) * push * 0.06;
          }
        }
      },
      { passive: true },
    );

    const settle = (body) => {
      const floor = height - body.h - 6;
      if (body.y > floor) {
        body.y = floor;
        if (body.vy > 1.4) body.vy = -body.vy * 0.42;
        else body.vy = 0;
        body.vx *= 0.94;
        body.va *= 0.9;
      }
      if (body.x < 6) {
        body.x = 6;
        body.vx = Math.abs(body.vx) * 0.5;
      }
      if (body.x + body.w > width - 6) {
        body.x = width - body.w - 6;
        body.vx = -Math.abs(body.vx) * 0.5;
      }
    };

    const collide = () => {
      for (let i = 0; i < bodies.length; i += 1) {
        const a = bodies[i];
        if (!a.live) continue;
        for (let j = i + 1; j < bodies.length; j += 1) {
          const b = bodies[j];
          if (!b.live) continue;
          const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (overlapX <= 0 || overlapY <= 0) continue;
          if (overlapX < overlapY) {
            const sign = a.x + a.w / 2 < b.x + b.w / 2 ? -1 : 1;
            a.x += sign * overlapX * 0.5;
            b.x -= sign * overlapX * 0.5;
            a.vx *= 0.85;
            b.vx *= 0.85;
          } else {
            const sign = a.y + a.h / 2 < b.y + b.h / 2 ? -1 : 1;
            a.y += sign * overlapY * 0.5;
            b.y -= sign * overlapY * 0.5;
            if (sign < 0) {
              b.vy = Math.max(b.vy, a.vy * 0.7);
              a.vy *= 0.4;
            } else {
              a.vy = Math.max(a.vy, b.vy * 0.7);
              b.vy *= 0.4;
            }
            a.vx += (Math.random() - 0.5) * 0.2;
            b.vx += (Math.random() - 0.5) * 0.2;
          }
        }
      }
    };

    const frame = (now) => {
      if (visible && spawned < bodies.length && now >= nextSpawn) {
        const body = bodies[spawned];
        body.live = true;
        body.x = clamp(
          60 + Math.random() * Math.max(1, width - 220),
          6,
          width - body.w - 6,
        );
        body.y = -body.h - 10;
        spawned += 1;
        nextSpawn = now + 260;
      }
      if (visible) {
        for (const body of bodies) {
          if (!body.live) continue;
          body.vy += 0.34;
          body.vx *= 0.995;
          body.vy = Math.min(body.vy, 16);
          body.x += body.vx;
          body.y += body.vy;
          body.angle += body.va;
          body.va *= 0.97;
          settle(body);
        }
        collide();
        for (const body of bodies)
          if (body.live)
            body.el.style.transform = `translate3d(${body.x}px, ${body.y}px, 0) rotate(${body.angle}rad)`;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
}
