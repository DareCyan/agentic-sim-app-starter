/* Tab switching */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const tabName = tab.dataset.tab;
    if (tabName !== "workflow") {
      wfStopRealTimer();
    }
    if (tabName === "app-build") {
      // Only app-build tab has live content - refresh when switching back
      refreshAll();
    }
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("is-active"));
    tab.classList.add("is-active");
    document.querySelector(`.tab-pane[data-pane="${tabName}"]`).classList.add("is-active");
  });
});

const els = {
  pipelineSelect: document.getElementById("pipeline-select"),
  title: document.getElementById("task-title"),
  artifactDownloadButton: document.getElementById("artifact-download-button"),
  statusPill: document.getElementById("status-pill"),
  scenarioId: document.getElementById("scenario-id"),
  scenarioQuestion: document.getElementById("scenario-question"),
  appType: document.getElementById("app-type"),
  baseBranch: document.getElementById("base-branch"),
  branchName: document.getElementById("branch-name"),
  workspace: document.getElementById("workspace"),
  workspaceCopyButton: document.getElementById("workspace-copy-button"),
  agentPid: document.getElementById("agent-pid"),
  startedAt: document.getElementById("started-at"),
  updatedAt: document.getElementById("updated-at"),
  runtimeDuration: document.getElementById("runtime-duration"),
  progressLabel: document.getElementById("progress-label"),
  progressPercent: document.getElementById("progress-percent"),
  progressBar: document.getElementById("progress-bar"),
  steps: document.getElementById("steps"),
  inspectionStatus: document.getElementById("inspection-status"),
  inspectionCycles: document.getElementById("inspection-cycles"),
  inspectionLast: document.getElementById("inspection-last"),
  inspectionMessage: document.getElementById("inspection-message"),
  pipelineLog: document.getElementById("pipeline-log"),
  agentLog: document.getElementById("agent-log"),
  terminateButton: document.getElementById("terminate-button"),
  shutdownConsoleButton: document.getElementById("shutdown-console-button"),
  terminateHint: document.getElementById("terminate-hint"),
  agentRunningState: document.getElementById("agent-running-state"),
  agentName: document.getElementById("agent-name"),
  agentModel: document.getElementById("agent-model"),
  agentProvider: document.getElementById("agent-provider"),
  agentApproval: document.getElementById("agent-approval"),
  agentSandbox: document.getElementById("agent-sandbox"),
  agentReasoningEffort: document.getElementById("agent-reasoning-effort"),
  agentReasoningSummary: document.getElementById("agent-reasoning-summary"),
  agentSessionId: document.getElementById("agent-session-id"),
};

let latestTask = null;
let currentPipeline = "baseApp";
const BEIJING_OFFSET_MINUTES = 8 * 60;

function fmt(value) {
  return value || "-";
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "-";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDisplayTime(value) {
  if (!value) return "-";
  const text = String(value).trim();
  if (!text) return "-";
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:[+-]\d{2}:\d{2}|Z)?$/);
  if (match) return `${match[1]} ${match[2]}`;
  return text;
}

function setText(el, value) {
  const text = fmt(value);
  el.textContent = text;
  el.title = text;
}

function parseDisplayTimeMs(value) {
  if (!value) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:([+-])(\d{2}):(\d{2})|Z)?$/);
  if (!match) return null;

  const utcMs = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  );

  if (match[7]) {
    const sign = match[7] === "+" ? 1 : -1;
    const offsetMinutes = Number(match[8]) * 60 + Number(match[9]);
    return utcMs - sign * offsetMinutes * 60 * 1000;
  }
  return utcMs - BEIJING_OFFSET_MINUTES * 60 * 1000;
}

