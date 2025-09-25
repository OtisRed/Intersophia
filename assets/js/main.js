// ===== FAQ APP (responsive desktop/mobile rendering) =====

const layoutQuery = window.matchMedia('(max-width: 960px)');
const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

let FAQ = [];
let flatQuestions = [];
let activeDesktopId = null;
let sidebarBound = false;
let accordionBound = false;

const AUTO_SCROLL = true;
const DEBUG = false;
const STICKY_CLASS = 'is-sticky';

let stickyRefreshScheduled = false;

async function loadFAQ() {
  const res = await fetch('assets/faq-data.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('FAQ musi być tablicą sekcji');
  return data;
}

function prefersReducedMotion() {
  return reduceMotionQuery && typeof reduceMotionQuery.matches === 'boolean'
    ? reduceMotionQuery.matches
    : false;
}

function isMobileLayout() {
  return layoutQuery && typeof layoutQuery.matches === 'boolean'
    ? layoutQuery.matches
    : window.innerWidth <= 960;
}

function observeMedia(query, handler) {
  if (!query || typeof handler !== 'function') return;
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', handler);
  } else if (typeof query.addListener === 'function') {
    query.addListener(handler);
  }
}

function extractHashId() {
  if (!window.location.hash) return null;
  let hash = window.location.hash.slice(1);
  if (!hash) return null;
  try {
    hash = decodeURIComponent(hash);
  } catch (error) {
    if (DEBUG) console.warn('Nie udało się zdekodować hash:', error);
  }
  return hash.trim() || null;
}

function resolveQuestionId(candidate) {
  if (!candidate || !flatQuestions.length) return null;
  if (flatQuestions.some((item) => item.id === candidate)) return candidate;

  if (candidate.startsWith('q-')) {
    const trimmed = candidate.slice(2);
    if (flatQuestions.some((item) => item.id === trimmed)) return trimmed;
  } else {
    const prefixed = `q-${candidate}`;
    if (flatQuestions.some((item) => item.id === prefixed)) return prefixed;
  }

  return null;
}

