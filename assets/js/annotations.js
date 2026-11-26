import { annotationExport } from './annotation-export.js';

const sessionUrl = '/panel?widok=sesja-adnotacji';
const targetSelector = [
  '[data-annotation-target]',
  '.question[data-question-id]',
  '.side-link[data-question-id]',
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

function currentView() {
  return location.pathname === '/panel'
    ? `panel:${currentPanelView()}`
    : `faq:${location.hash.slice(1) || 'home'}`;
}

function contextFor(element) {
  const question = element.dataset.annotationQuestion ?? element.closest('[data-question-id]')?.dataset.questionId;
  const panel = location.pathname === '/panel';
  const global = element.dataset.annotationTarget?.startsWith('page-');
  const view = panel ? currentPanelView() : (global ? 'home' : question ?? location.hash.slice(1));
  const target = element.dataset.annotationTarget
    ?? `faq:${question}:${element.matches('.acc-btn, .side-link') ? 'question' : 'answer'}`;
  return { view: `${panel ? 'panel' : 'faq'}:${view || 'home'}`, target };
}

function visibleTargets() {
  return [...document.querySelectorAll(targetSelector)]
    .filter(element => element.getClientRects().length && getComputedStyle(element).visibility === 'visible'
      && !element.closest('[inert], [aria-hidden="true"], [data-annotation-private]'));
}

function anchorKey({ view, target }) {
  return `${view}/${target}`;
}

function anchorKeys(entry) {
  if (!entry.target.startsWith('region|')) return [anchorKey(entry)];
  const parts = entry.target.slice(7).split('|');
  return parts[0].startsWith('@') ? parts.slice(1) : parts;
}

function corners(start, end) {
  return { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y),
    right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y) };
}

function intersect(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
}

