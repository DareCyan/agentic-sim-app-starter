/* ===== Exception Tab — Full-Screen Matrix Cross-Table ===== */

const excState = {
  apps: [],          // [{category, flow}, ...]
  matrix: [],        // raw API response
  details: [],       // full issues.json (with _priority, _desc)
  // Derived
  appNames: [],      // sorted unique app names
  appFlows: {},      // app → [flows]
  // Column-based structure (L3 is the column unit)
  columns: [],       // [{id, name, example, l2_name, l1_name, ci}, ...]
  l2Groups: [],      // [{name, l1_name, colStart, colEnd}, ...]
  cellData: {},      // "app||flow||l3_name" → {primary, entries}
  totalScenarios: 0,
  // Selection
  selectedCols: new Set(), // column indices
  selectedRow: -1,         // row index (-1 = none)
  // Row mapping
  rows: [],          // [{type:'app', name, ri}, {type:'flow', name, app, ri}]
};

const excCache = { loaded: false };

const PRI_COLORS = {
  P0: '#c25450',
  P1: '#c49a4a',
  P2: '#6882b8',
  P3: '#8c919a',
};

function excParsePriority(desc) {
  const m = desc.match(/^\[(P[0-4])\]\s*/);
  return m ? { priority: m[1], desc: desc.slice(m[0].length) } : { priority: '', desc };
}

/* ===== Data Loading ===== */

async function excLoadAll() {
  if (excCache.loaded) return;
  try {
    const [apps, matrix, details] = await Promise.all([
      fetch('/api/issues/apps').then(r => r.json()),
      fetch('/api/issues/matrix').then(r => r.json()),
      fetch('/api/issues/details').then(r => r.json()),
    ]);
    excState.apps = apps || [];
    excState.matrix = matrix || [];
    excState.details = (details || []).map(d => {
      const p = excParsePriority(d.exception_description);
      return { ...d, _priority: d._priority || p.priority, _desc: p.desc };
    });
    excDeriveData();
    excCache.loaded = true;
    try {
      excBuild();
    } catch (e) {
      console.error('excBuild error:', e);
      document.getElementById('exc-matrix-wrap').innerHTML =
        '<div class="exc-empty">构建失败: ' + e.message + '</div>';
    }
  } catch (e) {
    console.error('excLoadAll error:', e);
    document.getElementById('exc-matrix-wrap').innerHTML =
      '<div class="exc-empty">加载失败: ' + e.message + '</div>';
  }
}

function excDeriveData() {
  // App names
  const appSet = new Set(excState.details.map(d => d.app));
  excState.appNames = [...appSet].sort();

  // App flows mapping (preserve order from apps CSV)
  excState.appFlows = {};
  excState.apps.forEach(a => {
    if (!excState.appFlows[a.category]) excState.appFlows[a.category] = [];
    if (!excState.appFlows[a.category].includes(a.flow)) {
      excState.appFlows[a.category].push(a.flow);
    }
  });

  // Build flat columns list from matrix API (L3-based)
  excState.columns = [];
  excState.l2Groups = [];
  let ci = 0;
  excState.matrix.forEach(group => {
    const l1Name = group.column;
    (group.types || []).forEach(l2 => {
      const l3Cols = l2.columns || [];
      const colStart = ci;
      l3Cols.forEach(col => {
        excState.columns.push({
          id: col.id,
          name: col.name,
          example: col.example || '',
          l2_name: l2.name,
          l1_name: l1Name,
          ci: ci,
        });
        ci++;
      });
      excState.l2Groups.push({
        name: l2.name,
        l1_name: l1Name,
        colStart: colStart,
        colEnd: ci - 1,
      });
    });
  });

  // Build cell data: "app||flow||l3_name" → {primary, entries}
  excState.cellData = {};
  excState.totalScenarios = 0;
  const PRI_RANK = { P0: 0, P1: 1, P2: 2, P3: 3, '': 4 };
  excState.details.forEach(d => {
    const l3Name = d.exception_l3 || d.exception_category;
    const key = d.app + '||' + d.flow + '||' + l3Name;
    if (!excState.cellData[key]) {
      excState.cellData[key] = { primary: d, entries: [] };
    }
    excState.cellData[key].entries.push(d);
    if (PRI_RANK[d._priority] < PRI_RANK[excState.cellData[key].primary._priority]) {
      excState.cellData[key].primary = d;
    }
    excState.totalScenarios += (d.questions ? d.questions.length : 0);
  });

  // Build rows array
  excState.rows = [];
  let ri = 0;
  excState.appNames.forEach(app => {
    excState.rows.push({ type: 'app', name: app, ri });
    ri++;
    const flows = excState.appFlows[app] || [];
    flows.forEach(flow => {
      excState.rows.push({ type: 'flow', name: flow, app, ri });
      ri++;
    });
  });
}

/* ===== Build ===== */

function excBuild() {
  excBuildStats();
  excBuildMatrix();
  // Bind add button
  const addBtn = document.getElementById('exc-add-btn');
  if (addBtn) addBtn.addEventListener('click', excOpenAddModal);
}

/* ===== Stats Bar ===== */

