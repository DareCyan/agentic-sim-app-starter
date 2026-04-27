/* ===== Exception Tab ===== */

const excState = {
  apps: [],
  matrix: [],
  details: [],
  filtered: [],
  sortKey: null,
  sortAsc: true,
  page: 1,
  pageSize: 50,
  searchTerm: '',
  filterApp: '',
  filterFlow: '',
  filterCol: '',
  filterPri: '',
  treeFilter: '',
  treeOpen: {},
  filterCategory: '',
};

const excCache = { loaded: false };

function excParsePriority(desc) {
  const m = desc.match(/^\[(P[0-4])\]\s*/);
  return m ? { priority: m[1], desc: desc.slice(m[0].length) } : { priority: '', desc };
}

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
      return { ...d, _priority: p.priority, _desc: p.desc };
    });
    excCache.loaded = true;
    try {
      excBuild();
    } catch (e) {
      console.error('excBuild error:', e);
      document.getElementById('exc-matrix').innerHTML =
        '<div class="exc-loading">构建界面失败: ' + e.message + ' @ ' + (e.stack || '').split('\n')[1]?.trim() + '</div>';
      return;
    }
  } catch (e) {
    console.error('excLoadAll error:', e);
    document.getElementById('exc-matrix').innerHTML =
      '<div class="exc-loading">加载失败: ' + e.message + '</div>';
  }
}

function excBuild() {
  const fns = [
    ['excBuildTree', excBuildTree],
    ['excBuildMatrix', excBuildMatrix],
    ['excBuildFilterDropdowns', excBuildFilterDropdowns],
    ['excApplyFilters', excApplyFilters],
  ];
  for (const [name, fn] of fns) {
    try { fn(); } catch (e) {
      console.error(name + ' failed:', e);
      const el = document.getElementById('exc-matrix');
      if (el) el.innerHTML = '<div class="exc-loading">[' + name + '] ' + e.message + '</div>';
      throw e;
    }
  }
}

function excBuildTree() {
  const tree = document.getElementById('exc-tree');
  const badge = document.getElementById('exc-badge');

  const flowCounts = {};
  excState.details.forEach(d => {
    const key = d.app + '||' + d.flow;
    flowCounts[key] = (flowCounts[key] || 0) + 1;
  });

  const appFlowCounts = {};
  excState.apps.forEach(a => {
    if (!appFlowCounts[a.category]) appFlowCounts[a.category] = { flows: {} };
    appFlowCounts[a.category].flows[a.flow] = flowCounts[a.category + '||' + a.flow] || 0;
  });

  const cats = Object.keys(appFlowCounts);
  badge.textContent = cats.length + (currentLang === 'en' ? '' : '类');

  const filter = excState.treeFilter.toLowerCase();
  let html = '';
  let anyVisible = false;

  cats.forEach((cat, ci) => {
    const flows = appFlowCounts[cat].flows;
    const flowEntries = Object.keys(flows).sort();
    const catTotal = Object.values(flows).reduce((s, v) => s + v, 0);

    const catMatch = filter && cat.toLowerCase().includes(filter);
    let visibleFlows = filter
      ? flowEntries.filter(f => catMatch || f.toLowerCase().includes(filter))
      : flowEntries;

    if (filter && !catMatch && visibleFlows.length === 0) return;
    anyVisible = true;

    const isOpen = excState.treeOpen[cat] !== false;
    html += '<li class="exc-tree-cat' + (isOpen ? '' : ' is-collapsed') + '" data-cat="' + ci + '">';
    html += '<div class="exc-tree-cat-label" data-cat-name="' + cat + '">';
    html += '<span class="exc-tree-arrow">▶</span>';
    html += cat;
    html += '<span class="exc-tree-cat-count">' + catTotal + '</span>';
    html += '</div>';

    if (!filter || visibleFlows.length > 0) {
      html += '<ul class="exc-tree-flow-list">';
      visibleFlows.forEach(f => {
        const isActive = excState.filterApp === cat && excState.filterFlow === f;
        const isHighlighted = excState.searchTerm && f.toLowerCase().includes(excState.searchTerm.toLowerCase());
        html += '<li class="exc-tree-flow' +
          (isActive ? ' is-active' : '') +
          (isHighlighted ? ' is-highlighted' : '') +
          '" data-category="' + cat + '" data-flow="' + f + '">';
        html += f;
        if (flows[f] > 0) html += ' <span class="exc-tree-cat-count">' + flows[f] + '</span>';
        html += '</li>';
      });
      html += '</ul>';
    }
    html += '</li>';
  });

  const emptyMsg = currentLang === 'en' ? 'No matching categories' : '无匹配分类';
  tree.innerHTML = html || '<li class="exc-tree-empty">' + emptyMsg + '</li>';

  if (!anyVisible && filter) {
    tree.innerHTML = '<li class="exc-tree-empty">' + emptyMsg + '</li>';
  }
}