function formatDurationSeconds(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const days = Math.floor(safeSeconds / 86400);
  const hours = Math.floor((safeSeconds % 86400) / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  const hhmmss = [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  return days > 0 ? `${days}d ${hhmmss}` : hhmmss;
}

function formatRuntimeDuration(startValue, endValue) {
  const startMs = parseDisplayTimeMs(startValue);
  if (startMs === null) return "-";
  const endMs = endValue ? parseDisplayTimeMs(endValue) : Date.now();
  if (endMs === null) return "-";
  return formatDurationSeconds((endMs - startMs) / 1000);
}

function getRuntimeStart(task) {
  return task.runtimeStartedAt || task.createdAt || task.agent.startedAt || null;
}

function isTerminalStatus(status) {
  return ["cancelled", "pushed", "completed", "build_failed", "agent_exited_without_result", "dry_run_success_detected"].includes(status);
}

function getRuntimeEnd(task) {
  if (task.runtimeEndedAt) return task.runtimeEndedAt;
  if (isTerminalStatus(task.status)) return null;
  return task.updatedAt || null;
}

async function copyToClipboard(text) {
  if (!text || text === "-") return false;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  return copied;
}

function classifyStatus(status) {
  if (["pushed", "completed", "dry_run_success_detected", "ready"].includes(status)) return "status-success";
  if (["build_failed", "agent_exited_without_result"].includes(status)) return "status-failed";
  if (status === "cancelled") return "status-cancelled";
  return "status-running";
}

function renderArtifact(task) {
  const artifact = task.artifact;
  if (!artifact || !artifact.downloadUrl) {
    els.artifactDownloadButton.classList.add("is-hidden");
    els.artifactDownloadButton.removeAttribute("href");
    els.artifactDownloadButton.removeAttribute("download");
    els.artifactDownloadButton.removeAttribute("title");
    return;
  }

  els.artifactDownloadButton.classList.remove("is-hidden");
  els.artifactDownloadButton.href = `${artifact.downloadUrl}`;
  els.artifactDownloadButton.setAttribute("download", artifact.name || "app.hap");
  const meta = [artifact.name, formatBytes(artifact.sizeBytes)].filter((part) => part && part !== "-").join(" · ");
  els.artifactDownloadButton.title = meta || "下载 HAP 安装包";
}

function renderPipelineOptions(items) {
  const previous = currentPipeline;
  els.pipelineSelect.innerHTML = "";
  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.key;
    option.textContent = item.type === "baseApp" ? "baseApp" : `${item.key} (${item.status})`;
    if (item.key === previous) option.selected = true;
    els.pipelineSelect.appendChild(option);
  });
  if (![...els.pipelineSelect.options].some((option) => option.value === previous) && els.pipelineSelect.options.length > 0) {
    currentPipeline = els.pipelineSelect.options[0].value;
  }
  els.pipelineSelect.value = currentPipeline;
}

function renderTask(task) {
  latestTask = task;
  const runtime = task.agent.runtime || {};
  renderArtifact(task);
  els.title.textContent = task.pipelineName || task.pipelineKey || "当前任务";
  setText(els.statusPill, task.status);
  els.statusPill.className = `card-state ${classifyStatus(task.status)}`;
  setText(els.scenarioId, task.scenarioId || task.pipelineKey);
  setText(els.scenarioQuestion, task.scenarioQuestion || task.pipelineRoot || "当前 pipeline 无场景说明");
  setText(els.appType, task.appDisplayName || task.appType);
  setText(els.baseBranch, task.baseBranch);
  setText(els.branchName, task.branchName);
  setText(els.workspace, task.pipelineRoot || task.agent.workspace || runtime.workspace);
  setText(els.agentPid, task.agent.pid);
  setText(els.startedAt, formatDisplayTime(task.agent.startedAt));
  setText(els.updatedAt, formatDisplayTime(task.updatedAt));
  setText(els.agentRunningState, task.agent.running ? "运行中" : "未运行");
  els.agentRunningState.className = `card-state ${task.agent.running ? "status-running" : "status-cancelled"}`;
  setText(els.agentName, runtime.name || task.agent.type);
  setText(els.agentModel, runtime.model);
  setText(els.agentProvider, runtime.provider);
  setText(els.agentApproval, runtime.approval_policy);
  setText(els.agentSandbox, runtime.sandbox_mode);
  setText(els.agentReasoningEffort, runtime.reasoning_effort);
  setText(els.agentReasoningSummary, runtime.reasoning_summary);
  setText(els.agentSessionId, task.agent.sessionId || runtime.session_id || runtime.sessionId);
  setText(els.progressLabel, task.progress.label);
  setText(els.progressPercent, `${task.progress.percent || 0}%`);
  els.progressPercent.className = "card-state status-progress";
  els.progressBar.style.width = `${task.progress.percent || 0}%`;
  els.steps.innerHTML = "";

  (task.progress.steps || []).forEach((step, index) => {
    const li = document.createElement("li");
    li.className = "progress-step";
    if (index + 1 < task.progress.currentStep) li.classList.add("done");
    if (index + 1 === task.progress.currentStep) li.classList.add("active");
    li.innerHTML = `<span class="step-node" aria-hidden="true"></span><span class="step-text">${step}</span>`;
    els.steps.appendChild(li);
  });

  setText(els.inspectionStatus, task.inspection.status);
  els.inspectionStatus.className = `card-state ${classifyStatus(task.inspection.status)}`;
  setText(els.runtimeDuration, formatRuntimeDuration(getRuntimeStart(task), getRuntimeEnd(task)));
  setText(els.inspectionCycles, task.inspection.cycleCount);
  setText(els.inspectionLast, formatDisplayTime(task.inspection.lastCheckedAt));
  setText(els.inspectionMessage, task.inspection.message);

  const terminal = isTerminalStatus(task.status) || task.pipelineType === "baseApp" || task.status === "idle" || task.status === "ready";
  els.terminateButton.disabled = terminal;
  if (terminal) {
    els.terminateHint.textContent = "当前对象不可终止。";
  }
}