function excBuildStats() {
  const el = document.getElementById('exc-stats');
  const total = excState.details.length;
  const scenarios = excState.totalScenarios;
  const apps = excState.appNames.length;
  const flows = excState.rows.filter(r => r.type === 'flow').length;
  const colCount = excState.columns.length;
  const l2Count = excState.l2Groups.length;

  let html = '';
  html += '<div class="exc-stat-item"><span class="exc-stat-num exc-stat-accent">' + scenarios + '</span><span class="exc-stat-label">' + t('exc.stat-scenarios') + '</span></div>';
  html += '<div class="exc-stat-item"><span class="exc-stat-num">' + total + '</span><span class="exc-stat-label">' + t('exc.stat-total') + '</span></div>';
  html += '<div class="exc-stat-item"><span class="exc-stat-num">' + apps + '</span><span class="exc-stat-label">' + t('exc.stat-apps') + '</span></div>';
  html += '<div class="exc-stat-item"><span class="exc-stat-num">' + flows + '</span><span class="exc-stat-label">' + (currentLang === 'en' ? 'Flows' : '流程') + '</span></div>';
  html += '<div class="exc-stat-item"><span class="exc-stat-num">' + colCount + '</span><span class="exc-stat-label">' + t('exc.stat-types') + '</span></div>';
  html += '<div class="exc-stat-item"><span class="exc-stat-num">' + l2Count + '</span><span class="exc-stat-label">' + t('exc.stat-domains') + '</span></div>';

  // Add button
  html += '<div class="exc-stat-pri">';
  html += '<button class="exc-add-btn" id="exc-add-btn">' + t('exc.add-btn') + '</button>';
  html += '</div>';

  el.innerHTML = html;
}

/* ===== Matrix Cross-Table ===== */

