/* ===== Workflow Tab ===== */
const wfState = {
  workflows: {},
  currentId: null,
  running: false,
  sessionActive: false,
  taskIndex: 0,
  terminalLines: [],
};

// Command history for terminal
const wfCmdHistory = [];
let wfCmdHistoryIdx = -1;
let wfCmdSavedInput = '';

// Command suggestions data
const wfCmdSuggestionsData = [
  { key: '/start', desc: '启动工作流' },
  { key: '/stop', desc: '停止工作流' },
  { key: '/run', desc: '启动工作流' },
  { key: '/reset', desc: '重置工作流状态' },
  { key: '/status', desc: '查看工作流状态' },
  { key: '/help', desc: '显示帮助信息' },
];
let wfCmdSuggestionIdx = -1;

function wfRenderSuggestions(filter) {
  const container = document.getElementById('wf-cmd-suggestions');
  if (!container) return;

  // If branch suggestions are shown, don't interfere
  if (container.querySelector('[data-branch]')) return;

  if (!filter || !filter.startsWith('/')) {
    container.classList.remove('is-visible');
    container.innerHTML = '';
    wfCmdSuggestionIdx = -1;
    return;
  }
  const q = filter.slice(1).toLowerCase();
  const matches = wfCmdSuggestionsData.filter((item) =>
    item.key.toLowerCase().includes(q) || item.key.replace('/','').toLowerCase().includes(q)
  );
  if (matches.length === 0 || (matches.length === 1 && matches[0].key === filter.trim())) {
    container.classList.remove('is-visible');
    container.innerHTML = '';
    wfCmdSuggestionIdx = -1;
    return;
  }
  container.innerHTML = '';
  matches.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'wf-cmd-suggestion' + (i === 0 ? ' is-highlighted' : '');
    div.dataset.index = i;
    div.dataset.cmd = item.key;
    div.innerHTML = `<span class="cmd-key">${item.key}</span><span class="cmd-desc">${item.desc}</span>`;
    div.addEventListener('click', () => {
      wfEls.terminalInput.value = item.key;
      container.classList.remove('is-visible');
      container.innerHTML = '';
      wfCmdSuggestionIdx = -1;
      wfEls.terminalInput.focus();
    });
    div.addEventListener('mouseenter', () => {
      container.querySelectorAll('.wf-cmd-suggestion').forEach((el) => el.classList.remove('is-highlighted'));
      div.classList.add('is-highlighted');
      wfCmdSuggestionIdx = i;
    });
    container.appendChild(div);
  });
  container.classList.add('is-visible');
  wfCmdSuggestionIdx = 0;
}

function wfApplySuggestion() {
  const container = document.getElementById('wf-cmd-suggestions');
  if (!container.classList.contains('is-visible')) return false;
  const highlighted = container.querySelector('.wf-cmd-suggestion.is-highlighted');
  if (highlighted) {
    if (highlighted.dataset.branch) {
      highlighted.click();
      return true;
    }
    wfEls.terminalInput.value = highlighted.dataset.cmd;
    container.classList.remove('is-visible');
    container.innerHTML = '';
    wfCmdSuggestionIdx = -1;
    return true;
  }
  return false;
}

// Real pipeline integration
const WF_REAL_SUBTASK_MAP = {
  '任务初始化': ['参数校验', '环境检测'],
  '仿真基线准备': ['基线同步', '依赖安装', '配置检查'],
  'Agent 运行时': ['Agent连接', '任务分配', '结果汇聚'],
  '状态巡检': ['健康检测', '日志采集'],
  '结果输出': ['产物打包', '报告生成'],
  '完成': ['资源清理'],
};

const WF_REAL_STEPS = [
  { id: 'init', name: '任务初始化' },
  { id: 'prepare', name: '仿真基线准备' },
  { id: 'agent', name: 'Agent 运行时' },
  { id: 'inspect', name: '状态巡检' },
  { id: 'output', name: '结果输出' },
  { id: 'done', name: '完成' },
];

let wfRealTimer = null;

function wfStopRealTimer() {
  if (wfRealTimer) {
    clearInterval(wfRealTimer);
    wfRealTimer = null;
  }
}

