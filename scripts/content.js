/**
 * FORM SOLVER v3.5 — Content Script
 * Multi-page form support via MutationObserver.
 * Sends image URLs to background (no canvas CORS issues).
 */
(function () {
  'use strict';

  console.log('[FormSolver v3.5] Script loaded at', new Date().toISOString());

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
      console.log('[FormSolver v3.5] FAB missing after page change — re-injecting');
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

      // Get only VISIBLE list items on the current page/section
      const items = getVisibleListItems();
      let filled = 0;

      items.forEach(item => {
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
        console.log(`[FormSolver v3.5] Auto-filled ${filled} fields on current page`);
      }
    });
  }

  // ── Get only visible list items (handles multi-page forms) ──
  function getVisibleListItems() {
    const allItems = document.querySelectorAll('div[role="listitem"]');
    const visible = [];
    for (const item of allItems) {
      // Skip items that are hidden (display:none, visibility:hidden, or zero-size)
      if (item.offsetParent === null && getComputedStyle(item).position !== 'fixed') continue;
      if (item.offsetHeight === 0 && item.offsetWidth === 0) continue;
      visible.push(item);
    }
    return visible;
  }

  // ── Generate a signature of the current page to detect navigation ──
  function getPageSignature() {
    const items = getVisibleListItems();
    // Use the text of headings + count of items as a fingerprint
    const parts = [];
    for (const item of items) {
      const heading = item.querySelector('div[role="heading"]');
      if (heading) {
        parts.push(heading.innerText.substring(0, 60).trim());
      }
    }
    // Also include any "Page X of Y" indicator or progress bar state
    const progressEl = document.querySelector('[role="progressbar"]');
    const progress = progressEl ? progressEl.getAttribute('aria-valuenow') || '' : '';
    return `${items.length}|${progress}|${parts.join('||')}`;
  }

  // ── Called when we detect a page change in the form ──
  function onPageChange() {
    const newSig = getPageSignature();
    if (newSig === lastPageSignature) return; // No actual change

    lastPageSignature = newSig;
    console.log('[FormSolver v3.5] Page change detected. New signature:', newSig.substring(0, 100));

    // Re-ensure FAB exists
    ensureFAB();

    // Re-run autofill for the new page
    autoFill();

    // Clear any previous answer highlights from old page
    clearHighlights();
  }

  // ── Clear stale highlights from previous page ──
  function clearHighlights() {
    document.querySelectorAll('.fs-correct-highlight').forEach(el => {
      el.classList.remove('fs-correct-highlight');
    });
    // Also clear inline styles from the old highlighting approach
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
    // Google Forms renders sections inside a specific container
    // We watch the form container for child additions/removals
    const formContainer = document.querySelector('form')
      || document.querySelector('[role="list"]')?.parentElement
      || document.body;

    observer = new MutationObserver((mutations) => {
      // Debounce: Google Forms makes many rapid DOM changes during transitions
      clearTimeout(pageChangeTimer);
      pageChangeTimer = setTimeout(() => {
        // Check if any mutation actually involves list items or structural changes
        let hasStructuralChange = false;
        for (const m of mutations) {
          if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
            // Check if the change involves form content (not just our own injections)
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

    console.log('[FormSolver v3.5] MutationObserver watching:', formContainer.tagName);
  }

  // ── Also intercept "Next" and "Back" button clicks directly ──
  function interceptNavButtons() {
    document.addEventListener('click', (e) => {
      const target = e.target.closest('[role="button"], button');
      if (!target) return;

      const text = (target.innerText || target.textContent || '').trim().toLowerCase();
      // Google Forms uses "Next", "Back", "Submit" — various languages too
      const isNavButton = ['next', 'back', 'previous', 'submit',
        'अगला', 'पिछला', // Hindi
        'आगे', 'पीछे'
      ].some(kw => text.includes(kw));

      // Also catch the arrow-style navigation buttons (no text, just icons)
      const ariaLabel = (target.getAttribute('aria-label') || '').toLowerCase();
      const isNavArrow = ariaLabel.includes('next') || ariaLabel.includes('back')
        || ariaLabel.includes('previous') || ariaLabel.includes('forward');

      if (isNavButton || isNavArrow) {
        console.log(`[FormSolver v3.5] Nav button clicked: "${text || ariaLabel}"`);
        // Wait for the new page to render before re-processing
        setTimeout(() => onPageChange(), 1200);
        setTimeout(() => onPageChange(), 2500); // Double-check in case of slow render
      }
    }, true); // Capture phase to catch it before Google's handler
  }

  // ── Scrape questions — only from the VISIBLE page ──
  function scrapeQuestions() {
    const items = getVisibleListItems();
    const qs = [];
    console.log('[FormSolver v3.5] Visible containers:', items.length);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const heading = item.querySelector('div[role="heading"]');
      if (!heading) continue;
      const title = heading.innerText.split('\n')[0].trim();
      if (!title) continue;

      const radios = item.querySelectorAll('div[role="radio"]');
      const checks = item.querySelectorAll('div[role="checkbox"]');
      const texts  = item.querySelectorAll('input[type="text"], textarea');

      // Just grab the image URL — background script will fetch it
      let imageUrl = null;
      const img = item.querySelector('img[src]:not([src*="svg"])');
      if (img && img.src) {
        imageUrl = img.src;
        console.log('[FormSolver v3.5] Image URL for Q' + i + ':', imageUrl.substring(0, 100));
      }

      let type = null, opts = [];
      if (radios.length) {
        type = 'radio';
        radios.forEach(r => opts.push(r.getAttribute('aria-label') || r.innerText.trim()));
      } else if (checks.length) {
        type = 'checkbox';
        checks.forEach(c => opts.push(c.getAttribute('aria-label') || c.innerText.trim()));
      } else if (texts.length) {
        type = 'text';
      }

      if (type) {
        console.log(`[FormSolver v3.5] Q${i}: "${title}" (${type}) opts=[${opts.join(', ')}] img=${!!imageUrl}`);
        qs.push({ index: i, question: title, type, options: opts, imageUrl, container: item });
      }
    }
    return qs;
  }

  // ── Apply one answer to the page ──
  function applyAnswer(q, ansObj) {
    const c = q.container;
    const target = ansObj.answer;
    console.log(`[FormSolver v3.5] Applying Q${q.index}: AI said "${target}"`);

    if (q.type === 'radio') {
      const radios = c.querySelectorAll('div[role="radio"]');
      const targetStr = String(target).trim().toLowerCase();

      radios.forEach(r => {
        const label = (r.getAttribute('aria-label') || '').trim().toLowerCase();
        if (label === targetStr) {
          const el = r.closest('label') || r;
          el.style.setProperty('outline', '2px solid #00f0ff', 'important');
          el.style.setProperty('outline-offset', '4px', 'important');
          el.style.setProperty('background-color', 'rgba(0, 240, 255, 0.05)', 'important');
          el.style.setProperty('border-radius', '2px', 'important');
          el.style.setProperty('box-shadow', 'inset 4px 0 0 #00f0ff', 'important');
          console.log(`[FormSolver v3.5]   ✅ Radio MATCH: "${label}"`);
        }
      });

    } else if (q.type === 'checkbox') {
      const checks = c.querySelectorAll('div[role="checkbox"]');
      const answers = Array.isArray(target) ? target : [target];
      const ansSet = new Set(answers.map(a => String(a).trim().toLowerCase()));

      checks.forEach(cb => {
        const label = (cb.getAttribute('aria-label') || '').trim().toLowerCase();
        if (ansSet.has(label)) {
          const el = cb.closest('label') || cb;
          el.style.setProperty('outline', '2px solid #00f0ff', 'important');
          el.style.setProperty('outline-offset', '4px', 'important');
          el.style.setProperty('background-color', 'rgba(0, 240, 255, 0.05)', 'important');
          el.style.setProperty('border-radius', '2px', 'important');
          el.style.setProperty('box-shadow', 'inset 4px 0 0 #00f0ff', 'important');
          console.log(`[FormSolver v3.5]   ✅ Checkbox MATCH: "${label}"`);
        }
      });

    } else if (q.type === 'text' && target) {
      const input = c.querySelector('input[type="text"], textarea');
      if (input) {
        input.focus();
        setNative(input, String(target));
        input.blur();
      }
    }
  }

  // ── Main solver ──
  async function runSolver() {
    const fab = document.getElementById('fs-fab');
    fab.classList.add('solving');
    fab.disabled = true;

    showToast('Scanning current page...');

    // Small delay to ensure DOM is fully settled (important after page navigation)
    await new Promise(r => setTimeout(r, 300));

    const questions = scrapeQuestions();

    if (!questions.length) {
      showToast('No questions found on this page. Try clicking the button after the page fully loads.');
      fab.classList.remove('solving');
      fab.disabled = false;
      return;
    }

    showToast(`Found ${questions.length} questions on this page. Sending to AI...`);

    // Send image URLs (not base64) — background will fetch them
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

        // Show which provider was used
        const provider = (response.provider || 'gemini').toUpperCase();
        const fallbackNote = response.fallback ? ' (Gemini overloaded → fallback)' : '';
        showToast(`${count} anomalies resolved via ${provider}${fallbackNote}`);
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

    // Record initial page signature
    lastPageSignature = getPageSignature();

    // Start watching for page changes (Next/Back in multi-section forms)
    startObserver();
    interceptNavButtons();

    console.log('[FormSolver v3.5] Initialized with multi-page support. Signature:', lastPageSignature.substring(0, 80));
  }, INITIAL_WAIT);
})();
