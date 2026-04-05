/**
 * FORM SOLVER v3.1 — Content Script
 * Sends image URLs to background (no canvas CORS issues).
 */
(function () {
  'use strict';

  console.log('[FormSolver v3.1] Script loaded at', new Date().toISOString());

  const INITIAL_WAIT = 2500;

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
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square">
        <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"></polygon>
      </svg>
      SOLVE_FORM
    `;
    b.addEventListener('click', runSolver);
    document.body.appendChild(b);
  }

  // ── Set native value (bypass frameworks) ──
  function setNative(el, val) {
    const p = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const s = Object.getOwnPropertyDescriptor(p, 'value')?.set;
    if (s) s.call(el, val); else el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── Auto-fill personal details ──
  function autoFill() {
    chrome.storage.local.get(['userName', 'userEmail', 'userRollNo', 'userDiv', 'userBranch'], data => {
      if (!data.userName && !data.userEmail) return;
      const items = document.querySelectorAll('div[role="listitem"]');
      items.forEach(item => {
        const inputs = item.querySelectorAll('input[type="text"], input[type="email"], textarea');
        if (!inputs.length) return;
        const txt = item.innerText.toLowerCase();
        let v = null;
        if (txt.includes('name') && !txt.includes('branch')) v = data.userName;
        else if (txt.includes('email')) v = data.userEmail;
        else if (txt.includes('roll')) v = data.userRollNo;
        else if (txt.includes('div')) v = data.userDiv;
        else if (txt.includes('branch') || txt.includes('dept')) v = data.userBranch;
        if (v && !inputs[0].value) { inputs[0].focus(); setNative(inputs[0], v); inputs[0].blur(); }
      });
    });
  }

  // ── Scrape questions — send image URLs, not base64 ──
  function scrapeQuestions() {
    const items = document.querySelectorAll('div[role="listitem"]');
    const qs = [];
    console.log('[FormSolver v3.1] Found', items.length, 'containers');

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
        console.log('[FormSolver v3.1] Image URL for Q' + i + ':', imageUrl.substring(0, 100));
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
        console.log(`[FormSolver v3.1] Q${i}: "${title}" (${type}) opts=[${opts.join(', ')}] img=${!!imageUrl}`);
        qs.push({ index: i, question: title, type, options: opts, imageUrl, container: item });
      }
    }
    return qs;
  }

  // ── Apply one answer to the page ──
  function applyAnswer(q, ansObj) {
    const c = q.container;
    const target = ansObj.answer;
    console.log(`[FormSolver v3.1] Applying Q${q.index}: AI said "${target}"`);

    if (q.type === 'radio') {
      const radios = c.querySelectorAll('div[role="radio"]');
      const targetStr = String(target).trim().toLowerCase();

      radios.forEach(r => {
        const label = (r.getAttribute('aria-label') || '').trim().toLowerCase();
        if (label === targetStr) {
          const el = r.closest('label') || r;
          el.style.setProperty('outline', '2px solid #d4ff00', 'important');
          el.style.setProperty('outline-offset', '4px', 'important');
          el.style.setProperty('background-color', 'rgba(212, 255, 0, 0.05)', 'important');
          el.style.setProperty('border-radius', '2px', 'important');
          el.style.setProperty('box-shadow', 'inset 4px 0 0 #d4ff00', 'important');
          console.log(`[FormSolver v3.1]   ✅ Radio MATCH: "${label}"`);
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
          el.style.setProperty('outline', '2px solid #d4ff00', 'important');
          el.style.setProperty('outline-offset', '4px', 'important');
          el.style.setProperty('background-color', 'rgba(212, 255, 0, 0.05)', 'important');
          el.style.setProperty('border-radius', '2px', 'important');
          el.style.setProperty('box-shadow', 'inset 4px 0 0 #d4ff00', 'important');
          console.log(`[FormSolver v3.1]   ✅ Checkbox MATCH: "${label}"`);
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
    fab.innerHTML = '<span class="spinner"></span> SYS.SOLVING...';
    fab.disabled = true;

    showToast('Scanning DOM matrix...');
    const questions = scrapeQuestions();

    if (!questions.length) {
      showToast('No diagnostic targets found.');
      fab.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square">
          <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"></polygon>
        </svg>
        SOLVE_FORM
      `;
      fab.disabled = false;
      return;
    }

    showToast(`Found ${questions.length} questions. Sending to AI (with images)...`);

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
        showToast(`Target acquired. ${count} anomalies resolved.`);
      }
      fab.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square">
          <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"></polygon>
        </svg>
        SOLVE_FORM
      `;
      fab.disabled = false;
    });
  }

  // ── Init ──
  setTimeout(() => { injectFAB(); autoFill(); }, INITIAL_WAIT);
})();