async function wfOpenReal(wf) {
  wfStopRealTimer();
  if (wfRunTimeout) {
    clearTimeout(wfRunTimeout);
    wfRunTimeout = null;
  }

  wfState.currentId = wf.id;
  wfState.running = false;
  wfState.sessionActive = false;

  wfEls.detailTitle.textContent = wf.name;
  wfEls.detailDesc.textContent = '连接后端流水线...';

  wfRenderSidebarList(wfState.workflows);
  wfTerminalClear();
  wfTerminalWriteln(`[${wfTerminalTimestamp()}] 打开: ${wf.name}`);
  wfTerminalWriteln(`[${wfTerminalTimestamp()}] 连接后端 API...`, 'wf-terminal-muted');

  wfEls.terminalStatus.textContent = '连接中...';
  wfEls.terminalStatus.style.color = '';
  wfEls.terminalInput.disabled = false;
  wfEls.runBtn.textContent = '▶ 运行';
  wfEls.runBtn.classList.remove('wf-btn-stop');

  wfCanvas.panX = 0;
  wfCanvas.panY = 0;
  wfCanvas.contentGroup = null;

  // Default tasks before first fetch
  wf.tasks = WF_REAL_STEPS.map((s) => {
    const subNames = WF_REAL_SUBTASK_MAP[s.name] || [];
    return { id: s.id, name: s.name, type: 'task', status: 'idle', subtasks: subNames.map((n) => ({ name: n })) };
  });
  wf.edges = [];
  for (let i = 0; i < WF_REAL_STEPS.length - 1; i++) {
    wf.edges.push({ from: WF_REAL_STEPS[i].id, to: WF_REAL_STEPS[i + 1].id });
  }
  wfRenderFlow(wf);

  // First fetch
  await wfRefreshReal(wf);

  // Poll every 3 seconds
  wfRealTimer = setInterval(() => wfRefreshReal(wf), 3000);
}

async function wfRefreshReal(wf) {
  try {
    const task = await wfFetchJSON('/api/pipelines/current?pipeline=baseApp');
    const progress = task.progress || {};
    const currentStep = progress.currentStep || 1;
    const steps = progress.steps || WF_REAL_STEPS.map((s) => s.name);
    const terminalStatuses = ['completed', 'pushed', 'cancelled', 'build_failed', 'agent_exited_without_result', 'dry_run_success_detected'];
    const isTerminal = terminalStatuses.includes(task.status);
    const isFailed = ['build_failed', 'cancelled', 'agent_exited_without_result'].includes(task.status);

    wf.tasks = steps.map((name, i) => {
      let status = 'idle';
      const stepNum = i + 1;
      if (stepNum < currentStep) status = 'completed';
      else if (stepNum === currentStep) {
        if (isTerminal || task.status === 'ready') status = 'completed';
        else if (isFailed) status = 'failed';
        else status = 'running';
      }
      return {
        id: 'step' + i, name, type: 'task', status,
        subtasks: (WF_REAL_SUBTASK_MAP[name] || []).map((n) => ({ name: n })),
      };
    });

    wf.edges = [];
    for (let i = 0; i < wf.tasks.length - 1; i++) {
      wf.edges.push({ from: 'step' + i, to: 'step' + (i + 1) });
    }

    wfRenderFlow(wf);

    wfEls.detailDesc.textContent = '状态: ' + task.status + ' · ' + (progress.label || '');
    wfEls.terminalStatus.textContent = progress.label || task.status || '-';

    const agentRunning = task.agent && task.agent.running;
    if (agentRunning) {
      wfState.sessionActive = true;
      wfEls.runBtn.textContent = '■ 停止';
      wfEls.runBtn.classList.add('wf-btn-stop');
    } else {
      wfState.sessionActive = false;
      wfEls.runBtn.textContent = '▶ 运行';
      wfEls.runBtn.classList.remove('wf-btn-stop');
    }
  } catch (e) {
    if (wfEls.terminalBody) {
      wfTerminalWriteln(`[${wfTerminalTimestamp()}] ⚠ 刷新失败: ${e.message}`, 'wf-terminal-error');
    }
  }
}

async function wfStopRealRun(wf) {
  wfTerminalWriteln(`[${wfTerminalTimestamp()}] 发送终止请求...`, 'wf-terminal-muted');
  try {
    const res = await fetch('/api/pipelines/current/terminate?pipeline=baseApp', { method: 'POST', cache: 'no-store' });
    const data = await res.json();
    if (data.ok) {
      wfTerminalWriteln(`[${wfTerminalTimestamp()}] ✓ 终止请求已提交`, 'wf-terminal-success');
    } else {
      wfTerminalWriteln(`[${wfTerminalTimestamp()}] ✗ 终止失败`, 'wf-terminal-error');
    }
  } catch (e) {
    wfTerminalWriteln(`[${wfTerminalTimestamp()}] ✗ 终止请求失败: ${e.message}`, 'wf-terminal-error');
  }
  wfState.sessionActive = false;
  wfEls.runBtn.textContent = '▶ 运行';
  wfEls.runBtn.classList.remove('wf-btn-stop');
}

