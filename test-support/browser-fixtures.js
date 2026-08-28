'use strict';

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

class FakeStyle {
  constructor() {
    this.properties = new Map();
  }

  setProperty(name, value) {
    this.properties.set(name, String(value));
  }

  removeProperty(name) {
    this.properties.delete(name);
  }

  getPropertyValue(name) {
    return this.properties.get(name) || '';
  }
}

class FakeNode extends FakeEventTarget {
  constructor(tagName, ownerDocument, isFragment = false) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.isFragment = isFragment;
    this.children = [];
    this.attributes = new Map();
    this.style = new FakeStyle();
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.focused = false;
    this.focusOptions = null;
    this.scrollOptions = null;
    this._textContent = '';
    this.classList = {
      toggle: (className, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        if (force) classes.add(className);
        else classes.delete(className);
        this.className = [...classes].join(' ');
      }
    };
  }

  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join('');
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  get href() {
    return this.getAttribute('href') || '';
  }

  set href(value) {
    this.setAttribute('href', value);
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.isFragment) this.children.push(...node.children);
      else this.children.push(node);
    }
    this._textContent = '';
  }

  replaceChildren(...nodes) {
    this.children = [];
    this._textContent = '';
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  matches(selector) {
    if (selector.startsWith('#')) return this.getAttribute('id') === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  focus(options = undefined) {
    this.focused = true;
    this.focusOptions = options;
  }

  scrollIntoView(options) {
    this.scrollOptions = options;
  }
}

class FakeWindow extends FakeEventTarget {
  constructor() {
    super();
    this.prefersReducedMotion = false;
  }

  matchMedia() {
    return { matches: this.prefersReducedMotion };
  }

  requestAnimationFrame(callback) {
    callback();
  }
}

class FakeDocument {
  constructor() {
    this.defaultView = new FakeWindow();
    this.root = new FakeNode('body', this);
  }

  createElement(tagName) {
    return new FakeNode(tagName, this);
  }

  createDocumentFragment() {
    return new FakeNode('fragment', this, true);
  }

  querySelector(selector) {
    return this.root.matches(selector) ? this.root : this.root.querySelector(selector);
  }
}

function makeElement(document, tagName, options = {}) {
  const element = document.createElement(tagName);
  if (options.id) element.setAttribute('id', options.id);
  if (options.className) element.className = options.className;
  if (options.hidden) element.hidden = true;
  return element;
}

function buildReport(document) {
  const report = makeElement(document, 'section', { id: 'report', hidden: true });
  const definitions = [
    ['h2', 'report-title'],
    ['a', 'analyzed-url'],
    ['p', 'fetched-at'],
    ['div', 'score-dial'],
    ['strong', 'score-value'],
    ['span', 'score-grade'],
    ['p', 'score-message'],
    ['ol', 'recommendations'],
    ['dl', 'metrics'],
    ['div', 'keywords'],
    ['p', 'checks-summary'],
    ['tbody', 'checks-body']
  ];
  definitions.forEach(([tagName, id]) => report.append(makeElement(document, tagName, { id })));
  return report;
}

function buildAppDocument() {
  const document = new FakeDocument();
  const form = makeElement(document, 'form', { id: 'analyzer-form' });
  const input = makeElement(document, 'input', { id: 'url-input' });
  const button = makeElement(document, 'button', { id: 'analyze-button' });
  button.append(makeElement(document, 'span', { className: 'button__label' }));
  const panel = makeElement(document, 'div', { id: 'analyzer-panel' });
  const status = makeElement(document, 'p', { id: 'status' });
  const error = makeElement(document, 'p', { id: 'error-message', hidden: true });
  const report = buildReport(document);
  document.root.append(form, input, button, panel, status, error, report);
  return { document, form, input, button, panel, status, error, report };
}

function reportPayload(overrides = {}) {
  return {
    ok: true,
    url: 'https://example.com/article',
    fetchedAt: '2026-08-28T10:00:00.000Z',
    report: {
      score: 88,
      grade: 'B',
      recommendations: ['Add a descriptive title.'],
      metadata: { titleLength: 22, descriptionLength: 110, lang: 'en' },
      content: {
        words: { count: 640, topKeywords: [{ term: 'search', count: 4 }] },
        headings: { counts: { h1: 1 } },
        images: { missingAlt: 2 },
        links: { internal: 5, external: 3 },
        structuredDataCount: 1
      },
      checks: [
        { label: 'Title', status: 'pass', points: 10, maxPoints: 10, detail: 'Present' },
        { label: 'Images', status: 'warn', points: 2, maxPoints: 5, detail: 'Review' }
      ],
      ...overrides
    }
  };
}

function createRendererSpy() {
  return {
    clearCalls: 0,
    focusCalls: 0,
    rendered: [],
    clear() {
      this.clearCalls += 1;
    },
    focus() {
      this.focusCalls += 1;
    },
    render(payload) {
      this.rendered.push(payload);
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function submitEvent() {
  return { preventDefault() {} };
}

module.exports = {
  FakeDocument,
  buildAppDocument,
  buildReport,
  createRendererSpy,
  deferred,
  reportPayload,
  submitEvent
};
