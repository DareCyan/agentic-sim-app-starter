/* ===== Sim-Build Tab — Image Simulation APP ===== */

const simBuild = {
  pollTimer: null,
  screenTimer: null,
  state: 'idle',
  step: -1,
  logs: [],
  deviceId: '',
  resolution: { width: 0, height: 0 },
  screenBlobUrl: null,
  // Touch tracking
  touchStart: null,
  touchMoved: false,
  mirrorStandalone: false,
};

// ===== DOM refs =====
const simEls = {
  badge: document.getElementById('sim-state-badge'),
  btn: document.getElementById('sim-run-btn'),
  steps: document.getElementById('sim-steps'),
  log: document.getElementById('sim-log'),
  deviceSelect: document.getElementById('sim-device-select'),
  deviceManual: document.getElementById('sim-device-manual'),
  deviceRefresh: document.getElementById('sim-device-refresh'),
  screenImg: document.getElementById('sim-screen-img'),
  screenCanvas: document.getElementById('sim-screen-canvas'),
  screenViewport: document.getElementById('sim-screen-viewport'),
  screenPlaceholder: document.getElementById('sim-screen-placeholder'),
};

// ===== Device list =====

function simFetchDevices() {
  simEls.deviceSelect.innerHTML = '<option value="" data-i18n="sim.device-loading">' + t('sim.device-loading') + '</option>';
  fetch('/api/sim-build/devices', { cache: 'no-store' })
    .then(r => r.json())
    .then(data => {
      const devices = data.devices || [];
      let html = '';
      if (devices.length === 0) {
        html += '<option value="" disabled>' + t('sim.device-none') + '</option>';
      } else {
        devices.forEach(d => {
          html += '<option value="' + d + '">' + d + '</option>';
        });
      }
      html += '<option value="__manual__">' + t('sim.device-manual') + '</option>';
      simEls.deviceSelect.innerHTML = html;
      // Show/hide manual input
      simDeviceToggleManual();
    })
    .catch(() => {
      simEls.deviceSelect.innerHTML = '<option value="__manual__">' + t('sim.device-manual') + '</option>';
      simDeviceToggleManual();
    });
}

function simDeviceToggleManual() {
  const isManual = simEls.deviceSelect.value === '__manual__';
  simEls.deviceManual.classList.toggle('is-hidden', !isManual);
  if (!isManual && simEls.deviceSelect.value) {
    simStartMirror(simEls.deviceSelect.value);
  }
}

function simStartMirror(deviceId) {
  if (!deviceId) return;
  simBuild.deviceId = deviceId;
  simBuild.mirrorStandalone = true;
  fetch('/api/sim-build/mirror', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
  }).then(() => {
    simScreenPollStart();
  }).catch(() => {});
}

simEls.deviceSelect.addEventListener('change', simDeviceToggleManual);
simEls.deviceRefresh.addEventListener('click', simFetchDevices);

// ===== Status polling =====

function simBuildRefresh() {
  fetch('/api/sim-build/status', { cache: 'no-store' })
    .then(r => r.json())
    .then(data => {
      const prevState = simBuild.state;
      simBuild.state = data.state || 'idle';
      simBuild.step = data.step ?? -1;
      simBuild.logs = data.logs || [];
      simBuildRender();
      // Start screen polling when running (handles tab switch + state transition)
      if (simBuild.state === 'running' && !simBuild.screenTimer) {
        simScreenPollStart();
      }
      // Stop screen polling when done/error (unless mirror was started independently)
      if ((simBuild.state === 'done' || simBuild.state === 'error') && simBuild.screenTimer && !simBuild.mirrorStandalone) {
        setTimeout(() => simScreenPollStop(), 2000);
      }
    })
    .catch(() => {});
}

function simBuildRender() {
  // State badge
  const stateLabels = { idle: '', running: t('sim.state-running'), done: t('sim.state-done'), error: t('sim.state-error') };
  simEls.badge.textContent = stateLabels[simBuild.state] || '';
  simEls.badge.className = 'sim-state-badge' + (simBuild.state !== 'idle' ? ' sim-state-' + simBuild.state : '');

  // Run button
  simEls.btn.disabled = simBuild.state === 'running';

  // Steps
  const steps = simEls.steps.querySelectorAll('.sim-step');
  steps.forEach((el, i) => {
    el.classList.remove('is-active', 'is-done', 'is-error');
    if (simBuild.state === 'error' && i === simBuild.step) {
      el.classList.add('is-error');
    } else if (i < simBuild.step) {
      el.classList.add('is-done');
    } else if (i === simBuild.step && simBuild.state === 'running') {
      el.classList.add('is-active');
    }
  });

  // Logs
  if (simBuild.logs.length > 0) {
    simEls.log.textContent = simBuild.logs.join('\n');
    simEls.log.scrollTop = simEls.log.scrollHeight;
  } else {
    simEls.log.textContent = t('sim.log-empty');
  }
}

// ===== Start flow =====

function simGetSelectedDevice() {
  const sel = simEls.deviceSelect.value;
  if (sel === '__manual__') {
    return simEls.deviceManual.value.trim();
  }
  return sel;
}

function simBuildStart() {
  const deviceId = simGetSelectedDevice();
  if (!deviceId) {
    if (simEls.deviceSelect.value === '__manual__') simEls.deviceManual.focus();
    else simEls.deviceSelect.focus();
    return;
  }
  simBuild.deviceId = deviceId;
  simBuild.mirrorStandalone = false;

  fetch('/api/sim-build/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.ok) {
        simBuildPollStart();
      }
    })
    .catch(() => {});
}

