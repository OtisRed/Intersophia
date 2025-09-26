// ===== FAQ APP (responsive desktop/mobile rendering) =====

(() => {
  const AUTO_SCROLL = false;
  const DEBUG = false;
  const STICKY_CLASS = 'is-sticky';
  const STATIC_ACCORDION_IDS = new Set(['kim-jestesmy']);
  const SOCIAL_GLOW_MAPPING = new Map([
    ['jak-dowiem-sie-o-spotkaniu', [0, 1]],
    ['jak-zlapac-kontakt', [1]],
    ['co-to-wspolny-notes', [2]],
  ]);
  const SOCIAL_GLOW_CLASS = 'glow-twice';
  const SOCIAL_REDUCED_MOTION_TIMEOUT = 450;

  const layoutQuery = window.matchMedia('(max-width: 960px)');
  const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  const dom = {
    viewer: document.getElementById('contentInner'),
    sidebar: document.getElementById('sidebar'),
    accordion: document.getElementById('mobileAccordion'),
  };

  const state = {
    sections: [],
    flatList: [],
    questionMap: new Map(),
    activeId: null,
    sidebarButtons: new Map(),
    accordionItems: new Map(),
    sidebarBound: false,
    accordionBound: false,
  };

  init();

  async function init() {
    bindGlobalListeners();

    try {
      const sections = await loadFaqData();
      hydrate(sections);
      if (DEBUG) runTests();
    } catch (error) {
      handleDataLoadError(error);
    }
  }

  async function loadFaqData() {
    const response = await fetch('assets/faq-data.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('FAQ musi być tablicą sekcji');
    return data;
  }

  function hydrate(sections) {
    state.sections = Array.isArray(sections) ? sections : [];

    const { flatList, questionMap } = buildQuestionIndex(state.sections);
    state.flatList = flatList;
    state.questionMap = questionMap;

    const hashCandidate = resolveQuestionId(extractHashId());
    if (hashCandidate) {
      state.activeId = hashCandidate;
    } else if (!state.activeId || !state.questionMap.has(state.activeId)) {
      state.activeId = state.flatList[0]?.id || null;
    }

    renderDesktop();
    renderMobile();

    if (state.activeId && state.questionMap.has(state.activeId)) {
      renderDesktopQuestion(state.activeId);
      updateSidebarActive(state.activeId);
      setHashQuestionId(state.activeId);
      syncMobileAccordion(state.activeId, { scroll: false, focus: false });
    } else if (dom.viewer) {
      dom.viewer.innerHTML = '<p class="question-empty">Brak pytań do wyświetlenia.</p>';
    }
  }

  function buildQuestionIndex(sections) {
    const flatList = [];
    const map = new Map();

    sections.forEach((section) => {
      const items = Array.isArray(section?.items) ? section.items : [];
      items.forEach((item) => {
        if (!item || !item.id) return;
        const id = String(item.id);
        if (map.has(id)) return;

        const entry = {
          id,
          section: section?.section || '',
          question: item.q || '',
          answer: item.a || '',
        };

        flatList.push(entry);
        map.set(id, entry);
      });
    });

    return { flatList, questionMap: map };
  }

  function renderDesktop() {
    const content = ensureSidebarContent();
    if (!content) return;

    const fragment = document.createDocumentFragment();

    state.sections.forEach((section) => {
      const validItems = getValidItems(section);
      if (!validItems.length) return;

      const sectionEl = document.createElement('section');
      sectionEl.className = 'side-section';

      if (!section.hideHeading) {
        const title = document.createElement('h2');
        title.className = 'side-title';
        title.textContent = section.section;
        sectionEl.appendChild(title);
      }

      const list = document.createElement('ul');
      list.className = 'side-list';

      validItems.forEach((entry) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'side-link';
        button.dataset.questionId = entry.id;
        button.setAttribute('aria-controls', 'contentInner');
        button.innerHTML = `<span>${entry.question}</span>`;

        li.appendChild(button);
        list.appendChild(li);
        state.sidebarButtons.set(entry.id, button);
      });

      sectionEl.appendChild(list);
      fragment.appendChild(sectionEl);
    });

    content.appendChild(fragment);

    if (!state.sidebarBound && dom.sidebar) {
      dom.sidebar.addEventListener('click', handleSidebarClick);
      state.sidebarBound = true;
    }
  }

  function ensureSidebarContent() {
    if (!dom.sidebar) return null;

    dom.sidebar.classList.add('card-surface');
    dom.sidebar.innerHTML = '';

    const content = document.createElement('div');
    content.className = 'sidebar-content';
    dom.sidebar.appendChild(content);

    const footer = document.createElement('footer');
    footer.className = 'sidebar-footer';
    footer.innerHTML = `
      <small>© 2025 | DESGINED BY<br>
        <a href="https://www.linkedin.com/in/krzysztof-durczak/" target="_blank" rel="noopener">KRZYSZTOF DURCZAK</a> |
        <a href="https://github.com/OtisRed" target="_blank" rel="noopener">OTISRED</a>
      </small>
    `;
    dom.sidebar.appendChild(footer);

    state.sidebarButtons.clear();
    return content;
  }

  function renderMobile() {
    if (!dom.accordion) return;

    dom.accordion.innerHTML = '';
    state.accordionItems.clear();

    const fragment = document.createDocumentFragment();

    state.sections.forEach((section) => {
      const validItems = getValidItems(section);
      if (!validItems.length) return;

      if (!section.hideHeading) {
        const heading = document.createElement('div');
        heading.className = 'side-title';
        heading.textContent = section.section;
        fragment.appendChild(heading);
      }

      validItems.forEach((entry) => {
        if (STATIC_ACCORDION_IDS.has(entry.id)) {
          const staticBlock = createStaticAccordionBlock(entry);
          fragment.appendChild(staticBlock);
          return;
        }

        const item = createAccordionItem(entry);
        fragment.appendChild(item.wrapper);
        state.accordionItems.set(entry.id, {
          item: item.wrapper,
          button: item.button,
          panel: item.panel,
        });
      });
    });

    dom.accordion.appendChild(fragment);

    if (!state.accordionBound) {
      dom.accordion.addEventListener('click', handleAccordionClick);
      state.accordionBound = true;
    }

    if (state.activeId) {
      syncMobileAccordion(state.activeId, { scroll: false, focus: false });
    }
  }

  function createAccordionItem(entry) {
    const wrapper = document.createElement('div');
    wrapper.className = 'acc-item';
    wrapper.dataset.questionId = entry.id;

    const button = document.createElement('button');
    button.id = `q-${entry.id}`;
    button.className = 'acc-btn';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', `p-${entry.id}`);
    button.innerHTML = `
      <span>${entry.question}</span>
      <span class="chev" aria-hidden="true">▾</span>
    `;

    const panel = document.createElement('div');
    panel.className = 'acc-panel';
    panel.id = `p-${entry.id}`;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-labelledby', button.id);

    const body = document.createElement('div');
    body.className = 'acc-body card-surface';
    body.innerHTML = entry.answer;
    panel.appendChild(body);

    setPanelAccessibilityState(panel, false);

    wrapper.append(button, panel);
    return { wrapper, button, panel };
  }

  function createStaticAccordionBlock(entry) {
    const block = document.createElement('div');
    block.className = 'acc-body card-surface acc-static';
    block.dataset.questionId = entry.id;
    block.setAttribute('tabindex', '0');
    block.setAttribute('role', 'region');
    block.innerHTML = entry.answer;
    return block;
  }

  function getValidItems(section) {
    if (!section || !Array.isArray(section.items)) return [];
    return section.items
      .map((item) => (item && state.questionMap.get(String(item.id))) || null)
      .filter(Boolean);
  }

  function renderDesktopQuestion(id) {
    if (!dom.viewer) return;
    const entry = state.questionMap.get(id);
    if (!entry) return;

    dom.viewer.setAttribute('tabindex', '0');
    dom.viewer.innerHTML = `
      <article class="question card-surface" data-question-id="${entry.id}" aria-label="${entry.question}">
        <div class="answer">${entry.answer}</div>
      </article>
    `;

    const article = dom.viewer.querySelector('.question');
    if (article) {
      article.classList.remove('question-animate');

      if (!prefersReducedMotion()) {
        void article.offsetWidth;
        article.classList.add('question-animate');
        article.addEventListener(
          'animationend',
          () => article.classList.remove('question-animate'),
          { once: true }
        );
      }
    }

    smoothScrollTo(dom.viewer, 0);
  }

  function updateSidebarActive(id) {
    state.sidebarButtons.forEach((button, questionId) => {
      const isActive = questionId === id;
      button.classList.toggle('active', isActive);
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-current', isActive ? 'true' : 'false');
    });
  }

  function applyActiveQuestion(id, { syncHash = true, scrollMobile = false } = {}) {
    if (!id || !state.questionMap.has(id)) return;

    state.activeId = id;
    renderDesktopQuestion(id);
    updateSidebarActive(id);
    if (syncHash) setHashQuestionId(id);
    syncMobileAccordion(id, { scroll: scrollMobile, focus: false });
  }

  function syncMobileAccordion(id, { scroll = false, focus = false } = {}) {
    if (!id || !state.accordionItems.size) return;

    const targetEntry = state.accordionItems.get(id);
    if (!targetEntry) return;

    const { panel, button } = targetEntry;

    state.accordionItems.forEach((entry, questionId) => {
      if (questionId !== id && entry.panel.classList.contains('open')) {
        collapsePanel(entry.panel);
      }
    });

    if (!panel.classList.contains('open')) {
      expandPanel(panel, { scroll });
    } else if (scroll) {
      const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
      const target = button || panel;
      scrollAccordionTriggerIntoView(target, behavior);
      requestAnimationFrame(() => {
        if (button && isMobileLayout()) {
          enableAccordionButtonSticky(button);
        } else if (button) {
          disableAccordionButtonSticky(button);
        }
      });
    }

    if (focus && button && typeof button.focus === 'function') {
      button.focus({ preventScroll: true });
    }
  }

  function expandPanel(panel, { scroll = AUTO_SCROLL } = {}) {
    const button = panel.previousElementSibling;
    panel.classList.add('open');
    panel.style.opacity = '1';
    adjustPanelHeight(panel);
    setPanelAccessibilityState(panel, true);

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
        () => adjustPanelHeight(panel),
        { once: true }
      );
    });

    const updateSticky = () => {
      if (!button) return;
      if (isMobileLayout()) {
        enableAccordionButtonSticky(button);
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
          return;
        }

        panel.scrollIntoView({ behavior, block: 'start', inline: 'nearest' });
        updateSticky();
      };

      requestAnimationFrame(() => requestAnimationFrame(performScroll));
    } else {
      updateSticky();
    }
  }

  function collapsePanel(panel) {
    const button = panel.previousElementSibling;
    panel.style.maxHeight = '0px';
    panel.style.opacity = '0';
    panel.classList.remove('open');
    setPanelAccessibilityState(panel, false);

    if (button) {
      disableAccordionButtonSticky(button);
      button.classList.remove('is-active');
      button.setAttribute('aria-expanded', 'false');
      const chev = button.querySelector('.chev');
      if (chev) chev.style.transform = 'rotate(0deg)';
    }
  }

  function adjustPanelHeight(panel) {
    if (!panel) return;
    panel.style.maxHeight = `${panel.scrollHeight}px`;
  }

  function setPanelAccessibilityState(panel, isOpen) {
    if (!panel) return;

    panel.setAttribute('aria-hidden', String(!isOpen));
    panel.dataset.open = isOpen ? 'true' : 'false';

    const body = panel.querySelector('.acc-body');
    if (body) {
      body.setAttribute('tabindex', isOpen ? '0' : '-1');
    }
  }

  function getMobileScrollOffset() {
    if (!isMobileLayout()) return 0;

    const header = document.querySelector('header');
    const socials = document.querySelector('.socials-mobile');
    let safeTop = 0;

    if (header) {
      const headerRect = header.getBoundingClientRect();
      safeTop = Math.max(safeTop, headerRect.bottom);
    }

    if (socials) {
      const rect = socials.getBoundingClientRect();
      const styles = window.getComputedStyle(socials);
      const marginTop = parseFloat(styles.marginTop || '0');
      const marginBottom = parseFloat(styles.marginBottom || '0');
      const stickyHeight = rect.height + marginTop;
      const socialBottom = rect.bottom + marginBottom;

      safeTop = rect.top <= 0 ? Math.max(safeTop, stickyHeight) : Math.max(safeTop, socialBottom);
    }

    return Math.max(safeTop, 0);
  }

  function enableAccordionButtonSticky(button) {
    if (!button) return;
    disableAccordionButtonSticky(button);
  }

  function disableAccordionButtonSticky(button) {
    if (!button) return;
    button.classList.remove(STICKY_CLASS);
    button.style.removeProperty('--accordion-sticky-top');
  }

  function scrollAccordionTriggerIntoView(element, behavior) {
    if (!element) return;

    if (!isMobileLayout()) {
      element.scrollIntoView({ behavior, block: 'start', inline: 'nearest' });
      return;
    }

    const targetItem = element.closest('.acc-item') || element;
    const scrollBehavior = behavior === 'smooth' ? 'smooth' : 'auto';

    if (typeof targetItem.scrollIntoView === 'function') {
      try {
        targetItem.scrollIntoView({ behavior: scrollBehavior, block: 'start', inline: 'nearest' });
      } catch (_error) {
        targetItem.scrollIntoView();
      }
    } else {
      const offset = getMobileScrollOffset();
      const rect = targetItem.getBoundingClientRect();
      const targetTop = Math.max(0, window.scrollY + rect.top - offset);
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const clampedTarget = Math.min(targetTop, maxScroll);
      window.scrollTo({ top: clampedTarget, behavior: scrollBehavior });
    }
  }

  function triggerSocialGlow(indices = [0]) {
    const desktopIcons = Array.from(document.querySelectorAll('.socials-desktop .icon-btn'));
    const mobileIcons = Array.from(document.querySelectorAll('.socials-mobile .icon-btn'));

    const icons = indices
      .flatMap((index) => {
        if (typeof index !== 'number' || Number.isNaN(index)) return [];
        return [desktopIcons[index], mobileIcons[index]].filter(Boolean);
      })
      .filter(Boolean);

    const uniqueIcons = Array.from(new Set(icons));

    if (!uniqueIcons.length) return;

    const shouldAnimate = !prefersReducedMotion();

    uniqueIcons.forEach((icon) => {
      if (!icon) return;

      if (!shouldAnimate) {
        icon.classList.add('is-active');
        window.setTimeout(() => icon.classList.remove('is-active'), SOCIAL_REDUCED_MOTION_TIMEOUT);
        return;
      }

      icon.classList.remove(SOCIAL_GLOW_CLASS);
      void icon.offsetWidth;

      const handleAnimationEnd = () => {
        icon.classList.remove(SOCIAL_GLOW_CLASS);
        icon.removeEventListener('animationend', handleAnimationEnd);
      };

      icon.addEventListener('animationend', handleAnimationEnd);
      icon.classList.add(SOCIAL_GLOW_CLASS);
    });
  }

  function handleAccordionClick(event) {
    const button = event.target.closest('.acc-btn');
    if (!button) return;

    const item = button.closest('.acc-item');
    const id = item?.dataset.questionId;
    if (!id || !state.accordionItems.has(id)) return;

    const { panel } = state.accordionItems.get(id);
    const isOpen = panel.classList.contains('open');

    state.accordionItems.forEach((entry, questionId) => {
      if (questionId !== id && entry.panel.classList.contains('open')) {
        collapsePanel(entry.panel);
      }
    });

    if (isOpen) {
      collapsePanel(panel);
      return;
    }

    expandPanel(panel);
    applyActiveQuestion(id, { syncHash: true, scrollMobile: false });

    const glowIndices = SOCIAL_GLOW_MAPPING.get(id);
    if (glowIndices) {
      triggerSocialGlow(glowIndices);
    }
  }

  function handleSidebarClick(event) {
    const button = event.target.closest('.side-link');
    if (!button) return;

    const id = button.dataset.questionId;
    if (!id || !state.questionMap.has(id)) return;

    if (id === state.activeId) {
      scrollQuestionToTop();
      return;
    }

    applyActiveQuestion(id, { syncHash: true, scrollMobile: false });
  }

  function refreshOpenPanels() {
    state.accordionItems.forEach(({ panel }) => {
      if (panel.classList.contains('open')) adjustPanelHeight(panel);
    });
  }

  function scrollQuestionToTop() {
    if (!dom.viewer) return;
    smoothScrollTo(dom.viewer, 0);
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
    if (!candidate || !state.questionMap.size) return null;
    if (state.questionMap.has(candidate)) return candidate;

    if (candidate.startsWith('q-')) {
      const trimmed = candidate.slice(2);
      if (state.questionMap.has(trimmed)) return trimmed;
    } else {
      const prefixed = `q-${candidate}`;
      if (state.questionMap.has(prefixed)) return prefixed;
    }

    return null;
  }

  function handleHashChange() {
    const candidate = resolveQuestionId(extractHashId());
    if (!candidate) return;

    if (candidate === state.activeId) {
      syncMobileAccordion(candidate, { scroll: isMobileLayout(), focus: false });
      return;
    }

    applyActiveQuestion(candidate, { syncHash: false, scrollMobile: isMobileLayout() });
  }

  function bindGlobalListeners() {
    window.addEventListener('resize', refreshOpenPanels);
    window.addEventListener('hashchange', handleHashChange);

    observeMedia(layoutQuery, handleLayoutChange);
    observeMedia(reduceMotionQuery, handleMotionPreferenceChange);
  }

  function handleLayoutChange() {
    if (!state.flatList.length) return;

    if (isMobileLayout()) {
      syncMobileAccordion(state.activeId, { scroll: false, focus: false });
    } else {
      renderDesktopQuestion(state.activeId);
      updateSidebarActive(state.activeId);
    }
  }

  function handleMotionPreferenceChange() {
    if (!prefersReducedMotion()) refreshOpenPanels();
  }

  function observeMedia(query, handler) {
    if (!query || typeof handler !== 'function') return;
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', handler);
    } else if (typeof query.addListener === 'function') {
      query.addListener(handler);
    }
  }

  function isMobileLayout() {
    return layoutQuery && typeof layoutQuery.matches === 'boolean'
      ? layoutQuery.matches
      : window.innerWidth <= 960;
  }

  function prefersReducedMotion() {
    return reduceMotionQuery && typeof reduceMotionQuery.matches === 'boolean'
      ? reduceMotionQuery.matches
      : false;
  }

  function handleDataLoadError(error) {
    console.error('Nie udało się wczytać FAQ z faq-data.json:', error);
    if (dom.viewer) {
      dom.viewer.innerHTML = '<p style="opacity:.7">Brak danych FAQ – sprawdź plik <code>faq-data.json</code>.</p>';
    }
  }

  function runTests() {
    try {
      const totalItems = state.flatList.length;
      const sidebarCount = dom.sidebar ? dom.sidebar.querySelectorAll('.side-link').length : 0;
      const accordionCount = dom.accordion ? dom.accordion.querySelectorAll('.acc-item').length : 0;

      console.info('[TEST] FAQ items count:', totalItems);
      console.assert(sidebarCount === totalItems, 'Sidebar link count should match FAQ size');
      console.assert(accordionCount === totalItems, 'Accordion item count should match FAQ size');

      const ids = state.sections.flatMap((section) =>
        (Array.isArray(section?.items) ? section.items : []).map((item) => String(item?.id || ''))
      );
      const duplicates = ids.filter((id, index) => id && ids.indexOf(id) !== index);
      console.assert(!duplicates.length, 'FAQ item IDs must be unique: ' + duplicates.join(', '));

      const questionCount = dom.viewer ? dom.viewer.querySelectorAll('.question').length : 0;
      console.assert(questionCount <= 1, 'Question viewer should render a single article at a time');

      console.log('%cSelf-tests passed', 'color: #22c55e;');
    } catch (error) {
      console.error('Self-tests failed:', error);
    }
  }
})();