function setHashQuestionId(id) {
  if (!id) return;
  const encoded = encodeURIComponent(id);
  const current = window.location.hash.replace(/^#/, '');
  if (current === encoded) return;

  if (typeof history.replaceState === 'function') {
    history.replaceState(null, '', `#${encoded}`);
  } else {
    window.location.hash = `#${encoded}`;
  }
}

function syncMobileAccordion(id, { scroll = false, focus = false } = {}) {
  if (!id) return;
  const accordion = document.getElementById('mobileAccordion');
  if (!accordion) return;

  const selectorId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id;
  const targetItem = accordion.querySelector(`.acc-item[data-question-id="${selectorId}"]`);
  if (!targetItem) return;

  const targetPanel = targetItem.querySelector('.acc-panel');
  if (!targetPanel) return;

  accordion.querySelectorAll('.acc-panel.open').forEach((panel) => {
    if (panel !== targetPanel) collapsePanel(panel);
  });

  if (!targetPanel.classList.contains('open')) {
    expandPanel(targetPanel, { scroll });
  } else if (scroll) {
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    const trigger = targetItem.querySelector('.acc-btn');
    const targetNode = trigger || targetPanel;
    scrollAccordionTriggerIntoView(targetNode, behavior);
    if (trigger) {
      requestAnimationFrame(() => {
        if (isMobileLayout()) {
          enableAccordionButtonSticky(trigger);
          scheduleStickyRefresh();
          ensurePanelBelowSticky(targetPanel, trigger);
        } else {
          disableAccordionButtonSticky(trigger);
        }
      });
    }
  }

  if (focus) {
    const button = targetItem.querySelector('.acc-btn');
    if (button && typeof button.focus === 'function') {
      button.focus({ preventScroll: true });
    }
  }
}

function getMobileScrollOffset() {
  if (!isMobileLayout()) return 0;

  const socials = document.querySelector('.socials-mobile');
  const header = document.querySelector('header');
  let safeTop = 0;

  if (header) {
    const headerRect = header.getBoundingClientRect();
    if (headerRect.bottom > safeTop) {
      safeTop = headerRect.bottom;
    }
  }

  if (socials) {
    const socialRect = socials.getBoundingClientRect();
    const styles = window.getComputedStyle(socials);
    const marginBottom = parseFloat(styles.marginBottom || '0');
    const marginTop = parseFloat(styles.marginTop || '0');
    const socialBottom = socialRect.bottom + marginBottom;

    if (socialRect.top <= 0) {
      // Sticky state: reserve height plus any top margin; ignore bottom margin so elements can meet.
      const stickyHeight = socialRect.height + marginTop;
      safeTop = Math.max(safeTop, stickyHeight);
    } else {
      safeTop = Math.max(safeTop, socialBottom);
    }
  }

  return Math.max(safeTop, 0);
}

function ensureElementBelowSocials(element) {
  if (!element || !isMobileLayout()) return true;

  const safeTop = getMobileScrollOffset();
  const rect = element.getBoundingClientRect();
  const delta = rect.top - safeTop;

  if (Math.abs(delta) <= 1) return true;

  const target = Math.max(0, window.scrollY + rect.top - safeTop);
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const clampedTarget = Math.min(target, maxScroll);

  window.scrollTo({ top: clampedTarget, behavior: 'auto' });
  return false;
}

function ensurePanelBelowSticky(panel, button, attempt = 0) {
  if (!panel || !button || !isMobileLayout()) return true;

  const content = panel.querySelector('.acc-body') || panel;
  if (!content) return true;

  const buttonRect = button.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  const desiredTop = buttonRect.bottom + 8;

  if (contentRect.top < desiredTop - 1) {
    const target = Math.max(0, window.scrollY + contentRect.top - desiredTop);
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const clampedTarget = Math.min(target, maxScroll);
    window.scrollTo({ top: clampedTarget, behavior: 'auto' });
  }

  if (attempt < 12) {
    const delay = attempt < 6 ? 16 : 80;
    setTimeout(() => ensurePanelBelowSticky(panel, button, attempt + 1), delay);
  }

  return true;
}

function enableAccordionButtonSticky(button) {
  if (!button) return;
  if (!isMobileLayout()) {
    disableAccordionButtonSticky(button);
    return;
  }

  const offset = getMobileScrollOffset();
  button.classList.add(STICKY_CLASS);
  button.style.setProperty('--accordion-sticky-top', `${offset}px`);
}

function disableAccordionButtonSticky(button) {
  if (!button) return;
  button.classList.remove(STICKY_CLASS);
  button.style.removeProperty('--accordion-sticky-top');
}

function refreshStickyButtons() {
  const buttons = document.querySelectorAll(`.acc-btn.${STICKY_CLASS}`);
  if (!buttons.length) return;

  if (!isMobileLayout()) {
    buttons.forEach((btn) => disableAccordionButtonSticky(btn));
    return;
  }

  const offset = getMobileScrollOffset();
  buttons.forEach((btn) => {
    btn.style.setProperty('--accordion-sticky-top', `${offset}px`);
  });
}

function scheduleStickyRefresh() {
  if (stickyRefreshScheduled) return;
  stickyRefreshScheduled = true;
  requestAnimationFrame(() => {
    stickyRefreshScheduled = false;
    refreshStickyButtons();
  });
}

function scrollAccordionTriggerIntoView(element, behavior) {
  if (!element) return;

  if (!isMobileLayout()) {
    element.scrollIntoView({ behavior, block: 'start', inline: 'nearest' });
    return;
  }

  const offset = getMobileScrollOffset();
  const rect = element.getBoundingClientRect();
  const target = Math.max(0, window.scrollY + rect.top - offset);
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const clampedTarget = Math.min(target, maxScroll);

  window.scrollTo({ top: clampedTarget, behavior });

  if (behavior === 'smooth') {
    let attempts = 0;
    const adjust = () => {
      attempts += 1;
      const aligned = ensureElementBelowSocials(element);
      if (!aligned && attempts < 6) {
        requestAnimationFrame(adjust);
      }
    };
    requestAnimationFrame(adjust);
  } else {
    ensureElementBelowSocials(element);
  }
}

function applyActiveQuestion(id, { syncHash = true, scrollMobile = false } = {}) {
  if (!id) return;
  activeDesktopId = id;
  renderDesktopQuestion(id);
  updateSidebarActive(id);
  if (syncHash) setHashQuestionId(id);
  syncMobileAccordion(id, { scroll: scrollMobile, focus: false });
}

function smoothScrollTo(target, top = 0) {
  if (!target) return;
  const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
  if (typeof target.scrollTo === 'function') {
    target.scrollTo({ top, behavior });
  } else {
    target.scrollTop = top;
  }
}

function scrollQuestionToTop() {
  const viewer = document.getElementById('contentInner');
  if (!viewer) return;
  smoothScrollTo(viewer, 0);
}

function renderDesktopQuestion(id) {
  const viewer = document.getElementById('contentInner');
  if (!viewer) return;
  const item = flatQuestions.find((entry) => entry.id === id);
  if (!item) return;

  viewer.setAttribute('tabindex', '0');
  viewer.innerHTML = `
    <article class="question" data-question-id="${item.id}">
      <header class="question-header">
        <p class="question-section">${item.section}</p>
        <h2>${item.question}</h2>
      </header>
      <div class="answer">${item.answer}</div>
    </article>
  `;

  smoothScrollTo(viewer, 0);
}

function updateSidebarActive(id) {
  document.querySelectorAll('#sidebar .side-link').forEach((button) => {
    const isActive = button.dataset.questionId === id;
    button.classList.toggle('active', isActive);
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-current', isActive ? 'true' : 'false');
  });
}

function handleSidebarClick(event) {
  const button = event.target.closest('.side-link');
  if (!button) return;
  const id = button.dataset.questionId;
  if (!id) return;

  if (id === activeDesktopId) {
    scrollQuestionToTop();
    return;
  }

  applyActiveQuestion(id, { syncHash: true, scrollMobile: false });
}

function ensureSidebarStructure(sidebar) {
  if (!sidebar) return { container: null };
  let container = sidebar.querySelector('.sidebar-content');
  if (!container) {
    sidebar.innerHTML = '';
    container = document.createElement('div');
    container.className = 'sidebar-content';
    sidebar.appendChild(container);

    const footer = document.createElement('footer');
    footer.className = 'sidebar-footer';
    footer.innerHTML = `
      <small>© 2025 Intersophia</small>
    `;
    sidebar.appendChild(footer);
  } else {
    container.innerHTML = '';
  }

  return { container };
}

function renderDesktop() {
  const viewer = document.getElementById('contentInner');
  const sidebar = document.getElementById('sidebar');
  if (!viewer || !sidebar) return;

  const { container } = ensureSidebarStructure(sidebar);
  if (!container) return;

  flatQuestions = [];
  const fragment = document.createDocumentFragment();

  FAQ.forEach((section) => {
    if (!section || !Array.isArray(section.items) || !section.items.length) return;

    const sectionEl = document.createElement('section');
    sectionEl.className = 'side-section';

    const title = document.createElement('h2');
    title.className = 'side-title';
    title.textContent = section.section;
    sectionEl.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'side-list';

    section.items.forEach((item) => {
      if (!item || !item.id) return;

      flatQuestions.push({
        id: item.id,
        question: item.q,
        answer: item.a,
        section: section.section,
      });

      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'side-link';
      button.dataset.questionId = item.id;
      button.setAttribute('aria-controls', 'contentInner');
      button.innerHTML = `<span>${item.q}</span>`;
      li.appendChild(button);
      list.appendChild(li);
    });

    sectionEl.appendChild(list);
    fragment.appendChild(sectionEl);
  });

  container.appendChild(fragment);

  if (!flatQuestions.length) {
    viewer.innerHTML = '<p class="question-empty">Brak pytań do wyświetlenia.</p>';
    return;
  }

  const hashCandidate = resolveQuestionId(extractHashId());
  if (hashCandidate) {
    activeDesktopId = hashCandidate;
  }

  if (!activeDesktopId || !flatQuestions.some((item) => item.id === activeDesktopId)) {
    activeDesktopId = flatQuestions[0].id;
  }

  renderDesktopQuestion(activeDesktopId);
  updateSidebarActive(activeDesktopId);
  setHashQuestionId(activeDesktopId);

  if (!sidebarBound) {
    sidebar.addEventListener('click', handleSidebarClick);
    sidebarBound = true;
  }

}

function adjustPanelHeight(panel) {
  panel.style.maxHeight = panel.scrollHeight + 'px';

  if (isMobileLayout() && panel.classList.contains('open')) {
    const button = panel.previousElementSibling;
    if (button) {
      requestAnimationFrame(() => ensurePanelBelowSticky(panel, button));
    }
  }
}

function collapsePanel(panel) {
  const button = panel.previousElementSibling;
  panel.style.maxHeight = '0px';
  panel.style.opacity = '0';
  panel.classList.remove('open');
  if (button) {
    disableAccordionButtonSticky(button);
    button.classList.remove('is-active');
    button.setAttribute('aria-expanded', 'false');
    const chev = button.querySelector('.chev');
    if (chev) chev.style.transform = 'rotate(0deg)';
  }
}

function expandPanel(panel, { scroll = AUTO_SCROLL } = {}) {
  const button = panel.previousElementSibling;
  panel.classList.add('open');
  panel.style.opacity = '1';
  adjustPanelHeight(panel);
  if (button) {
    button.classList.add('is-active');
    button.setAttribute('aria-expanded', 'true');
    const chev = button.querySelector('.chev');
    if (chev) chev.style.transform = 'rotate(180deg)';
  }

  panel.querySelectorAll('img').forEach((img) => {
    if (img.complete) return;
    img.addEventListener(
      'load',
      () => {
        adjustPanelHeight(panel);
        if (isMobileLayout() && button) ensurePanelBelowSticky(panel, button);
      },
      { once: true }
    );
  });

  const updateSticky = () => {
    if (!button) return;
    if (isMobileLayout()) {
      enableAccordionButtonSticky(button);
      scheduleStickyRefresh();
      requestAnimationFrame(() => ensurePanelBelowSticky(panel, button));
    } else {
      disableAccordionButtonSticky(button);
    }
  };

  if (scroll) {
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    const target = button || panel;
    const performScroll = () => {
      if (isMobileLayout()) {
        scrollAccordionTriggerIntoView(target, behavior);
        requestAnimationFrame(updateSticky);
        requestAnimationFrame(() => ensurePanelBelowSticky(panel, button));
        return;
      }

      panel.scrollIntoView({ behavior, block: 'start', inline: 'nearest' });
      updateSticky();
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(performScroll);
    });
  } else {
    updateSticky();
    if (isMobileLayout()) {
      requestAnimationFrame(() => ensurePanelBelowSticky(panel, button));
    }
  }
}

