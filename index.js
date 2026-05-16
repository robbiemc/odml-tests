function init() {
  TestCase.registerCustomElement();
  checkAvailability();

  for (let section of $$('section')) {
    new TestCase(section);
  }
}

async function checkAvailability() {
  const status = await LanguageModel.availability();
  const statusElement = $('.availability');
  statusElement.innerText = status;
  statusElement.dataset.label = status;

  const available = status === 'available';
  // TODO: fix button disabling
  for (let control of $$('section button')) {
    control.disabled = !available;
  }
}

class TestCase extends HTMLElement {
  constructor() {
    super();
    const template = $('#test-case-template');
    const shadowRoot = this.attachShadow({ mode: 'open' });
    shadowRoot.appendChild(document.importNode(template.content, true));

    const sourceEl = $('slot[name=source]', shadowRoot).assignedElements()[0];
    sourceEl.innerText = unindent(sourceEl.innerText);
    this.source = sourceEl.innerText;
    this.status = $('.status', shadowRoot);
    this.results = $('.results > tbody', shadowRoot);

    for (let btn of $$('.run', shadowRoot)) {
      btn.addEventListener('click', this.run.bind(this));
    }
  }

  async run(e) {
    const count = e.target.dataset.count;
    const rowTemplate = $('#output-row-template').content.children[0];
    for (let i = 0; i < count; i++) {
      const row = document.importNode(rowTemplate, true);
      this.results.appendChild(row);

      const runner = new TestRun(this.source);
      // TODO: handle cancel and error events
      runner.addEventListener('output', (e) => {
        $('.output', row).innerText += e.detail.string;
        $('.tks', row).innerText = round(runner.tks() * 1000, 1);
        const ttft = runner.ttft();
        if (ttft > 0) {
          $('.ttft', row).innerText = round(ttft / 1000, 2);
        }
      });
      await runner.execute();
    }
  }

  static registerCustomElement() {
    customElements.define('test-case', TestCase);
  }
}

class TestRun extends EventTarget {
  constructor(source) {
    super();
    this.runFn = TestRun.#createRunner(this.#onModelOutput.bind(this), source);
    this.outputString = '';
    this.startTime = 0;
    this.firstTokenTime = 0;
    this.tokenCount = 0;
    this.endTime = 0;
  }

  async execute() {
    try {
      this.startTime = Date.now();
      await this.runFn();
      this.endTime = Date.now();
    } catch (err) {
      if (err.name === 'AbortError') {
        this.#dispatch('cancel');
      } else {
        this.#dispatch('error', { error: err });
      }
    }
  }

  output() {
    return this.outputString;
  }

  ttft() {
    if (this.firstTokenTime > 0) {
      return this.firstTokenTime - this.startTime;
    }
    return -1;
  }

  tks() {
    if (this.firstTokenTime > 0) {
      const end = this.endTime || Date.now();
      return this.tokenCount / (end - this.firstTokenTime);
    }
    return 0;
  }

  #onModelOutput(str) {
    if (this.firstTokenTime === 0) {
      this.firstTokenTime = Date.now();
    }
    this.tokenCount++;
    this.outputString += str;
    this.#dispatch('output', { string: str });
  }

  #dispatch(event, detail) {
    this.dispatchEvent(new CustomEvent(event, { detail }));
  }

  static #createRunner(logger, source) {
    return new Function(
      'log',
      'LanguageModel',
      'Translator',
      'LanguageDetector',
      'Summarizer',
      'Writer',
      'Rewriter',
      'window',
      `return (async () => { ${source} })();`,
    ).bind(
      null,
      logger,
      window.LanguageModel,
      window.Translator,
      window.LanguageDetector,
      window.Summarizer,
      window.Writer,
      window.Rewriter,
      window,
    );
  }
}

function $(selector, base = document.body) {
  return base.querySelector(selector);
}

function $$(selector, base = document.body) {
  return [...base.querySelectorAll(selector)];
}

function round(x, precision = 0) {
  const n = Math.pow(10, precision);
  return Math.round(x * n) / n;
}

function unindent(s) {
  let lines = s.split('\n');
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  if (lines.length === 0) {
    return '';
  }
  const prefix = /(\s*).*?/.exec(lines[0])[0];
  let unindented = '';
  for (let line of lines) {
    if (line.startsWith(prefix)) {
      line = line.substr(prefix.length);
    }
    unindented += line + '\n';
  }
  return unindented.trimEnd();
}

document.addEventListener('DOMContentLoaded', init);
