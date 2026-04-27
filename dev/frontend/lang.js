/* Language switching */
const langDict = {
  zh: {
    'tab.workflow': '工作流',
    'tab.exception': '异常场景',
    'tab.sim-build': '图片仿真APP',
    'tab.app-build': '代码仿真APP',
    'wf.terminal.header': 'Chat',
    'wf.terminal.placeholder': '输入命令...',
    'wf.terminal.standby': '待命',
    'wf.terminal.select': '← 选择一个工作流开始',
    'wf.run': '▶ 运行',
    'wf.stop': '■ 停止',
    'wf.run-title': '运行工作流',
    'metric.status': '流水线状态',
    'metric.base': '仿真 APP 基线',
    'metric.branch': '当前分支',
    'metric.app-type': '仿真 APP 类型',
    'metric.scenario-id': '场景编号',
    'metric.updated': '最近更新时间',
    'metric.workspace': '工作空间',
    'metric.copy-workspace': '复制工作空间',
    'exc.sidebar-title': 'APP 场景分类',
    'exc.search-placeholder': '搜索APP或流程...',
    'exc.filter-all-app': '所有 APP',
    'exc.filter-all-flow': '所有流程',
    'exc.filter-all-col': '所有故障域',
    'exc.filter-all-pri': '所有优先级',
    'exc.total': '共',
    'exc.filtered': '筛选',
    'exc.items': '条',
    'exc.th-priority': '风险等级',
    'exc.th-app': 'APP',
    'exc.th-flow': '流程',
    'exc.th-col': '故障域',
    'exc.th-type': '故障类型',
    'exc.th-category': '故障分类',
    'exc.th-desc': '故障描述',
    'exc.th-actions': '操作',
    'exc.show-questions': '查看现象示例',
    'exc.modal-title': '现象示例',
    'exc.fault-types': '种故障类型',
    'control.terminate': '终止任务',
    'control.shutdown': '关闭控制台',
    'control.hint-terminal': '当前对象不可终止。',
    'pipeline.select': '场景选择',
    'app.download': '仿真APP',
    'agent.running': '运行中',
    'agent.not-running': '未运行',
    'progress.label': '任务进度',
    'progress.current': '当前阶段',
    'agent.title': 'Agent 信息',
    'control.title': '任务控制',
    'logs.pipeline': '流水线日志',
    'logs.agent': 'Agent 日志',
    'logs.pipeline-empty': '暂无日志',
    'logs.agent-empty': '暂无日志',
  },
  en: {
    'tab.workflow': 'Workflow',
    'tab.exception': 'Exceptions',
    'tab.sim-build': 'Image Sim',
    'tab.app-build': 'Code Sim',
    'wf.terminal.header': 'Chat',
    'wf.terminal.placeholder': 'Type a command...',
    'wf.terminal.standby': 'Standby',
    'wf.terminal.select': '← Select a workflow to start',
    'wf.run': '▶ Run',
    'wf.stop': '■ Stop',
    'wf.run-title': 'Run Workflow',
    'metric.status': 'Pipeline Status',
    'metric.base': 'Sim App Base',
    'metric.branch': 'Branch',
    'metric.app-type': 'App Type',
    'metric.scenario-id': 'Scenario ID',
    'metric.updated': 'Updated',
    'metric.workspace': 'Workspace',
    'metric.copy-workspace': 'Copy Workspace',
    'exc.sidebar-title': 'App Categories',
    'exc.search-placeholder': 'Search app or flow...',
    'exc.filter-all-app': 'All Apps',
    'exc.filter-all-flow': 'All Flows',
    'exc.filter-all-col': 'All Domains',
    'exc.filter-all-pri': 'All Priorities',
    'exc.total': 'Total',
    'exc.filtered': 'Filtered',
    'exc.items': '',
    'exc.th-priority': 'Risk Level',
    'exc.th-app': 'App',
    'exc.th-flow': 'Flow',
    'exc.th-col': 'Domain',
    'exc.th-type': 'Type',
    'exc.th-category': 'Category',
    'exc.th-desc': 'Description',
    'exc.th-actions': 'Actions',
    'exc.show-questions': 'View scenarios',
    'exc.modal-title': 'Example Scenarios',
    'exc.fault-types': 'fault types',
    'control.terminate': 'Terminate',
    'control.shutdown': 'Shutdown Console',
    'control.hint-terminal': 'Not available for termination.',
    'pipeline.select': 'Pipeline',
    'app.download': 'Sim App',
    'agent.running': 'Running',
    'agent.not-running': 'Stopped',
    'progress.label': 'Progress',
    'progress.current': 'Current',
    'agent.title': 'Agent Info',
    'control.title': 'Task Control',
    'logs.pipeline': 'Pipeline Log',
    'logs.agent': 'Agent Log',
    'logs.pipeline-empty': 'No logs yet',
    'logs.agent-empty': 'No logs yet',
  },
};

let currentLang = localStorage.getItem('lang') || 'zh';

function t(key) {
  const dict = langDict[currentLang] || langDict.zh;
  return dict[key] || langDict.zh[key] || key;
}

function setLang(lang) {
  if (!langDict[lang]) return;
  currentLang = lang;
  localStorage.setItem('lang', lang);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

  // Update data-i18n elements
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });

  // Update data-i18n-placeholder elements
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });

  // Update data-i18n-title elements
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });

  // Dispatch event for dynamic content
  document.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));

  // Update toggle button active state
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.lang === lang);
  });
}

// Toggle button click handlers
document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.addEventListener('click', () => setLang(btn.dataset.lang));
});

// Load saved language on init
setLang(currentLang);