function handleAccordionClick(event) {
  const button = event.target.closest('.acc-btn');
  if (!button) return;

  const item = button.closest('.acc-item');
  const accordion = button.closest('.accordion');
  if (!item || !accordion) return;

  const panel = item.querySelector('.acc-panel');
  if (!panel) return;

  const isOpen = panel.classList.contains('open');
  const id = item.dataset.questionId;

  accordion.querySelectorAll('.acc-panel.open').forEach((openPanel) => {
    if (openPanel !== panel) collapsePanel(openPanel);
  });

  if (isOpen) {
    collapsePanel(panel);
  } else {
    expandPanel(panel);
    if (id) {
      applyActiveQuestion(id, { syncHash: true, scrollMobile: false });
    }
  }
}

function renderMobile() {
  const accordion = document.getElementById('mobileAccordion');
  if (!accordion) return;

  accordion.innerHTML = '';

  FAQ.forEach((section) => {
    if (!section || !Array.isArray(section.items) || !section.items.length) return;

    const heading = document.createElement('div');
    heading.className = 'side-title';
    heading.textContent = section.section;
    heading.style.margin = '12px 16px 10px';
    accordion.appendChild(heading);

    section.items.forEach((item) => {
      if (!item || !item.id) return;

      const wrap = document.createElement('div');
      wrap.className = 'acc-item';
      wrap.dataset.questionId = item.id;
      wrap.innerHTML = `
        <button id="q-${item.id}" class="acc-btn" aria-expanded="false" aria-controls="p-${item.id}">
          <span>${item.q}</span>
          <span class="chev" aria-hidden="true">▾</span>
        </button>
        <div class="acc-panel" id="p-${item.id}" role="region" aria-labelledby="q-${item.id}">
          <div class="acc-body">${item.a}</div>
        </div>
      `;
      accordion.appendChild(wrap);
    });
  });

  if (!accordionBound) {
    accordion.addEventListener('click', handleAccordionClick);
    accordionBound = true;
  }

  if (activeDesktopId) {
    syncMobileAccordion(activeDesktopId, { scroll: false, focus: false });
  }
}