function excBuildMatrix() {
  const wrap = document.getElementById('exc-matrix-wrap');
  const loading = document.getElementById('exc-matrix-loading');
  if (loading) loading.remove();

  const columns = excState.columns;
  const l2Groups = excState.l2Groups;
  const domains = excState.matrix.map(g => g.column);

  let html = '';
  html += '<div class="exc-matrix-table-wrap">';
  html += '<table class="exc-matrix-table">';

  // ===== THEAD =====
  html += '<thead>';

  // L1: Domain group headers
  html += '<tr class="exc-matrix-hr exc-matrix-hr-l1">';
  html += '<th class="exc-corner" colspan="2">';
  html += '<div class="exc-corner-inner">';
  html += '<span class="exc-corner-app">' + t('exc.matrix-app') + '</span>';
  html += '<span class="exc-corner-flow">' + (currentLang === 'en' ? 'Flow' : '流程') + '</span>';
  html += '</div></th>';
  // Build L1 colspan from l2Groups
  const l1Spans = {};
  l2Groups.forEach(g => {
    if (!l1Spans[g.l1_name]) l1Spans[g.l1_name] = 0;
    l1Spans[g.l1_name] += (g.colEnd - g.colStart + 1);
  });
  let colOffset = 0;
  domains.forEach((domain, di) => {
    const span = l1Spans[domain] || 1;
    html += '<th class="exc-domain-header exc-domain-' + di + '" colspan="' + span + '" data-col-start="' + colOffset + '" data-col-end="' + (colOffset + span - 1) + '">';
    html += '<span class="exc-domain-name">' + escHtml(domain) + '</span>';
    html += '</th>';
    colOffset += span;
  });
  html += '</tr>';

  // L2: Type names with colspan
  html += '<tr class="exc-matrix-hr exc-matrix-hr-l2">';
  html += '<th class="exc-hdr-spacer exc-domain-0" colspan="2"></th>';
  l2Groups.forEach(g => {
    const span = g.colEnd - g.colStart + 1;
    const di = domains.indexOf(g.l1_name);
    html += '<th class="exc-type-header exc-domain-' + di + '" colspan="' + span + '" data-col-start="' + g.colStart + '" data-col-end="' + g.colEnd + '">';
    html += '<span class="exc-type-name">' + escHtml(g.name) + '</span>';
    html += '</th>';
  });
  html += '</tr>';

  // L3: Column names (one per column)
  html += '<tr class="exc-matrix-hr exc-matrix-hr-l3">';
  html += '<th class="exc-hdr-spacer exc-domain-0" colspan="2"></th>';
  columns.forEach(col => {
    const di = domains.indexOf(col.l1_name);
    html += '<th class="exc-desc-header exc-domain-' + di + '" data-col="' + col.ci + '">';
    html += '<span class="exc-l3-name">' + escHtml(col.name) + '</span>';
    html += '</th>';
  });
  html += '</tr>';

  // L4: Examples (one per column)
  html += '<tr class="exc-matrix-hr exc-matrix-hr-l4">';
  html += '<th class="exc-hdr-spacer exc-domain-0" colspan="2"></th>';
  columns.forEach(col => {
    const di = domains.indexOf(col.l1_name);
    html += '<th class="exc-example-header exc-domain-' + di + '" data-col="' + col.ci + '">';
    html += '<span class="exc-example-text">' + escHtml(col.example) + '</span>';
    html += '</th>';
  });
  html += '</tr>';

  html += '</thead>';

  // ===== TBODY =====
  html += '<tbody>';
  excState.rows.forEach(row => {
    if (row.type === 'app') {
      // App header row
      const appTotal = excState.details.filter(d => d.app === row.name).length;
      html += '<tr class="exc-app-row" data-row="' + row.ri + '">';
      html += '<td class="exc-app-cell" colspan="2" data-row="' + row.ri + '">';
      html += '<div class="exc-app-label">';
      html += '<span class="exc-app-name">' + escHtml(row.name) + '</span>';
      html += '<span class="exc-app-count">' + appTotal + '</span>';
      html += '</div></td>';
      for (let ci = 0; ci < columns.length; ci++) {
        const di = domains.indexOf(columns[ci].l1_name);
        html += '<td class="exc-app-fill exc-domain-' + di + '" data-col="' + ci + '" data-row="' + row.ri + '"></td>';
      }
      html += '</tr>';
    } else {
      // Flow data row
      html += '<tr class="exc-flow-row" data-row="' + row.ri + '">';
      html += '<td class="exc-flow-cell" colspan="2" data-row="' + row.ri + '">';
      html += '<span class="exc-flow-name">' + escHtml(row.name) + '</span>';
      html += '</td>';

      // Data cells — one per L3 column
      columns.forEach(col => {
        const di = domains.indexOf(col.l1_name);
        const key = row.app + '||' + row.name + '||' + col.name;
        const cell = excState.cellData[key];

        html += '<td class="exc-cell exc-domain-' + di + '"' +
          ' data-col="' + col.ci + '"' +
          ' data-row="' + row.ri + '"' +
          ' data-key="' + escHtml(key) + '"' +
          ' data-has="' + (cell ? '1' : '0') + '">';

        if (cell) {
          const entry = cell.primary;
          const pri = entry._priority || 'P3';
          const color = PRI_COLORS[pri] || PRI_COLORS.P3;
          const count = cell.entries.length;
          html += '<div class="exc-cell-block" style="background:' + color + '">';
          html += '<span class="exc-cell-pri">' + pri + '</span>';
          html += '<span class="exc-cell-desc">' + escHtml(entry._desc.substring(0, 30)) + '</span>';
          if (count > 1) html += '<span class="exc-cell-multi">×' + count + '</span>';
          html += '</div>';
        } else {
          html += '<span class="exc-cell-empty">&mdash;</span>';
        }

        html += '</td>';
      });

      html += '</tr>';
    }
  });
  html += '</tbody>';

  html += '</table>';
  html += '</div>';

  // Legend
  html += '<div class="exc-matrix-legend">';
  html += '<span class="exc-matrix-legend-label">' + t('exc.matrix-legend') + ':</span>';
  html += '<span class="exc-matrix-legend-scale">';
  ['P0', 'P1', 'P2', 'P3'].forEach(pri => {
    const color = PRI_COLORS[pri];
    html += '<span class="exc-matrix-legend-item">';
    html += '<span class="exc-matrix-legend-block" style="background:' + color + '"></span>';
    html += '<span class="exc-matrix-legend-pri">' + pri + '</span>';
    html += '</span>';
  });
  html += '</span>';
  html += '</div>';

  wrap.innerHTML = html;

  // ===== Event bindings =====

  // L1 Domain header click → select all columns in domain
  wrap.querySelectorAll('.exc-domain-header[data-col-start]').forEach(el => {
    el.addEventListener('click', () => {
      const start = parseInt(el.dataset.colStart, 10);
      const end = parseInt(el.dataset.colEnd, 10);
      excToggleDomainCols(start, end);
    });
  });

  // L2 Type header click → select all columns in L2 group
  wrap.querySelectorAll('.exc-type-header[data-col-start]').forEach(el => {
    el.addEventListener('click', () => {
      const start = parseInt(el.dataset.colStart, 10);
      const end = parseInt(el.dataset.colEnd, 10);
      excToggleDomainCols(start, end);
    });
  });

  // L3/L4 Column header click → select single column
  wrap.querySelectorAll('[data-col]').forEach(el => {
    if (el.classList.contains('exc-domain-header') || el.classList.contains('exc-type-header')) return;
    if (el.closest('tbody') && !el.classList.contains('exc-app-fill') && !el.classList.contains('exc-cell')) return;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.exc-cell-block') || e.target.closest('.exc-cell-empty')) return;
      const ci = parseInt(el.dataset.col, 10);
      if (!isNaN(ci)) excToggleCol(ci);
    });
  });

  // Cell click → open modal
  wrap.querySelectorAll('.exc-cell[data-has]').forEach(cell => {
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      if (cell.dataset.has === '0') return;
      excOpenCellModal(cell.dataset.key);
    });
  });

  // Row header click → select row
  wrap.querySelectorAll('tr[data-row]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.exc-cell') || e.target.closest('.exc-app-fill')) return;
      const ri = parseInt(el.dataset.row, 10);
      if (!isNaN(ri)) excToggleRow(ri);
    });
  });
}

/* ===== Selection ===== */

function excToggleCol(ci) {
  const cols = excState.selectedCols;
  if (cols.has(ci) && cols.size === 1) {
    cols.clear();
  } else {
    cols.clear();
    cols.add(ci);
  }
  excApplySelection();
}

function excToggleDomainCols(start, end) {
  const cols = excState.selectedCols;
  const allSelected = [];
  for (let i = start; i <= end; i++) allSelected.push(cols.has(i));
  if (allSelected.every(Boolean)) {
    cols.clear();
  } else {
    cols.clear();
    for (let i = start; i <= end; i++) cols.add(i);
  }
  excApplySelection();
}