async function wfFetchJSON(url, options) {
  const res = await fetch(url, { cache: 'no-store', ...options });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// Sample workflow definitions
function initWorkflows() {
  const defs = [
    {
      id: 'img-sim',
      name: '图片仿真APP',
      description: '加载图片 → 图片预处理 → 仿真渲染 → 输出结果',
      tasks: [
        { id: 'load', name: '加载图片', type: 'task' },
        { id: 'preprocess', name: '图片预处理', type: 'task' },
        { id: 'render', name: '仿真渲染', type: 'branch', branches: ['标准渲染', '高质量渲染', '快速预览'] },
        { id: 'output', name: '输出结果', type: 'task' },
      ],
      edges: [
        { from: 'load', to: 'preprocess' },
        { from: 'preprocess', to: 'render' },
        { from: 'render', to: 'output' },
      ],
    },
    {
      id: 'code-sim',
      name: '代码仿真APP',
      description: '连接后端流水线，实时监控构建状态',
      real: true,
      tasks: [
        { id: 'init', name: '任务初始化', type: 'task' },
        { id: 'prepare', name: '仿真基线准备', type: 'task' },
        { id: 'agent', name: 'Agent 运行时', type: 'task' },
        { id: 'inspect', name: '状态巡检', type: 'task' },
        { id: 'output', name: '结果输出', type: 'task' },
        { id: 'done', name: '完成', type: 'task' },
      ],
      edges: [
        { from: 'init', to: 'prepare' },
        { from: 'prepare', to: 'agent' },
        { from: 'agent', to: 'inspect' },
        { from: 'inspect', to: 'output' },
        { from: 'output', to: 'done' },
      ],
    },
  ];

  defs.forEach((def) => {
    wfState.workflows[def.id] = {
      ...def,
      tasks: def.tasks.map((t) => ({ ...t, status: 'idle' })),
    };
  });
}

// DOM refs
const wfEls = {
  list: document.getElementById('wf-list'),
  detailView: document.getElementById('wf-detail-view'),
  detailTitle: document.getElementById('wf-detail-title'),
  detailDesc: document.getElementById('wf-detail-desc'),
  flowSvg: document.getElementById('wf-flow-svg'),
  terminalBody: document.getElementById('wf-terminal-body'),
  terminalInput: document.getElementById('wf-terminal-input'),
  terminalStatus: document.getElementById('wf-terminal-status'),
  runBtn: document.getElementById('wf-run-btn'),
};

function wfResetStatuses(wf) {
  wf.tasks.forEach((t) => (t.status = 'idle'));
}

function wfGetTask(wf, id) {
  return wf.tasks.find((t) => t.id === id);
}

function wfGetNextPending(wf) {
  for (const task of wf.tasks) {
    if (task.status === 'idle' || task.status === 'waiting') return task;
  }
  return null;
}

/* Terminal */
function wfTerminalWriteln(text, className) {
  const div = document.createElement('div');
  div.className = 'wf-terminal-line' + (className ? ' ' + className : '');
  div.textContent = text;
  wfEls.terminalBody.appendChild(div);
  wfEls.terminalBody.scrollTop = wfEls.terminalBody.scrollHeight;
}

function wfTerminalWriteHTML(html) {
  const div = document.createElement('div');
  div.className = 'wf-terminal-line';
  div.innerHTML = html;
  wfEls.terminalBody.appendChild(div);
  wfEls.terminalBody.scrollTop = wfEls.terminalBody.scrollHeight;
}

function wfTerminalClear() {
  wfEls.terminalBody.innerHTML = '';
}

function wfTerminalTimestamp() {
  const now = new Date();
  return now.toLocaleTimeString('zh-CN', { hour12: false });
}

/* Flow graph rendering — UE FlowGraph style, left-to-right, dark theme, canvas panning */
const wfCanvas = {
  panX: 0, panY: 0,
  isPanning: false,
  startX: 0, startY: 0,
  startPanX: 0, startPanY: 0,
  contentGroup: null,
};

function wfRenderFlow(wf) {
  const svg = wfEls.flowSvg;
  const container = svg.parentElement;
  const rect = container.getBoundingClientRect();
  const svgW = Math.max(rect.width, 500);
  const svgH = Math.max(rect.height, 200);
  if (svgW === 0 || svgH === 0) return;
  svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);

  const tasks = wf.tasks;
  if (!tasks.length) return;

  const nodeW = 190;
  // Compute node height — extra room for subtask chips if any
  let maxSubRows = 0;
  tasks.forEach(t => {
    if (t.subtasks && t.subtasks.length > 0) {
      const rows = Math.ceil(t.subtasks.length / 3);
      if (rows > maxSubRows) maxSubRows = rows;
    }
  });
  const nodeH = maxSubRows > 0 ? 120 : 68;
  const headerH = 26;
  const gapX = 130;
  const padX = 60;
  const padY = Math.max(40, (svgH - nodeH) / 2);

  // Content bounds
  const contentW = padX * 2 + tasks.length * (nodeW + gapX) - gapX;
  const contentH = padY * 2 + nodeH;

  // Clear SVG
  svg.innerHTML = '';

  // ---- Defs ----
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <marker id="mk-idle" viewBox="0 0 10 7" refX="9" refY="3.5" markerWidth="7" markerHeight="5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="#505668" />
    </marker>
    <marker id="mk-done" viewBox="0 0 10 7" refX="9" refY="3.5" markerWidth="7" markerHeight="5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="#3a9a6a" />
    </marker>
    <marker id="mk-run" viewBox="0 0 10 7" refX="9" refY="3.5" markerWidth="7" markerHeight="5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="#4a8fe0" />
    </marker>
    <marker id="mk-warn" viewBox="0 0 10 7" refX="9" refY="3.5" markerWidth="7" markerHeight="5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="#b878d0" />
    </marker>`;
  svg.appendChild(defs);

  // ---- Dot grid (static, doesn't pan) ----
  const gridSpacing = 18;
  for (let gx = 0; gx <= Math.max(svgW, contentW + 100); gx += gridSpacing) {
    for (let gy = 0; gy <= Math.max(svgH, contentH + 100); gy += gridSpacing) {
      const isMajor = gx % (gridSpacing * 5) === 0 && gy % (gridSpacing * 5) === 0;
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', gx);
      dot.setAttribute('cy', gy);
      dot.setAttribute('r', isMajor ? 1.5 : 1);
      dot.setAttribute('class', isMajor ? 'wf-flow-bg-dot-major' : 'wf-flow-bg-dot');
      svg.appendChild(dot);
    }
  }

  // ---- Content group (for panning) ----
  const contentGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  contentGroup.setAttribute('transform', `translate(${wfCanvas.panX}, ${wfCanvas.panY})`);
  svg.appendChild(contentGroup);
  wfCanvas.contentGroup = contentGroup;

  // ---- Node positions (horizontal, left-to-right) ----
  const nodePos = {};
  tasks.forEach((task, i) => {
    nodePos[task.id] = { x: padX + i * (nodeW + gapX), y: padY };
  });

  // ---- Edge status ----
  function getEdgeStatus(fromId) {
    const ft = wfGetTask(wf, fromId);
    if (!ft) return '';
    if (ft.status === 'completed') return 'completed';
    if (ft.status === 'running') return 'running';
    if (ft.status === 'waiting') return 'warning';
    return '';
  }

  // ---- Draw edges (behind nodes) ----
  wf.edges.forEach((e) => {
    const fromP = nodePos[e.from];
    const toP = nodePos[e.to];
    if (!fromP || !toP) return;

    const x1 = fromP.x + nodeW;
    const y1 = fromP.y + nodeH / 2;
    const x2 = toP.x;
    const y2 = toP.y + nodeH / 2;

    const statusClass = getEdgeStatus(e.from);
    const markerMap = { completed: 'mk-done', running: 'mk-run', warning: 'mk-warn' };
    const markerId = markerMap[statusClass] || 'mk-idle';

    const dx = Math.abs(x2 - x1) * 0.45;
    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'wf-flow-edge' + (statusClass ? ' ' + statusClass : ''));
    path.setAttribute('marker-end', `url(#${markerId})`);
    contentGroup.appendChild(path);
  });

  // ---- Draw nodes ----
  const R = 6; // corner radius

  tasks.forEach((task) => {
    const pos = nodePos[task.id];
    if (!pos) return;
    const x = pos.x;
    const y = pos.y;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `wf-flow-node status-${task.status} wf-flow-node-shadow`);
    g.dataset.taskId = task.id;

    // Body: fill all, then header colored on top.
    const bodyPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    bodyPath.setAttribute('class', 'wf-flow-node-body');
    bodyPath.setAttribute('d',
      `M ${x+R} ${y} L ${x+nodeW-R} ${y} ` +
      `Q ${x+nodeW} ${y} ${x+nodeW} ${y+R} ` +
      `L ${x+nodeW} ${y+nodeH-R} ` +
      `Q ${x+nodeW} ${y+nodeH} ${x+nodeW-R} ${y+nodeH} ` +
      `L ${x+R} ${y+nodeH} ` +
      `Q ${x} ${y+nodeH} ${x} ${y+nodeH-R} ` +
      `L ${x} ${y+R} ` +
      `Q ${x} ${y} ${x+R} ${y} Z`
    );
    g.appendChild(bodyPath);

    // Header fill
    const headerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    headerPath.setAttribute('class', 'wf-flow-node-header-bg');
    headerPath.setAttribute('d',
      `M ${x+R} ${y} L ${x+nodeW-R} ${y} ` +
      `Q ${x+nodeW} ${y} ${x+nodeW} ${y+R} ` +
      `L ${x+nodeW} ${y+headerH} ` +
      `L ${x} ${y+headerH} ` +
      `L ${x} ${y+R} ` +
      `Q ${x} ${y} ${x+R} ${y} Z`
    );
    g.appendChild(headerPath);

    // Dark divider line at header bottom
    const divider = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    divider.setAttribute('x1', x + 1);
    divider.setAttribute('y1', y + headerH);
    divider.setAttribute('x2', x + nodeW - 1);
    divider.setAttribute('y2', y + headerH);
    divider.setAttribute('stroke', 'rgba(0,0,0,0.25)');
    divider.setAttribute('stroke-width', '1');
    g.appendChild(divider);

    // Title (left-aligned in header)
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    title.setAttribute('x', x + 12);
    title.setAttribute('y', y + headerH / 2 + 1);
    title.setAttribute('class', 'wf-flow-node-title');
    title.setAttribute('dominant-baseline', 'central');
    title.textContent = task.name;
    g.appendChild(title);

    // Status label in body
    const statusLabels = {
      idle: '待命中', running: '执行中...', completed: '已完成',
      failed: '失败', waiting: '等待选择',
    };
    const hasSubtasks = task.subtasks && task.subtasks.length > 0;
    const statText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    statText.setAttribute('x', x + 12);
    statText.setAttribute('y', hasSubtasks ? y + headerH + 14 : y + headerH + (nodeH - headerH) / 2);
    statText.setAttribute('class', 'wf-flow-node-status');
    statText.setAttribute('dominant-baseline', 'central');
    statText.textContent = statusLabels[task.status] || task.status;
    if (task.status === 'running') statText.setAttribute('fill', '#4a8fe0');
    else if (task.status === 'completed') statText.setAttribute('fill', '#3a9a6a');
    else if (task.status === 'failed') statText.setAttribute('fill', '#d04a3a');
    else if (task.status === 'waiting') statText.setAttribute('fill', '#b878d0');
    g.appendChild(statText);

    // Subtask cards
    if (hasSubtasks) {
      const cardW = 56; const cardH = 24; const cardGap = 6;
      const cardsPerRow = Math.max(1, Math.floor((nodeW - 16) / (cardW + cardGap)));
      const cardStartX = x + 8;
      const cardStartY = y + headerH + 30;
      task.subtasks.forEach((sub, j) => {
        const col = j % cardsPerRow;
        const row = Math.floor(j / cardsPerRow);
        const cx = cardStartX + col * (cardW + cardGap);
        const cy = cardStartY + row * (cardH + 6);
        // Card body
        const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bg.setAttribute('x', cx); bg.setAttribute('y', cy);
        bg.setAttribute('width', cardW); bg.setAttribute('height', cardH);
        bg.setAttribute('rx', 4);
        bg.setAttribute('class', 'wf-flow-sub-card');
        g.appendChild(bg);
        // Colored left bar (status indicator)
        const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bar.setAttribute('x', cx + 2);
        bar.setAttribute('y', cy + 3);
        bar.setAttribute('width', 3);
        bar.setAttribute('height', cardH - 6);
        bar.setAttribute('rx', 1.5);
        bar.setAttribute('class', 'wf-flow-sub-bar status-' + task.status);
        g.appendChild(bar);
        // Sub-task name
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', cx + 10);
        label.setAttribute('y', cy + cardH / 2);
        label.setAttribute('class', 'wf-flow-sub-label');
        label.setAttribute('dominant-baseline', 'central');
        label.textContent = sub.name;
        g.appendChild(label);
      });
    }


    contentGroup.appendChild(g);
  });
}