function simBuildPollStart() {
  if (simBuild.pollTimer) return;
  simBuild.pollTimer = setInterval(() => {
    simBuildRefresh();
    if (simBuild.state === 'done' || simBuild.state === 'error') {
      simBuildPollStop();
    }
  }, 1000);
}

function simBuildPollStop() {
  if (simBuild.pollTimer) {
    clearInterval(simBuild.pollTimer);
    simBuild.pollTimer = null;
  }
}

// ===== Screen mirror =====

function simScreenPollStart() {
  if (simBuild.screenTimer) return;
  // Fetch resolution once
  simScreenFetchResolution();
  // Start frame polling
  simBuild.screenTimer = setInterval(simScreenFetchFrame, 400);
  // Show screen UI
  simEls.screenImg.classList.add('is-visible');
  simEls.screenCanvas.classList.add('is-visible');
  simEls.screenPlaceholder.classList.add('is-hidden');
}

function simScreenPollStop() {
  if (simBuild.screenTimer) {
    clearInterval(simBuild.screenTimer);
    simBuild.screenTimer = null;
  }
}

function simScreenFetchResolution() {
  fetch('/api/sim-build/resolution', { cache: 'no-store' })
    .then(r => r.json())
    .then(data => {
      if (data.width > 0 && data.height > 0) {
        simBuild.resolution = data;
        simScreenResizeCanvas();
      }
    })
    .catch(() => {});
}

function simScreenFetchFrame() {
  fetch('/api/sim-build/screen', { cache: 'no-store' })
    .then(r => {
      if (!r.ok) return;
      return r.blob();
    })
    .then(blob => {
      if (!blob) return;
      if (simBuild.screenBlobUrl) URL.revokeObjectURL(simBuild.screenBlobUrl);
      simBuild.screenBlobUrl = URL.createObjectURL(blob);
      simEls.screenImg.src = simBuild.screenBlobUrl;
    })
    .catch(() => {});
}

function simScreenResizeCanvas() {
  const canvas = simEls.screenCanvas;
  const img = simEls.screenImg;
  // Set canvas internal resolution to match device screen
  if (simBuild.resolution.width > 0) {
    canvas.width = simBuild.resolution.width;
    canvas.height = simBuild.resolution.height;
  }
}

// ===== Input control =====

function simScreenGetDeviceCoords(clientX, clientY) {
  const img = simEls.screenImg;
  const rect = img.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;

  // Image display area
  const imgAspect = simBuild.resolution.width / simBuild.resolution.height;
  const rectAspect = rect.width / rect.height;
  let drawW, drawH, offsetX, offsetY;
  if (imgAspect > rectAspect) {
    // Image is wider than container — fit width
    drawW = rect.width;
    drawH = rect.width / imgAspect;
    offsetX = 0;
    offsetY = (rect.height - drawH) / 2;
  } else {
    // Image is taller — fit height
    drawH = rect.height;
    drawW = rect.height * imgAspect;
    offsetX = (rect.width - drawW) / 2;
    offsetY = 0;
  }

  const relX = clientX - rect.left - offsetX;
  const relY = clientY - rect.top - offsetY;
  if (relX < 0 || relY < 0 || relX > drawW || relY > drawH) return null;

  const devX = Math.round((relX / drawW) * simBuild.resolution.width);
  const devY = Math.round((relY / drawH) * simBuild.resolution.height);
  return { x: devX, y: devY };
}

function simSendInput(data) {
  if (!simBuild.deviceId) return;
  fetch('/api/sim-build/input?device_id=' + encodeURIComponent(simBuild.deviceId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).catch(() => {});
}

// Canvas touch/mouse events
simEls.screenCanvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const coords = simScreenGetDeviceCoords(e.clientX, e.clientY);
  if (!coords) return;
  simBuild.touchStart = coords;
  simBuild.touchMoved = false;
});

simEls.screenCanvas.addEventListener('mousemove', (e) => {
  if (!simBuild.touchStart) return;
  simBuild.touchMoved = true;
});

simEls.screenCanvas.addEventListener('mouseup', (e) => {
  e.preventDefault();
  if (!simBuild.touchStart) return;
  const endCoords = simScreenGetDeviceCoords(e.clientX, e.clientY);
  if (!endCoords) { simBuild.touchStart = null; return; }

  if (simBuild.touchMoved) {
    // Swipe
    const dx = Math.abs(endCoords.x - simBuild.touchStart.x);
    const dy = Math.abs(endCoords.y - simBuild.touchStart.y);
    if (dx > 20 || dy > 20) {
      simSendInput({
        action: 'swipe',
        x: simBuild.touchStart.x, y: simBuild.touchStart.y,
        x2: endCoords.x, y2: endCoords.y,
        duration: 300,
      });
    }
  } else {
    // Tap
    simSendInput({ action: 'tap', x: simBuild.touchStart.x, y: simBuild.touchStart.y });
  }
  simBuild.touchStart = null;
  simBuild.touchMoved = false;
});

simEls.screenCanvas.addEventListener('mouseleave', () => {
  simBuild.touchStart = null;
  simBuild.touchMoved = false;
});

// Key buttons
document.querySelectorAll('.sim-key-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.key;
    if (key) simSendInput({ action: 'key', key });
  });
});

// ===== Event bindings =====

simEls.btn.addEventListener('click', simBuildStart);
simEls.deviceManual.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') simBuildStart();
});

// Language change
document.addEventListener('langchange', () => {
  simBuildRender();
});

// Init: fetch device list
simFetchDevices();