function excBuildMatrix() {
  const container = document.getElementById('exc-matrix');
  const colColors = ['#0f4ec9', '#0d8a72', '#7b5ea0'];
  let html = '';
  excState.matrix.forEach((col, i) => {
    const isActive = excState.filterCol === col.column;
    html += '<div class="exc-matrix-card' +
      (isActive ? ' is-active' : '') +
      ' exc-matrix-card-col' + i + '" data-col="' + col.column + '">';
    html += '<span class="exc-matrix-card-title" style="color:' + colColors[i] + '">' + col.column + '</span>';
    html += '<span style="font-size:11px;color:var(--muted)">' + col.types.length + ' ' + t('exc.fault-types') + '</span>';
    html += '<div class="exc-matrix-card-cols">';
    col.types.forEach(t => {
      const chipActive = excState.filterCategory === t.name;
      html += '<span class="exc-matrix-chip' + (chipActive ? ' is-active' : '') + '" data-category="' + t.name + '">' + t.name + '</span>';
    });
    html += '</div></div>';
  });
  container.innerHTML = html;

  container.querySelectorAll('.exc-matrix-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.exc-matrix-chip')) return;
      const col = card.dataset.col;
      excState.filterCol = excState.filterCol === col ? '' : col;
      excBuildMatrix();
      excApplyFilters();
    });
  });

  container.querySelectorAll('.exc-matrix-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const cat = chip.dataset.category;
      excState.filterCategory = excState.filterCategory === cat ? '' : cat;
      excBuildMatrix();
      excApplyFilters();
    });
  });
}

function excBuildFilterDropdowns() {
  const appSel = document.getElementById('exc-f-app');
  const flowSel = document.getElementById('exc-f-flow');
  const colSel = document.getElementById('exc-f-col');
  const priSel = document.getElementById('exc-f-pri');

  const apps = [...new Set(excState.apps.map(a => a.category))];
  appSel.innerHTML = '<option value="">' + t('exc.filter-all-app') + '</option>' +
    apps.map(a => '<option value="' + a + '"' + (excState.filterApp === a ? ' selected' : '') + '>' + a + '</option>').join('');

  let flows = excState.filterApp
    ? excState.apps.filter(a => a.category === excState.filterApp).map(a => a.flow)
    : [...new Set(excState.apps.map(a => a.flow))];
  flowSel.innerHTML = '<option value="">' + t('exc.filter-all-flow') + '</option>' +
    flows.map(f => '<option value="' + f + '"' + (excState.filterFlow === f ? ' selected' : '') + '>' + f + '</option>').join('');

  const cols = excState.matrix.map(c => c.column);
  colSel.innerHTML = '<option value="">' + t('exc.filter-all-col') + '</option>' +
    cols.map(c => '<option value="' + c + '"' + (excState.filterCol === c ? ' selected' : '') + '>' + c + '</option>').join('');

  priSel.innerHTML = '<option value="">' + t('exc.filter-all-pri') + '</option>' +
    ['P0','P1','P2','P3'].map(p => '<option value="' + p + '"' + (excState.filterPri === p ? ' selected' : '') + '>' + p + '</option>').join('');
}

function excApplyFilters() {
  let data = excState.details;

  if (excState.filterApp) {
    data = data.filter(d => d.app === excState.filterApp);
  }

  if (excState.filterFlow) {
    data = data.filter(d => d.flow === excState.filterFlow);
  }

  if (excState.filterCol) {
    data = data.filter(d => d.exception_column === excState.filterCol);
  }

  if (excState.filterCategory) {
    data = data.filter(d => d.exception_category === excState.filterCategory);
  }

  if (excState.filterPri) {
    data = data.filter(d => d._priority === excState.filterPri);
  }

  if (excState.searchTerm) {
    const q = excState.searchTerm.toLowerCase();
    data = data.filter(d =>
      d.app.toLowerCase().includes(q) ||
      d.flow.toLowerCase().includes(q) ||
      d.exception_column.toLowerCase().includes(q) ||
      d.exception_type.toLowerCase().includes(q) ||
      d.exception_category.toLowerCase().includes(q) ||
      d._desc.toLowerCase().includes(q)
    );
  }

  excState.filtered = data;
  excState.page = 1;

  document.getElementById('exc-total').textContent = excState.details.length;
  document.getElementById('exc-showing').textContent = data.length;

  excSortAndRender();
}