function visibleRect(element) {
  let rect = intersect(element.getBoundingClientRect(), { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
  for (let parent = element.parentElement; rect && parent && parent !== document.body; parent = parent.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(parent);
    if (overflowX === 'visible' && overflowY === 'visible') continue;
    const clip = parent.getBoundingClientRect();
    rect = intersect(rect, {
      left: overflowX === 'visible' ? rect.left : clip.left,
      right: overflowX === 'visible' ? rect.right : clip.right,
      top: overflowY === 'visible' ? rect.top : clip.top,
      bottom: overflowY === 'visible' ? rect.bottom : clip.bottom,
    });
  }
  return rect;
}

function regionAnchors(rect, targets = visibleTargets().map(element => [element, visibleRect(element)])) {
  const area = (rect.right - rect.left) * (rect.bottom - rect.top);
  const candidates = targets.filter(([, bounds]) => {
    const overlap = bounds && intersect(rect, bounds);
    return overlap && overlap.width * overlap.height >= .5 * Math.min(area, bounds.width * bounds.height);
  }).map(([element]) => element);
  return [...new Set(candidates
    .filter(element => !candidates.some(child => child !== element && element.contains(child)))
    .map(element => anchorKey(contextFor(element))))];
}

function isSpace(target) {
  return target.startsWith('space|');
}

function spaceReference(name) {
  return (name === 'page' ? document.documentElement : document.querySelector(name))?.getBoundingClientRect();
}

function rectangleReference(rect) {
  const name = ['main', 'header', 'page'].find(candidate => {
    const bounds = spaceReference(candidate);
    return bounds && rect.left >= bounds.left && rect.right <= bounds.right
      && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
  }) ?? 'page';
  const bounds = spaceReference(name);
  const unit = (position, offset, size) => Math.round(Math.max(0, Math.min(1, (position - offset) / size)) * 10000);
  const coordinates = [unit(rect.left, bounds.left, bounds.width), unit(rect.top, bounds.top, bounds.height),
    unit(rect.right, bounds.left, bounds.width), unit(rect.bottom, bounds.top, bounds.height)];
  return { name, coordinates: coordinates.join(',') };
}

function overlapsPrivateArea(rect) {
  return [...document.querySelectorAll('[data-annotation-private]')].some(element => {
    const bounds = visibleRect(element);
    return bounds && intersect(rect, bounds);
  });
}

function projectRectangle(name, coordinates) {
  if (!['main', 'header', 'page'].includes(name) || !/^\d{1,5}(,\d{1,5}){3}$/.test(coordinates)) return null;
  const bounds = spaceReference(name);
  if (!bounds?.width || !bounds.height) return null;
  const [left, top, right, bottom] = coordinates.split(',').map(value => Number(value) / 10000);
  return intersect({
    left: bounds.left + left * bounds.width, top: bounds.top + top * bounds.height,
    right: bounds.left + right * bounds.width, bottom: bounds.top + bottom * bounds.height,
  }, { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
}

function projectSpace(target, targets) {
  const [, name, coordinates] = target.split('|');
  const rect = projectRectangle(name, coordinates);
  return rect && rect.width >= 6 && rect.height >= 6 && !regionAnchors(rect, targets).length
    && !overlapsPrivateArea(rect) ? rect : null;
}

function regionLayout() {
  const breakpoint = location.pathname === '/panel' ? 650 : 960;
  return matchMedia(`(max-width: ${breakpoint}px)`).matches ? 'mobile' : 'desktop';
}

function projectRegion({ view, target }) {
  if (view !== currentView() || !target.startsWith('region|@')) return null;
  const [layout, name, coordinates] = target.slice(8).split('|', 1)[0].split('/');
  return layout === regionLayout() ? projectRectangle(name, coordinates) : null;
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
    <div class="annotations-toolbar" role="group" aria-label="Tryb adnotacji">
      <span class="annotations-hint" role="status" hidden></span>
      <span data-list-status class="annotations-sr-only" role="status"></span>
      <div class="annotations-filter" data-filter-bar hidden>
        <label for="annotation-filter" class="annotations-sr-only">Zakres adnotacji</label>
        <select id="annotation-filter"><option value="wszystkie">Wszystkie</option><option value="moje">Moje</option></select>
      </div>
      <button type="button" data-list title="Lista uwag" hidden>Uwagi</button>
      <button type="button" data-add hidden>Zrób adnotację</button>
      <button type="button" data-toggle>Adnotacje</button>
    </div>
    <div class="annotations-region-input" hidden aria-hidden="true"></div>
    <div class="annotations-markers" hidden></div>
    <div class="annotations-outline" aria-hidden="true" hidden></div>
    <dialog class="annotations-dialog" aria-labelledby="annotations-title">
      <form method="dialog">
        <h2 id="annotations-title">Nowa adnotacja</h2>
        <p data-progress role="status"></p>
        <img data-preview alt="Wycinek zaznaczenia" hidden>
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
      <h2 id="annotation-library-title" tabindex="-1">Uwagi na stronie</h2>
      <button type="button" data-close-direct hidden aria-label="Zamknij podgląd rozmowy" title="Zamknij podgląd rozmowy">×</button>
      <div data-library-list>
        <p data-library-status role="status"></p>
        <ul class="annotations-list"></ul>
      </div>
      <section class="annotations-detail" hidden>
        <div data-discussion-view>
          <p data-author></p>
          <p data-anchor-missing hidden>Element nie jest widoczny w tym widoku. Poniżej jest zapisany wycinek.</p>
          <p data-comment></p>
          <img data-saved-preview alt="Zapisany wycinek">
          <a data-location>Przejdź do widoku</a>
          <section class="annotations-discussion" aria-labelledby="annotation-discussion-title">
            <h3 id="annotation-discussion-title">Dyskusja</h3>
            <p data-thread-status role="status"></p>
            <ol data-replies></ol>
            <form data-reply-form hidden>
              <label for="annotation-reply">Twoja odpowiedź</label>
              <textarea id="annotation-reply" rows="2" maxlength="3000" required></textarea>
              <div class="annotations-actions"><button type="submit">Odpowiedz</button></div>
            </form>
          </section>
        </div>
        <div class="annotations-export" data-export-fields hidden>
          <form aria-label="Zgłoszenie na GitHub">
            <label for="annotation-export-title">Tytuł zgłoszenia</label>
            <input id="annotation-export-title" name="title" maxlength="120" required>
            <label for="annotation-export-summary">Opis zgłoszenia</label>
            <textarea id="annotation-export-summary" name="summary" rows="4" maxlength="3000" required></textarea>
            <fieldset><legend>Odpowiedzi do opublikowania</legend><div data-export-choices></div></fieldset>
            <p>Do zgłoszenia dołączymy zapisany wycinek i adres widoku.</p>
            <button type="submit" data-export-retry hidden>Sprawdź ponownie</button>
          </form>
        </div>
        <div class="annotations-thread-actions" role="group" aria-label="Działania wątku">
          <button type="button" data-close-thread hidden>Zamknij dyskusję</button>
          <section class="annotations-export" data-export hidden aria-label="Publikacja na GitHubie">
            <button type="button" data-export-open hidden>Zgłoś na GitHub</button>
            <button type="button" data-export-check hidden>Sprawdź wynik na GitHubie</button>
            <a data-export-result hidden target="_blank" rel="noopener">Otwórz zgłoszenie na GitHubie</a>
            <button type="button" data-export-cancel hidden>Wróć do dyskusji</button>
            <button type="button" data-export-confirm hidden disabled>Potwierdź i opublikuj</button>
            <p data-export-status role="status"></p>
          </section>
        </div>
      </section>
      <form class="annotations-actions" method="dialog" data-library-actions>
        <button type="button" data-back-to-list hidden>Wróć do listy</button>
        <button type="submit">Zamknij</button>
      </form>
    </dialog>`;
  document.body.append(ui);

  const toggle = ui.querySelector('[data-toggle]');
  const add = ui.querySelector('[data-add]');
  const regionInput = ui.querySelector('.annotations-region-input');
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
  const libraryTitle = library.querySelector('h2');
  const libraryList = library.querySelector('[data-library-list]');
  const backToList = library.querySelector('[data-back-to-list]');
  const closeDirect = library.querySelector('[data-close-direct]');
  const libraryActions = library.querySelector('[data-library-actions]');
  const filterBar = ui.querySelector('[data-filter-bar]');
  const filter = filterBar.querySelector('select');
  const list = library.querySelector('ul');
  const detail = library.querySelector('.annotations-detail');
  const missingAnchor = detail.querySelector('[data-anchor-missing]');
  const libraryStatus = library.querySelector('[data-library-status]');
  const threadStatus = library.querySelector('[data-thread-status]');
  const replies = library.querySelector('[data-replies]');
  const replyForm = library.querySelector('[data-reply-form]');
  const replyInput = replyForm.querySelector('textarea');
  const replySubmit = replyForm.querySelector('button');
  const closeThread = library.querySelector('[data-close-thread]');
  const replyDateFormat = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'short' });
  const api = '/panel?widok=adnotacje';
  const publication = annotationExport(library, session.csrf, api, positionContext);
  const scope = location.pathname === '/panel' ? `panel:${currentPanelView()}` : 'faq';
  const closedThreads = new Set();
  let entries = [];
  let listAttempt = 0;
  let layoutFrame;
  let draft;
  let imageBlob;
  let previewUrl;
  let saving = false;
  let regionStart;
  let capturedRegion;
  let focusedElement;
  let capturedElement;
  let selectedEntry;
  let listTrigger;
  let directTrigger;
  let captureAttempt = 0;
  let threadAttempt = 0;
  let threadWriting = false;
  let replyDraft;

  function isActive() {
    return document.body.classList.contains('annotations-mode');
  }

  function findAnchors(entry) {
    const targets = new Map(visibleTargets().map(node => [anchorKey(contextFor(node)), node]));
    return anchorKeys(entry).map(key => targets.get(key)).filter(Boolean);
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

  function placeDirectThread() {
    const marker = directTrigger?.getBoundingClientRect();
    if (!marker) return;
    const width = library.getBoundingClientRect().width;
    const right = marker.right + 10;
    const left = right + width <= innerWidth - 12 ? right
      : marker.left - width >= 22 ? marker.left - width - 10 : (innerWidth - width) / 2;
    library.style.setProperty('--thread-left', `${Math.max(12, Math.min(left, innerWidth - width - 12))}px`);
    const top = Math.min(marker.top, innerHeight - library.offsetHeight - 12);
    library.style.setProperty('--thread-top', `${Math.max(12, top)}px`);
  }

  function positionContext() {
    const modal = dialog.open ? dialog : library;
    const space = !dialog.open && selectedEntry && isSpace(selectedEntry.target);
    const savedRegion = !dialog.open && selectedEntry?.target.startsWith('region|');
    const area = dialog.open ? Boolean(capturedRegion) : space || savedRegion;
    let rect;
    if (dialog.open && capturedRegion) {
      rect = intersect(viewportRegion(), { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    } else if (space) {
      rect = selectedEntry.view === currentView() && projectSpace(selectedEntry.target);
    } else if (savedRegion) {
      rect = projectRegion(selectedEntry);
    } else {
      const element = dialog.open ? capturedElement : selectedEntry && findAnchors(selectedEntry)[0];
      if (element?.isConnected) rect = visibleRect(element);
    }
    const visible = Boolean(modal.open && rect);
    const direct = modal === library && Boolean(directTrigger);
    modal.classList.toggle('annotations-context', visible);
    outline.classList.toggle('annotations-outline-context', visible && !area && !direct);
    outline.classList.toggle('annotations-outline-region', visible && Boolean(area));
    missingAnchor.hidden = !selectedEntry || visible;
    missingAnchor.textContent = space
      ? 'Tego pustego miejsca nie da się teraz wskazać. Poniżej jest oryginalny wycinek.'
      : savedRegion
        ? 'Poniżej jest oryginalny wycinek zaznaczenia.'
        : 'Element nie jest widoczny w tym widoku. Poniżej jest zapisany wycinek.';
    drawOutline(visible ? rect : null);
    if (direct) {
      detail.querySelector('[data-saved-preview]').hidden = visible;
      detail.querySelector('[data-location]').hidden = visible;
      delete modal.dataset.dock;
      placeDirectThread();
    }
    if (!visible) {
      delete modal.dataset.dock;
      return;
    }
    if (!direct) dockDialog(modal, rect);
  }

  function showEntry(entry, trigger, direct = false) {
    publication.reset();
    selectedEntry = entry;
    listTrigger = direct ? null : trigger;
    directTrigger = direct ? trigger : null;
    library.toggleAttribute('data-direct', direct);
    libraryTitle.textContent = direct ? 'Rozmowa o adnotacji' : 'Adnotacja';
    libraryTitle.classList.toggle('annotations-sr-only', direct);
    libraryList.hidden = true;
    backToList.hidden = direct || !trigger;
    closeDirect.hidden = !direct;
    libraryActions.hidden = direct;
    detail.hidden = false;
    detail.querySelector('[data-author]').textContent = entry.author;
    detail.querySelector('[data-comment]').textContent = entry.comment;
    detail.querySelector('[data-saved-preview]').src = `${api}&obraz=${entry.id}`;
    detail.querySelector('[data-location]').href = entry.path;
    detail.querySelector('[data-saved-preview]').hidden = direct;
    detail.querySelector('[data-location]').hidden = direct;
    if (!library.open) {
      if (direct) library.show();
      else library.showModal();
    }
    if (!isSpace(entry.target)) {
      const anchors = findAnchors(entry);
      if (!anchors.some(visibleRect)) anchors[0]?.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    positionContext();
    library.scrollTop = 0;
    libraryTitle.focus({ preventScroll: true });
    replyInput.value = '';
    replyDraft = null;
    void loadDiscussion(entry.id);
  }

  function threadUrl(id) {
    return `${api}&watek=${id}`;
  }

  function hideClosedThread(id) {
    closedThreads.add(id);
    if (selectedEntry?.id === id && library.open) {
      library.close();
      listButton.focus({ preventScroll: true });
      listStatus.textContent = 'Dyskusja zamknięta.';
    }
    entries = entries.filter(entry => entry.id !== id);
    renderEntries();
  }

  function renderDiscussion(thread) {
    replies.replaceChildren(...thread.replies.map(reply => {
      const row = document.createElement('li');
      const author = document.createElement('strong');
      const time = document.createElement('time');
      const text = document.createElement('p');
      const date = new Date(reply.created_at * 1000);
      author.textContent = reply.author;
      time.dateTime = date.toISOString();
      time.textContent = replyDateFormat.format(date);
      text.textContent = reply.comment;
      row.append(author, time, text);
      return row;
    }));
    threadStatus.textContent = thread.closed ? 'Dyskusja zamknięta.' : thread.has_replies ? '' : 'Brak odpowiedzi.';
    replyForm.hidden = thread.closed;
    closeThread.hidden = !thread.can_close;
    publication.show(selectedEntry, thread);
    if (directTrigger) placeDirectThread();
  }

  async function loadDiscussion(id) {
    const attempt = ++threadAttempt;
    threadStatus.textContent = 'Wczytuję dyskusję…';
    replies.replaceChildren();
    replyForm.hidden = true;
    closeThread.hidden = true;
    try {
      const response = await fetch(threadUrl(id), { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load the discussion');
      const thread = await response.json();
      if (thread.closed) hideClosedThread(id);
      else if (attempt === threadAttempt && selectedEntry?.id === id) renderDiscussion(thread);
    } catch {
      if (attempt === threadAttempt && selectedEntry?.id === id) {
        threadStatus.textContent = 'Nie udało się wczytać dyskusji. Otwórz uwagę ponownie.';
      }
    }
  }

  async function updateDiscussion(action) {
    if (threadWriting || !selectedEntry) return;
    const { id } = selectedEntry;
    const attempt = threadAttempt;
    const form = new FormData();
    form.set('csrf', session.csrf);
    form.set('action', action);
    if (action === 'reply') {
      const text = replyInput.value.trim();
      if (!text) {
        threadStatus.textContent = 'Wpisz odpowiedź.';
        replyInput.focus();
        return;
      }
      if (replyDraft?.text !== text) replyDraft = { text, id: crypto.randomUUID() };
      form.set('comment', text);
      form.set('draft', replyDraft.id);
    }
    threadWriting = true;
    replySubmit.disabled = closeThread.disabled = true;
    try {
      const response = await fetch(threadUrl(id), { method: 'POST', body: form });
      if (response.status === 409) {
        if (attempt === threadAttempt && selectedEntry?.id === id) await loadDiscussion(id);
        return;
      }
      if (!response.ok) throw new Error('Could not update the discussion');
      const thread = await response.json();
      if (thread.closed) {
        hideClosedThread(id);
        return;
      }
      if (attempt !== threadAttempt || selectedEntry?.id !== id) return;
      replyInput.value = '';
      replyDraft = null;
      renderDiscussion(thread);
    } catch {
      if (attempt === threadAttempt && selectedEntry?.id === id) {
        threadStatus.textContent = 'Nie udało się zapisać zmiany. Spróbuj ponownie.';
      }
    } finally {
      threadWriting = false;
      replySubmit.disabled = closeThread.disabled = false;
    }
  }

  function showList() {
    selectedEntry = null;
    directTrigger = null;
    threadAttempt++;
    publication.reset();
    library.removeAttribute('data-direct');
    libraryTitle.textContent = 'Uwagi na stronie';
    libraryTitle.classList.remove('annotations-sr-only');
    libraryList.hidden = false;
    backToList.hidden = true;
    closeDirect.hidden = true;
    libraryActions.hidden = false;
    detail.hidden = true;
    detail.querySelector('[data-saved-preview]').removeAttribute('src');
    positionContext();
  }

  function markerPosition(rect, width, height, occupied) {
    const gap = 4;
    const offsets = [0, -1, 1, -2, 2];
    const left = Math.max(0, Math.min(innerWidth - width, rect.right - 14));
    const top = Math.max(0, Math.min(innerHeight - height, rect.top - 10));
    for (const row of offsets) {
      for (const column of offsets) {
        const x = left + column * (width + gap);
        const y = top + row * (height + gap);
        const right = x + width;
        const bottom = y + height;
        if (x < 0 || y < 0 || right > innerWidth || bottom > innerHeight) continue;
        const overlaps = occupied.some(other =>
          x < other.right + gap && right + gap > other.x &&
          y < other.bottom + gap && bottom + gap > other.y);
        if (!overlaps) return { x, y, right, bottom };
      }
    }
    return null;
  }

  function positionMarkers() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = null;
      if (!isActive() || !regionInput.hidden) return;
      const targets = visibleTargets().map(node => [node, visibleRect(node)]);
      const positions = new Map(targets.map(([node, rect]) => [anchorKey(contextFor(node)), rect]));
      const occupied = [];
      for (const button of markers.children) {
        const entry = { view: button.dataset.view, target: button.dataset.target };
        const rect = isSpace(entry.target)
          ? entry.view === currentView() && projectSpace(entry.target, targets)
          : projectRegion(entry) || anchorKeys(entry).map(key => positions.get(key)).find(Boolean);
        button.hidden = !rect;
        if (!rect) continue;
        const position = markerPosition(rect, button.offsetWidth, button.offsetHeight, occupied);
        button.hidden = !position;
        if (!position) continue;
        occupied.push(position);
        button.style.left = `${position.x}px`;
        button.style.top = `${position.y}px`;
      }
    });
  }

  function renderEntries() {
    list.replaceChildren();
    markers.replaceChildren();
    entries.forEach((entry, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${index + 1}. ${entry.comment.length > 85 ? entry.comment.slice(0, 82) + '…' : entry.comment}`;
      button.addEventListener('click', () => showEntry(entry, button));
      item.append(button);
      list.append(item);

      const pin = document.createElement('button');
      pin.type = 'button';
      pin.hidden = true;
      pin.dataset.target = entry.target;
      pin.dataset.view = entry.view;
      pin.textContent = String(index + 1);
      const description = `${entry.author} · ${entry.comment.slice(0, 95)}`;
      pin.setAttribute('aria-label', `Otwórz adnotację ${index + 1}: ${description}`);
      pin.title = description;
      pin.addEventListener('click', () => showEntry(entry, pin, true));
      markers.append(pin);
    });
    libraryStatus.textContent = entries.length ? '' : 'Brak uwag w tym widoku.';
    positionMarkers();
  }

  async function refreshEntries() {
    const attempt = ++listAttempt;
    libraryStatus.textContent = 'Wczytuję uwagi…';
    if (!selectedEntry) showList();
    const query = new URLSearchParams({ zakres: scope, filtr: filter.value });
    try {
      const response = await fetch(`${api}&${query}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load annotations');
      const result = await response.json();
      if (attempt !== listAttempt) return;
      entries = result.items.filter(entry => !closedThreads.has(entry.id));
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
    outline.hidden = !rect || rect.right === rect.left || rect.bottom === rect.top;
    if (outline.hidden) return;
    placeOutline(outline, rect);
  }

  function placeOutline(node, rect) {
    Object.assign(node.style, {
      left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.right - rect.left}px`, height: `${rect.bottom - rect.top}px`,
    });
  }

  function stopPicking() {
    regionStart = null;
    regionInput.hidden = true;
    hint.hidden = true;
    add.textContent = 'Zrób adnotację';
    filterBar.hidden = listButton.hidden = !isActive();
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
    const region = capturedRegion;
    clearPreview();
    retry.hidden = true;
    progress.textContent = 'Tworzę wycinek…';
    try {
      const render = await loadRenderer();
      if (!region && !element?.isConnected) throw new Error('The selected element changed');
      const { width, height } = region ?? element.getBoundingClientRect();
      const canvas = await render(region ? document.documentElement : element, {
        ...(region ? { x: region.left, y: region.top, width, height } : {}),
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        scale: Math.min(1, 2047 / width, 2047 / height, Math.sqrt(1_950_000 / (width * height))),
        logging: false,
        ignoreElements: node => node.matches('.annotations-ui'),
        onclone: doc => doc.querySelectorAll('input, textarea, [data-annotation-private]').forEach(node => {
          node.style.setProperty('visibility', 'hidden', 'important');
          node.querySelectorAll('*').forEach(child => child.style.setProperty('visibility', 'hidden', 'important'));
        }),
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
      retry.hidden = !region && !element?.isConnected;
    }
  }

  function choose(element) {
    capturedElement = element;
    capturedRegion = null;
    openDraft(contextFor(element));
  }

  function viewportRegion() {
    return { left: capturedRegion.left - scrollX, top: capturedRegion.top - scrollY,
      right: capturedRegion.left + capturedRegion.width - scrollX,
      bottom: capturedRegion.top + capturedRegion.height - scrollY };
  }

  function openDraft({ view, target }) {
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
    if (!active && directTrigger) library.close();
    document.body.classList.toggle('annotations-mode', active);
    toggle.textContent = active ? 'Wyjdź' : 'Adnotacje';
    add.hidden = !active;
    stopPicking();
    if (active) void refreshEntries();
  });
  add.addEventListener('click', () => {
    if (!regionInput.hidden) return stopPicking();
    if (directTrigger) library.close();
    regionInput.hidden = false;
    markers.hidden = filterBar.hidden = listButton.hidden = true;
    add.textContent = 'Wróć do odczytu';
    hint.textContent = 'Przeciągnij, aby zaznaczyć obszar, lub kliknij element. Esc anuluje.';
    hint.hidden = false;
  });
  regionInput.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    regionInput.setPointerCapture(event.pointerId);
    highlight(null);
    regionStart = { x: event.clientX, y: event.clientY };
  });
  regionInput.addEventListener('pointermove', event => {
    if (event.isPrimary && regionStart) drawOutline(corners(regionStart, { x: event.clientX, y: event.clientY }));
  });
  regionInput.addEventListener('pointercancel', () => {
    regionStart = null;
    drawOutline(null);
  });
  regionInput.addEventListener('pointerup', event => {
    if (!event.isPrimary || !regionStart) return;
    const end = { x: event.clientX, y: event.clientY };
    const selection = corners(regionStart, end);
    regionStart = null;
    drawOutline(null);
    if (selection.right - selection.left < 5 && selection.bottom - selection.top < 5) {
      const hit = document.elementsFromPoint(end.x, end.y).find(node => !ui.contains(node));
      const target = !hit?.closest('[data-annotation-private]') && hit?.closest(targetSelector);
      if (target) choose(target);
      return;
    }
    const rect = intersect(selection, { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    if (!rect || rect.width < 12 || rect.height < 12) return;
    const keys = regionAnchors(rect);
    if (keys.length > 24) {
      hint.textContent = 'Zaznacz mniejszy obszar.';
      return;
    }
    if (!keys.length && overlapsPrivateArea(rect)) {
      hint.textContent = 'Wskaż puste miejsce poza obszarem danych prywatnych.';
      return;
    }
    capturedElement = null;
    capturedRegion = { left: rect.left + scrollX, top: rect.top + scrollY, width: rect.width, height: rect.height };
    const { name, coordinates } = rectangleReference(rect);
    const target = keys.length ? `region|@${regionLayout()}/${name}/${coordinates}|${keys.join('|')}`
      : `space|${name}|${coordinates}`;
    openDraft({ view: currentView(), target });
  });
  retry.addEventListener('click', snapshot);
  listButton.addEventListener('click', () => {
    if (library.open) library.close();
    showList();
    listTrigger = null;
    library.showModal();
  });
  backToList.addEventListener('click', () => {
    showList();
    if (listTrigger?.isConnected) listTrigger.focus();
    else libraryTitle.focus({ preventScroll: true });
    listTrigger = null;
  });
  closeDirect.addEventListener('click', () => library.close());
  filter.addEventListener('change', refreshEntries);
  replyForm.addEventListener('submit', event => {
    event.preventDefault();
    void updateDiscussion('reply');
  });
  closeThread.addEventListener('click', () => updateDiscussion('close'));
  library.addEventListener('close', () => {
    if (library.open) return;
    const previousMarker = directTrigger;
    showList();
    listTrigger = null;
    if (isActive() && regionInput.hidden && previousMarker?.isConnected
      && (document.activeElement === document.body || library.contains(document.activeElement))) {
      previousMarker.focus({ preventScroll: true });
    }
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
    capturedRegion = null;
    dialog.classList.remove('annotations-context');
    delete dialog.dataset.dock;
    positionContext();
    add.focus();
  });

  function isPageEvent(event) {
    return isActive() && event.target instanceof Element && !ui.contains(event.target);
  }

  function blockPageAction(event) {
    if (!isPageEvent(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  for (const eventType of ['auxclick', 'dblclick', 'submit', 'beforeinput', 'contextmenu', 'dragstart']) {
    window.addEventListener(eventType, blockPageAction, true);
  }
  window.addEventListener('focusin', event => {
    if (!isPageEvent(event)) return;
    event.stopImmediatePropagation();
    toggle.focus({ preventScroll: true });
  }, true);
  // The FAQ listens for keyboard shortcuts on the document.
  ui.addEventListener('keydown', event => {
    event.stopPropagation();
  });
  window.addEventListener('click', event => {
    if (isPageEvent(event) && directTrigger) library.close();
    blockPageAction(event);
  }, true);
  window.addEventListener('keydown', event => {
    if (!isActive()) return;
    if (event.key === 'Escape' && directTrigger) {
      event.preventDefault();
      library.close();
      return;
    }
    if (isPageEvent(event)) {
      event.stopImmediatePropagation();
      if (event.key === 'Enter' || event.key === ' ') event.preventDefault();
    }
    if (event.key === 'Tab' && !dialog.open && !library.open) {
      const controls = [...ui.querySelectorAll('.annotations-toolbar :is(button, select), .annotations-markers button')]
        .filter(button => button.getClientRects().length);
      const current = controls.indexOf(document.activeElement);
      const delta = event.shiftKey ? -1 : 1;
      const start = current < 0 ? (event.shiftKey ? 0 : -1) : current;
      event.preventDefault();
      controls[(start + delta + controls.length) % controls.length]?.focus({ preventScroll: true });
      return;
    }
    if (regionInput.hidden) return;
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
    else if (!regionInput.hidden && !regionStart) highlight(focusedElement);
    else positionMarkers();
  }
  window.addEventListener('scroll', updatePositions, true);
  window.addEventListener('resize', updatePositions);
  window.addEventListener('hashchange', () => {
    if (!regionInput.hidden) stopPicking();
    positionMarkers();
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