/* Node selection */
wfEls.flowSvg.addEventListener('click', (e) => {
  document.querySelectorAll('.wf-flow-node.selected').forEach((n) => n.classList.remove('selected'));
  const nodeGroup = e.target.closest('.wf-flow-node');
  if (nodeGroup) {
    nodeGroup.classList.add('selected');
  }
});

/* Canvas panning */
function wfSetupPanning() {
  const svg = wfEls.flowSvg;

  svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.wf-flow-node')) return;

    wfCanvas.isPanning = true;
    wfCanvas.startX = e.clientX;
    wfCanvas.startY = e.clientY;
    wfCanvas.startPanX = wfCanvas.panX;
    wfCanvas.startPanY = wfCanvas.panY;
    svg.style.cursor = 'grabbing';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!wfCanvas.isPanning) return;
    const dx = e.clientX - wfCanvas.startX;
    const dy = e.clientY - wfCanvas.startY;
    wfCanvas.panX = wfCanvas.startPanX + dx;
    wfCanvas.panY = wfCanvas.startPanY + dy;
    if (wfCanvas.contentGroup) {
      wfCanvas.contentGroup.setAttribute('transform', `translate(${wfCanvas.panX}, ${wfCanvas.panY})`);
    }
  });

  window.addEventListener('mouseup', () => {
    if (wfCanvas.isPanning) {
      wfCanvas.isPanning = false;
      svg.style.cursor = 'grab';
    }
  });
}

