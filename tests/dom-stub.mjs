// Minimal DOM doubles for component tests that need shadow roots, a little
// markup parsing and selector lookup. Not a browser DOM: only the operations
// the connect panel and collaboration wheel actually call are implemented.

const VOID_TAGS = new Set(["input", "br", "hr", "img", "meta", "link"]);

function parseAttributes(source) {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu;
  for (const match of source.matchAll(re))
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  return attrs;
}

function matchesSimple(node, selector) {
  let rest = selector.trim();
  if (rest.includes(":not([disabled])")) {
    if (node.attrs.has("disabled")) return false;
    rest = rest.replaceAll(":not([disabled])", "");
  }
  const tag = rest.match(/^[a-zA-Z][\w-]*/u)?.[0];
  if (tag) {
    if (node.tagName !== tag.toUpperCase()) return false;
    rest = rest.slice(tag.length);
  }
  const token = /([.#])([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]/gu;
  for (const match of rest.matchAll(token)) {
    if (match[1] === ".") {
      if (!node.className.split(/\s+/u).includes(match[2])) return false;
    } else if (match[1] === "#") {
      if (node.attrs.get("id") !== match[2]) return false;
    } else {
      if (!node.attrs.has(match[3])) return false;
      const value = match[4] ?? match[5];
      if (value !== undefined && node.attrs.get(match[3]) !== value)
        return false;
    }
  }
  return true;
}

function parseHtml(html, doc) {
  const root = doc.createElement("root");
  const stack = [root];
  let i = 0;
  while (i < html.length) {
    if (html[i] !== "<") {
      let end = html.indexOf("<", i);
      if (end === -1) end = html.length;
      const text = html.slice(i, end);
      if (text.trim()) stack.at(-1).append(doc.createTextNode(text));
      i = end;
      continue;
    }
    if (html.startsWith("<!--", i)) {
      i = html.indexOf("-->", i + 4) + 3;
      continue;
    }
    const closing = html[i + 1] === "/";
    const bodyStart = closing ? i + 2 : i + 1;
    let end = bodyStart;
    while (end < html.length && html[end] !== ">") end += 1;
    const body = html.slice(bodyStart, end).trim();
    i = end + 1;
    const tag = body.match(/^[a-zA-Z][\w-]*/u)?.[0]?.toLowerCase();
    if (!tag) continue;
    if (closing) {
      for (let level = stack.length - 1; level > 0; level -= 1) {
        if (stack[level].tagName === tag.toUpperCase()) {
          stack.length = level;
          break;
        }
      }
      continue;
    }
    const attrs = parseAttributes(body.slice(tag.length));
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs))
      node.setAttribute(name, value);
    stack.at(-1).append(node);
    if (!VOID_TAGS.has(tag)) stack.push(node);
  }
  return root;
}

