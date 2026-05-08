/* ===== Exception Tab — Full-Screen Matrix Cross-Table ===== */

const excState = {
  apps: [],          // [{category, flow}, ...]
  matrix: [],        // [{column, types: [{name, description, example}]}, ...]
  details: [],       // full issues.json (with _priority, _desc)
  // Derived
  appNames: [],      // sorted unique app names
  appFlows: {},      // app → [flows]
  types: [],         // all exception types in CSV order
  typeDomain: {},    // type → domain name
  domainTypes: {},   // domain → [types]
  typeDesc: {},      // type → description
  typeExample: {},   // type → example
  cellData: {},      // "app||flow||type" → {primary, entries}
  totalScenarios: 0, // total questions count
  // Selection
  selectedCols: new Set(), // column indices
  selectedRow: -1,         // row index (-1 = none)
  // Row mapping
  rows: [],          // [{type:'app', name, ri}, {type:'flow', name, app, ri}]
};

const excCache = { loaded: false };

const PRI_COLORS = {
  P0: '#dc2626',  // red
  P1: '#d97706',  // orange
  P2: '#2563eb',  // blue
  P3: '#6b7280',  // gray
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

  // Types in CSV order, with domain/desc/example mapping
  excState.types = [];
  excState.typeDomain = {};
  excState.domainTypes = {};
  excState.typeDesc = {};
  excState.typeExample = {};

  excState.matrix.forEach(group => {
    const domain = group.column;
    excState.domainTypes[domain] = [];
    (group.types || []).forEach(t => {
      excState.types.push(t.name);
      excState.typeDomain[t.name] = domain;
      excState.domainTypes[domain].push(t.name);
      excState.typeDesc[t.name] = t.description || '';
      excState.typeExample[t.name] = t.example || '';
    });
  });

  // Build cell data: "app||flow||category" → {entry (highest pri), entries: []}
  excState.cellData = {};
  excState.totalScenarios = 0;
  const PRI_RANK = { P0: 0, P1: 1, P2: 2, P3: 3, '': 4 };
  excState.details.forEach(d => {
    const key = d.app + '||' + d.flow + '||' + d.exception_category;
    if (!excState.cellData[key]) {
      excState.cellData[key] = { primary: d, entries: [] };
    }
    excState.cellData[key].entries.push(d);
    // Keep highest priority as primary
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
}

/* ===== Stats Bar ===== */

function excBuildStats() {
  const el = document.getElementById('exc-stats');
  const total = excState.details.length;
  const scenarios = excState.totalScenarios;
  const apps = excState.appNames.length;
  const flows = excState.rows.filter(r => r.type === 'flow').length;
  const types = excState.types.length;
  const domains = excState.matrix.length;

  let html = '';
  html += '<div class="exc-stat-item"><span class="exc-stat-num exc-stat-accent">' + scenarios + '</span><span class="exc-stat-label">' + t('exc.stat-scenarios') + '</span></div>';
  html += '<div class="exc-stat-item"><span class="exc-stat-num">' + total + '</span><span class="exc-stat-label">' + t('exc.stat-total') + '</span></div>';
  html += '<div class="exc-stat-item"><span class="exc-stat-num">' + apps + '</span><span class="exc-stat-label">' + t('exc.stat-apps') + '</span></div>';
  html += '<div class="exc-stat-item"><span class="exc-stat-num">' + flows + '</span><span class="exc-stat-label">' + (currentLang === 'en' ? 'Flows' : '流程') + '</span></div>';
  html += '<div class="exc-stat-item"><span class="exc-stat-num">' + types + '</span><span class="exc-stat-label">' + t('exc.stat-types') + '</span></div>';
  html += '<div class="exc-stat-item"><span class="exc-stat-num">' + domains + '</span><span class="exc-stat-label">' + t('exc.stat-domains') + '</span></div>';

  // Priority breakdown
  const priCounts = {};
  excState.details.forEach(d => { priCounts[d._priority] = (priCounts[d._priority] || 0) + 1; });
  html += '<div class="exc-stat-pri">';
  ['P0', 'P1', 'P2', 'P3'].forEach(p => {
    const cnt = priCounts[p] || 0;
    if (cnt > 0) {
      html += '<span class="exc-stat-pri-chip exc-pri-' + p + '">' + p + ' <b>' + cnt + '</b></span>';
    }
  });
  html += '</div>';

  el.innerHTML = html;
}

/* ===== Matrix Cross-Table ===== */

function excBuildMatrix() {
  const wrap = document.getElementById('exc-matrix-wrap');
  const loading = document.getElementById('exc-matrix-loading');
  if (loading) loading.remove();

  const domains = excState.matrix.map(g => g.column);
  const types = excState.types;

  let html = '';
  html += '<div class="exc-matrix-table-wrap">';
  html += '<table class="exc-matrix-table">';

  // ===== THEAD: 4 layers =====
  html += '<thead>';

  // L1: Domain group headers
  html += '<tr class="exc-matrix-hr exc-matrix-hr-l1">';
  html += '<th class="exc-corner" colspan="2">';
  html += '<div class="exc-corner-inner">';
  html += '<span class="exc-corner-app">' + t('exc.matrix-app') + '</span>';
  html += '<span class="exc-corner-flow">' + (currentLang === 'en' ? 'Flow' : '流程') + '</span>';
  html += '</div></th>';
  let colOffset = 0;
  domains.forEach((domain, di) => {
    const count = (excState.domainTypes[domain] || []).length;
    html += '<th class="exc-domain-header exc-domain-' + di + '" colspan="' + count + '" data-col-start="' + colOffset + '" data-col-end="' + (colOffset + count - 1) + '">';
    html += '<span class="exc-domain-name">' + escHtml(domain) + '</span>';
    html += '</th>';
    colOffset += count;
  });
  html += '</tr>';

  // L2: Exception type names
  html += '<tr class="exc-matrix-hr exc-matrix-hr-l2">';
  html += '<th class="exc-hdr-spacer exc-domain-0" colspan="2"></th>';
  types.forEach((type, ti) => {
    const di = domains.indexOf(excState.typeDomain[type]);
    html += '<th class="exc-type-header exc-domain-' + di + '" data-col="' + ti + '">';
    html += '<span class="exc-type-name">' + escHtml(type) + '</span>';
    html += '</th>';
  });
  html += '</tr>';

  // L3: Descriptions
  html += '<tr class="exc-matrix-hr exc-matrix-hr-l3">';
  html += '<th class="exc-hdr-spacer exc-domain-0" colspan="2"></th>';
  types.forEach((type, ti) => {
    const di = domains.indexOf(excState.typeDomain[type]);
    html += '<th class="exc-desc-header exc-domain-' + di + '" data-col="' + ti + '">';
    html += '<span class="exc-desc-text">' + escHtml(excState.typeDesc[type]) + '</span>';
    html += '</th>';
  });
  html += '</tr>';

  // L4: Examples
  html += '<tr class="exc-matrix-hr exc-matrix-hr-l4">';
  html += '<th class="exc-hdr-spacer exc-domain-0" colspan="2"></th>';
  types.forEach((type, ti) => {
    const di = domains.indexOf(excState.typeDomain[type]);
    html += '<th class="exc-example-header exc-domain-' + di + '" data-col="' + ti + '">';
    html += '<span class="exc-example-text">' + escHtml(excState.typeExample[type]) + '</span>';
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
      // Fill remaining columns
      for (let ti = 0; ti < types.length; ti++) {
        const di = domains.indexOf(excState.typeDomain[types[ti]]);
        html += '<td class="exc-app-fill exc-domain-' + di + '" data-col="' + ti + '" data-row="' + row.ri + '"></td>';
      }
      html += '</tr>';
    } else {
      // Flow data row
      html += '<tr class="exc-flow-row" data-row="' + row.ri + '">';
      html += '<td class="exc-flow-cell" colspan="2" data-row="' + row.ri + '">';
      html += '<span class="exc-flow-name">' + escHtml(row.name) + '</span>';
      html += '</td>';

      // Data cells
      types.forEach((type, ti) => {
        const di = domains.indexOf(excState.typeDomain[type]);
        const key = row.app + '||' + row.name + '||' + type;
        const cell = excState.cellData[key];

        html += '<td class="exc-cell exc-domain-' + di + '"' +
          ' data-col="' + ti + '"' +
          ' data-row="' + row.ri + '"' +
          ' data-key="' + key + '"' +
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

  // Legend — priority colors
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

  // L2-L4 Column header click → select single column
  wrap.querySelectorAll('[data-col]').forEach(el => {
    if (el.classList.contains('exc-domain-header')) return;
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

  // Row header click → select row (only on <tr> to avoid double-toggle from <td> bubbling)
  wrap.querySelectorAll('tr[data-row]').forEach(el => {
    el.addEventListener('click', (e) => {
      // Don't trigger row select when clicking data cells
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

  // Clear all
  wrap.querySelectorAll('.col-selected').forEach(el => el.classList.remove('col-selected'));
  wrap.querySelectorAll('.row-selected').forEach(el => el.classList.remove('row-selected'));
  wrap.querySelectorAll('.cross-selected').forEach(el => el.classList.remove('cross-selected'));

  // Highlight selected columns
  cols.forEach(ci => {
    wrap.querySelectorAll('[data-col="' + ci + '"]').forEach(el => el.classList.add('col-selected'));
  });

  // Highlight domain headers that cover selected columns
  if (cols.size > 0) {
    wrap.querySelectorAll('.exc-domain-header[data-col-start]').forEach(el => {
      const start = parseInt(el.dataset.colStart, 10);
      const end = parseInt(el.dataset.colEnd, 10);
      let overlap = false;
      for (let i = start; i <= end; i++) {
        if (cols.has(i)) { overlap = true; break; }
      }
      if (overlap) el.classList.add('col-selected');
    });
  }

  // Highlight selected row
  if (sr >= 0) {
    wrap.querySelectorAll('[data-row="' + sr + '"]').forEach(el => el.classList.add('row-selected'));
  }

  // Cross highlight (row × column intersection)
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

  // Parse key: app||flow||category
  const parts = key.split('||');
  const app = parts[0];
  const flow = parts[1];
  const cat = parts[2];

  if (title) title.textContent = cat;

  let html = '';
  const entries = cell.entries;

  // Header context bar
  html += '<div class="exc-modal-ctx">';
  html += '<span class="exc-modal-ctx-tag">' + escHtml(app) + '</span>';
  html += '<span class="exc-modal-ctx-sep">/</span>';
  html += '<span class="exc-modal-ctx-tag">' + escHtml(flow) + '</span>';
  html += '<span class="exc-modal-ctx-count">' + entries.length + ' ' + t('exc.modal-descriptions') + ' · ' + entries.reduce((s, e) => s + (e.questions ? e.questions.length : 0), 0) + ' ' + t('exc.modal-scenarios') + '</span>';
  html += '</div>';

  // Entry cards
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
        html += '<button class="exc-q-copy" data-q="' + escHtml(q) + '" title="' + t('exc.copy') + '">📋</button>';
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

// Modal close
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

// Copy button inside modal
document.getElementById('exc-modal-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('.exc-q-copy');
  if (!btn) return;
  const text = btn.dataset.q;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '✓';
    btn.classList.add('is-copied');
    setTimeout(() => { btn.textContent = '📋'; btn.classList.remove('is-copied'); }, 1200);
  } catch {
    btn.textContent = '!';
    setTimeout(() => { btn.textContent = '📋'; }, 1200);
  }
});

// Language change
document.addEventListener('langchange', () => {
  if (excCache.loaded) excBuild();
});