wfSetupPanning();

/* Workflow execution simulation */
let wfRunTimeout = null;

function wfRunNext(wf) {
  const next = wfGetNextPending(wf);
  if (!next) {
    wfState.running = false;
    wfEls.terminalStatus.textContent = '已完成';
    wfEls.terminalStatus.style.color = 'var(--success)';
    wfTerminalWriteln(`[${wfTerminalTimestamp()}] ✓ 工作流执行完毕`, 'wf-terminal-success');
    wfEls.runBtn.textContent = '▶ 运行';
    wfEls.runBtn.classList.remove('wf-btn-stop');
    wfState.sessionActive = false;
    wfRenderFlow(wf);
    return;
  }

  next.status = 'running';
  wfRenderFlow(wf);
  wfEls.terminalStatus.textContent = `执行中: ${next.name}`;
  wfEls.terminalStatus.style.color = 'var(--accent-2)';
  wfTerminalWriteln(`[${wfTerminalTimestamp()}] ▶ 开始: ${next.name}`);

  if (next.type === 'branch') {
    next.status = 'waiting';
    wfRenderFlow(wf);
    wfEls.terminalStatus.textContent = `等待选择: ${next.name}`;
    wfEls.terminalStatus.style.color = 'var(--warning)';
    wfTerminalWriteln(`[${wfTerminalTimestamp()}] ◇ ${next.name} — 请选择分支方向:`, 'wf-terminal-branch');

    const container = document.getElementById('wf-cmd-suggestions');
    container.innerHTML = '';
    next.branches.forEach((b, i) => {
      const div = document.createElement('div');
      div.className = 'wf-cmd-suggestion' + (i === 0 ? ' is-highlighted' : '');
      div.dataset.branch = b;
      div.dataset.taskId = next.id;
      div.innerHTML = `<span class="cmd-key">[${i + 1}]</span><span class="cmd-desc">${b}</span>`;
      div.addEventListener('click', () => {
        container.classList.remove('is-visible');
        container.innerHTML = '';
        wfCmdSuggestionIdx = -1;
        wfHandleBranch(wf, next.id, b);
      });
      container.appendChild(div);
    });
    container.classList.add('is-visible');
    wfCmdSuggestionIdx = 0;

    wfState.running = false;
    return;
  }

  const delay = 1500 + Math.random() * 2000;
  wfRunTimeout = setTimeout(() => {
    next.status = 'completed';
    wfTerminalWriteln(`[${wfTerminalTimestamp()}] ✓ 完成: ${next.name}`, 'wf-terminal-success');
    wfRenderFlow(wf);
    wfRunNext(wf);
  }, delay);
}

