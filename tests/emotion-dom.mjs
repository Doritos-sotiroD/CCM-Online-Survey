// Minimal event/element model for exercising the actual response callbacks in Node.
export function createEmotionDom() {
  const counters = [];
  const nodes = new Map();
  const document = { activeElement: null };
  class Element {
    constructor(tag = "div") {
      this.tagName = tag;
      this.ownerDocument = document;
      this.children = [];
      this.parentElement = null;
      this.attributes = {};
      this.listeners = new Map();
      this.value = "";
      this.disabled = false;
      this.hidden = false;
      this.scrollTop = 0;
      this.clientHeight = 440;
      this.offsetHeight = 44;
      this._text = "";
      this.classes = new Set();
      this.classList = {
        add: name => this.classes.add(name),
        contains: name => this.classes.has(name),
        toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name)
      };
    }
    set className(value) { this.classes = new Set(value.split(/\s+/)); }
    get className() { return [...this.classes].join(" "); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    get offsetTop() { return this.parentElement ? this.parentElement.children.indexOf(this) * 44 : 0; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    replaceChildren(...children) {
      this.children.forEach(child => { child.parentElement = null; });
      this.children = []; this._text = ""; this.append(...children);
    }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    remove() {
      if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
    }
    before(node) { counters.push({selector: this.selector, text: node.textContent, className: node.className}); }
    addEventListener(name, callback, capture = false) {
      const handlers = this.listeners.get(name) ?? [];
      handlers.push({callback, capture}); this.listeners.set(name, handlers);
    }
    removeEventListener(name, callback) {
      this.listeners.set(name, (this.listeners.get(name) ?? []).filter(handler => handler.callback !== callback));
    }
    fire(name, values = {}) {
      const event = { target: this, key: "", repeat: false, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; }, ...values };
      const path = [];
      for (let node = this; node; node = node.parentElement) path.push(node);
      const invoke = (node, capture) => {
        for (const handler of [...(node.listeners.get(name) ?? [])]) {
          if (handler.capture === capture) handler.callback(event);
        }
      };
      for (const node of [...path].reverse()) { invoke(node, true); if (event.stopped) return event; }
      for (const node of path) { invoke(node, false); if (event.stopped) break; }
      return event;
    }
    click() { if (!this.disabled) this.fire("click"); }
    focus() { document.activeElement = this; this.fire("focus"); }
    blur() { document.activeElement = null; this.fire("focusout", {relatedTarget: null}); }
    select() { this.selection = this.value; }
  }
  document.createElement = tag => new Element(tag);
  document.createTextNode = text => { const node = new Element("#text"); node.textContent = text; return node; };
  document.head = new Element("head");
  const display = new Element();
  function node(selector) {
    if (!nodes.has(selector)) {
      const element = new Element();
      element.selector = selector;
      element.id = selector.slice(1);
      nodes.set(selector, element); display.appendChild(element);
    }
    return nodes.get(selector);
  }
  display.querySelector = node;
  const input = node("#emotion-keyword-input");
  const menu = node("#emotion-suggestions");
  for (const selector of ["#emotion-options", "#emotion-no-matches"]) {
    const element = node(selector); element.remove(); menu.appendChild(element);
  }
  return { display, document, nodes, counters, node, input };
}
