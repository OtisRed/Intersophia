const sessionUrl = '/panel?widok=sesja-adnotacji';
const targetSelector = [
  '[data-annotation-target]',
  '.question[data-question-id]',
  '.acc-btn[id]',
  '.acc-item[data-question-id] .acc-body',
  '.acc-static[data-question-id]',
].join(', ');

async function canAnnotate() {
  try {
    const response = await fetch(sessionUrl, { cache: 'no-store', headers: { Accept: 'application/json' } });
    return response.ok && (await response.json()).annotations === true;
  } catch {
    return false;
  }
}

function contextFor(element) {
  const question = element.closest('[data-question-id]')?.dataset.questionId;
  const panel = location.pathname === '/panel';
  const query = new URLSearchParams(location.search);
  const view = panel
    ? (document.querySelector('.member-layout') ? (query.get('widok') === 'dostep' ? 'access' : 'invites') : 'welcome')
    : (question ?? location.hash.slice(1));
  const target = element.dataset.annotationTarget
    ?? `faq:${question}:${element.matches('.acc-btn') ? 'question' : 'answer'}`;
  return { view: `${panel ? 'panel' : 'faq'}:${view || 'home'}`, target };
}

let rendererPromise;

function loadRenderer() {
  rendererPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/assets/vendor/html2canvas/html2canvas.min.js';
    script.onload = () => {
      if (typeof window.html2canvas === 'function') resolve(window.html2canvas);
      else reject(new Error('Snapshot renderer unavailable'));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('Snapshot renderer could not load'));
    };
    document.head.append(script);
  }).catch(error => {
    rendererPromise = undefined;
    throw error;
  });
  return rendererPromise;
}

async function start() {
  if (!await canAnnotate()) return;

  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = '/assets/css/annotations.css';
  document.head.append(stylesheet);

  const ui = document.createElement('div');
  ui.className = 'annotations-ui';
  ui.innerHTML = `
    <div class="annotations-toolbar" aria-label="Tryb adnotacji">
      <span class="annotations-hint" role="status" hidden>Wskaż element. Klawiaturą użyj strzałek i Enter.</span>
      <button type="button" data-add hidden>Dodaj adnotację</button>
      <button type="button" data-toggle aria-pressed="false">Adnotacje</button>
    </div>
    <div class="annotations-outline" aria-hidden="true" hidden></div>
    <dialog class="annotations-dialog" aria-labelledby="annotations-title">
      <form method="dialog">
        <h2 id="annotations-title">Nowa adnotacja</h2>
        <p data-progress role="status"></p>
        <img data-preview alt="Wycinek wybranego elementu" hidden>
        <label for="annotations-comment">Komentarz</label>
        <textarea id="annotations-comment" rows="3" maxlength="3000"></textarea>
        <div class="annotations-actions">
          <button type="button" data-retry hidden>Ponów zrzut</button>
          <button type="submit">Zamknij podgląd</button>
        </div>
      </form>
    </dialog>`;
  document.body.append(ui);

  const toggle = ui.querySelector('[data-toggle]');
  const add = ui.querySelector('[data-add]');
  const hint = ui.querySelector('.annotations-hint');
  const outline = ui.querySelector('.annotations-outline');
  const dialog = ui.querySelector('dialog');
  const preview = ui.querySelector('[data-preview]');
  const progress = ui.querySelector('[data-progress]');
  const retry = ui.querySelector('[data-retry]');
  const comment = ui.querySelector('textarea');
  let picking = false;
  let focusedElement;
  let capturedElement;
  let captureAttempt = 0;

  function highlight(element) {
    focusedElement = element;
    const rect = element?.getBoundingClientRect();
    outline.hidden = !rect || !element.isConnected || rect.width === 0 || rect.height === 0;
    if (outline.hidden) return;
    Object.assign(outline.style, {
      left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
    });
  }

  function stopPicking() {
    picking = false;
    hint.hidden = true;
    add.removeAttribute('aria-pressed');
    highlight(null);
  }

  async function snapshot() {
    const attempt = ++captureAttempt;
    const element = capturedElement;
    preview.hidden = true;
    preview.removeAttribute('src');
    retry.hidden = true;
    progress.textContent = 'Tworzę wycinek…';
    try {
      const render = await loadRenderer();
      if (!element?.isConnected) throw new Error('The selected element changed');
      const canvas = await render(element, {
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        scale: 1,
        logging: false,
        ignoreElements: node => node.matches('.annotations-ui, input, textarea, [data-annotation-private]'),
      });
      if (attempt !== captureAttempt) return;
      if (!canvas.width || !canvas.height) throw new Error('Empty snapshot');
      preview.src = canvas.toDataURL('image/png');
      preview.hidden = false;
      progress.textContent = '';
    } catch {
      if (attempt !== captureAttempt) return;
      progress.textContent = 'Nie udało się przygotować wycinka.';
      retry.hidden = !element?.isConnected;
    }
  }

  function choose(element) {
    capturedElement = element;
    const { view, target } = contextFor(element);
    dialog.dataset.annotationView = view;
    dialog.dataset.annotationTarget = target;
    stopPicking();
    comment.value = '';
    dialog.showModal();
    comment.focus();
    void snapshot();
  }

  toggle.addEventListener('click', () => {
    const active = toggle.getAttribute('aria-pressed') === 'false';
    toggle.setAttribute('aria-pressed', String(active));
    add.hidden = !active;
    if (!active) stopPicking();
  });
  add.addEventListener('click', () => {
    if (picking) {
      stopPicking();
      return;
    }
    picking = true;
    hint.hidden = false;
    add.setAttribute('aria-pressed', 'true');
  });
  retry.addEventListener('click', snapshot);
  dialog.addEventListener('close', () => {
    captureAttempt++;
    preview.removeAttribute('src');
    capturedElement = null;
    add.focus();
  });

  document.addEventListener('pointermove', event => {
    if (picking && event.target instanceof Element) {
      highlight(event.target.closest(targetSelector));
    }
  });
  window.addEventListener('click', event => {
    if (!picking || !(event.target instanceof Element) || ui.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const element = event.target.closest(targetSelector);
    if (element) choose(element);
  }, true);
  window.addEventListener('keydown', event => {
    if (!picking) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      stopPicking();
      add.focus();
      return;
    }
    if (event.key === 'Enter' && focusedElement?.isConnected) {
      event.preventDefault();
      choose(focusedElement);
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const targets = [...document.querySelectorAll(targetSelector)]
      .filter(element => element.getClientRects().length && getComputedStyle(element).visibility === 'visible'
        && !element.closest('[inert], [aria-hidden="true"]'));
    if (!targets.length) return;
    const previous = targets.indexOf(focusedElement);
    const delta = ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1;
    const next = targets[previous < 0 ? (delta < 0 ? targets.length - 1 : 0)
      : (previous + delta + targets.length) % targets.length];
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    highlight(next);
  }, true);
  window.addEventListener('scroll', () => { if (picking) highlight(focusedElement); }, true);
  window.addEventListener('resize', () => { if (picking) highlight(focusedElement); });
  window.addEventListener('hashchange', stopPicking);
}

void start();