function wfHandleBranch(wf, taskId, branch) {
  if (wfRunTimeout) {
    clearTimeout(wfRunTimeout);
    wfRunTimeout = null;
  }

  const task = wfGetTask(wf, taskId);
  if (!task) return;

  task.status = 'completed';
  wfTerminalWriteln(`[${wfTerminalTimestamp()}] → 选择: "${branch}"`, 'wf-terminal-warning');

  if (branch.includes('跳过') || branch.includes('拒绝')) {
    wfTerminalWriteln(`[${wfTerminalTimestamp()}] ⚠ 跳过后续依赖任务`, 'wf-terminal-error');
    const downstream = new Set();
    const collectDownstream = (id) => {
      wf.edges.filter((e) => e.from === id).forEach((e) => {
        const t = wfGetTask(wf, e.to);
        if (t && t.status === 'idle') {
          t.status = 'completed';
          downstream.add(t.name);
          collectDownstream(e.to);
        }
      });
    };
    collectDownstream(taskId);
    wfRenderFlow(wf);
    wfState.running = false;
    wfState.sessionActive = false;
    wfEls.runBtn.textContent = '▶ 运行';
    wfEls.runBtn.classList.remove('wf-btn-stop');
    wfEls.terminalStatus.textContent = '已终止';
    wfEls.terminalStatus.style.color = 'var(--muted)';
    wfTerminalWriteln(`[${wfTerminalTimestamp()}] ■ 工作流终止`, 'wf-terminal-muted');
    return;
  }

  if (branch.includes('重试')) {
    task.status = 'idle';
    wfRenderFlow(wf);
    wfTerminalWriteln(`[${wfTerminalTimestamp()}] ⟳ 准备重试: ${task.name}`, 'wf-terminal-warning');
    wfState.running = true;
    wfRunNext(wf);
    return;
  }

  wfRenderFlow(wf);
  wfState.running = true;
  wfRunNext(wf);
}

