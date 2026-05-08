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

  /* --- Modal open/close --- */
  btn.addEventListener('click', async () => {
    modal.classList.remove('is-hidden');
    await loadConfig();
  });
  closeBtn.addEventListener('click', () => modal.classList.add('is-hidden'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('is-hidden');
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
    fields.forEach(f => {
      const inp = document.getElementById(f.id);
      inp.value = currentConfig[f.key] || '';
      inp.classList.remove('is-valid', 'is-invalid');
      setStatus(f.statusId, '');
    });
  }

  /* --- Auto-validate on input (debounced, requires all 3 fields) --- */
  fields.forEach(f => {
    const inp = document.getElementById(f.id);
    inp.addEventListener('input', () => {
      clearTimer(f.id);
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
    const payload = {};
    fields.forEach(f => {
      const val = document.getElementById(f.id).value.trim();
      // Skip key if unchanged (still masked)
      if (f.key === 'llm_api_key' && val === originalKey) return;
      payload[f.key] = val;
    });
    if (Object.keys(payload).length === 0) return;
    saveBtn.disabled = true;
    try {
      await fetch('/api/user/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      Object.assign(currentConfig, payload);
      if (payload.llm_api_key) originalKey = payload.llm_api_key;
      saveBtn.textContent = t('config.saved');
      setTimeout(() => { saveBtn.textContent = t('config.save'); saveBtn.disabled = false; }, 1500);
    } catch {
      saveBtn.disabled = false;
    }
  });

  /* --- Re-apply i18n labels on language change --- */
  document.addEventListener('langchange', () => {
    saveBtn.textContent = t('config.save');
  });
})();
