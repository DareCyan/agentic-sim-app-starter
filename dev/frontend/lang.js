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
    'exc.show-questions': '查看示例场景',
    'exc.modal-title': '示例场景',
    'exc.fault-types': '种故障类型',
    'exc.stat-total': '故障场景',
    'exc.stat-scenarios': '示例场景',
    'exc.stat-apps': 'APP 种类',
    'exc.stat-types': '故障类型',
    'exc.stat-domains': '故障域',
    'exc.matrix-app': 'APP',
    'exc.matrix-fault': '故障分类',
    'exc.matrix-types': '种类型',
    'exc.matrix-scenarios': '条场景',
    'exc.matrix-legend': '场景密度',
    'exc.modal-descriptions': '故障描述',
    'exc.modal-scenarios': '示例场景',
    'exc.modal-flows': '关联流程',
    'exc.modal-meta': '详细信息',
    'exc.copy': '复制',
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
    'sim.title': '图片仿真APP',
    'sim.subtitle': '安装 HAP 应用并传输文件到设备',
    'sim.device-id': '设备标识',
    'sim.device-placeholder': '如 192.168.1.100:5555',
    'sim.device-loading': '搜索设备中...',
    'sim.device-none': '未发现设备',
    'sim.device-manual': '手动输入...',
    'sim.run': '▶ 执行',
    'sim.step-hdc': '检查 HDC',
    'sim.step-connect': '连接设备',
    'sim.step-uninstall': '卸载旧应用',
    'sim.step-install': '安装 HAP',
    'sim.step-start': '启动应用',
    'sim.step-send': '传输文件',
    'sim.step-stop': '关闭应用',
    'sim.log-title': '执行日志',
    'sim.log-empty': '等待执行...',
    'sim.state-running': '执行中',
    'sim.state-done': '已完成',
    'sim.state-error': '出错',
    'sim.screen-title': '设备屏幕',
    'sim.screen-placeholder': '等待连接设备...',
    'sim.key-back': '返回',
    'sim.key-home': '主页',
    'sim.key-recent': '最近任务',
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
    'exc.stat-total': 'Faults',
    'exc.stat-scenarios': 'Scenarios',
    'exc.stat-apps': 'App Types',
    'exc.stat-types': 'Fault Types',
    'exc.stat-domains': 'Domains',
    'exc.matrix-app': 'APP',
    'exc.matrix-fault': 'Fault Category',
    'exc.matrix-types': 'types',
    'exc.matrix-scenarios': 'scenarios',
    'exc.matrix-legend': 'Density',
    'exc.modal-descriptions': 'Fault Description',
    'exc.modal-scenarios': 'Example Scenarios',
    'exc.modal-flows': 'Related Flows',
    'exc.modal-meta': 'Details',
    'exc.copy': 'Copy',
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
    'sim.title': 'Image Sim APP',
    'sim.subtitle': 'Install HAP and transfer files to device',
    'sim.device-id': 'Device ID',
    'sim.device-placeholder': 'e.g. 192.168.1.100:5555',
    'sim.device-loading': 'Searching devices...',
    'sim.device-none': 'No devices found',
    'sim.device-manual': 'Enter manually...',
    'sim.run': '▶ Run',
    'sim.step-hdc': 'Check HDC',
    'sim.step-connect': 'Connect Device',
    'sim.step-uninstall': 'Uninstall Old App',
    'sim.step-install': 'Install HAP',
    'sim.step-start': 'Start App',
    'sim.step-send': 'Transfer Files',
    'sim.step-stop': 'Stop App',
    'sim.log-title': 'Execution Log',
    'sim.log-empty': 'Waiting to run...',
    'sim.state-running': 'Running',
    'sim.state-done': 'Done',
    'sim.state-error': 'Error',
    'sim.screen-title': 'Device Screen',
    'sim.screen-placeholder': 'Waiting for device...',
    'sim.key-back': 'Back',
    'sim.key-home': 'Home',
    'sim.key-recent': 'Recent',
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