function wfStartRun(wf) {
  if (wf && wf.real) {
    wfTerminalWriteln(`[${wfTerminalTimestamp()}] 代码仿真APP流水线由外部脚本 run_pipeline.py 触发`, 'wf-terminal-muted');
    wfTerminalWriteln(`[${wfTerminalTimestamp()}] 当前为实时监控模式，状态每 3 秒自动刷新`, 'wf-terminal-muted');
    return;
  }
  if (wfState.sessionActive) return;
  wfResetStatuses(wf);
  wfState.running = true;
  wfState.sessionActive = true;
  wfEls.runBtn.textContent = '■ 停止';
  wfEls.runBtn.classList.add('wf-btn-stop');
  wfEls.terminalInput.disabled = false;
  wfEls.terminalStatus.textContent = '启动中...';
  wfEls.terminalStatus.style.color = 'var(--accent)';
  wfTerminalClear();
  wfTerminalWriteln(`[${wfTerminalTimestamp()}] ──── 工作流启动 ────`, 'wf-terminal-muted');
  wfRenderFlow(wf);
  wfRunNext(wf);
}

function wfStopRun(wf) {
  if (wf && wf.real) {
    wfStopRealRun(wf);
    return;
  }
  if (wfRunTimeout) {
    clearTimeout(wfRunTimeout);
    wfRunTimeout = null;
  }
  wfState.running = false;
  wfState.sessionActive = false;
  wfEls.runBtn.textContent = '▶ 运行';
  wfEls.runBtn.classList.remove('wf-btn-stop');
  wfEls.terminalStatus.textContent = '已停止';
  wfEls.terminalStatus.style.color = 'var(--muted)';
  wfTerminalWriteln(`[${wfTerminalTimestamp()}] ■ 工作流已停止`, 'wf-terminal-muted');
}

/* Workflow list rendering */
function wfRenderSidebarList(wfs, filter) {
  wfEls.list.innerHTML = '';
  const entries = Object.values(wfs);
  const filtered = filter
    ? entries.filter((w) => w.name.includes(filter) || w.description.includes(filter))
    : entries;

  filtered.forEach((wf) => {
    const li = document.createElement('li');
    li.className = 'wf-list-item' + (wfState.currentId === wf.id ? ' is-active' : '');
    li.dataset.wfId = wf.id;
    li.innerHTML = `<span class="wf-list-item-name">${wf.name}${wf.real ? ' <span class="wf-list-item-badge">● 实时</span>' : ''}</span><span class="wf-list-item-desc">${wf.description}</span>`;
    li.addEventListener('click', () => wfOpen(wf.id));
    wfEls.list.appendChild(li);
  });
}

function wfOpen(id) {
  const wf = wfState.workflows[id];
  if (!wf) return;

  if (wf.real) {
    wfOpenReal(wf);
    return;
  }

  if (wfRunTimeout) {
    clearTimeout(wfRunTimeout);
    wfRunTimeout = null;
  }
  wfStopRealTimer();

  wfState.currentId = id;
  wfState.running = false;

  wfEls.detailTitle.textContent = wf.name;
  wfEls.detailDesc.textContent = wf.description;

  wfRenderSidebarList(wfState.workflows);
  wfTerminalClear();
  wfTerminalWriteln(`[${wfTerminalTimestamp()}] 打开工作流: ${wf.name}`);
  wfTerminalWriteln(`[${wfTerminalTimestamp()}] 共 ${wf.tasks.length} 个任务，${wf.edges.length} 条依赖`);
  wfTerminalWriteln(`[${wfTerminalTimestamp()}] 点击 ▶ 运行 或 /start 开始执行工作流`, 'wf-terminal-muted');

  wfEls.terminalStatus.textContent = '待命';
  wfEls.terminalStatus.style.color = '';
  wfEls.terminalInput.disabled = false;
  wfEls.runBtn.textContent = '▶ 运行';
  wfEls.runBtn.classList.remove('wf-btn-stop');
  wfState.sessionActive = false;

  wfCanvas.panX = 0;
  wfCanvas.panY = 0;
  wfCanvas.contentGroup = null;

  wfResetStatuses(wf);
  wfRenderFlow(wf);
}