function refreshRuntimeDurationTick() {
  if (!latestTask) return;
  setText(els.runtimeDuration, formatRuntimeDuration(getRuntimeStart(latestTask), getRuntimeEnd(latestTask)));
}

els.workspaceCopyButton.addEventListener("click", async () => {
  const workspace = els.workspace.textContent.trim();
  try {
    const copied = await copyToClipboard(workspace);
    els.workspaceCopyButton.textContent = copied ? "✓" : "!";
    els.workspaceCopyButton.title = copied ? "已复制" : "复制失败";
    window.setTimeout(() => {
      els.workspaceCopyButton.textContent = "⧉";
      els.workspaceCopyButton.title = "复制工作空间";
    }, 1000);
  } catch (error) {
    els.workspaceCopyButton.textContent = "!";
    els.workspaceCopyButton.title = `复制失败: ${error}`;
    window.setTimeout(() => {
      els.workspaceCopyButton.textContent = "⧉";
      els.workspaceCopyButton.title = "复制工作空间";
    }, 1200);
  }
});

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { cache: "no-store", ...options });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function refreshPipelineList() {
  const payload = await fetchJson("/api/pipelines");
  renderPipelineOptions(payload.items || []);
}

async function refreshLogs() {
  const logs = await fetchJson(`/api/pipelines/current/logs?pipeline=${encodeURIComponent(currentPipeline)}`);
  els.pipelineLog.textContent = logs.pipelineLog || "暂无日志";
  els.agentLog.textContent = logs.agentLog || "暂无日志";
}

async function refreshTask() {
  const task = await fetchJson(`/api/pipelines/current?pipeline=${encodeURIComponent(currentPipeline)}`);
  renderTask(task);
}

async function refreshAll() {
  try {
    await refreshPipelineList();
    await Promise.all([refreshTask(), refreshLogs()]);
    els.terminateHint.textContent = "";
  } catch (error) {
    els.terminateHint.textContent = `刷新失败: ${error}`;
  }
}

els.pipelineSelect.addEventListener("change", async (event) => {
  currentPipeline = event.target.value;
  await refreshAll();
});

els.terminateButton.addEventListener("click", async () => {
  const confirmed = window.confirm(`确定终止 ${currentPipeline} 的 Agent 任务吗？`);
  if (!confirmed) return;
  els.terminateButton.disabled = true;
  try {
    const payload = await fetchJson(`/api/pipelines/current/terminate?pipeline=${encodeURIComponent(currentPipeline)}`, { method: "POST" });
    els.terminateHint.textContent = payload.ok ? "终止请求已提交。" : "终止失败。";
    await refreshAll();
  } catch (error) {
    els.terminateHint.textContent = `终止失败: ${error}`;
  }
});

els.shutdownConsoleButton.addEventListener("click", async () => {
  const confirmed = window.confirm("确定关闭当前 Web 控制台吗？");
  if (!confirmed) return;
  els.shutdownConsoleButton.disabled = true;
  try {
    // 与 terminate 一样必须为 POST，否则走 GET 会得到 404，页面无法进入“已关闭”状态
    const payload = await fetchJson("/api/console/shutdown", { method: "POST" });
    els.terminateHint.textContent = payload.ok ? "控制台正在关闭。" : "关闭控制台失败。";
    window.setTimeout(() => {
      window.clearInterval(refreshAllIntervalId);
      window.clearInterval(refreshRuntimeIntervalId);
      document.body.innerHTML = "<main class=\"shell\"><section class=\"card hero-card\"><div><p class=\"eyebrow\">Console Closed</p><h1>控制台已关闭</h1><p class=\"card-note\">请重新执行 run_pipeline 再次启动 Web 页面。</p></div></section></main>";
    }, 500);
  } catch (error) {
    els.shutdownConsoleButton.disabled = false;
    els.terminateHint.textContent = `关闭控制台失败: ${error}`;
  }
});

