/*
TODO:
 * Handle exceptions gracefully
 * Disable buttons while script executing
 * Other APIs
 * Maybe add global samplingMode flag?
*/

function init() {
  TestCase.registerCustomElement();
  monitorAvailability();
}

function monitorAvailability() {
  const statusElement = $('.availability');
  const modelAvailability = new ModelAvailability();
  modelAvailability.addEventListener('availabilitychanged', (e) => {
    const availability = e.detail.availability;
    statusElement.innerText = availability;
    statusElement.dataset.label = availability;

    const available = availability === 'available';
    for (let testCase of $$('test-case')) {
      testCase.setEnabled(available);
    }
  });

  const downloadProgress = $('.download-progress');
  modelAvailability.addEventListener('downloadprogress', (e) => {
    downloadProgress.value = e.detail.percent;
  });

  $('.download').addEventListener(
    'click',
    modelAvailability.downloadModel.bind(modelAvailability),
  );
}

class ModelAvailability extends EventTarget {
  availability = 'unknown';
  #model = null;

  constructor() {
    super();
    this.#checkAvailability();
  }

  downloadModel() {
    this.#maybeStartDownload();
  }

  async #checkAvailability() {
    const newAvailability = await LanguageModel.availability();
    if (newAvailability === this.availability) {
      return;
    }
    this.availability = newAvailability;

    if (this.availability === 'downloading') {
      // Start the download to monitor its progress.
      this.#maybeStartDownload();
    }

    this.dispatchEvent(
      new CustomEvent('availabilitychanged', {
        detail: { availability: this.availability },
      }),
    );
  }

  #maybeStartDownload() {
    if (this.#model !== null) {
      return;
    }
    this.#model = LanguageModel.create({
      monitor: (monitor) => {
        monitor.addEventListener('downloadprogress', (e) => {
          const percent = round(e.loaded * 100);
          this.dispatchEvent(
            new CustomEvent('downloadprogress', {
              detail: { percent },
            }),
          );
          if (percent === 100) {
            this.#checkAvailability();
          }
        });
      }
    });
    this.#checkAvailability();
  }
}

class TestCase extends HTMLElement {
  constructor() {
    super();
    const template = $('#test-case-template');
    const shadowRoot = this.attachShadow({ mode: 'open' });
    shadowRoot.appendChild(document.importNode(template.content, true));

    if (this.attributes.nostats) {
      $('.test-case', shadowRoot).classList.add('nostats');
    }

    const sourceEl = $('slot[name=source]', shadowRoot).assignedElements()[0];
    sourceEl.innerText = unindent(sourceEl.innerText);
    this.source = sourceEl.innerText;
    this.abort = $('.abort', shadowRoot);
    this.status = $('.status', shadowRoot);
    this.inputs = $('slot[name=inputs]', shadowRoot).assignedElements();
    this.results = $('.results > tbody', shadowRoot);

    this.buttons = $$('.run', shadowRoot);
    for (let btn of this.buttons) {
      btn.addEventListener('click', this.run.bind(this));
    }
  }

  async run(e) {
    const count = e.target.dataset.count;
    const rowTemplate = $('#output-row-template').content.children[0];
    for (let i = 0; i < count; i++) {
      $('tr:last-child > .collapse', this.results)?.classList.add('collapsed');

      const row = document.importNode(rowTemplate, true);
      const collapse = $('.collapse', row);
      $('button', collapse).addEventListener('click', () => {
        collapse.classList.toggle('collapsed');
      });
      this.results.appendChild(row);
      this.results.parentElement.classList.remove('empty');

      const runner = new TestRun(this.inputs, this.source);
      // TODO: handle error events
      runner.addEventListener('output', (_) => {
        $('.output > span', row).innerText = runner.output();
        $('.tks', row).innerText = round(runner.tks() * 1000, 1);
        const ttft = runner.ttft();
        if (ttft > 0) {
          $('.ttft', row).innerText = round(ttft / 1000, 2) + 's';
        }
      });
      runner.addEventListener('hasabortcontroller', (e) => {
        this.abort.addEventListener('click', (_) => {
          e.detail.controller.abort();
          this.abort.classList.add('hidden');
        });
        this.abort.classList.remove('hidden');
      });
      await runner.execute();
    }
  }

  setEnabled(enabled) {
    for (let btn of this.buttons) {
      btn.disabled = !enabled;
    }
  }

  static registerCustomElement() {
    customElements.define('test-case', TestCase);
  }
}

class TestRun extends EventTarget {
  constructor(inputs, source) {
    super();
    this.runFn = TestRun.#createRunner(
      this.#onOutput.bind(this),
      this.#onModelOutput.bind(this),
      this.#setAbortController.bind(this),
      inputs,
      source);
    this.abortController = null;
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
    this.#onOutput(str);
  }

  #onOutput(str) {
    this.outputString += str;
    this.#dispatch('output', { string: str });
  }

  #setAbortController(abortController) {
    this.abortController = abortController;
    this.#dispatch('hasabortcontroller', {
      controller: this.abortController
    });
  }

  #dispatch(event, detail) {
    this.dispatchEvent(new CustomEvent(event, { detail }));
  }

  static #createRunner(log, logToken, setAbortController, inputs, source) {
    return new Function(
      'log',
      'logToken',
      'setAbortController',
      'inputs',
      'LanguageModel',
      'Translator',
      'LanguageDetector',
      'Summarizer',
      'Writer',
      'Rewriter',
      `return (async () => { ${source} })();`,
    ).bind(
      null,
      log,
      logToken,
      setAbortController,
      inputs,
      window.LanguageModel,
      window.Translator,
      window.LanguageDetector,
      window.Summarizer,
      window.Writer,
      window.Rewriter,
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