function excSortData(data) {
  if (!excState.sortKey) return data;
  const key = excState.sortKey;
  return [...data].sort((a, b) => {
    let va = key === 'priority' ? (a._priority || 'P9') : (a[key] || '');
    let vb = key === 'priority' ? (b._priority || 'P9') : (b[key] || '');
    if (key === 'priority') {
      const nA = parseInt(va.slice(1), 10);
      const nB = parseInt(vb.slice(1), 10);
      const numA = isNaN(nA) ? 99 : nA;
      const numB = isNaN(nB) ? 99 : nB;
      return excState.sortAsc ? numA - numB : numB - numA;
    }
    va = String(va).toLowerCase();
    vb = String(vb).toLowerCase();
    if (va < vb) return excState.sortAsc ? -1 : 1;
    if (va > vb) return excState.sortAsc ? 1 : -1;
    return 0;
  });
}

function excSortAndRender() {
  excSortData(excState.filtered);
  excRenderTable();
  excRenderPagination();
}

function excRenderTable() {
  const tbody = document.getElementById('exc-tbody');
  const sorted = excSortData(excState.filtered);
  const totalPages = Math.max(1, Math.ceil(sorted.length / excState.pageSize));
  if (excState.page > totalPages) excState.page = totalPages;
  const start = (excState.page - 1) * excState.pageSize;
  const pageData = sorted.slice(start, start + excState.pageSize);

  if (pageData.length === 0) {
    const emptyMsg = currentLang === 'en' ? 'No matching data' : '无匹配数据';
    tbody.innerHTML = '<tr><td colspan="8"><div class="exc-empty">' + emptyMsg + '</div></td></tr>';
    return;
  }

  let html = '';
  pageData.forEach((d, idx) => {
    const pri = d._priority;
    const dataIdx = start + idx;
    html += '<tr class="exc-tr">';
    html += '<td class="exc-td">' +
      (pri ? '<span class="exc-pri exc-pri-' + pri + '">' + pri + '</span>' : '') +
      '</td>';
    html += '<td class="exc-td">' + escHtml(d._desc) + '</td>';
    html += '<td class="exc-td">' + escHtml(d.app) + '</td>';
    html += '<td class="exc-td">' + escHtml(d.flow) + '</td>';
    html += '<td class="exc-td">' + escHtml(d.exception_column) + '</td>';
    html += '<td class="exc-td">' + escHtml(d.exception_type) + '</td>';
    html += '<td class="exc-td">' + escHtml(d.exception_category) + '</td>';
    html += '<td class="exc-td exc-td-action"><button class="exc-q-btn" data-index="' + dataIdx + '" title="' + t('exc.show-questions') + '">👁</button></td>';
    html += '</tr>';
  });
  tbody.innerHTML = html;

  document.querySelectorAll('.exc-th').forEach(th => {
    const key = th.dataset.sort;
    th.classList.toggle('is-sort', key === excState.sortKey);
    th.classList.toggle('is-desc', key === excState.sortKey && !excState.sortAsc);
  });
}

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function excRenderPagination() {
  const container = document.getElementById('exc-pagination');
  const total = Math.max(1, Math.ceil(excState.filtered.length / excState.pageSize));
  const page = excState.page;

  if (total <= 1) {
    container.innerHTML = '';
    return;
  }

  let html = '';
  html += '<button class="exc-page-btn" data-page="prev"' + (page <= 1 ? ' disabled' : '') + '>◀</button>';

  const range = excPaginationRange(page, total);
  range.forEach(item => {
    if (item === '...') {
      html += '<span class="exc-page-ellipsis">…</span>';
    } else {
      html += '<button class="exc-page-btn' + (item === page ? ' is-active' : '') + '" data-page="' + item + '">' + item + '</button>';
    }
  });

  html += '<button class="exc-page-btn" data-page="next"' + (page >= total ? ' disabled' : '') + '>▶</button>';
  html += '<span class="exc-page-info">第 ' + page + ' / ' + total + ' 页</span>';

  container.innerHTML = html;

  container.querySelectorAll('.exc-page-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.page;
      if (target === 'prev') { if (excState.page > 1) excState.page--; }
      else if (target === 'next') { if (excState.page < total) excState.page++; }
      else { excState.page = parseInt(target); }
      excRenderTable();
      excRenderPagination();
    });
  });
}

