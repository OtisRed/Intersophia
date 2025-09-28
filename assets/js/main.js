/**
 * @fileoverview Intersophia FAQ Application
 * Responsive FAQ interface with desktop sidebar navigation and mobile accordion
 * Features social media icon glow animations and smooth scroll behavior
 * 
 * @author Krzysztof Durczak
 * @version 2.0
 * @since 2025
 * 
 * Key Features:
 * - Responsive desktop/mobile layouts
 * - Social media icon glow animations
 * - Smooth accordion transitions
 * - URL hash navigation
 * - Accessibility support
 * - Reduced motion respect
 */

// ===== FAQ APP (responsive desktop/mobile rendering) =====

(() => {
  // ===== CONFIGURATION =====
  const CONFIG = {
    // Feature flags
    AUTO_SCROLL: false,
    
    // Layout & responsive
    MOBILE_BREAKPOINT: 960,
    
    // Animation & timing
    ANIMATION_DURATION: 300,
    ACCORDION_TRANSITION_DURATION: 400,
    QUESTION_REVEAL_DURATION: 480,
    SOCIAL_REDUCED_MOTION_TIMEOUT: 450,
    
    // Social media glow
    SOCIAL_GLOW_CLASS: 'glow-twice',
    SOCIAL_GLOW_ANIMATION_DURATION: 750, // 0.75s from CSS
    
    // Scroll offsets
    MOBILE_STICKY_OFFSET: 32,
    
    // Static accordion items (always expanded)
    STATIC_ACCORDION_IDS: new Set(['kim-jestesmy']),
    
    // Social media icon glow mappings
    SOCIAL_GLOW_MAPPING: new Map([
      ['jak-sie-dowiem-o-spotkaniach', [0, 1]],  // Facebook + Messenger
      ['jak-moge-zlapac-kontakt', [1]],          // Messenger
      ['do-czego-uzywacie-onenote', [2]],        // OneNote
    ]),
    
    // UX Enhancement flags
    KEYBOARD_NAVIGATION_ENABLED: true,
    FOCUS_ENHANCEMENT_ENABLED: true,
    PROGRESSIVE_ENHANCEMENT_ENABLED: true,
    
    // Loading state configuration
    LOADING_SKELETON_ITEMS: 3,
    LOADING_DELAY_MS: 100,
    
    // Smart scroll behavior
    SMART_SCROLL_THRESHOLD: 300,
  };

  const layoutQuery = window.matchMedia(`(max-width: ${CONFIG.MOBILE_BREAKPOINT}px)`);
  const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  const dom = {
    viewer: document.getElementById('contentInner'),
    sidebar: document.getElementById('sidebar'),
    accordion: document.getElementById('mobileAccordion'),
    // Cache social icons for performance
    socialIcons: null,
    // Cache document fragment for reuse
    fragment: null,
  };

  const state = {
    questions: new Map(),     // Single source of truth - combines questionMap + flatList data
    sections: [],            // Keep for section structure (needed for rendering)
    activeId: null,
    elements: {
      sidebar: new Map(),    // Renamed from sidebarButtons for clarity
      accordion: new Map(),  // Renamed from accordionItems for clarity
    },
    bound: {
      sidebar: false,        // Consolidated binding flags
      accordion: false,
    }
  };

  init();

  /**
   * Initializes cached DOM references for performance
   * @function initDomCache
   */
  function initDomCache() {
    // Cache social icons and containers once to avoid repeated DOM queries
    dom.socialIcons = {
      desktop: Array.from(document.querySelectorAll('.socials-desktop .icon-btn')),
      mobile: Array.from(document.querySelectorAll('.socials-mobile .icon-btn')),
      mobileContainer: document.querySelector('.socials-mobile'),
    };
  }

  /**
   * Initializes the FAQ application
   * Sets up event listeners, loads data, and renders initial state
   * @async
   * @function init
   */
  async function init() {
    bindGlobalListeners();
    
    // Show loading state immediately for better perceived performance
    showLoadingState();
    
    try {
      // Small delay to ensure loading state is visible
      await new Promise(resolve => setTimeout(resolve, CONFIG.LOADING_DELAY_MS));
      
      const sections = await loadFaqData();
      hydrate(sections);

    } catch (error) {
      showErrorState(error);
      handleDataLoadError(error);
    }
  }

  /**
   * Loads FAQ data from external JSON file
   * @async
   * @function loadFaqData
   * @returns {Promise<Array>} Array of FAQ sections with items
   * @throws {Error} When fetch fails or data format is invalid
   */
  async function loadFaqData() {
    const response = await fetch('assets/faq-data.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('FAQ musi być tablicą sekcji');
    return data;
  }

  /**
   * Converts asterisk-based bullet points to proper HTML unordered lists
   * @function formatBulletPoints
   * @param {string} text - Text content that may contain asterisk bullet points
   * @returns {string} HTML with proper <ul> and <li> elements
   */
  function formatBulletPoints(text) {
    if (!text || typeof text !== 'string') return text;
    
    // Split by lines and process bullet points
    const lines = text.split('\n');
    let result = [];
    let inList = false;
    let currentList = [];
    
    for (let line of lines) {
      const trimmed = line.trim();
      
      // Check if line starts with asterisk bullet point
      if (trimmed.startsWith('* ')) {
        const bulletContent = trimmed.substring(2).trim();
        if (!inList) {
          inList = true;
          currentList = [];
        }
        currentList.push(bulletContent);
      } else {
        // If we were in a list, close it
        if (inList) {
          const listItems = currentList.map(item => `<li>${item}</li>`).join('');
          result.push(`<ul>${listItems}</ul>`);
          inList = false;
          currentList = [];
        }
        
        // Add regular line (if not empty)
        if (trimmed) {
          result.push(line);
        }
      }
    }
    
    // Close any remaining list
    if (inList && currentList.length > 0) {
      const listItems = currentList.map(item => `<li>${item}</li>`).join('');
      result.push(`<ul>${listItems}</ul>`);
    }
    
    return result.join('\n');
  }

  /**
   * Hydrates the application state with FAQ data and renders initial content
   * @function hydrate
   * @param {Array} sections - Raw FAQ sections from loadFaqData
   */
  function hydrate(sections) {
    const rawSections = Array.isArray(sections) ? sections : [];
    const { questions, processedSections } = buildQuestionIndex(rawSections);
    
    state.sections = processedSections; // Store processed sections with cached validItems
    state.questions = questions;

    const hashCandidate = resolveQuestionId(extractHashId());
    if (hashCandidate) {
      state.activeId = hashCandidate;
    } else if (!state.activeId || !state.questions.has(state.activeId)) {
      // Get first question by order
      const firstQuestion = Array.from(state.questions.values()).sort((a, b) => a.order - b.order)[0];
      state.activeId = firstQuestion?.id || null;
    }

    renderDesktop();
    renderMobile();
    initDomCache();

    if (state.activeId && state.questions.has(state.activeId)) {
      renderDesktopQuestion(state.activeId);
      updateSidebarActive(state.activeId);
      setHashQuestionId(state.activeId);
      syncMobileAccordion(state.activeId, { scroll: false, focus: false });
    } else if (dom.viewer) {
      dom.viewer.innerHTML = '<p class="question-empty">Brak pytań do wyświetlenia.</p>';
    }
  }

  /**
   * Builds question index and processes sections for optimal rendering
   * Creates a Map for O(1) question lookups and caches valid items per section
   * @function buildQuestionIndex
   * @param {Array} sections - Raw FAQ sections from JSON
   * @returns {Object} Object containing questions Map and processed sections
   * @returns {Map} returns.questions - Map of question ID to question data
   * @returns {Array} returns.processedSections - Sections with cached validItems
   */
  function buildQuestionIndex(sections) {
    const questions = new Map();

    // Process sections and cache valid items to avoid repeated processing
    const processedSections = sections.map((section) => {
      const items = Array.isArray(section?.items) ? section.items : [];
      const validItems = [];

      items.forEach((item, index) => {
        if (!item || !item.id) return;
        const id = String(item.id);
        if (questions.has(id)) return;

        const entry = {
          id,
          section: section?.section || '',
          question: item.q || '',
          answer: item.a || '',
          order: questions.size, // Track original order for flatList compatibility
        };

        questions.set(id, entry);
        validItems.push(entry);
      });

      // Return processed section with cached valid items
      return {
        ...section,
        validItems, // Cache the processed valid items
      };
    });

    return { questions, processedSections };
  }

  /**
   * Renders the desktop sidebar with question navigation
   * Creates section headings and clickable question links
   * @function renderDesktop
   */
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
        state.elements.sidebar.set(entry.id, button);
      });

      sectionEl.appendChild(list);
      fragment.appendChild(sectionEl);
    });

    content.appendChild(fragment);

    if (!state.bound.sidebar && dom.sidebar) {
      dom.sidebar.addEventListener('click', handleSidebarClick);
      state.bound.sidebar = true;
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
      <small>© 2025 | DESIGNED BY<br>
        <a href="https://www.linkedin.com/in/krzysztof-durczak/" target="_blank" rel="noopener">KRZYSZTOF DURCZAK</a> |
        <a href="https://github.com/OtisRed" target="_blank" rel="noopener">OTISRED</a>
      </small>
    `;
    dom.sidebar.appendChild(footer);

    state.elements.sidebar.clear();
    return content;
  }

  /**
   * Renders the mobile accordion interface
   * Creates expandable accordion items and static blocks
   * @function renderMobile
   */
  function renderMobile() {
    if (!dom.accordion) return;

    dom.accordion.innerHTML = '';
    state.elements.accordion.clear();

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
        if (CONFIG.STATIC_ACCORDION_IDS.has(entry.id)) {
          const staticBlock = createStaticAccordionBlock(entry);
          fragment.appendChild(staticBlock);
          return;
        }

        const item = createAccordionItem(entry);
        fragment.appendChild(item.wrapper);
        state.elements.accordion.set(entry.id, {
          item: item.wrapper,
          button: item.button,
          panel: item.panel,
        });
      });
    });

    dom.accordion.appendChild(fragment);

    if (!state.bound.accordion) {
      dom.accordion.addEventListener('click', handleAccordionClick);
      state.bound.accordion = true;
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
    body.innerHTML = formatBulletPoints(entry.answer);
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
    block.innerHTML = formatBulletPoints(entry.answer);
    return block;
  }

  function getValidItems(section) {
    // Return pre-cached valid items instead of processing on each call
    return section?.validItems || [];
  }

  /**
   * Renders a specific question in the desktop viewer
   * @function renderDesktopQuestion
   * @param {string} id - Question ID to render
   */
  function renderDesktopQuestion(id) {
    if (!dom.viewer) return;
    const entry = state.questions.get(id);
    if (!entry) return;

    // Add smooth content transition
    const hasExistingContent = dom.viewer.children.length > 0 && !dom.viewer.querySelector('.loading-skeleton');
    if (hasExistingContent && !prefersReducedMotion()) {
      dom.viewer.classList.add('content-fade-out');
      
      // Wait for fade out, then update content
      setTimeout(() => {
        updateDesktopQuestionContent(entry);
      }, 150);
    } else {
      // Direct update for first load or reduced motion
      updateDesktopQuestionContent(entry);
    }
  }

  /**
   * Update desktop question content with smooth transitions
   * @param {Object} entry - The question entry to render
   */
  function updateDesktopQuestionContent(entry) {
    dom.viewer.setAttribute('tabindex', '0');
    dom.viewer.innerHTML = `
      <article class="question card-surface" data-question-id="${entry.id}" aria-label="${entry.question}">
        <div class="answer">${entry.answer}</div>
      </article>
    `;

    const article = dom.viewer.querySelector('.question');
    if (article) {
      article.classList.remove('question-animate');
      
      // Remove fade out and add fade in
      dom.viewer.classList.remove('content-fade-out');
      if (!prefersReducedMotion()) {
        dom.viewer.classList.add('content-fade-in');
        setTimeout(() => dom.viewer.classList.remove('content-fade-in'), 300);
        
        void article.offsetWidth;
        article.classList.add('question-animate');
        article.addEventListener(
          'animationend',
          () => article.classList.remove('question-animate'),
          { once: true }
        );
      }
    }

    scrollTo({ target: dom.viewer, mode: 'container' });
  }

  function updateSidebarActive(id) {
    state.elements.sidebar.forEach((button, questionId) => {
      const isActive = questionId === id;
      button.classList.toggle('active', isActive);
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-current', isActive ? 'true' : 'false');
    });
  }

  /**
   * Applies a question as active across desktop and mobile interfaces
   * @function applyActiveQuestion
   * @param {string} id - Question ID to activate
   * @param {Object} options - Configuration options
   * @param {boolean} [options.syncHash=true] - Whether to update URL hash
   * @param {boolean} [options.scrollMobile=false] - Whether to scroll on mobile
   */
  function applyActiveQuestion(id, { syncHash = true, scrollMobile = false } = {}) {
    if (!id || !state.questions.has(id)) return;

    state.activeId = id;
    renderDesktopQuestion(id);
    updateSidebarActive(id);
    if (syncHash) setHashQuestionId(id);
    syncMobileAccordion(id, { scroll: scrollMobile, focus: false });

    const glowIndices = CONFIG.SOCIAL_GLOW_MAPPING.get(id);
    if (glowIndices) {
      triggerSocialGlow(glowIndices);
    }
  }

  function syncMobileAccordion(id, { scroll = false, focus = false } = {}) {
    if (!id || !state.elements.accordion.size) return;

    const targetEntry = state.elements.accordion.get(id);
    if (!targetEntry) return;

    const { panel, button } = targetEntry;

    state.elements.accordion.forEach((entry, questionId) => {
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
    }

    if (focus && button && typeof button.focus === 'function') {
      button.focus({ preventScroll: true });
    }
  }

  /**
   * Expands an accordion panel with animation and accessibility updates
   * @function expandPanel
   * @param {HTMLElement} panel - The panel element to expand
   * @param {Object} options - Configuration options
   * @param {boolean} [options.scroll=CONFIG.AUTO_SCROLL] - Whether to scroll panel into view
   */
  function expandPanel(panel, { scroll = CONFIG.AUTO_SCROLL } = {}) {
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

    if (scroll) {
      const target = button || panel;

      const performScroll = () => {
        if (isMobileLayout()) {
          scrollTo({ target, mode: 'accordion', respectSticky: true });
        } else {
          scrollTo({ target: panel, mode: 'element' });
        }
      };

      requestAnimationFrame(() => requestAnimationFrame(performScroll));
    }
  }

  /**
   * Collapses an accordion panel with animation and accessibility updates
   * @function collapsePanel
   * @param {HTMLElement} panel - The panel element to collapse
   */
  function collapsePanel(panel) {
    const button = panel.previousElementSibling;
    panel.style.maxHeight = '0px';
    panel.style.opacity = '0';
    panel.classList.remove('open');
    setPanelAccessibilityState(panel, false);

    if (button) {
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
    
    // Use cached reference if available, fallback to query
    const socials = dom.socialIcons?.mobileContainer || document.querySelector('.socials-mobile');
    if (socials && socials.getBoundingClientRect().top <= 0) {
      return socials.offsetHeight + CONFIG.MOBILE_STICKY_OFFSET; // Configurable margin
    }
    
    return 0;
  }
  function scrollAccordionTriggerIntoView(element, behavior) {
    scrollTo({ target: element, behavior, mode: 'accordion', respectSticky: true });
  }

  /**
   * Triggers glow animation on social media icons
   * @function triggerSocialGlow
   * @param {Array<number>} [indices=[0]] - Array of icon indices to animate (0=Facebook, 1=Messenger, 2=OneNote)
   * @example
   * triggerSocialGlow([0, 1]); // Glows Facebook and Messenger
   * triggerSocialGlow([2]);    // Glows OneNote only
   */
  function triggerSocialGlow(indices = [0]) {
    // Use cached icons for better performance
    const { desktop: desktopIcons, mobile: mobileIcons } = dom.socialIcons || { desktop: [], mobile: [] };

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
        window.setTimeout(() => icon.classList.remove('is-active'), CONFIG.SOCIAL_REDUCED_MOTION_TIMEOUT);
        return;
      }

      icon.classList.remove(CONFIG.SOCIAL_GLOW_CLASS);
      void icon.offsetWidth;

      const handleAnimationEnd = () => {
        icon.classList.remove(CONFIG.SOCIAL_GLOW_CLASS);
        icon.removeEventListener('animationend', handleAnimationEnd);
      };

      icon.addEventListener('animationend', handleAnimationEnd);
      icon.classList.add(CONFIG.SOCIAL_GLOW_CLASS);
    });
  }

  /**
   * Handles clicks on accordion buttons in mobile view
   * @function handleAccordionClick
   * @param {Event} event - Click event from accordion button
   */
  function handleAccordionClick(event) {
    const button = event.target.closest('.acc-btn');
    if (!button) return;

    const item = button.closest('.acc-item');
    const id = item?.dataset.questionId;
    if (!id || !state.elements.accordion.has(id)) return;

    const { panel } = state.elements.accordion.get(id);
    const isOpen = panel.classList.contains('open');

    state.elements.accordion.forEach((entry, questionId) => {
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
  }

  /**
   * Handles clicks on sidebar navigation links in desktop view
   * @function handleSidebarClick
   * @param {Event} event - Click event from sidebar link
   */
  function handleSidebarClick(event) {
    const button = event.target.closest('.side-link');
    if (!button) return;

    const id = button.dataset.questionId;
    if (!id || !state.questions.has(id)) return;

    if (id === state.activeId) {
      scrollQuestionToTop();
      return;
    }

    applyActiveQuestion(id, { syncHash: true, scrollMobile: false });
  }

  function refreshOpenPanels() {
    state.elements.accordion.forEach(({ panel }) => {
      if (panel.classList.contains('open')) adjustPanelHeight(panel);
    });
  }

  /**
   * Universal scroll utility with support for different scroll contexts
   * @function scrollTo
   * @param {Object} options - Scroll configuration
   * @param {HTMLElement} options.target - Element to scroll or scroll into view
   * @param {number} [options.top=0] - Scroll position (for container scrolling)
   * @param {'auto'|'smooth'|null} [options.behavior=null] - Override behavior (null = auto-detect)
   * @param {'element'|'container'|'accordion'} [options.mode='element'] - Scroll mode
   * @param {boolean} [options.respectSticky=false] - Account for mobile sticky elements
   */
  function scrollTo({ 
    target, 
    top = 0, 
    behavior = null, 
    mode = 'element', 
    respectSticky = false 
  } = {}) {
    if (!target) return;
    
    // Auto-detect behavior if not specified
    const scrollBehavior = behavior || (prefersReducedMotion() ? 'auto' : 'smooth');
    
    switch (mode) {
      case 'container':
        // Scroll within a container element
        if (typeof target.scrollTo === 'function') {
          target.scrollTo({ top, behavior: scrollBehavior });
        } else {
          target.scrollTop = top;
        }
        break;
        
      case 'accordion':
        // Accordion-specific scrolling with mobile sticky offset
        const targetItem = target.closest('.acc-item') || target;
        
        if (isMobileLayout() && respectSticky) {
          const offset = getMobileScrollOffset();
          const rect = targetItem.getBoundingClientRect();
          const targetY = window.scrollY + rect.top - offset;
          window.scrollTo({ top: Math.max(0, targetY), behavior: scrollBehavior });
        } else {
          target.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
        }
        break;
        
      case 'element':
      default:
        // Standard element scroll into view
        target.scrollIntoView({ 
          behavior: scrollBehavior, 
          block: 'start', 
          inline: 'nearest' 
        });
    }
  }

  function scrollQuestionToTop() {
    if (!dom.viewer) return;
    scrollTo({ target: dom.viewer, mode: 'container' });
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
      // Fallback to raw hash if decoding fails
      console.warn('Failed to decode URL hash:', error.message);
    }
    return hash.trim() || null;
  }

  function resolveQuestionId(candidate) {
    if (!candidate || !state.questions.size) return null;
    if (state.questions.has(candidate)) return candidate;

    if (candidate.startsWith('q-')) {
      const trimmed = candidate.slice(2);
      if (state.questions.has(trimmed)) return trimmed;
    } else {
      const prefixed = `q-${candidate}`;
      if (state.questions.has(prefixed)) return prefixed;
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

  /**
   * Enhanced keyboard navigation handler
   * Supports arrow keys for navigation and Enter/Space for activation
   * @param {KeyboardEvent} event - The keyboard event
   */
  function handleKeyboardNavigation(event) {
    const { key, target, ctrlKey, metaKey } = event;
    
    // Show keyboard navigation hint on first use
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
      if (!document.body.classList.contains('keyboard-navigation')) {
        document.body.classList.add('keyboard-navigation');
        setTimeout(() => document.body.classList.remove('keyboard-navigation'), 3000);
      }
    }
    
    // Don't interfere with form inputs or when modifier keys are pressed
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || ctrlKey || metaKey) {
      return;
    }

    const isMobile = isMobileLayout();
    const questionIds = Array.from(questionIndex.keys());
    const currentIndex = questionIds.indexOf(state.activeId);

    switch (key) {
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault();
        navigateToQuestion(currentIndex + 1, questionIds, isMobile);
        break;
        
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault();
        navigateToQuestion(currentIndex - 1, questionIds, isMobile);
        break;
        
      case 'Home':
        event.preventDefault();
        navigateToQuestion(0, questionIds, isMobile);
        break;
        
      case 'End':
        event.preventDefault();
        navigateToQuestion(questionIds.length - 1, questionIds, isMobile);
        break;
        
      case 'Enter':
      case ' ':
        // Handle activation when focused on sidebar links or accordion buttons
        if (target.classList.contains('side-link') || target.classList.contains('acc-btn')) {
          event.preventDefault();
          target.click();
        }
        break;
    }
  }

  /**
   * Show loading skeleton while FAQ data is being fetched
   */
  function showLoadingState() {
    const skeletonItems = Array.from({ length: CONFIG.LOADING_SKELETON_ITEMS }, (_, i) => `
      <div class="skeleton-item" style="animation-delay: ${i * 0.1}s">
        <div class="skeleton-title"></div>
        <div class="skeleton-content"></div>
        <div class="skeleton-content short"></div>
      </div>
    `).join('');
    
    const skeletonHTML = `
      <div class="loading-skeleton" aria-label="Loading content">
        <div class="skeleton-header">
          <div class="skeleton-logo"></div>
        </div>
        ${skeletonItems}
      </div>
    `;
    
    if (dom.viewer) {
      dom.viewer.innerHTML = skeletonHTML;
    }
    
    if (dom.sidebar) {
      const sidebarSkeleton = Array.from({ length: 6 }, (_, i) => `
        <div class="skeleton-sidebar-item" style="animation-delay: ${i * 0.05}s"></div>
      `).join('');
      dom.sidebar.innerHTML = `<div class="loading-skeleton">${sidebarSkeleton}</div>`;
    }
    
    if (dom.accordion) {
      const accordionSkeleton = Array.from({ length: CONFIG.LOADING_SKELETON_ITEMS }, (_, i) => `
        <div class="skeleton-accordion-item" style="animation-delay: ${i * 0.1}s">
          <div class="skeleton-accordion-button"></div>
        </div>
      `).join('');
      dom.accordion.innerHTML = `<div class="loading-skeleton">${accordionSkeleton}</div>`;
    }
  }

  /**
   * Show error state when FAQ data fails to load
   * @param {Error} error - The error that occurred
   */
  function showErrorState(error) {
    const errorHTML = `
      <div class="error-state" role="alert" aria-live="assertive">
        <div class="error-icon">⚠️</div>
        <h2>Unable to Load Content</h2>
        <p>We're having trouble loading the FAQ content. Please check your connection and try again.</p>
        <button class="error-retry-btn" onclick="location.reload()">Retry</button>
        <details class="error-details">
          <summary>Technical Details</summary>
          <pre>${error.message}</pre>
        </details>
      </div>
    `;
    
    if (dom.viewer) {
      dom.viewer.innerHTML = errorHTML;
    }
    
    // Clear other containers
    if (dom.sidebar) dom.sidebar.innerHTML = '';
    if (dom.accordion) dom.accordion.innerHTML = '';
  }

  /**
   * Navigate to a specific question by index with wrap-around
   * @param {number} targetIndex - The target question index
   * @param {string[]} questionIds - Array of all question IDs
   * @param {boolean} isMobile - Whether in mobile layout
   */
  function navigateToQuestion(targetIndex, questionIds, isMobile) {
    if (questionIds.length === 0) return;
    
    // Wrap around navigation
    let wrappedIndex = targetIndex;
    if (targetIndex >= questionIds.length) {
      wrappedIndex = 0;
    } else if (targetIndex < 0) {
      wrappedIndex = questionIds.length - 1;
    }
    
    const targetId = questionIds[wrappedIndex];
    applyActiveQuestion(targetId, { syncHash: true, scrollMobile: isMobile });
    
    // Focus the appropriate element for keyboard users
    if (isMobile) {
      const shouldScroll = !reduceMotionQuery.matches;
      syncMobileAccordion(targetId, { scroll: shouldScroll, focus: true });
    } else {
      const sidebarButton = dom.sidebar?.querySelector(`[data-question-id="${targetId}"]`);
      if (sidebarButton && typeof sidebarButton.focus === 'function') {
        sidebarButton.focus({ preventScroll: true });
      }
    }
  }

  function bindGlobalListeners() {
    window.addEventListener('resize', refreshOpenPanels, { passive: true });
    window.addEventListener('hashchange', handleHashChange);
    
    // Enhanced keyboard navigation
    document.addEventListener('keydown', handleKeyboardNavigation);

    observeMedia(layoutQuery, handleLayoutChange);
    observeMedia(reduceMotionQuery, handleMotionPreferenceChange);
  }

  function handleLayoutChange() {
    if (!state.questions.size) return;

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

  /**
   * Determines if the current layout should be mobile
   * @function isMobileLayout
   * @returns {boolean} True if viewport is mobile-sized
   */
  function isMobileLayout() {
    return layoutQuery?.matches ?? window.innerWidth <= CONFIG.MOBILE_BREAKPOINT;
  }

  /**
   * Checks if user prefers reduced motion for accessibility
   * @function prefersReducedMotion
   * @returns {boolean} True if reduced motion is preferred
   */
  function prefersReducedMotion() {
    return reduceMotionQuery?.matches ?? false;
  }

  function handleDataLoadError(error) {
    console.error('Failed to load FAQ data from faq-data.json:', error);
    if (dom.viewer) {
      dom.viewer.innerHTML = '<p style="opacity:.7">Brak danych FAQ – sprawdź plik <code>faq-data.json</code>.</p>';
    }
  }


})();

