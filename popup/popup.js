document.addEventListener('DOMContentLoaded', () => {
  const fields = {
    userName:    'userName',
    userEmail:   'userEmail',
    userRollNo:  'userRollNo',
    userDiv:     'userDiv',
    userBranch:  'userBranch',
    apiKey:      'apiKey'
  };

  const ids = Object.values(fields);

  // ── Load saved settings ──
  chrome.storage.local.get(ids, (result) => {
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el && result[id]) el.value = result[id];
    });
  });

  // ── Toggle API key visibility ──
  document.getElementById('toggleKey').addEventListener('click', () => {
    const input = document.getElementById('apiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // ── Save ──
  document.getElementById('saveBtn').addEventListener('click', () => {
    const data = {};
    let hasError = false;

    ids.forEach(id => {
      const el = document.getElementById(id);
      data[id] = el.value.trim();
    });

    // Require at least the API key
    if (!data.apiKey) {
      showStatus('Please enter your Gemini API Key.', 'error');
      return;
    }

    chrome.storage.local.set(data, () => {
      showStatus('Settings saved successfully!', 'success');
    });
  });

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