refreshAll();
const refreshAllIntervalId = window.setInterval(refreshAll, 3000);
const refreshRuntimeIntervalId = window.setInterval(refreshRuntimeDurationTick, 1000);

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
    wfEls.terminalInput.value = highlighted.dataset.cmd;
    container.classList.remove('is-visible');
    container.innerHTML = '';
    wfCmdSuggestionIdx = -1;
    return true;
  }
  return false;
}

// Real pipeline integration
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
  wf.tasks = WF_REAL_STEPS.map((s) => ({ id: s.id, name: s.name, type: 'task', status: 'idle' }));
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
      return { id: 'step' + i, name, type: 'task', status };
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
  // Find first task that hasn't completed or is running
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
  const nodeH = 68;
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
    // Body path: full rect with all corners rounded.
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

    // Header fill: same shape but clipped to header height.
    // We draw a full rounded rect but cover the bottom half with a flat-bottom rect.
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
    const statText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    statText.setAttribute('x', x + 12);
    statText.setAttribute('y', y + headerH + (nodeH - headerH) / 2);
    statText.setAttribute('class', 'wf-flow-node-status');
    statText.setAttribute('dominant-baseline', 'central');
    statText.textContent = statusLabels[task.status] || task.status;
    if (task.status === 'running') statText.setAttribute('fill', '#4a8fe0');
    else if (task.status === 'completed') statText.setAttribute('fill', '#3a9a6a');
    else if (task.status === 'failed') statText.setAttribute('fill', '#d04a3a');
    else if (task.status === 'waiting') statText.setAttribute('fill', '#b878d0');
    g.appendChild(statText);

    contentGroup.appendChild(g);
  });
}

/* Node selection */
wfEls.flowSvg.addEventListener('click', (e) => {
  // Clear all selections first
  document.querySelectorAll('.wf-flow-node.selected').forEach((n) => n.classList.remove('selected'));
  // Find clicked node
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
    // Only start pan if clicking on empty space (not on a node)
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

// Init panning
wfSetupPanning();

/* Workflow execution simulation */
let wfRunTimeout = null;

function wfRunNext(wf) {
  const next = wfGetNextPending(wf);
  if (!next) {
    // All tasks completed
    wfState.running = false;
    wfEls.terminalStatus.textContent = '已完成';
    wfEls.terminalStatus.style.color = 'var(--success)';
    wfEls.terminalInput.disabled = true;
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
    // Branch task: pause for user input
    next.status = 'waiting';
    wfRenderFlow(wf);
    wfEls.terminalStatus.textContent = `等待选择: ${next.name}`;
    wfEls.terminalStatus.style.color = 'var(--warning)';
    wfTerminalWriteln(`[${wfTerminalTimestamp()}] ◇ ${next.name} — 请选择分支方向:`, 'wf-terminal-branch');

    const branchStr = next.branches.map((b, i) =>
      `<span class="wf-terminal-branch-option" data-branch="${b}" data-task-id="${next.id}">[${i + 1}] ${b}</span>`
    ).join(' ');
    wfTerminalWriteHTML(branchStr);

    // Add click handlers for branch options
    wfEls.terminalBody.querySelectorAll('.wf-terminal-branch-option').forEach((el) => {
      el.addEventListener('click', () => {
        const branch = el.dataset.branch;
        const taskId = el.dataset.taskId;
        wfHandleBranch(wf, taskId, branch);
      });
    });

    wfState.running = false;
    return;
  }

  // Regular task: simulate execution with delay
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

  // Simulate branch-specific behavior
  if (branch.includes('跳过') || branch.includes('拒绝')) {
    wfTerminalWriteln(`[${wfTerminalTimestamp()}] ⚠ 跳过后续依赖任务`, 'wf-terminal-error');
    // Mark downstream tasks as skipped (completed without doing)
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
    wfEls.terminalInput.disabled = true;
    wfTerminalWriteln(`[${wfTerminalTimestamp()}] ■ 工作流终止`, 'wf-terminal-muted');
    return;
  }

  if (branch.includes('重试')) {
    // Retry: reset and run this task again
    task.status = 'idle';
    wfRenderFlow(wf);
    wfTerminalWriteln(`[${wfTerminalTimestamp()}] ⟳ 准备重试: ${task.name}`, 'wf-terminal-warning');
    wfState.running = true;
    wfRunNext(wf);
    return;
  }

  // Normal branch: continue to next task
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

  // Reset canvas pan to center
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
      // Restart real pipeline polling
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