/* Terminal input handling */
wfEls.terminalInput.addEventListener('keydown', (e) => {
  const container = document.getElementById('wf-cmd-suggestions');
  const suggestionsVisible = container && container.classList.contains('is-visible');

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (suggestionsVisible) {
      const items = container.querySelectorAll('.wf-cmd-suggestion');
      if (wfCmdSuggestionIdx > 0) {
        items[wfCmdSuggestionIdx].classList.remove('is-highlighted');
        wfCmdSuggestionIdx--;
        items[wfCmdSuggestionIdx].classList.add('is-highlighted');
      }
    } else {
      if (wfCmdHistory.length === 0) return;
      if (wfCmdHistoryIdx === -1) {
        wfCmdSavedInput = wfEls.terminalInput.value;
      }
      if (wfCmdHistoryIdx < wfCmdHistory.length - 1) {
        wfCmdHistoryIdx++;
        wfEls.terminalInput.value = wfCmdHistory[wfCmdHistory.length - 1 - wfCmdHistoryIdx];
      }
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (suggestionsVisible) {
      const items = container.querySelectorAll('.wf-cmd-suggestion');
      if (wfCmdSuggestionIdx < items.length - 1) {
        items[wfCmdSuggestionIdx].classList.remove('is-highlighted');
        wfCmdSuggestionIdx++;
        items[wfCmdSuggestionIdx].classList.add('is-highlighted');
      }
    } else {
      if (wfCmdHistoryIdx > -1) {
        wfCmdHistoryIdx--;
        wfEls.terminalInput.value = wfCmdHistoryIdx >= 0
          ? wfCmdHistory[wfCmdHistory.length - 1 - wfCmdHistoryIdx]
          : wfCmdSavedInput;
      }
    }
  } else if (e.key === 'Enter') {
    if (suggestionsVisible) {
      e.preventDefault();
      if (wfApplySuggestion()) return;
    }
    const val = wfEls.terminalInput.value.trim();
    wfEls.terminalInput.value = '';
    if (val) {
      wfCmdHistory.push(val);
    }
    wfCmdHistoryIdx = -1;
    wfCmdSavedInput = '';
    if (!val) return;

    wfTerminalWriteln(`❯ ${val}`, 'wf-terminal-muted');

    if (val === '/help') {
      wfTerminalWriteln('可用命令: /start, /stop, /run, /reset, /status, /help', 'wf-terminal-branch');
    } else if (val === '/run' || val === '/start') {
      const wf = wfState.workflows[wfState.currentId];
      if (wf) wfStartRun(wf);
    } else if (val === '/stop') {
      const wf = wfState.workflows[wfState.currentId];
      if (wf) wfStopRun(wf);
    } else if (val === '/reset') {
      const wf = wfState.workflows[wfState.currentId];
      if (wf) {
        wfResetStatuses(wf);
        wfRenderFlow(wf);
        wfTerminalWriteln(`[${wfTerminalTimestamp()}] 已重置工作流状态`);
        wfEls.terminalStatus.textContent = '待命';
        wfEls.terminalStatus.style.color = '';
      }
    } else if (val === '/status') {
      const wf = wfState.workflows[wfState.currentId];
      if (wf) {
        wf.tasks.forEach((t) => {
          const s = { idle: '○ 待命', running: '▶ 运行中', completed: '✓ 完成', waiting: '◇ 等待', failed: '✗ 失败' };
          wfTerminalWriteln(`  ${s[t.status] || t.status} — ${t.name}`, 'wf-terminal-muted');
        });
      }
    } else {
      wfTerminalWriteln(`未知命令: ${val}。输入 /help 查看可用命令`);
    }
  } else if (e.key === 'Escape') {
    if (suggestionsVisible) {
      e.preventDefault();
      container.classList.remove('is-visible');
      container.innerHTML = '';
      wfCmdSuggestionIdx = -1;
    }
  } else if (/^[1-9]$/.test(e.key)) {
    const container = document.getElementById('wf-cmd-suggestions');
    const opts = container.querySelectorAll('.wf-cmd-suggestion[data-branch]');
    const idx = parseInt(e.key, 10) - 1;
    if (idx < opts.length) {
      e.preventDefault();
      opts[idx].click();
    }
  }
});

// Show suggestions on input
wfEls.terminalInput.addEventListener('input', () => {
  wfRenderSuggestions(wfEls.terminalInput.value);
});

/* Event bindings */
wfEls.runBtn.addEventListener('click', () => {
  const wf = wfState.workflows[wfState.currentId];
  if (!wf) return;
  if (wfState.sessionActive) {
    wfStopRun(wf);
  } else {
    wfStartRun(wf);
  }
});

/* Handle tab switch: re-render flow on window resize */
window.addEventListener('resize', () => {
  if (wfState.currentId) {
    const wf = wfState.workflows[wfState.currentId];
    if (wf) wfRenderFlow(wf);
  }
});

// Re-render / restart polling when workflow tab becomes active
document.querySelector('.tab[data-tab="workflow"]').addEventListener('click', () => {
  setTimeout(() => {
    const wf = wfState.workflows[wfState.currentId];
    if (!wf) return;
    if (wf.real) {
      if (!wfRealTimer) {
        wfRealTimer = setInterval(() => wfRefreshReal(wf), 3000);
      }
    }
    wfRenderFlow(wf);
  }, 50);
});

/* Init */
initWorkflows();
wfRenderSidebarList(wfState.workflows);
wfOpen('img-sim');