function createNode(tag, doc) {
  const node = {
    tagName: String(tag).toUpperCase(),
    ownerDocument: doc,
    nodeType: tag === "#text" ? 3 : 1,
    children: [],
    parentNode: null,
    attrs: new Map(),
    style: {},
    dataset: {},
    _text: "",
    _listeners: new Map(),
    get className() {
      return this.attrs.get("class") ?? "";
    },
    set className(value) {
      this.attrs.set("class", String(value));
    },
    get id() {
      return this.attrs.get("id") ?? "";
    },
    set id(value) {
      this.attrs.set("id", String(value));
    },
    get hidden() {
      return this.attrs.has("hidden");
    },
    set hidden(value) {
      if (value) this.attrs.set("hidden", "");
      else this.attrs.delete("hidden");
    },
    get title() {
      return this.attrs.get("title") ?? "";
    },
    set title(value) {
      this.attrs.set("title", String(value));
    },
    get textContent() {
      return this.nodeType === 3
        ? this._text
        : this._text + this.children.map((child) => child.textContent).join("");
    },
    set textContent(value) {
      this._text = String(value ?? "");
      this.children = [];
    },
    set innerHTML(html) {
      this._text = "";
      this.children = [];
      for (const child of [...parseHtml(html, doc).children])
        this.append(child);
    },
    setAttribute(name, value) {
      this.attrs.set(String(name), String(value));
      if (String(name).startsWith("data-")) {
        const key = String(name)
          .slice(5)
          .replaceAll(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
        this.dataset[key] = String(value);
      }
    },
    getAttribute(name) {
      return this.attrs.has(name) ? this.attrs.get(name) : null;
    },
    removeAttribute(name) {
      this.attrs.delete(name);
      if (String(name).startsWith("data-")) {
        const key = String(name)
          .slice(5)
          .replaceAll(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
        delete this.dataset[key];
      }
    },
    hasAttribute(name) {
      return this.attrs.has(name);
    },
    append(...nodes) {
      for (const child of nodes) {
        const node =
          typeof child === "string" || typeof child === "number"
            ? doc.createTextNode(String(child))
            : child;
        node.parentNode = this;
        this.children.push(node);
      }
    },
    replaceChildren(...nodes) {
      this._text = "";
      this.children = [];
      this.append(...nodes);
    },
    remove() {
      const siblings = this.parentNode?.children;
      const index = siblings?.indexOf(this) ?? -1;
      if (index !== -1) siblings.splice(index, 1);
      this.parentNode = null;
    },
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      this._listeners.get(type)?.delete(fn);
    },
    dispatch(type, event = {}) {
      const detail = {
        type,
        preventDefault() {},
        stopPropagation() {},
        ...event,
      };
      for (const fn of [...(this._listeners.get(type) ?? [])]) fn(detail);
    },
    focus() {
      doc.activeElement = this;
    },
    attachShadow() {
      const shadow = createNode("shadowroot", doc);
      this.shadowRoot = shadow;
      return shadow;
    },
    get classList() {
      const names = () =>
        new Set((this.attrs.get("class") ?? "").split(/\s+/u).filter(Boolean));
      return {
        add: (...values) => {
          const set = names();
          for (const value of values) set.add(value);
          this.attrs.set("class", [...set].join(" "));
        },
        remove: (...values) => {
          const set = names();
          for (const value of values) set.delete(value);
          this.attrs.set("class", [...set].join(" "));
        },
        contains: (value) => names().has(value),
      };
    },
    querySelectorAll(selector) {
      const parts = selector.trim().split(/\s+/u).filter(Boolean);
      const all = [];
      const walk = (parent) => {
        for (const child of parent.children) {
          if (child.nodeType !== 1) continue;
          all.push(child);
          walk(child);
        }
      };
      walk(this);
      if (parts.length === 1)
        return all.filter((node) => matchesSimple(node, parts[0]));
      return all.filter((node) => {
        if (!matchesSimple(node, parts.at(-1))) return false;
        const ancestors = [];
        for (
          let parent = node.parentNode;
          parent && parent !== this;
          parent = parent.parentNode
        )
          if (parent.nodeType === 1) ancestors.unshift(parent);
        let matched = 0;
        for (const ancestor of ancestors)
          if (
            matched < parts.length - 1 &&
            matchesSimple(ancestor, parts[matched])
          )
            matched += 1;
        return matched === parts.length - 1;
      });
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
    closest(selector) {
      for (let current = this; current; current = current.parentNode)
        if (current.nodeType === 1 && matchesSimple(current, selector))
          return current;
      return null;
    },
  };
  return node;
}

export function createStubDom({ coarsePointer = false, matchMedia } = {}) {
  const doc = { body: null, activeElement: null };
  doc.createElement = (tag) => createNode(tag, doc);
  doc.createTextNode = (text) => {
    const node = createNode("#text", doc);
    node._text = String(text);
    return node;
  };
  doc.body = doc.createElement("body");
  const win = {
    document: doc,
    navigator: {},
    matchMedia:
      matchMedia ??
      ((query) => ({
        media: query,
        matches: query === "(pointer: coarse)" ? coarsePointer : false,
        addEventListener() {},
        removeEventListener() {},
      })),
  };
  doc.defaultView = win;
  return { doc, win };
}
