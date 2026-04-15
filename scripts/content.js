/**
 * FORM SOLVER v4.0 — Content Script
 * Robust multi-strategy question detection.
 * Multi-page form support via MutationObserver.
 * Sends image URLs to background (no canvas CORS issues).
 */
(function () {
  'use strict';

  console.log('[FormSolver v4.0] Script loaded at', new Date().toISOString());

  const INITIAL_WAIT = 2500;
  const PAGE_CHANGE_DEBOUNCE = 800;

  let lastPageSignature = '';
  let pageChangeTimer = null;
  let observer = null;

  // ── Toast ──
  function showToast(msg) {
    let t = document.getElementById('fs-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'fs-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('visible');
    clearTimeout(t._tid);
    t._tid = setTimeout(() => t.classList.remove('visible'), 6000);
  }

  // ── FAB Button ──
  function injectFAB() {
    if (document.getElementById('fs-fab')) return;
    const b = document.createElement('button');
    b.id = 'fs-fab';
    b.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"></path>
      </svg>
    `;
    b.addEventListener('click', runSolver);
    document.body.appendChild(b);
  }

  // ── Ensure FAB persists (Google Forms may nuke custom DOM on page change) ──
  function ensureFAB() {
    if (!document.getElementById('fs-fab')) {
      console.log('[FormSolver v4.0] FAB missing after page change — re-injecting');
      injectFAB();
    }
  }

  // ── Set native value (bypass frameworks) ──
  function setNative(el, val) {
    const p = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const s = Object.getOwnPropertyDescriptor(p, 'value')?.set;
    if (s) s.call(el, val); else el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── Auto-fill personal details (runs on every page) ──
  function autoFill() {
    chrome.storage.local.get(['userName', 'userEmail', 'userRollNo', 'userDiv', 'userBranch'], data => {
      if (!data.userName && !data.userEmail) return;

      const containers = getQuestionContainers();
      let filled = 0;

      containers.forEach(item => {
        const inputs = item.querySelectorAll('input[type="text"], input[type="email"], textarea');
        if (!inputs.length) return;
        const txt = item.innerText.toLowerCase();
        let v = null;
        if (txt.includes('name') && !txt.includes('branch')) {
          if (txt.includes('father') || txt.includes('mother') || txt.includes('parent') || txt.includes('middle')) {
            v = null; // Do not auto-fill parents or middle names
          } else if (txt.includes('first')) {
            v = data.userName.split(' ')[0];
          } else if (txt.includes('sur') || txt.includes('last')) {
            const parts = data.userName.split(' ');
            v = parts.length > 1 ? parts.slice(1).join(' ') : '';
          } else {
            v = data.userName;
          }
        }
        else if (txt.includes('email')) v = data.userEmail;
        else if (txt.includes('roll')) v = data.userRollNo;
        else if (txt.includes('div')) v = data.userDiv;
        else if (txt.includes('branch') || txt.includes('dept')) v = data.userBranch;

        if (v && !inputs[0].value) {
          inputs[0].focus();
          setNative(inputs[0], v);
          inputs[0].blur();
          filled++;
        }
      });

      if (filled > 0) {
        console.log(`[FormSolver v4.0] Auto-filled ${filled} fields on current page`);
      }
    });
  }

  // ══════════════════════════════════════════════════
  //  ROBUST QUESTION CONTAINER DETECTION
  //  Strategy: Try multiple methods and deduplicate.
  // ══════════════════════════════════════════════════

  function getQuestionContainers() {
    const containers = new Set();

    // Strategy 1: div[role="listitem"] — standard Google Forms structure
    document.querySelectorAll('div[role="listitem"]').forEach(el => {
      if (!isHidden(el)) containers.add(el);
    });

    // Strategy 2: elements with data-params (Google Forms internal question marker)
    document.querySelectorAll('[data-params]').forEach(el => {
      // data-params is on the question container or a parent
      // Walk up to find a reasonable container boundary
      const container = el.closest('div[role="listitem"]') || findQuestionBoundary(el);
      if (container && !isHidden(container)) containers.add(container);
    });

    // Strategy 3: Walk UP from interactive elements (radio, checkbox, text input)
    // This catches questions even if they lack role="listitem"
    document.querySelectorAll('div[role="radio"], div[role="checkbox"]').forEach(el => {
      const container = findQuestionBoundary(el);
      if (container && !isHidden(container)) containers.add(container);
    });

    // Strategy 4: Find by the freebirdFormviewerViewItemsItemItem class pattern
    // Google Forms uses classes like "freebirdFormviewerViewNumberedItemContainer"
    document.querySelectorAll('[class*="freebirdFormviewerViewItemsItemItem"], [class*="freebirdFormviewerViewNumberedItemContainer"]').forEach(el => {
      if (!isHidden(el)) containers.add(el);
    });

    // Convert to array and sort by DOM order
    const arr = Array.from(containers);
    arr.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    // Deduplicate: remove containers that are children of other containers in our list
    const deduped = [];
    for (const container of arr) {
      let isChild = false;
      for (const other of arr) {
        if (other !== container && other.contains(container)) {
          isChild = true;
          break;
        }
      }
      if (!isChild) deduped.push(container);
    }

    console.log(`[FormSolver v4.0] Found ${deduped.length} question containers (from ${arr.length} before dedup)`);
    return deduped;
  }

  // Walk up from an interactive element to find the nearest question boundary
  function findQuestionBoundary(el) {
    let current = el.parentElement;
    let lastGoodContainer = null;

    while (current && current !== document.body) {
      // The question container is typically a direct child of the form's list
      // or has specific structural markers
      if (current.getAttribute('role') === 'listitem') return current;

      // Check for Google Forms structural classes
      const cls = current.className || '';
      if (typeof cls === 'string') {
        if (cls.includes('freebirdFormviewerViewItemsItemItem') ||
            cls.includes('freebirdFormviewerViewNumberedItemContainer') ||
            cls.includes('Qr7Oae')) {
          return current;
        }
      }

      // Heuristic: if this div's parent is a role="list" or the form,
      // then this div is likely the question container
      const parent = current.parentElement;
      if (parent) {
        const parentRole = parent.getAttribute('role');
        if (parentRole === 'list' || parent.tagName === 'FORM') {
          lastGoodContainer = current;
        }
      }

      current = current.parentElement;
    }

    return lastGoodContainer;
  }

  // Check if an element is hidden (but NOT just offscreen/below the fold)
  function isHidden(el) {
    const style = getComputedStyle(el);
    if (style.display === 'none') return true;
    if (style.visibility === 'hidden') return true;
    // Don't check bounding rect — items below the fold are NOT hidden,
    // they just haven't been scrolled to yet
    return false;
  }

  // ══════════════════════════════════════════════════
  //  ROBUST QUESTION TITLE EXTRACTION
  // ══════════════════════════════════════════════════

  function getQuestionTitle(container) {
    // 1. div[role="heading"] — standard Google Forms
    const heading = container.querySelector('div[role="heading"]');
    if (heading) {
      const t = heading.innerText.split('\n')[0].trim();
      if (t) return t;
    }

    // 2. span with role="heading"
    const spanHeading = container.querySelector('span[role="heading"]');
    if (spanHeading) {
      const t = spanHeading.innerText.split('\n')[0].trim();
      if (t) return t;
    }

    // 3. Element with aria-level (heading indicator)
    const ariaHeading = container.querySelector('[aria-level]');
    if (ariaHeading) {
      const t = ariaHeading.innerText.split('\n')[0].trim();
      if (t) return t;
    }

    // 4. data-value attribute (some Google Forms versions)
    const dataValue = container.querySelector('[data-value]');
    if (dataValue) {
      const t = dataValue.innerText.trim();
      if (t && t.length > 2) return t;
    }

    // 5. The first significant text block before any interactive elements
    //    Walk through child elements and find text that precedes radio/checkbox/input
    const textContent = extractTitleFromStructure(container);
    if (textContent) return textContent;

    return null;
  }

  // Extract title text by finding the text content that comes before
  // any radio/checkbox/input elements in the container
  function extractTitleFromStructure(container) {
    // Get all text nodes and element nodes in order
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (node) => {
          // Stop at interactive elements
          const role = node.getAttribute('role');
          if (role === 'radio' || role === 'checkbox' || role === 'listbox') {
            return NodeFilter.FILTER_REJECT;
          }
          if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
            return NodeFilter.FILTER_REJECT;
          }
          // Skip our own injected elements
          if (node.id && node.id.startsWith('fs-')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    // Collect text from elements above the interactive area
    let bestText = '';
    let node;
    while ((node = walker.nextNode())) {
      // Look for elements that contain direct text (not just wrapper divs)
      const directText = Array.from(node.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join(' ')
        .trim();

      if (directText && directText.length > 2 && directText.length < 500) {
        // Prefer the first substantial text block we find
        if (!bestText || directText.length > bestText.length) {
          bestText = directText;
        }
        // If we found something reasonable (at least a few words), use it
        if (bestText.length > 5) break;
      }
    }

    return bestText || null;
  }

  // ══════════════════════════════════════════════════
  //  FIND OPTIONS (radio/checkbox) WITHIN A CONTAINER
  // ══════════════════════════════════════════════════

  function getOptions(container) {
    const radios = container.querySelectorAll('div[role="radio"]');
    const checks = container.querySelectorAll('div[role="checkbox"]');
    const texts = container.querySelectorAll('input[type="text"], textarea');
    const dropdowns = container.querySelectorAll('div[role="listbox"]');

    if (radios.length > 0) {
      const opts = [];
      radios.forEach(r => {
        const label = r.getAttribute('aria-label') || r.innerText.trim();
        if (label) opts.push(label);
      });
      return { type: 'radio', options: opts };
    }

    if (checks.length > 0) {
      const opts = [];
      checks.forEach(c => {
        const label = c.getAttribute('aria-label') || c.innerText.trim();
        if (label) opts.push(label);
      });
      return { type: 'checkbox', options: opts };
    }

    if (dropdowns.length > 0) {
      // Try to get dropdown options
      const opts = [];
      const options = container.querySelectorAll('div[role="option"], [data-value]');
      options.forEach(o => {
        const label = o.getAttribute('data-value') || o.getAttribute('aria-label') || o.innerText.trim();
        if (label) opts.push(label);
      });
      return { type: 'dropdown', options: opts };
    }

    if (texts.length > 0) {
      return { type: 'text', options: [] };
    }

    return { type: null, options: [] };
  }

  // ── Keywords that indicate a personal-info field (handled by autoFill, not AI) ──
  const PERSONAL_FIELD_KEYWORDS = ['name', 'email', 'roll', 'division', 'div', 'branch', 'dept', 'department',
    'prn', 'enrollment', 'contact', 'phone', 'mobile', 'sapid', 'sap id', 'section',
    'grade', 'class', 'semester', 'year', 'batch'];

  function isPersonalField(titleLower) {
    // Only consider it a personal field if it's a SHORT text question
    // (actual quiz questions with these words in a longer sentence should still be sent to AI)
    if (titleLower.length > 60) return false; // Long titles are likely actual questions
    return PERSONAL_FIELD_KEYWORDS.some(kw => titleLower.includes(kw));
  }

  // ══════════════════════════════════════════════════
  //  SCRAPE ALL QUESTIONS ON CURRENT PAGE
  // ══════════════════════════════════════════════════

  function scrapeQuestions() {
    const containers = getQuestionContainers();
    const qs = [];
    console.log(`[FormSolver v4.0] Processing ${containers.length} containers`);

    for (let i = 0; i < containers.length; i++) {
      const container = containers[i];

      // Get title
      const title = getQuestionTitle(container);
      if (!title) {
        console.log(`[FormSolver v4.0] Container ${i}: no title found, skipping`);
        continue;
      }

      // Get options/type
      const { type, options: opts } = getOptions(container);
      if (!type) {
        console.log(`[FormSolver v4.0] Container ${i}: "${title}" — no interactive elements, skipping`);
        continue;
      }

      // Skip personal-info text fields — handled by autoFill, not AI
      if (type === 'text' && isPersonalField(title.toLowerCase())) {
        console.log(`[FormSolver v4.0] Container ${i}: "${title}" — personal field, skipping`);
        continue;
      }

      // Check for images
      let imageUrl = null;
      const img = container.querySelector('img[src]:not([src*="svg"])');
      if (img && img.src) {
        imageUrl = img.src;
        console.log(`[FormSolver v4.0] Image URL for Q${qs.length}:`, imageUrl.substring(0, 100));
      }

      console.log(`[FormSolver v4.0] Q${qs.length}: "${title.substring(0, 60)}" (${type}) opts=[${opts.slice(0, 3).join(', ')}${opts.length > 3 ? '...' : ''}] img=${!!imageUrl}`);
      qs.push({ index: qs.length, question: title, type, options: opts, imageUrl, container });
    }

    console.log(`[FormSolver v4.0] Total questions scraped: ${qs.length}`);
    return qs;
  }

  // ══════════════════════════════════════════════════
  //  PAGE CHANGE DETECTION (multi-page forms)
  // ══════════════════════════════════════════════════

  function getPageSignature() {
    const containers = getQuestionContainers();
    const parts = [];
    for (const container of containers.slice(0, 5)) { // Sample first 5 for performance
      const title = getQuestionTitle(container);
      if (title) parts.push(title.substring(0, 40));
    }
    const progressEl = document.querySelector('[role="progressbar"]');
    const progress = progressEl ? progressEl.getAttribute('aria-valuenow') || '' : '';
    return `${containers.length}|${progress}|${parts.join('||')}`;
  }

  function onPageChange() {
    const newSig = getPageSignature();
    if (newSig === lastPageSignature) return;

    lastPageSignature = newSig;
    console.log('[FormSolver v4.0] Page change detected. New signature:', newSig.substring(0, 100));

    ensureFAB();
    autoFill();
    clearHighlights();
  }

  function clearHighlights() {
    document.querySelectorAll('.fs-correct-highlight').forEach(el => {
      el.classList.remove('fs-correct-highlight');
    });
    document.querySelectorAll('[style*="inset 4px 0 0 #00f0ff"]').forEach(el => {
      el.style.removeProperty('outline');
      el.style.removeProperty('outline-offset');
      el.style.removeProperty('background-color');
      el.style.removeProperty('border-radius');
      el.style.removeProperty('box-shadow');
    });
  }

  // ── MutationObserver to detect page changes in multi-section forms ──
  function startObserver() {
    const formContainer = document.querySelector('form')
      || document.querySelector('[role="list"]')?.parentElement
      || document.body;

    observer = new MutationObserver((mutations) => {
      clearTimeout(pageChangeTimer);
      pageChangeTimer = setTimeout(() => {
        let hasStructuralChange = false;
        for (const m of mutations) {
          if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
            for (const node of m.addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE && !node.id?.startsWith('fs-')) {
                hasStructuralChange = true;
                break;
              }
            }
            for (const node of m.removedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE && !node.id?.startsWith('fs-')) {
                hasStructuralChange = true;
                break;
              }
            }
          }
          if (hasStructuralChange) break;
        }

        if (hasStructuralChange) {
          onPageChange();
        }
      }, PAGE_CHANGE_DEBOUNCE);
    });

    observer.observe(formContainer, {
      childList: true,
      subtree: true
    });

    console.log('[FormSolver v4.0] MutationObserver watching:', formContainer.tagName);
  }

  // ── Intercept navigation button clicks ──
  function interceptNavButtons() {
    document.addEventListener('click', (e) => {
      const target = e.target.closest('[role="button"], button');
      if (!target) return;

      const text = (target.innerText || target.textContent || '').trim().toLowerCase();
      const isNavButton = ['next', 'back', 'previous', 'submit',
        'अगला', 'पिछला', 'आगे', 'पीछे'
      ].some(kw => text.includes(kw));

      const ariaLabel = (target.getAttribute('aria-label') || '').toLowerCase();
      const isNavArrow = ariaLabel.includes('next') || ariaLabel.includes('back')
        || ariaLabel.includes('previous') || ariaLabel.includes('forward');

      if (isNavButton || isNavArrow) {
        console.log(`[FormSolver v4.0] Nav button clicked: "${text || ariaLabel}"`);
        setTimeout(() => onPageChange(), 1200);
        setTimeout(() => onPageChange(), 2500);
      }
    }, true);
  }

  // ══════════════════════════════════════════════════
  //  APPLY ANSWERS TO THE PAGE
  // ══════════════════════════════════════════════════

  function applyAnswer(q, ansObj) {
    const c = q.container;
    const target = ansObj.answer;
    console.log(`[FormSolver v4.0] Applying Q${q.index}: AI said "${target}"`);

    if (q.type === 'radio') {
      const radios = c.querySelectorAll('div[role="radio"]');
      const targetStr = String(target).trim().toLowerCase();

      let matched = false;
      radios.forEach(r => {
        const label = (r.getAttribute('aria-label') || r.innerText || '').trim().toLowerCase();
        if (label === targetStr) {
          const el = r.closest('label') || r;
          el.style.setProperty('outline', '2px solid #00f0ff', 'important');
          el.style.setProperty('outline-offset', '4px', 'important');
          el.style.setProperty('background-color', 'rgba(0, 240, 255, 0.05)', 'important');
          el.style.setProperty('border-radius', '2px', 'important');
          el.style.setProperty('box-shadow', 'inset 4px 0 0 #00f0ff', 'important');
          console.log(`[FormSolver v4.0]   ✅ Radio MATCH: "${label}"`);
          matched = true;
        }
      });

      // Fuzzy fallback: if no exact match, try partial/includes matching
      if (!matched) {
        radios.forEach(r => {
          const label = (r.getAttribute('aria-label') || r.innerText || '').trim().toLowerCase();
          if (label.includes(targetStr) || targetStr.includes(label)) {
            const el = r.closest('label') || r;
            el.style.setProperty('outline', '2px solid #ffa032', 'important');
            el.style.setProperty('outline-offset', '4px', 'important');
            el.style.setProperty('background-color', 'rgba(255, 160, 50, 0.05)', 'important');
            el.style.setProperty('border-radius', '2px', 'important');
            el.style.setProperty('box-shadow', 'inset 4px 0 0 #ffa032', 'important');
            console.log(`[FormSolver v4.0]   ⚠️ Radio FUZZY match: "${label}" ≈ "${targetStr}"`);
            matched = true;
          }
        });
      }

      if (!matched) {
        console.warn(`[FormSolver v4.0]   ❌ No match for radio answer: "${targetStr}"`);
        console.warn(`[FormSolver v4.0]      Available labels:`, Array.from(radios).map(r => r.getAttribute('aria-label')));
      }

    } else if (q.type === 'checkbox') {
      const checks = c.querySelectorAll('div[role="checkbox"]');
      const answers = Array.isArray(target) ? target : String(target).split(',').map(s => s.trim());
      const ansSet = new Set(answers.map(a => String(a).trim().toLowerCase()));

      checks.forEach(cb => {
        const label = (cb.getAttribute('aria-label') || cb.innerText || '').trim().toLowerCase();
        if (ansSet.has(label)) {
          const el = cb.closest('label') || cb;
          el.style.setProperty('outline', '2px solid #00f0ff', 'important');
          el.style.setProperty('outline-offset', '4px', 'important');
          el.style.setProperty('background-color', 'rgba(0, 240, 255, 0.05)', 'important');
          el.style.setProperty('border-radius', '2px', 'important');
          el.style.setProperty('box-shadow', 'inset 4px 0 0 #00f0ff', 'important');
          console.log(`[FormSolver v4.0]   ✅ Checkbox MATCH: "${label}"`);
        }
      });

    } else if (q.type === 'dropdown') {
      // For dropdowns, try to click the correct option
      const listbox = c.querySelector('div[role="listbox"]');
      if (listbox) {
        listbox.click(); // Open dropdown
        setTimeout(() => {
          const options = document.querySelectorAll('div[role="option"]');
          const targetStr = String(target).trim().toLowerCase();
          options.forEach(opt => {
            const label = (opt.getAttribute('data-value') || opt.innerText || '').trim().toLowerCase();
            if (label === targetStr || label.includes(targetStr)) {
              opt.click();
              console.log(`[FormSolver v4.0]   ✅ Dropdown MATCH: "${label}"`);
            }
          });
        }, 300);
      }

    } else if (q.type === 'text' && target) {
      const input = c.querySelector('input[type="text"], textarea');
      if (input) {
        input.focus();
        setNative(input, String(target));
        input.blur();
      }
    }
  }

  // ══════════════════════════════════════════════════
  //  MAIN SOLVER
  // ══════════════════════════════════════════════════

  async function runSolver() {
    const fab = document.getElementById('fs-fab');
    fab.classList.add('solving');
    fab.disabled = true;

    showToast('Scanning current page...');

    // Let DOM settle
    await new Promise(r => setTimeout(r, 500));

    const questions = scrapeQuestions();

    if (!questions.length) {
      showToast('No questions found on this page. Try clicking after the page fully loads.');
      fab.classList.remove('solving');
      fab.disabled = false;
      return;
    }

    showToast(`Found ${questions.length} questions. Sending to AI...`);

    // Prepare payload — exclude container (DOM node) from the message
    const payload = questions.map(q => ({
      index: q.index, question: q.question, type: q.type, options: q.options, imageUrl: q.imageUrl
    }));

    chrome.runtime.sendMessage({ action: 'solveQuestions', questions: payload }, response => {
      if (chrome.runtime.lastError) {
        showToast('Error: ' + chrome.runtime.lastError.message);
      } else if (response?.error) {
        showToast('Error: ' + response.error);
      } else if (response?.answers) {

        let count = 0;
        response.answers.forEach(ans => {
          const q = questions.find(x => x.index === ans.index);
          if (q) { applyAnswer(q, ans); count++; }
        });

        const provider = (response.provider || 'gemini').toUpperCase();
        const fallbackNote = response.fallback ? ' (Gemini overloaded → fallback)' : '';
        showToast(`${count} answers applied via ${provider}${fallbackNote}`);
      }
      fab.classList.remove('solving');
      fab.disabled = false;
    });
  }

  // ══════════════════════════════════════════════════
  //  INIT — with multi-page awareness
  // ══════════════════════════════════════════════════
  setTimeout(() => {
    injectFAB();
    autoFill();

    lastPageSignature = getPageSignature();

    startObserver();
    interceptNavButtons();

    const containers = getQuestionContainers();
    console.log(`[FormSolver v4.0] Initialized. Found ${containers.length} question containers. Signature: ${lastPageSignature.substring(0, 80)}`);
  }, INITIAL_WAIT);
})();