function excToggleRow(ri) {
  excState.selectedRow = excState.selectedRow === ri ? -1 : ri;
  excApplySelection();
}

function excApplySelection() {
  const wrap = document.getElementById('exc-matrix-wrap');
  const cols = excState.selectedCols;
  const sr = excState.selectedRow;

  wrap.querySelectorAll('.col-selected').forEach(el => el.classList.remove('col-selected'));
  wrap.querySelectorAll('.row-selected').forEach(el => el.classList.remove('row-selected'));
  wrap.querySelectorAll('.cross-selected').forEach(el => el.classList.remove('cross-selected'));

  cols.forEach(ci => {
    wrap.querySelectorAll('[data-col="' + ci + '"]').forEach(el => el.classList.add('col-selected'));
  });

  // Highlight L1/L2 headers that cover selected columns
  if (cols.size > 0) {
    wrap.querySelectorAll('[data-col-start]').forEach(el => {
      const start = parseInt(el.dataset.colStart, 10);
      const end = parseInt(el.dataset.colEnd, 10);
      let overlap = false;
      for (let i = start; i <= end; i++) {
        if (cols.has(i)) { overlap = true; break; }
      }
      if (overlap) el.classList.add('col-selected');
    });
  }

  if (sr >= 0) {
    wrap.querySelectorAll('[data-row="' + sr + '"]').forEach(el => el.classList.add('row-selected'));
  }

  if (cols.size > 0 && sr >= 0) {
    cols.forEach(ci => {
      wrap.querySelectorAll('[data-col="' + ci + '"][data-row="' + sr + '"]').forEach(el => {
        el.classList.remove('col-selected', 'row-selected');
        el.classList.add('cross-selected');
      });
    });
  }
}

/* ===== Cell Detail Modal ===== */

function excOpenCellModal(key) {
  const cell = excState.cellData[key];
  if (!cell) return;

  const body = document.getElementById('exc-modal-body');
  const title = document.getElementById('exc-modal-title-text');

  // Parse key: app||flow||l3_name
  const parts = key.split('||');
  const app = parts[0];
  const flow = parts[1];
  const l3Name = parts[2];

  if (title) title.textContent = l3Name;

  let html = '';
  const entries = cell.entries;

  html += '<div class="exc-modal-ctx">';
  html += '<span class="exc-modal-ctx-tag">' + escHtml(app) + '</span>';
  html += '<span class="exc-modal-ctx-sep">/</span>';
  html += '<span class="exc-modal-ctx-tag">' + escHtml(flow) + '</span>';
  html += '<span class="exc-modal-ctx-count">' + entries.length + ' ' + t('exc.modal-descriptions') + ' · ' + entries.reduce((s, e) => s + (e.questions ? e.questions.length : 0), 0) + ' ' + t('exc.modal-scenarios') + '</span>';
  html += '</div>';

  entries.forEach((entry, idx) => {
    const pri = entry._priority || '';
    const questions = entry.questions || [];

    html += '<div class="exc-entry-card">';
    html += '<div class="exc-entry-head">';
    if (pri) html += '<span class="exc-pri exc-pri-' + pri + '">' + pri + '</span>';
    html += '<span class="exc-entry-desc">' + escHtml(entry._desc) + '</span>';
    if (entries.length > 1) html += '<span class="exc-entry-idx">#' + (idx + 1) + '</span>';
    html += '</div>';

    if (questions.length > 0) {
      html += '<div class="exc-entry-scenarios">';
      questions.forEach((q, qi) => {
        html += '<div class="exc-q-item">';
        html += '<span class="exc-q-num">' + (qi + 1) + '</span>';
        html += '<span class="exc-q-text">' + escHtml(q) + '</span>';
        html += '<button class="exc-q-copy" data-q-enc="' + encodeURIComponent(q) + '" title="' + t('exc.copy') + '">复制</button>';
        html += '<button class="exc-q-generalize" data-q="' + escHtml(q) + '" data-app="' + escHtml(app) + '" data-flow="' + escHtml(flow) + '" data-l3="' + escHtml(l3Name) + '" title="泛化">✦ 泛化</button>';
        html += '</div>';
      });
      html += '</div>';
    }
    html += '</div>';
  });

  body.innerHTML = html;
  document.getElementById('exc-modal').classList.remove('is-hidden');
}

function excCloseModal() {
  document.getElementById('exc-modal').classList.add('is-hidden');
}

/* ===== Utilities ===== */

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

/* ===== Event Bindings ===== */

document.getElementById('exc-modal-close').addEventListener('click', excCloseModal);
document.getElementById('exc-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) excCloseModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    excCloseModal();
    excState.selectedCols.clear();
    excState.selectedRow = -1;
    excApplySelection();
  }
});

document.getElementById('exc-modal-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('.exc-q-copy');
  if (!btn) return;
  const text = decodeURIComponent(btn.dataset.qEnc || '');
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '✓';
    btn.classList.add('is-copied');
    setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('is-copied'); }, 1200);
  } catch {
    btn.textContent = '!';
    setTimeout(() => { btn.textContent = '复制'; }, 1200);
  }
});

/* ===== Generalize Functionality ===== */

let excGeneralizeData = null;

