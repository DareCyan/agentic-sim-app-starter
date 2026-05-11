/* Config modal – LLM settings */
(function () {
  const btn = document.getElementById('settings-btn');
  const modal = document.getElementById('config-modal');
  const closeBtn = document.getElementById('config-modal-close');
  const saveBtn = document.getElementById('config-save-btn');

  const fields = [
    { id: 'cfg-api-url', key: 'llm_api_url', statusId: 'cfg-api-url-status' },
    { id: 'cfg-api-key', key: 'llm_api_key', statusId: 'cfg-api-key-status' },
    { id: 'cfg-model', key: 'llm_model', statusId: 'cfg-model-status' },
  ];

  let timers = {};
  let currentConfig = {};
  let originalKey = ''; // real key value for validation
  let originalValues = {}; // original values for change detection

  /* --- Modal open/close --- */
  btn.addEventListener('click', async () => {
    modal.classList.remove('is-hidden');
    await loadConfig();
  });
  closeBtn.addEventListener('click', () => modal.classList.add('is-hidden'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      // Don't close if user is selecting text
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) return;
      modal.classList.add('is-hidden');
    }
  });

  /* --- Load saved config --- */
  async function loadConfig() {
    try {
      const res = await fetch('/api/user/config');
      currentConfig = await res.json();
    } catch {
      currentConfig = {};
    }
    // Keep the masked key as display, but remember the masked state
    originalKey = currentConfig.llm_api_key || '';
    originalValues = {};
    fields.forEach(f => {
      const inp = document.getElementById(f.id);
      const val = currentConfig[f.key] || '';
      inp.value = val;
      inp.classList.remove('is-valid', 'is-invalid');
      setStatus(f.statusId, '');
      originalValues[f.key] = val;
    });
    // Disable save button initially (no changes)
    saveBtn.disabled = true;
  }

  /* --- Check if any field changed --- */
  function checkChanges() {
    const changed = fields.some(f => {
      const inp = document.getElementById(f.id);
      const current = inp.value.trim();
      const original = originalValues[f.key] || '';
      return current !== original;
    });
    saveBtn.disabled = !changed;
  }

  /* --- Auto-validate on input (debounced, requires all 3 fields) --- */
  fields.forEach(f => {
    const inp = document.getElementById(f.id);
    inp.addEventListener('input', () => {
      clearTimer(f.id);
      checkChanges();
      const allFilled = fields.every(ff => document.getElementById(ff.id).value.trim());
      if (!allFilled) {
        inp.classList.remove('is-valid', 'is-invalid');
        setStatus(f.statusId, '');
        return;
      }
      timers[f.id] = setTimeout(() => validateAll(), 600);
    });
  });

  function clearTimer(id) {
    if (timers[id]) { clearTimeout(timers[id]); timers[id] = null; }
  }

  /* --- Validate all fields via backend --- */
  async function validateAll() {
    const api_url = document.getElementById('cfg-api-url').value.trim();
    const api_key = document.getElementById('cfg-api-key').value.trim();
    const model = document.getElementById('cfg-model').value.trim();
    if (!api_url) return;

    // If key looks like it contains ****, don't send it — backend uses stored key
    const keyForValidation = api_key.includes('****') ? '' : api_key;

    // Show loading on all fields
    fields.forEach(f => {
      document.getElementById(f.id).classList.remove('is-valid', 'is-invalid');
      setStatus(f.statusId, '⏳', 'is-loading');
    });

    try {
      const res = await fetch('/api/llm/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_url, api_key: keyForValidation, model }),
      });
      const data = await res.json();
      const cls = data.ok ? 'is-valid' : 'is-invalid';
      const icon = data.ok ? '✓' : '✗';
      fields.forEach(f => {
        document.getElementById(f.id).classList.add(cls);
        setStatus(f.statusId, icon, data.ok ? 'is-valid' : 'is-invalid');
      });
    } catch {
      fields.forEach(f => {
        document.getElementById(f.id).classList.add('is-invalid');
        setStatus(f.statusId, '✗', 'is-invalid');
      });
    }
  }

  function setStatus(id, text, cls) {
    const el = document.getElementById(id);
    el.textContent = text;
    el.className = 'config-status' + (cls ? ' ' + cls : '');
  }

  /* --- Save --- */
  saveBtn.addEventListener('click', async () => {
    // Validate all fields are valid before saving
    const allValid = fields.every(f => {
      const inp = document.getElementById(f.id);
      return inp.classList.contains('is-valid');
    });
    if (!allValid) {
      alert(t('config.validate-fail') || '璇峰厛瀹屾垚鏈夋晥鐨勫ぇ妯″瀷閰嶇疆鏍￠獙');
      return;
    }

    const payload = {};
    fields.forEach(f => {
      const val = document.getElementById(f.id).value.trim();
      // Skip key if unchanged (still masked)
      if (f.key === 'llm_api_key' && val === originalKey) return;
      payload[f.key] = val;
    });
    if (Object.keys(payload).length === 0) {
      // Nothing to save but valid - close modal
      modal.classList.add('is-hidden');
      return;
    }
    saveBtn.disabled = true;
    try {
      const res = await fetch('/api/user/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok !== false) {
        Object.assign(currentConfig, payload);
        if (payload.llm_api_key) originalKey = payload.llm_api_key;
        // Update original values for change detection
        fields.forEach(f => {
          const inp = document.getElementById(f.id);
          originalValues[f.key] = inp.value.trim();
        });
        saveBtn.textContent = t('config.saved');
        setTimeout(() => {
          saveBtn.textContent = t('config.save');
          saveBtn.disabled = true;
          modal.classList.add('is-hidden');
        }, 800);
      } else {
        alert(data.error || t('config.save-fail') || '淇濆瓨澶辫触');
        checkChanges();
      }
    } catch (e) {
      alert(t('config.save-fail') || '淇濆瓨澶辫触');
      checkChanges();
    }
  });

  /* --- Re-apply i18n labels on language change --- */
  document.addEventListener('langchange', () => {
    saveBtn.textContent = t('config.save');
  });
})();