function excPaginationRange(page, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const range = [];
  if (page <= 3) {
    range.push(1, 2, 3, 4, '...', total);
  } else if (page >= total - 2) {
    range.push(1, '...', total - 3, total - 2, total - 1, total);
  } else {
    range.push(1, '...', page - 1, page, page + 1, '...', total);
  }
  return range;
}

/* Exception tab event bindings */

// Tree event delegation
document.getElementById('exc-tree').addEventListener('click', (e) => {
  const catLabel = e.target.closest('.exc-tree-cat-label');
  if (catLabel) {
    const li = catLabel.closest('.exc-tree-cat');
    if (li) {
      li.classList.toggle('is-collapsed');
      const catName = catLabel.dataset.catName;
      excState.treeOpen[catName] = !li.classList.contains('is-collapsed');
    }
    return;
  }

  const flowLi = e.target.closest('.exc-tree-flow');
  if (flowLi) {
    const cat = flowLi.dataset.category;
    const flow = flowLi.dataset.flow;
    if (excState.filterApp === cat && excState.filterFlow === flow) {
      excState.filterApp = '';
      excState.filterFlow = '';
    } else {
      excState.filterApp = cat;
      excState.filterFlow = flow;
    }
    excBuildTree();
    document.getElementById('exc-f-app').value = excState.filterApp;
    excBuildFilterDropdowns();
    excApplyFilters();
  }
});

// Filter dropdown changes
document.getElementById('exc-f-app').addEventListener('change', (e) => {
  excState.filterApp = e.target.value;
  excState.filterFlow = '';
  excBuildFilterDropdowns();
  excApplyFilters();
});

document.getElementById('exc-f-flow').addEventListener('change', (e) => {
  excState.filterFlow = e.target.value;
  excApplyFilters();
});

document.getElementById('exc-f-col').addEventListener('change', (e) => {
  excState.filterCol = e.target.value;
  excBuildMatrix();
  excApplyFilters();
});

document.getElementById('exc-f-pri').addEventListener('change', (e) => {
  excState.filterPri = e.target.value;
  excApplyFilters();
});

// Sort on column header click
document.getElementById('exc-table').addEventListener('click', (e) => {
  const th = e.target.closest('.exc-th');
  if (!th) return;
  const key = th.dataset.sort;
  if (!key) return;
  if (excState.sortKey === key) {
    excState.sortAsc = !excState.sortAsc;
  } else {
    excState.sortKey = key;
    excState.sortAsc = true;
  }
  excSortAndRender();
});

// Tree search
document.getElementById('exc-search').addEventListener('input', (e) => {
  excState.treeFilter = e.target.value;
  excBuildTree();
});

// Re-render on language change
document.addEventListener('langchange', () => {
  if (excCache.loaded) excBuild();
});

// Global search (on the table)
document.getElementById('exc-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    excState.searchTerm = e.target.value;
    excApplyFilters();
  }
});

/* ===== Questions Modal ===== */

function excOpenModal(dataIndex) {
  const d = excState.filtered[dataIndex];
  if (!d || !d.questions || d.questions.length === 0) return;

  const body = document.getElementById('exc-modal-body');
  body.innerHTML = d.questions.map((q, i) =>
    '<div class="exc-q-item">' +
      '<span class="exc-q-text">' + escHtml(q) + '</span>' +
      '<button class="exc-q-copy" data-q="' + escHtml(q) + '" title="复制">📋</button>' +
    '</div>'
  ).join('');

  document.getElementById('exc-modal').classList.remove('is-hidden');
}

function excCloseModal() {
  document.getElementById('exc-modal').classList.add('is-hidden');
}

// Table button clicks (event delegation)
document.getElementById('exc-tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('.exc-q-btn');
  if (btn) {
    const idx = parseInt(btn.dataset.index, 10);
    excOpenModal(idx);
    return;
  }
});

// Modal close
document.getElementById('exc-modal-close').addEventListener('click', excCloseModal);
document.getElementById('exc-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) excCloseModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') excCloseModal();
});

// Copy button inside modal (event delegation)
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