// Handle generalize button click
document.getElementById('exc-modal-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('.exc-q-generalize');
  if (!btn) return;

  // Check LLM config first
  try {
    const res = await fetch('/api/user/config');
    const cfg = await res.json();
    if (!cfg.llm_api_url || !cfg.llm_api_key) {
      alert(t('exc.add-no-llm'));
      return;
    }
  } catch {
    alert(t('exc.add-no-llm'));
    return;
  }

  excGeneralizeData = {
    question: btn.dataset.q,
    app: btn.dataset.app,
    flow: btn.dataset.flow,
    l3: btn.dataset.l3,
  };

  // Close the original modal first
  document.getElementById('exc-modal').classList.add('is-hidden');

  // Show direction selection modal
  document.getElementById('exc-generalize-source').textContent = btn.dataset.q;
  document.getElementById('exc-generalize-modal').classList.remove('is-hidden');
});

// Close generalize modal
document.getElementById('exc-generalize-close').addEventListener('click', () => {
  document.getElementById('exc-generalize-modal').classList.add('is-hidden');
});
document.getElementById('exc-generalize-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById('exc-generalize-modal').classList.add('is-hidden');
  }
});

// Row generalize
document.getElementById('exc-generalize-row').addEventListener('click', () => {
  document.getElementById('exc-generalize-modal').classList.add('is-hidden');
  excStartGeneralize('row');
});

// Column generalize
document.getElementById('exc-generalize-col').addEventListener('click', () => {
  document.getElementById('exc-generalize-modal').classList.add('is-hidden');
  excStartGeneralize('col');
});

// Start generalize process
async function excStartGeneralize(direction) {
  if (!excGeneralizeData) return;

  // Open add-modal and show loading
  document.getElementById('exc-add-modal').classList.remove('is-hidden');
  document.getElementById('exc-add-step1').classList.add('is-hidden');
  document.getElementById('exc-add-step2').classList.remove('is-hidden');
  document.getElementById('exc-add-step3').classList.add('is-hidden');

  // Update modal title for generalize
  const modalTitle = document.querySelector('#exc-add-modal .exc-modal-header span');
  const originalTitle = modalTitle.textContent;
  modalTitle.textContent = '泛化中';

  // Update loading text
  const loadingText = document.getElementById('exc-add-loading-text');
  loadingText.textContent = '✦ 泛化中...';

  try {
    const res = await fetch('/api/llm/generalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: excGeneralizeData.question,
        app: excGeneralizeData.app,
        flow: excGeneralizeData.flow,
        l3_name: excGeneralizeData.l3,
        direction: direction,
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.message || 'generalize failed');
    }

    // Hide loading, close add modal, show confirm
    document.getElementById('exc-add-step2').classList.add('is-hidden');
    document.getElementById('exc-add-modal').classList.add('is-hidden');
    modalTitle.textContent = originalTitle;
    excShowGeneralizeConfirm(data.results, direction);
  } catch (err) {
    document.getElementById('exc-add-step2').classList.add('is-hidden');
    document.getElementById('exc-add-modal').classList.add('is-hidden');
    modalTitle.textContent = originalTitle;
    alert('泛化失败: ' + err.message);
  }
}

// Show generalize confirm modal
function excShowGeneralizeConfirm(results, direction) {
  const body = document.getElementById('exc-generalize-confirm-body');
  let html = '';

  results.forEach((item, idx) => {
    const isNew = item.is_new || false;
    const skipped = item.skipped || false;

    html += '<div class="exc-generalize-item">';
    html += '<div class="exc-generalize-item-header">';
    html += '<span class="exc-generalize-item-cell">' + escHtml(item.app) + ' / ' + escHtml(item.flow) + '</span>';
    html += '<span class="exc-generalize-item-cell">' + escHtml(item.l3_name) + '</span>';
    if (skipped) {
      html += '<span class="exc-generalize-item-status skipped">跳过</span>';
    } else if (isNew) {
      html += '<span class="exc-generalize-item-status new">new</span>';
    }
    html += '</div>';

    if (!skipped) {
      if (item.new_description) {
        html += '<div class="exc-generalize-item-content"><strong>新增故障描述:</strong> ' + escHtml(item.new_description) + '</div>';
      }
      if (item.existing_description) {
        html += '<div class="exc-generalize-item-content"><strong>使用已有描述:</strong> ' + escHtml(item.existing_description) + '</div>';
      }
      if (item.new_scenario) {
        html += '<div class="exc-generalize-item-scenario">' + escHtml(item.new_scenario) + '</div>';
      }
    } else {
      html += '<div class="exc-generalize-item-content" style="color: var(--muted);">无法为此组合生成故障场景</div>';
    }

    html += '</div>';
  });

  body.innerHTML = html;
  document.getElementById('exc-generalize-confirm-modal').classList.remove('is-hidden');

  // Store results for confirmation
  excGeneralizeData.results = results;
}

// Close confirm modal
document.getElementById('exc-generalize-confirm-close').addEventListener('click', () => {
  document.getElementById('exc-generalize-confirm-modal').classList.add('is-hidden');
});
document.getElementById('exc-generalize-confirm-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById('exc-generalize-confirm-modal').classList.add('is-hidden');
  }
});