function refreshOpenPanels() {
  document.querySelectorAll('.acc-panel.open').forEach((panel) => adjustPanelHeight(panel));
}

function handleHashChange() {
  const candidate = resolveQuestionId(extractHashId());
  if (!candidate) return;
  if (!flatQuestions.some((item) => item.id === candidate)) return;

  if (candidate === activeDesktopId) {
    syncMobileAccordion(candidate, { scroll: isMobileLayout(), focus: false });
    return;
  }

  activeDesktopId = candidate;
  renderDesktopQuestion(candidate);
  updateSidebarActive(candidate);
  syncMobileAccordion(candidate, { scroll: isMobileLayout(), focus: false });
}

function runTests() {
  try {
    const totalItems = FAQ.reduce((sum, section) => sum + ((section.items && section.items.length) || 0), 0);
    console.info('[TEST] FAQ items count:', totalItems);
    console.assert(flatQuestions.length === totalItems, 'Desktop flattened list should match FAQ size');

    const sidebarCount = document.querySelectorAll('#sidebar .side-link').length;
    console.assert(sidebarCount === totalItems, 'Sidebar link count should match FAQ size');

    const accordionCount = document.querySelectorAll('#mobileAccordion .acc-item').length;
    console.assert(accordionCount === totalItems, 'Accordion item count should match FAQ size');

    const questionCount = document.querySelectorAll('#contentInner .question').length;
    console.assert(questionCount <= 1, 'Question viewer should render a single article at a time');

    const ids = FAQ.flatMap((section) => (section.items || []).map((item) => item.id));
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    console.assert(!duplicates.length, 'FAQ item IDs must be unique: ' + duplicates.join(', '));

    console.log('%cSelf-tests passed', 'color: #22c55e;');
  } catch (error) {
    console.error('Self-tests failed:', error);
  }
}

window.addEventListener('resize', () => {
  refreshOpenPanels();
  scheduleStickyRefresh();
});

window.addEventListener('scroll', scheduleStickyRefresh, { passive: true });

observeMedia(layoutQuery, () => {
  if (!flatQuestions.length) return;

  if (isMobileLayout()) {
    syncMobileAccordion(activeDesktopId, { scroll: false, focus: false });
  } else {
    renderDesktopQuestion(activeDesktopId);
    updateSidebarActive(activeDesktopId);
  }

  refreshStickyButtons();
});

observeMedia(reduceMotionQuery, () => {
  if (!prefersReducedMotion()) refreshOpenPanels();
});

window.addEventListener('hashchange', handleHashChange);

(async function init() {
  try {
    FAQ = await loadFAQ();
    renderDesktop();
    renderMobile();
    if (DEBUG) runTests();
  } catch (error) {
    console.error('Nie udało się wczytać FAQ z faq-data.json:', error);
    const viewer = document.getElementById('contentInner');
    if (viewer) {
      viewer.innerHTML = '<p style="opacity:.7">Brak danych FAQ – sprawdź plik <code>faq-data.json</code>.</p>';
    }
  }
})();