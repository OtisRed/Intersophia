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
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function currentPanelView() {
  if (!document.querySelector('.member-layout')) return 'welcome';
  return new URLSearchParams(location.search).get('widok') === 'dostep' ? 'access' : 'invites';
}

function contextFor(element) {
  const question = element.closest('[data-question-id]')?.dataset.questionId;
  const panel = location.pathname === '/panel';
  const view = panel ? currentPanelView() : (question ?? location.hash.slice(1));
  const target = element.dataset.annotationTarget
    ?? `faq:${question}:${element.matches('.acc-btn') ? 'question' : 'answer'}`;
  return { view: `${panel ? 'panel' : 'faq'}:${view || 'home'}`, target };
}

function visibleTargets() {
  return [...document.querySelectorAll(targetSelector)]
    .filter(element => element.getClientRects().length && getComputedStyle(element).visibility === 'visible'
      && !element.closest('[inert], [aria-hidden="true"]'));
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
  const session = await canAnnotate();
  if (!session?.annotations || !session.csrf) return;

  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = '/assets/css/annotations.css';
  document.head.append(stylesheet);

  const ui = document.createElement('div');
  ui.className = 'annotations-ui';
  ui.innerHTML = `
    <div class="annotations-toolbar" aria-label="Tryb adnotacji">
      <span class="annotations-hint" role="status" hidden>Wskaż element. Klawiaturą użyj strzałek i Enter.</span>
      <span data-list-status role="status" hidden></span>
      <button type="button" data-list hidden>Uwagi na stronie</button>
      <button type="button" data-add hidden>Dodaj adnotację</button>
      <button type="button" data-toggle aria-pressed="false">Adnotacje</button>
    </div>
    <div class="annotations-markers" hidden></div>
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
          <button type="button" data-save disabled>Zapisz adnotację</button>
          <button type="submit">Anuluj</button>
        </div>
      </form>
    </dialog>
    <dialog class="annotations-dialog" data-library aria-labelledby="annotation-library-title">
      <h2 id="annotation-library-title">Uwagi na stronie</h2>
      <label for="annotation-filter">Pokaż</label>
      <select id="annotation-filter"><option value="wszystkie">Wszystkie</option><option value="moje">Moje</option></select>
      <p data-library-status role="status"></p>
      <ul class="annotations-list"></ul>
      <section class="annotations-detail" hidden>
        <p data-author></p>
        <p data-anchor-missing hidden>Element nie jest widoczny w tym widoku. Poniżej jest zapisany wycinek.</p>
        <p data-comment></p>
        <img data-saved-preview alt="Zapisany wycinek">
        <a data-location>Przejdź do widoku</a>
      </section>
      <form class="annotations-actions" method="dialog"><button type="submit">Zamknij</button></form>
    </dialog>`;
  document.body.append(ui);

  const toggle = ui.querySelector('[data-toggle]');
  const add = ui.querySelector('[data-add]');
  const listButton = ui.querySelector('[data-list]');
  const markers = ui.querySelector('.annotations-markers');
  const listStatus = ui.querySelector('[data-list-status]');
  const hint = ui.querySelector('.annotations-hint');
  const outline = ui.querySelector('.annotations-outline');
  const dialog = ui.querySelector('dialog');
  const preview = ui.querySelector('[data-preview]');
  const progress = ui.querySelector('[data-progress]');
  const retry = ui.querySelector('[data-retry]');
  const save = ui.querySelector('[data-save]');
  const comment = ui.querySelector('textarea');
  const library = ui.querySelector('[data-library]');
  const filter = library.querySelector('select');
  const list = library.querySelector('ul');
  const detail = library.querySelector('.annotations-detail');
  const missingAnchor = detail.querySelector('[data-anchor-missing]');
  const libraryStatus = library.querySelector('[data-library-status]');
  const api = '/panel?widok=adnotacje';
  const scope = location.pathname === '/panel' ? `panel:${currentPanelView()}` : 'faq';
  let entries = [];
  let listAttempt = 0;
  let layoutFrame;
  let draft;
  let imageBlob;
  let previewUrl;
  let saving = false;
  let picking = false;
  let focusedElement;
  let capturedElement;
  let selectedEntry;
  let captureAttempt = 0;

  function isActive() {
    return toggle.getAttribute('aria-pressed') === 'true';
  }

  function findAnchor(entry) {
    return visibleTargets().find(node => {
      const { view, target } = contextFor(node);
      return view === entry.view && target === entry.target;
    });
  }

  function dockDialog(modal, rect) {
    const verticalSpace = { top: rect.top, bottom: innerHeight - rect.bottom };
    const side = rect.left > innerWidth - rect.right ? 'left' : 'right';
    const sideSpace = side === 'left' ? rect.left : innerWidth - rect.right;
    if (sideSpace >= 330) {
      modal.dataset.dock = side;
      modal.style.setProperty('--dock-width', `${Math.min(420, sideSpace - 32)}px`);
    } else {
      const edge = verticalSpace.top > verticalSpace.bottom ? 'top' : 'bottom';
      modal.dataset.dock = edge;
      modal.style.setProperty('--dock-height', `${Math.max(168, Math.min(innerHeight - 32, verticalSpace[edge] - 32))}px`);
    }
  }

  function positionContext() {
    const modal = dialog.open ? dialog : library;
    const element = dialog.open ? capturedElement : selectedEntry && findAnchor(selectedEntry);
    const rect = element?.isConnected ? element.getBoundingClientRect() : null;
    const visible = Boolean(modal.open && rect && rect.width && rect.height
      && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth);
    modal.classList.toggle('annotations-context', visible);
    outline.classList.toggle('annotations-outline-context', visible);
    missingAnchor.hidden = !selectedEntry || visible;
    drawOutline(visible ? rect : null);
    if (visible) dockDialog(modal, rect);
    else delete modal.dataset.dock;
  }

  function showEntry(entry) {
    selectedEntry = entry;
    detail.hidden = false;
    detail.querySelector('[data-author]').textContent = entry.author;
    detail.querySelector('[data-comment]').textContent = entry.comment;
    detail.querySelector('[data-saved-preview]').src = `${api}&obraz=${entry.id}`;
    detail.querySelector('[data-location]').href = entry.path;
    const anchor = findAnchor(entry);
    const rect = anchor?.getBoundingClientRect();
    if (rect && (rect.bottom <= 0 || rect.top >= innerHeight)) {
      anchor.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    positionContext();
  }

  function openLibrary(entry) {
    selectedEntry = null;
    detail.hidden = true;
    library.showModal();
    if (entry) showEntry(entry);
  }

  function positionMarkers() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = null;
      if (!isActive() || picking) return;
      const positions = new Map(visibleTargets().map(node => {
        const { view, target } = contextFor(node);
        return [`${view}/${target}`, node.getBoundingClientRect()];
      }));
      for (const button of markers.children) {
        const rect = positions.get(button.dataset.anchor);
        button.hidden = !rect || rect.bottom <= 0 || rect.top >= innerHeight;
        if (!button.hidden) {
          button.style.left = `${Math.max(0, Math.min(innerWidth - 28, rect.right - 14))}px`;
          button.style.top = `${Math.max(0, rect.top - 10)}px`;
        }
      }
    });
  }

  function renderEntries() {
    list.replaceChildren();
    markers.replaceChildren();
    const pinned = new Map();
    entries.forEach((entry, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${index + 1}. ${entry.comment.length > 85 ? entry.comment.slice(0, 82) + '…' : entry.comment}`;
      button.addEventListener('click', () => showEntry(entry));
      item.append(button);
      list.append(item);

      const anchor = `${entry.view}/${entry.target}`;
      if (pinned.has(anchor)) return;
      pinned.set(anchor, entry);
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.hidden = true;
      pin.dataset.anchor = anchor;
      pin.textContent = String(index + 1);
      pin.setAttribute('aria-label', `Otwórz adnotację ${index + 1}`);
      pin.addEventListener('click', () => openLibrary(entry));
      markers.append(pin);
    });
    libraryStatus.textContent = entries.length ? '' : 'Brak uwag w tym widoku.';
    positionMarkers();
  }

  async function refreshEntries() {
    const attempt = ++listAttempt;
    libraryStatus.textContent = 'Wczytuję uwagi…';
    detail.hidden = true;
    selectedEntry = null;
    if (library.open) positionContext();
    const query = new URLSearchParams({ zakres: scope, filtr: filter.value });
    try {
      const response = await fetch(`${api}&${query}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load annotations');
      const result = await response.json();
      if (attempt !== listAttempt) return;
      entries = result.items;
      renderEntries();
    } catch {
      if (attempt !== listAttempt) return;
      entries = [];
      renderEntries();
      libraryStatus.textContent = 'Nie udało się wczytać uwag.';
    }
  }

  function highlight(element) {
    focusedElement = element;
    drawOutline(element?.isConnected ? element.getBoundingClientRect() : null);
  }

  function drawOutline(rect) {
    outline.hidden = !rect || rect.width === 0 || rect.height === 0;
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
    markers.hidden = !isActive();
    positionMarkers();
  }

  function clearPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    imageBlob = null;
    preview.removeAttribute('src');
    preview.hidden = true;
    save.disabled = true;
  }

  async function snapshot() {
    const attempt = ++captureAttempt;
    const element = capturedElement;
    clearPreview();
    retry.hidden = true;
    progress.textContent = 'Tworzę wycinek…';
    try {
      const render = await loadRenderer();
      if (!element?.isConnected) throw new Error('The selected element changed');
      const { width, height } = element.getBoundingClientRect();
      const canvas = await render(element, {
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        scale: Math.min(1, 2047 / width, 2047 / height, Math.sqrt(1_950_000 / (width * height))),
        logging: false,
        ignoreElements: node => node.matches('.annotations-ui, input, textarea, [data-annotation-private]'),
      });
      if (!canvas.width || !canvas.height) throw new Error('Empty snapshot');
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (attempt !== captureAttempt) return;
      if (!blob || blob.size > 512 * 1024) throw new Error('Snapshot exceeds the upload limit');
      imageBlob = blob;
      previewUrl = URL.createObjectURL(blob);
      preview.src = previewUrl;
      preview.hidden = false;
      save.disabled = false;
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
    draft = crypto.randomUUID();
    stopPicking();
    comment.value = '';
    dialog.showModal();
    comment.focus();
    positionContext();
    void snapshot();
  }

  toggle.addEventListener('click', () => {
    const active = !isActive();
    toggle.setAttribute('aria-pressed', String(active));
    add.hidden = !active;
    listButton.hidden = !active;
    markers.hidden = !active;
    if (!active) stopPicking();
    else void refreshEntries();
  });
  add.addEventListener('click', () => {
    if (picking) {
      stopPicking();
      return;
    }
    picking = true;
    markers.hidden = true;
    hint.hidden = false;
    add.setAttribute('aria-pressed', 'true');
  });
  retry.addEventListener('click', snapshot);
  listButton.addEventListener('click', () => openLibrary());
  filter.addEventListener('change', refreshEntries);
  library.addEventListener('close', () => {
    selectedEntry = null;
    detail.hidden = true;
    detail.querySelector('[data-saved-preview]').removeAttribute('src');
    positionContext();
  });
  save.addEventListener('click', async () => {
    if (saving || !imageBlob) return;
    if (!comment.value.trim()) {
      progress.textContent = 'Wpisz komentarz.';
      comment.focus();
      return;
    }
    const form = new FormData();
    form.set('csrf', session.csrf);
    form.set('view', dialog.dataset.annotationView);
    form.set('target', dialog.dataset.annotationTarget);
    form.set('draft', draft);
    form.set('comment', comment.value);
    form.set('image', imageBlob, 'wycinek.png');
    saving = true;
    save.disabled = true;
    progress.textContent = 'Zapisuję…';
    try {
      const response = await fetch(api, { method: 'POST', body: form });
      if (!response.ok) throw new Error('Could not save annotation');
      dialog.close();
      listStatus.textContent = 'Adnotacja zapisana.';
      listStatus.hidden = false;
      await refreshEntries();
    } catch {
      progress.textContent = 'Nie udało się zapisać adnotacji. Spróbuj ponownie.';
      save.disabled = false;
    } finally {
      saving = false;
    }
  });
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.querySelector('form').addEventListener('submit', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    captureAttempt++;
    clearPreview();
    capturedElement = null;
    dialog.classList.remove('annotations-context');
    delete dialog.dataset.dock;
    positionContext();
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
    const targets = visibleTargets();
    if (!targets.length) return;
    const previous = targets.indexOf(focusedElement);
    const delta = ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1;
    const next = targets[previous < 0 ? (delta < 0 ? targets.length - 1 : 0)
      : (previous + delta + targets.length) % targets.length];
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    highlight(next);
  }, true);
  function updatePositions() {
    if (dialog.open || library.open) positionContext();
    else if (picking) highlight(focusedElement);
    else positionMarkers();
  }
  window.addEventListener('scroll', updatePositions, true);
  window.addEventListener('resize', updatePositions);
  window.addEventListener('hashchange', () => {
    if (picking) stopPicking();
    updatePositions();
  });
  const main = document.querySelector('main');
  if (main) {
    new MutationObserver(updatePositions).observe(main, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-expanded'],
    });
    new ResizeObserver(updatePositions).observe(main);
  }
}

void start();