// Cancel generalize
document.getElementById('exc-generalize-cancel').addEventListener('click', () => {
  document.getElementById('exc-generalize-confirm-modal').classList.add('is-hidden');
});

// Confirm generalize insert
document.getElementById('exc-generalize-confirm').addEventListener('click', async () => {
  if (!excGeneralizeData || !excGeneralizeData.results) return;

  const btn = document.getElementById('exc-generalize-confirm');
  btn.disabled = true;
  btn.textContent = '插入中...';

  try {
    const res = await fetch('/api/issues/generalize-insert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        results: excGeneralizeData.results,
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.message || 'insert failed');
    }

    // Close modal and refresh
    document.getElementById('exc-generalize-confirm-modal').classList.add('is-hidden');
    await excLoadAll();
  } catch (err) {
    alert('插入失败: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '确认插入';
  }
});

/* ===== Add Scenario Modal ===== */

let excAddClassifyResult = null;

async function excOpenAddModal() {
  // Check LLM config first
  try {
    const res = await fetch('/api/user/config');
    const cfg = await res.json();
    if (!cfg.llm_api_url || !cfg.llm_api_key) {
      alert(t('exc.add-no-llm'));
      return;
    }
  } catch {
    alert(t('exc.add-no-llm'));
    return;
  }
  const modal = document.getElementById('exc-add-modal');
  modal.classList.remove('is-hidden');
  // Reset to step 1
  document.getElementById('exc-add-step1').classList.remove('is-hidden');
  document.getElementById('exc-add-step2').classList.add('is-hidden');
  document.getElementById('exc-add-step3').classList.add('is-hidden');
  document.getElementById('exc-add-input').value = '';
  document.getElementById('exc-add-ai-btn').disabled = false;
  excAddClassifyResult = null;
}

function excCloseAddModal() {
  document.getElementById('exc-add-modal').classList.add('is-hidden');
}

document.getElementById('exc-add-close').addEventListener('click', excCloseAddModal);
document.getElementById('exc-add-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) excCloseAddModal();
});

// AI Classify button
document.getElementById('exc-add-ai-btn').addEventListener('click', async () => {
  const input = document.getElementById('exc-add-input').value.trim();
  if (!input) return;

  const btn = document.getElementById('exc-add-ai-btn');
  btn.disabled = true;

  // Show loading
  document.getElementById('exc-add-step1').classList.add('is-hidden');
  document.getElementById('exc-add-step2').classList.remove('is-hidden');

  // Start wave animation with random words
  const loadingText = document.getElementById('exc-add-loading-text');
  const words = currentLang === 'en'
    ? ['Analyzing', 'Classifying', 'Understanding', 'Generating', 'Optimizing', 'Processing']
    : ['分析中', '识别中', '分类中', '理解中', '生成中', '优化中'];
  let wordIndex = 0;
  const wordInterval = setInterval(() => {
    wordIndex = (wordIndex + 1) % words.length;
    loadingText.textContent = '✦ ' + words[wordIndex] + '...';
  }, 800);

  try {
    const res = await fetch('/api/llm/classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: input }),
    });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.message || 'classify failed');
    }
    excAddClassifyResult = data;
    excPopulateAddForm(data);
    // Show step 3
    document.getElementById('exc-add-step2').classList.add('is-hidden');
    document.getElementById('exc-add-step3').classList.remove('is-hidden');
  } catch (err) {
    document.getElementById('exc-add-step2').classList.add('is-hidden');
    document.getElementById('exc-add-step1').classList.remove('is-hidden');
    btn.disabled = false;
    alert(t('exc.add-error') + ': ' + err.message);
  } finally {
    clearInterval(wordInterval);
  }
});

