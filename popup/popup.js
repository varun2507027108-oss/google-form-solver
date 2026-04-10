document.addEventListener('DOMContentLoaded', () => {
  const fields = {
    userName:    'userName',
    userEmail:   'userEmail',
    userRollNo:  'userRollNo',
    userDiv:     'userDiv',
    userBranch:  'userBranch',
    apiKey:      'apiKey',
    groqApiKey:  'groqApiKey'
  };

  const ids = Object.values(fields);

  // ── Load saved settings ──
  chrome.storage.local.get(ids, (result) => {
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el && result[id]) el.value = result[id];
    });
    updateProviderStatus();
  });

  // ── Toggle API key visibility ──
  document.getElementById('toggleKey').addEventListener('click', () => {
    const input = document.getElementById('apiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('toggleGroqKey').addEventListener('click', () => {
    const input = document.getElementById('groqApiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // ── Live status update on key input ──
  document.getElementById('apiKey').addEventListener('input', updateProviderStatus);
  document.getElementById('groqApiKey').addEventListener('input', updateProviderStatus);

  // ── Save ──
  document.getElementById('saveBtn').addEventListener('click', () => {
    const data = {};

    ids.forEach(id => {
      const el = document.getElementById(id);
      data[id] = el.value.trim();
    });

    // Require at least one API key
    if (!data.apiKey && !data.groqApiKey) {
      showStatus('Enter at least one API key (Gemini or Groq).', 'error');
      return;
    }

    chrome.storage.local.set(data, () => {
      showStatus('Settings saved successfully!', 'success');
      updateProviderStatus();
    });
  });

  function updateProviderStatus() {
    const geminiKey = document.getElementById('apiKey').value.trim();
    const groqKey = document.getElementById('groqApiKey').value.trim();
    const dot = document.querySelector('.status-dot');
    const label = document.getElementById('providerLabel');
    const footer = document.getElementById('footerEngine');

    if (geminiKey && groqKey) {
      dot.className = 'status-dot dual';
      label.textContent = 'GEMINI_PRIMARY → GROQ_FALLBACK';
      footer.textContent = 'DUAL_CORE_ACTIVE';
      footer.style.color = '#ffa032';
    } else if (geminiKey) {
      dot.className = 'status-dot active';
      label.textContent = 'GEMINI_ONLY';
      footer.textContent = 'FLASH_CORE_ACTIVE';
      footer.style.color = 'var(--accent)';
    } else if (groqKey) {
      dot.className = 'status-dot dual';
      label.textContent = 'GROQ_ONLY';
      footer.textContent = 'GROQ_CORE_ACTIVE';
      footer.style.color = '#ffa032';
    } else {
      dot.className = 'status-dot';
      label.textContent = 'NO_KEYS_SET';
      footer.textContent = 'OFFLINE';
      footer.style.color = '#4b4b54';
    }
  }

  function showStatus(msg, type) {
    const el = document.getElementById('statusMsg');
    el.textContent = msg;
    el.className = 'status-msg ' + type;
    setTimeout(() => {
      el.textContent = '';
      el.className = 'status-msg';
    }, 3000);
  }
});