function excPopulateAddForm(data) {
  // Populate app dropdown
  const appSel = document.getElementById('exc-add-app');
  appSel.innerHTML = '';
  const appNames = [...excState.appNames];
  // If AI returned a new app not in list, add it
  if (data.app && !appNames.includes(data.app)) {
    appNames.push(data.app);
  }
  appNames.forEach(name => {
    appSel.innerHTML += '<option value="' + escHtml(name) + '">' + escHtml(name) + '</option>';
  });
  appSel.innerHTML += '<option value="__new__">' + t('exc.add-new-app') + '</option>';
  appSel.value = data.app || appNames[0] || '';
  excHandleAppChange();

  // Populate flow dropdown — pass AI result so new flows can be added
  excUpdateFlowOptions(appSel.value, data.flow);
  if (data.flow) {
    document.getElementById('exc-add-flow').value = data.flow;
  }

  // Populate L2 dropdown
  const l2Sel = document.getElementById('exc-add-l2');
  l2Sel.innerHTML = '';
  excState.l2Groups.forEach(g => {
    l2Sel.innerHTML += '<option value="' + escHtml(g.name) + '" data-l1="' + escHtml(g.l1_name) + '">' + escHtml(g.name) + ' (' + escHtml(g.l1_name) + ')</option>';
  });
  l2Sel.innerHTML += '<option value="__new__">' + t('exc.add-new-l2') + '</option>';
  // If AI returned an L2 not in the list, select "new" and pre-fill
  const existingL2Names = excState.l2Groups.map(g => g.name);
  if (data.l2_category && !existingL2Names.includes(data.l2_category)) {
    l2Sel.value = '__new__';
    document.getElementById('exc-add-new-l2').classList.remove('is-hidden');
    document.getElementById('exc-add-new-l2').value = data.l2_category;
  } else {
    l2Sel.value = data.l2_category || '';
    document.getElementById('exc-add-new-l2').classList.add('is-hidden');
  }

  // Populate L3 dropdown for the selected L2
  excUpdateL3Options(data.l2_category);
  // Check if L3 exists in current columns
  const existingL3Names = excState.columns.map(c => c.name);
  const l3Label = document.querySelector('[data-i18n="exc.add-l3"]');
  const oldBadge = l3Label ? l3Label.querySelector('.exc-add-new-badge') : null;
  if (oldBadge) oldBadge.remove();
  if (data.l3_name && !existingL3Names.includes(data.l3_name)) {
    // New L3 — select __new__ and pre-fill
    document.getElementById('exc-add-l3').value = '__new__';
    const newL3Input = document.getElementById('exc-add-new-l3');
    newL3Input.classList.remove('is-hidden');
    newL3Input.value = data.l3_name;
    // Add "new" badge next to label
    if (l3Label) {
      const badge = document.createElement('span');
      badge.className = 'exc-add-new-badge';
      badge.textContent = 'new';
      l3Label.appendChild(badge);
    }
  } else {
    document.getElementById('exc-add-l3').value = data.l3_name || '';
    document.getElementById('exc-add-new-l3').classList.add('is-hidden');
  }

  // Set description - check if existing description exists for this combination
  excUpdateDescription();

  // Pre-fill questions with user's original input
  const userInput = document.getElementById('exc-add-input').value.trim();
  if (userInput) {
    document.getElementById('exc-add-questions').value = userInput;
  }

  // Set priority
  document.getElementById('exc-add-pri').value = data.priority || 'P2';

  // Check if app is generic-eligible
  if (data.app && data.app !== '通用' && !excState.appNames.includes(data.app)) {
    document.getElementById('exc-add-generic-prompt').classList.remove('is-hidden');
    document.getElementById('exc-add-generic-prompt').dataset.newApp = data.app;
  } else {
    document.getElementById('exc-add-generic-prompt').classList.add('is-hidden');
  }
}

function excHandleAppChange() {
  const appSel = document.getElementById('exc-add-app');
  const newAppInput = document.getElementById('exc-add-new-app');
  if (appSel.value === '__new__') {
    newAppInput.classList.remove('is-hidden');
    newAppInput.value = excAddClassifyResult ? excAddClassifyResult.app : '';
    // Also show new flow input since the app is new
    const flowSel = document.getElementById('exc-add-flow');
    const newFlowInput = document.getElementById('exc-add-new-flow');
    flowSel.innerHTML = '<option value="__new__">' + t('exc.add-new-flow') + '</option>';
    flowSel.value = '__new__';
    newFlowInput.classList.remove('is-hidden');
    newFlowInput.value = excAddClassifyResult ? excAddClassifyResult.flow : '';
  } else {
    newAppInput.classList.add('is-hidden');
    excUpdateFlowOptions(appSel.value, excAddClassifyResult ? excAddClassifyResult.flow : null);
  }
  excUpdateDescription();
}

function excUpdateFlowOptions(appName, aiFlow) {
  const flowSel = document.getElementById('exc-add-flow');
  const newFlowInput = document.getElementById('exc-add-new-flow');
  flowSel.innerHTML = '';
  const flows = [...(excState.appFlows[appName] || [])];
  // If AI returned a new flow not in list, add it
  if (aiFlow && !flows.includes(aiFlow)) {
    flows.push(aiFlow);
  }
  flows.forEach(f => {
    flowSel.innerHTML += '<option value="' + escHtml(f) + '">' + escHtml(f) + '</option>';
  });
  flowSel.innerHTML += '<option value="__new__">' + t('exc.add-new-flow') + '</option>';
  // Show/hide new flow input
  newFlowInput.classList.add('is-hidden');
  flowSel.onchange = () => {
    if (flowSel.value === '__new__') {
      newFlowInput.classList.remove('is-hidden');
      newFlowInput.value = excAddClassifyResult ? excAddClassifyResult.flow : '';
    } else {
      newFlowInput.classList.add('is-hidden');
    }
    excUpdateDescription();
  };
}

function excUpdateL3Options(l2Name) {
  const l3Sel = document.getElementById('exc-add-l3');
  const newL3Input = document.getElementById('exc-add-new-l3');
  l3Sel.innerHTML = '';
  excState.columns.forEach(col => {
    if (col.l2_name === l2Name) {
      l3Sel.innerHTML += '<option value="' + escHtml(col.name) + '">' + escHtml(col.name) + '</option>';
    }
  });
  l3Sel.innerHTML += '<option value="__new__">' + t('exc.add-new-l3') + '...</option>';
  l3Sel.onchange = () => {
    if (l3Sel.value === '__new__') {
      newL3Input.classList.remove('is-hidden');
    } else {
      newL3Input.classList.add('is-hidden');
    }
    excUpdateDescription();
  };
}

// Update description based on current selection
function excUpdateDescription() {
  const appSel = document.getElementById('exc-add-app');
  const flowSel = document.getElementById('exc-add-flow');
  const l2Sel = document.getElementById('exc-add-l2');
  const l3Sel = document.getElementById('exc-add-l3');
  const descInput = document.getElementById('exc-add-desc');

  const app = appSel.value === '__new__' ? document.getElementById('exc-add-new-app').value.trim() : appSel.value;
  const flow = flowSel.value === '__new__' ? document.getElementById('exc-add-new-flow').value.trim() : flowSel.value;
  const l2_name = l2Sel.value === '__new__' ? document.getElementById('exc-add-new-l2').value.trim() : l2Sel.value;
  const l3_name = l3Sel.value === '__new__' ? document.getElementById('exc-add-new-l3').value.trim() : l3Sel.value;

  if (!app || !flow || !l2_name || !l3_name) {
    // Use AI result if available, otherwise use user input
    descInput.value = excAddClassifyResult ? excAddClassifyResult.description : document.getElementById('exc-add-input').value.trim();
    return;
  }

  // Check if this combination already exists in the matrix
  const key = app + '||' + flow + '||' + l3_name;
  const existingCell = excState.cellData[key];

  if (existingCell) {
    // Use existing description
    descInput.value = existingCell.primary._desc;
  } else {
    // Use AI generated description
    descInput.value = excAddClassifyResult ? excAddClassifyResult.description : document.getElementById('exc-add-input').value.trim();
  }
}

// App change handler
document.getElementById('exc-add-app').addEventListener('change', excHandleAppChange);

// L2 change handler
document.getElementById('exc-add-l2').addEventListener('change', () => {
  const l2Sel = document.getElementById('exc-add-l2');
  const newL2Input = document.getElementById('exc-add-new-l2');
  if (l2Sel.value === '__new__') {
    newL2Input.classList.remove('is-hidden');
  } else {
    newL2Input.classList.add('is-hidden');
  }
  excUpdateL3Options(l2Sel.value === '__new__' ? '' : l2Sel.value);
  // Remove "new" badge from L3 label
  const l3Label = document.querySelector('[data-i18n="exc.add-l3"]');
  const badge = l3Label ? l3Label.querySelector('.exc-add-new-badge') : null;
  if (badge) badge.remove();
  // Update description
  excUpdateDescription();
});

// Generic app choice
document.getElementById('exc-add-use-generic').addEventListener('click', () => {
  document.getElementById('exc-add-app').value = '通用';
  excHandleAppChange();
  document.getElementById('exc-add-generic-prompt').classList.add('is-hidden');
});
document.getElementById('exc-add-create-new-app').addEventListener('click', () => {
  document.getElementById('exc-add-app').value = '__new__';
  excHandleAppChange();
  const newAppInput = document.getElementById('exc-add-new-app');
  newAppInput.value = document.getElementById('exc-add-generic-prompt').dataset.newApp || '';
  document.getElementById('exc-add-generic-prompt').classList.add('is-hidden');
});

// Update description when typing in new option inputs
document.getElementById('exc-add-new-app').addEventListener('input', excUpdateDescription);
document.getElementById('exc-add-new-flow').addEventListener('input', excUpdateDescription);
document.getElementById('exc-add-new-l2').addEventListener('input', excUpdateDescription);
document.getElementById('exc-add-new-l3').addEventListener('input', excUpdateDescription);

// Confirm insert
document.getElementById('exc-add-confirm').addEventListener('click', async () => {
  const btn = document.getElementById('exc-add-confirm');
  btn.disabled = true;

  const appSel = document.getElementById('exc-add-app');
  const app = appSel.value === '__new__' ? document.getElementById('exc-add-new-app').value.trim() : appSel.value;
  const flowSel = document.getElementById('exc-add-flow');
  const flow = flowSel.value === '__new__' ? document.getElementById('exc-add-new-flow').value.trim() : flowSel.value;
  const l2Sel = document.getElementById('exc-add-l2');
  const l2_name = l2Sel.value === '__new__' ? document.getElementById('exc-add-new-l2').value.trim() : l2Sel.value;
  const l1_name = l2Sel.value === '__new__'
    ? (excAddClassifyResult ? excAddClassifyResult.l1_name || '' : '')
    : (l2Sel.options[l2Sel.selectedIndex]?.dataset.l1 || '');
  const l3Sel = document.getElementById('exc-add-l3');
  const l3_name = l3Sel.value === '__new__' ? document.getElementById('exc-add-new-l3').value.trim() : l3Sel.value;
  const description = document.getElementById('exc-add-desc').value.trim();
  const priority = document.getElementById('exc-add-pri').value;
  const questionsRaw = document.getElementById('exc-add-questions').value.trim();
  const questions = questionsRaw ? questionsRaw.split('\n').map(s => s.trim()).filter(Boolean) : [];

  if (!app || !flow || !l2_name || !l3_name || !description) {
    btn.disabled = false;
    return;
  }

  try {
    const res = await fetch('/api/issues/insert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description, app, flow, l2_name, l3_name, l1_name, priority,
        questions,
        new_app_category: appSel.value === '__new__' ? app : null,
        new_flow: flowSel.value === '__new__' ? flow : null,
        new_l2: l2Sel.value === '__new__' ? l2_name : null,
      }),
    });
    const data = await res.json();
    if (data.ok) {
      excCloseAddModal();
      await excLoadAll();
    } else {
      alert(data.message || 'insert failed');
    }
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener('langchange', () => {
  if (excCache.loaded) excBuild();
});
