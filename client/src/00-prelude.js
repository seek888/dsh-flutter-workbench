/* ====================================================================== *
 * 00-prelude.js — owner: dev-ui-core
 *
 * Design tokens, i18n dictionaries, the HTTP client, polling hooks and the
 * shared UI kit. Everything below is a plain declaration in the single
 * factory scope produced by `scripts/build-client.mjs`, so no module syntax.
 *
 * Rules honoured here (docs/CONTRACTS.md §1, §8.1):
 *  - colours / radii only through `--dsw-alias-*` / `--dsw-radius-*` tokens;
 *  - every user-visible string comes from `t()`, with a `zh` and an `en` entry;
 *  - `api()` throws `{ status, code, message, body }` and never resolves a
 *    non-ok body as success;
 *  - components are plain functions: props in, `h()` out.
 * ====================================================================== */

const h = React.createElement
const PANEL_ID = 'flutter-workbench'
const API = '/api/flutter-workbench'
const LOCALE_NS = 'flutter-workbench'

/** Log vocabulary — mirrors host/logs.js. */
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']
const SOURCES = ['flutter', 'stdout', 'stderr', 'daemon', 'vm', 'network', 'toolchain', 'plugin', 'ai']
/** RunState.phase values — mirrors CONTRACTS §4. */
const PHASES = ['starting', 'running', 'reloading', 'restarting', 'stopping', 'stopped', 'failed', 'exited']
/** Kanban lanes — mirrors CONTRACTS §4. */
const LANES = ['backlog', 'ready', 'running', 'review', 'verify', 'done']

/* ====================================================================== *
 * Design tokens
 * ====================================================================== */

/**
 * Theme tokens. The first block is the contract surface (§8.1) so pages can
 * rely on the names; the second block is a richer alias set.
 * No literal colour, gradient or radius appears here.
 */
const T = {
  /* --- §8.1 canonical names ------------------------------------------- */
  bg: 'var(--dsw-alias-bg-base)',
  bgRaised: 'var(--dsw-alias-bg-layer-1)',
  bgInput: 'var(--dsw-alias-bg-input, var(--dsw-alias-bg-layer-2))',
  border: 'var(--dsw-alias-border-l1)',
  borderStrong: 'var(--dsw-alias-border-l3)',
  text: 'var(--dsw-alias-label-primary)',
  textDim: 'var(--dsw-alias-label-secondary)',
  textFaint: 'var(--dsw-alias-label-tertiary)',
  brand: 'var(--dsw-alias-state-business-primary)',
  brandText: 'var(--dsw-alias-label-primary-foreground)',
  ok: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
  radius: 'var(--dsw-radius-lg)',
  radiusSm: 'var(--dsw-radius-sm)',
  font: 'var(--dsw-font-family, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif)',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Cascadia Mono", monospace',

  /* --- richer aliases (all host tokens) -------------------------------- */
  l1: 'var(--dsw-alias-bg-layer-1)',
  l2: 'var(--dsw-alias-bg-layer-2)',
  l3: 'var(--dsw-alias-bg-layer-3)',
  overlay: 'var(--dsw-alias-bg-overlay)',
  hover: 'var(--dsw-alias-interactive-bg-hover)',
  active: 'var(--dsw-alias-interactive-bg-active)',
  selected: 'var(--dsw-alias-button-ghost-active-fill)',
  link: 'var(--dsw-alias-link)',
  btn: 'var(--dsw-alias-button-primary-fill)',
  btnFg: 'var(--dsw-alias-label-primary-foreground)',
  tag: 'var(--dsw-alias-markdown-tag)',
  code: 'var(--dsw-alias-markdown-code-block)',
  inlineCode: 'var(--dsw-alias-markdown-inline-code)',
  warnLabel: 'var(--dsw-alias-state-warn-label)',
  done: 'var(--dsw-alias-state-done-primary)',
  idle: 'var(--dsw-alias-state-idle-primary)',
  skeleton: 'var(--dsw-alias-bg-skeleton)',
  scrollbar: 'var(--dsw-alias-scrollbar-bg-l2)',
  toastBg: 'var(--dsw-alias-toast-bg)',
  toastFg: 'var(--dsw-alias-toast-label)',
  shadow: 'var(--dsw-alias-shadow-overlay, var(--dsw-shadow-overlay, none))',

  /* --- radii beyond the two contract names ----------------------------- */
  radiusXs: 'var(--dsw-radius-xs)',
  radiusMd: 'var(--dsw-radius-md)',

  /* --- metrics (plain numbers: layout, not color) ---------------------- */
  fs: 13,
  fsXs: 11,
  fsSm: 12,
  fsMd: 14,
  fsLg: 16,
  fsXl: 18,
  spacing: { xs: 4, sm: 6, md: 10, lg: 14, xl: 20 },
  row: 22,
}

/** Body text style, reused by most kit primitives. */
const TEXT_STYLE = {
  fontFamily: T.font,
  fontSize: T.fs,
  lineHeight: '20px',
  color: T.text,
}

/* ====================================================================== *
 * Locale dictionaries
 *
 * `ZH` / `EN` are plain mutable objects on purpose: sibling fragments may
 * `Object.assign` their own keys at load time, and 90-apply registers these
 * very objects with `ctx.locale.register(LOCALE_NS, { zh: ZH, en: EN })`.
 * Key namespaces: common.*, nav.*, shell.*, phase.*, device.*, run.*,
 * runtime.*, logs.*, net.*, board.*, quality.*, settings.*, state.*, boot.*
 * ====================================================================== */

const ZH = {
  /* ---- common -------------------------------------------------------- */
  'common.ok': '确定',
  'common.cancel': '取消',
  'common.close': '关闭',
  'common.save': '保存',
  'common.saved': '已保存',
  'common.reset': '重置',
  'common.delete': '删除',
  'common.edit': '编辑',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.copyFailed': '复制失败',
  'common.refresh': '刷新',
  'common.retry': '重试',
  'common.loading': '加载中…',
  'common.empty': '暂无数据',
  'common.search': '搜索',
  'common.all': '全部',
  'common.none': '无',
  'common.yes': '是',
  'common.no': '否',
  'common.add': '添加',
  'common.remove': '移除',
  'common.create': '新建',
  'common.open': '打开',
  'common.export': '导出',
  'common.clear': '清空',
  'common.apply': '应用',
  'common.unknown': '未知',
  'common.details': '详情',
  'common.more': '更多',
  'common.collapse': '收起',
  'common.expand': '展开',
  'common.count': '共 {n} 条',
  'common.never': '从未',
  'common.enabled': '启用',
  'common.disabled': '已停用',
  'common.error': '出错了',
  'common.actionFailed': '操作失败：{message}',
  'common.required': '必填',
  'common.optional': '可选',
  'common.current': '当前',
  'common.total': '总计',
  'common.time': '时间',
  'common.status': '状态',
  'common.name': '名称',
  'common.path': '路径',
  'common.source': '来源',
  'common.level': '级别',
  'common.message': '消息',
  'common.run': '运行',
  'common.actions': '操作',
  'common.filters': '筛选',
  'common.confirm': '确认',
  'common.select': '选择',
  'common.noneSelected': '未选择',
  'common.start': '开始',
  'common.stop': '停止',
  'common.duration': '耗时',
  'common.size': '大小',
  'common.type': '类型',
  'common.value': '值',
  'common.key': '键',
  'common.id': 'ID',
  'common.download': '下载',
  'common.secondsAgo': '{n} 秒前',
  'common.minutesAgo': '{n} 分钟前',
  'common.hoursAgo': '{n} 小时前',
  'common.justNow': '刚刚',
  'common.notAvailable': '—',

  /* ---- nav ----------------------------------------------------------- */
  'nav.runtime': '运行',
  'nav.logs': '日志',
  'nav.network': '网络',
  'nav.board': '看板',
  'nav.quality': '质量',
  'nav.settings': '设置',
  'nav.section': '工作台',

  /* ---- shell --------------------------------------------------------- */
  'shell.title': 'Flutter 工作台',
  'shell.subtitle': '客户端开发',
  'shell.noProject': '未添加项目',
  'shell.projectPlaceholder': '选择项目…',
  'shell.addProject': '添加项目',
  'shell.addProjectTitle': '添加 Flutter 项目',
  'shell.addProjectHint': '项目根目录（含 pubspec.yaml）的绝对路径',
  'shell.addProjectPlaceholder': 'C:\\work\\my_app',
  'shell.addProjectEmpty': '请填写项目路径',
  'shell.removeProject': '从工作台移除',
  'shell.removeProjectConfirm': '从工作台移除「{name}」？磁盘文件不受影响。',
  'shell.projectAdded': '已添加项目：{name}',
  'shell.projectRemoved': '已移除项目',
  'shell.connected': '已连接',
  'shell.disconnected': '未连接',
  'shell.offlineTitle': '无法连接工作台后端',
  'shell.offlineBody': '请确认插件已启用，然后重试。{message}',
  'shell.palette': '命令面板',
  'shell.palettePlaceholder': '搜索页面或命令…',
  'shell.paletteEmpty': '没有匹配的命令',
  'shell.palettePages': '页面',
  'shell.paletteActions': '命令',
  'shell.paletteHint': '↑↓ 选择 · Enter 执行 · Esc 关闭',
  'shell.hintPalette': 'Ctrl/⌘ K 命令面板',
  'shell.hintRefreshLogs': 'R 刷新日志',
  'shell.hintEsc': 'Esc 关闭',
  'shell.logsCount': '{n} 条日志',
  'shell.errorsCount': '{n} 个异常',
  'shell.runId': '运行 {id}',
  'shell.noRun': '没有运行中的项目',
  'shell.devtools': 'DevTools',
  'shell.vmUri': 'VM 服务',
  'shell.copyVmUri': '复制 VM 地址',
  'shell.vmUriMissing': '还没有 VM 地址',
  'shell.device': '设备',
  'shell.deviceMissing': '未检测到设备',
  'shell.pausePolling': '暂停轮询',
  'shell.resumePolling': '继续轮询',
  'shell.paused': '轮询已暂停',
  'shell.locale': '语言',
  'shell.switchLocale': '切换到英文',
  'shell.fallbackTitle': '{page} 尚未加载',
  'shell.fallbackBody': '该页面模块还没有注册到客户端包里，运行 node scripts/build-client.mjs 重新构建。',
  'shell.counters': '计数',
  'shell.errorBoundary': '页面渲染失败：{message}',

  /* ---- phases -------------------------------------------------------- */
  'phase.starting': '启动中',
  'phase.running': '运行中',
  'phase.reloading': '热重载中',
  'phase.restarting': '热重启中',
  'phase.stopping': '停止中',
  'phase.stopped': '已停止',
  'phase.failed': '失败',
  'phase.exited': '已退出',
  'phase.idle': '空闲',

  /* ---- devices ------------------------------------------------------- */
  'device.device': '设备',
  'device.emulator': '模拟器',
  'device.none': '没有可用设备',
  'device.refresh': '刷新设备',
  'device.select': '选择设备',
  'device.platform': '平台',

  /* ---- run ----------------------------------------------------------- */
  'run.active': '当前运行',
  'run.recent': '最近运行',
  'run.empty': '还没有运行记录',
  'run.noActiveTitle': '还没有运行',
  'run.noActiveBody': '选择启动配置，然后点「启动」。',
  'run.id': '运行 ID',
  'run.phase': '阶段',
  'run.exitCode': '退出码',
  'run.pid': '进程 PID',
  'run.startedAt': '启动时间',
  'run.finishedAt': '结束时间',
  'run.duration': '已运行',
  'run.hotReloads': '热重载',
  'run.hotRestarts': '热重启',
  'run.vmService': 'VM Service',
  'run.httpUri': 'HTTP 地址',
  'run.devtools': 'DevTools',
  'run.appId': '应用 ID',
  'run.device': '设备',
  'run.project': '项目',
  'run.program': '入口',
  'run.error': '错误',
  'run.count': '{n} 次',

  /* ---- runtime page -------------------------------------------------- */
  'runtime.title': '运行',
  'runtime.subtitle': '选择项目、配置与设备，然后启动、热重载或热重启。',
  'runtime.controls': '运行控制',
  'runtime.project': '项目',
  'runtime.projectHint': '项目根目录来自工作台项目列表',
  'runtime.config': '启动配置',
  'runtime.configEmpty': '没有找到启动配置',
  'runtime.configEmptyHint': '在工作台添加项目，或检查 .vscode/launch.json 与 lib/main.dart。',
  'runtime.configSourceLaunch': 'launch.json',
  'runtime.configSourceEntry': '入口文件',
  'runtime.configSourceManual': '手动',
  'runtime.configManual': '手动配置',
  'runtime.device': '设备',
  'runtime.deviceRefresh': '刷新设备',
  'runtime.mode': '模式',
  'runtime.flavor': 'Flavor',
  'runtime.flavorHint': '可选，例如 dev / prod',
  'runtime.dartDefines': 'Dart defines',
  'runtime.dartDefinesEmpty': '还没有 define',
  'runtime.addDefine': '添加 define',
  'runtime.defineKey': '键（如 API_URL）',
  'runtime.defineValue': '值',
  'runtime.args': '额外参数',
  'runtime.argsHint': '空格分隔，例如 --dart-define-from-file=env.json',
  'runtime.program': '入口文件',
  'runtime.programHint': '默认 lib/main.dart',
  'runtime.start': '启动',
  'runtime.stop': '停止',
  'runtime.reload': '热重载',
  'runtime.restart': '热重启',
  'runtime.starting': '启动中…',
  'runtime.stopping': '停止中…',
  'runtime.reloading': '热重载中…',
  'runtime.restarting': '热重启中…',
  'runtime.started': '已启动运行 {id}',
  'runtime.stopped': '已停止 {n} 个运行',
  'runtime.reloaded': '热重载完成',
  'runtime.restarted': '热重启完成',
  'runtime.startFailed': '启动失败：{message}',
  'runtime.stopFailed': '停止失败：{message}',
  'runtime.reloadFailed': '热重载失败：{message}',
  'runtime.restartFailed': '热重启失败：{message}',
  'runtime.noProject': '先在工作台添加并选择一个项目',
  'runtime.noDevice': '没有可用设备，请先启动模拟器或连接真机',
  'runtime.launchFile': 'launch.json：{path}',
  'runtime.launchFileNone': '没有 launch.json，使用入口文件配置',
  'runtime.warnings': '配置警告',
  'runtime.refreshConfigs': '重新扫描配置',
  'runtime.configLoadFailed': '读取配置失败：{message}',
  'runtime.pendingHint': '正在{phase}…',
  'runtime.openDevtools': '打开 DevTools',
  'runtime.copyUri': '复制地址',
  'runtime.devtoolsNeedsRun': '先在运行中的应用上取到 VM 地址，才能打开 DevTools。',
  'runtime.recentEmpty': '还没有运行记录，启动一次即可看到摘要',
  'runtime.definesCount': '{n} 个 define',
  'runtime.deviceCount': '{n} 个设备',
  'runtime.modeDebugHint': 'debug：断言开启、VM Service 可用',
  'runtime.modeProfileHint': 'profile：性能分析，部分调试能力关闭',
  'runtime.modeReleaseHint': 'release：发布构建，无热重载',

  /* ---- logs page ----------------------------------------------------- */
  'logs.title': '日志',
  'logs.follow': '跟随',
  'logs.followOn': '跟随中',
  'logs.followPaused': '已暂停',
  'logs.searchPlaceholder': '搜索文本或正则…',
  'logs.regexInvalid': '无效正则：{message}',
  'logs.levels': '级别',
  'logs.sources': '来源',
  'logs.emptyTitle': '还没有日志',
  'logs.emptyBody': '启动一次运行，或放宽筛选条件。',
  'logs.noMatch': '没有匹配当前筛选的日志',
  'logs.showing': '显示 {shown} / 共 {total} 条',
  'logs.newLines': '{n} 条新日志',
  'logs.jumpToBottom': '跳到最新',
  'logs.copyAll': '复制全部',
  'logs.copyAllDone': '已复制 {n} 条日志',
  'logs.export': '导出 .log',
  'logs.exported': '已导出 {name}',
  'logs.clear': '清空视图',
  'logs.cleared': '日志视图已清空',
  'logs.currentRunOnly': '仅当前运行',
  'logs.allRuns': '全部运行',
  'logs.meta': '元数据',
  'logs.frames': '堆栈',
  'logs.openSource': '跳到源码',
  'logs.openFailed': '无法打开文件：{message}',
  'logs.truncated': '只保留最近 {n} 条',
  'logs.mark': '插入标记',
  'logs.markPrompt': '标记文字',
  'logs.marked': '已插入标记',
  'logs.expandHint': '点击行可展开元数据与堆栈',
  'logs.collapseHint': '点击收起',
  'logs.allLevels': '全部级别',
  'logs.allSources': '全部来源',
  'logs.autoScroll': '自动滚动',
  'logs.entries': '{n} 条',
  'logs.totalBuffered': '缓冲 {n} 条',
  'logs.filtersActive': '筛选生效中',
  'logs.resetFilters': '清除筛选',
  'logs.virtualized': '虚拟滚动（{n} 行）',

  /* ---- network page (dev-ui-data) ------------------------------------ */
  'net.title': '网络',
  'net.subtitle': '来自 Dart VM Service 的 HTTP 请求记录',
  'net.method': '方法',
  'net.status': '状态',
  'net.uri': 'URI',
  'net.host': '主机',
  'net.duration': '耗时',
  'net.size': '大小',
  'net.request': '请求',
  'net.response': '响应',
  'net.headers': 'Headers',
  'net.body': 'Body',
  'net.emptyTitle': '还没有网络请求',
  'net.emptyBody': '启动应用并触发一次 HTTP 请求后，这里会显示记录。',
  'net.errorsOnly': '只看失败',
  'net.searchPlaceholder': '过滤 URI…',
  'net.detailTitle': '请求详情',
  'net.requestHeaders': '请求头',
  'net.responseHeaders': '响应头',
  'net.noBody': '没有 body',
  'net.pending': '进行中',
  'net.clear': '清空',
  'net.copyUri': '复制 URI',
  'net.allStatus': '全部状态',
  'net.statusOk': '2xx 成功',
  'net.statusError': '4xx / 5xx 失败',
  'net.count': '{n} 个请求',
  'net.truncated': '内容已截断',
  'net.notConnected': 'VM Service 未连接，无法读取请求',
  'net.filterHost': '主机',

  /* ---- board (dev-ui-data) ------------------------------------------- */
  'board.title': '看板',
  'board.subtitle': '让 AI 执行的任务卡片',
  'board.lane.backlog': '待办',
  'board.lane.ready': '就绪',
  'board.lane.running': '执行中',
  'board.lane.review': '待验收',
  'board.lane.verify': '验证中',
  'board.lane.done': '完成',
  'board.newTask': '新建卡片',
  'board.editTask': '编辑卡片',
  'board.deleteTask': '删除卡片',
  'board.deleteConfirm': '删除「{title}」？此操作不可撤销。',
  'board.archive': '归档已完成',
  'board.archived': '已归档 {n} 张卡片',
  'board.decompose': 'AI 拆解',
  'board.decomposeHint': '描述一个需求，AI 会拆成带验收标准的卡片',
  'board.decomposePrompt': '需求描述',
  'board.decomposeEmpty': '请先写一段需求描述',
  'board.decomposed': '已生成 {n} 张卡片',
  'board.dispatch': '派发执行',
  'board.dispatched': '已派发到会话 {id}',
  'board.dispatchFailed': '派发失败：{message}',
  'board.report': '回报结果',
  'board.cancelAgent': '取消执行',
  'board.syncAgent': '同步状态',
  'board.fieldTitle': '标题',
  'board.fieldDetail': '详情',
  'board.fieldAcceptance': '验收标准（一行一条）',
  'board.fieldVerify': '验证命令（一行一条）',
  'board.fieldFiles': '涉及文件（一行一条）',
  'board.fieldDeps': '依赖卡片（一行一条）',
  'board.fieldPriority': '优先级',
  'board.fieldTags': '标签（逗号分隔）',
  'board.priority.low': '低',
  'board.priority.normal': '普通',
  'board.priority.high': '高',
  'board.priority.urgent': '紧急',
  'board.agent.idle': '空闲',
  'board.agent.queued': '排队中',
  'board.agent.working': '执行中',
  'board.agent.blocked': '阻塞',
  'board.agent.done': '已完成',
  'board.agent.failed': '失败',
  'board.blocked': '已阻塞',
  'board.verdict.pass': '通过',
  'board.verdict.fail': '未通过',
  'board.result': '执行结果',
  'board.history': '历史',
  'board.emptyLane': '拖入卡片或点击 + 新建',
  'board.emptyTitle': '看板是空的',
  'board.emptyBody': '新建一张卡片，或让 AI 从一个想法开始拆解。',
  'board.count': '{n} 张',
  'board.noProject': '未绑定项目',
  'board.moveTo': '移动到 {lane}',

  /* ---- quality (dev-ui-data) ----------------------------------------- */
  'quality.title': '质量',
  'quality.subtitle': '分析、测试、异常、性能与截图',
  'quality.tabAnalyze': '分析',
  'quality.tabTest': '测试',
  'quality.tabErrors': '异常',
  'quality.tabPerf': '性能',
  'quality.tabScreenshot': '截图',
  'quality.analyze': '运行分析',
  'quality.analyzing': '分析中…',
  'quality.issues': '问题',
  'quality.errors': '错误',
  'quality.warnings': '警告',
  'quality.infos': '提示',
  'quality.noIssues': '没有发现问题',
  'quality.runTests': '运行测试',
  'quality.testing': '测试中…',
  'quality.passed': '通过',
  'quality.failed': '失败',
  'quality.skipped': '跳过',
  'quality.testDuration': '耗时',
  'quality.noTests': '还没有测试结果',
  'quality.errEmptyTitle': '没有异常',
  'quality.errEmptyBody': '应用运行时的异常会按指纹去重后出现在这里。',
  'quality.errCount': '出现 {n} 次',
  'quality.errFrames': '堆栈帧',
  'quality.errOpen': '跳到源码',
  'quality.perfEmpty': '还没有帧统计',
  'quality.jank': '掉帧',
  'quality.frames': '帧数',
  'quality.worstFrame': '最差帧',
  'quality.buildTime': '构建',
  'quality.rasterTime': '光栅化',
  'quality.screenshot': '截屏',
  'quality.capturing': '截图中…',
  'quality.screenshotEmpty': '还没有截图',
  'quality.screenshotSaved': '已保存到 {path}',
  'quality.widgetTree': 'Widget 树',
  'quality.dumpTree': '导出 Widget 树',
  'quality.pubGet': 'pub get',
  'quality.clean': 'clean',
  'quality.build': '构建',
  'quality.doctor': 'doctor',
  'quality.format': 'format',
  'quality.jobRunning': '任务执行中…',
  'quality.jobDone': '任务完成',
  'quality.jobFailed': '任务失败：{message}',
  'quality.target': '构建目标',
  'quality.openScreenshot': '打开截图',
  'quality.noRun': '需要一次运行中的会话来收集数据',

  /* ---- settings (dev-ui-data owns the page) -------------------------- */
  'settings.title': '设置',
  'settings.subtitle': '工作台与本机工具链配置',
  'settings.save': '保存设置',
  'settings.saved': '设置已保存',
  'settings.saveFailed': '保存失败：{message}',
  'settings.groupPaths': '路径',
  'settings.groupWorkbench': '工作台',
  'settings.groupAi': 'AI',
  'settings.groupMcp': 'MCP',
  'settings.flutterPath': 'Flutter SDK 路径',
  'settings.dartPath': 'Dart SDK 路径',
  'settings.logCapacity': '日志缓冲条数',
  'settings.autoStart': '打开面板时自动启动上次运行',
  'settings.dataDir': '数据目录',
  'settings.editorCommand': '编辑器命令',
  'settings.defaultProvider': '默认 AI provider',
  'settings.defaultModel': '默认 AI model',
  'settings.autoRefreshMs': '面板刷新间隔',
  'settings.networkAutoRefreshMs': '网络日志刷新间隔',
  'settings.maxTaskConcurrency': '看板并发任务数',
  'settings.analysisEnabled': '自动分析错误',
  'settings.mcpToken': 'MCP 访问令牌',
  'settings.mcpEnabled': '启用 MCP',
  'settings.mcpUrl': 'MCP 端点',
  'settings.rotateToken': '重新生成',
  'settings.tokenRotated': '令牌已更新',
  'settings.resolvedPaths': '生效路径',
  'settings.milliseconds': '毫秒',
  'settings.descriptorOnly': '该项由宿主提供，暂不支持在此编辑',

  /* ---- app state ------------------------------------------------------ */
  'state.offline': '无法连接工作台后端',
  'state.connecting': '正在连接工作台…',
  'state.connectionOk': '连接正常',
  'state.lastOk': '最近成功 {time}',

  /* ---- boot ---------------------------------------------------------- */
  'boot.placeholder': '工作台模块正在构建中',
  'boot.disabled': '工作台未启用',
}

const EN = {
  /* ---- common -------------------------------------------------------- */
  'common.ok': 'OK',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.save': 'Save',
  'common.saved': 'Saved',
  'common.reset': 'Reset',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.copyFailed': 'Copy failed',
  'common.refresh': 'Refresh',
  'common.retry': 'Retry',
  'common.loading': 'Loading…',
  'common.empty': 'Nothing here yet',
  'common.search': 'Search',
  'common.all': 'All',
  'common.none': 'None',
  'common.yes': 'Yes',
  'common.no': 'No',
  'common.add': 'Add',
  'common.remove': 'Remove',
  'common.create': 'New',
  'common.open': 'Open',
  'common.export': 'Export',
  'common.clear': 'Clear',
  'common.apply': 'Apply',
  'common.unknown': 'Unknown',
  'common.details': 'Details',
  'common.more': 'More',
  'common.collapse': 'Collapse',
  'common.expand': 'Expand',
  'common.count': '{n} items',
  'common.never': 'never',
  'common.enabled': 'Enabled',
  'common.disabled': 'Disabled',
  'common.error': 'Something went wrong',
  'common.actionFailed': 'Action failed: {message}',
  'common.required': 'required',
  'common.optional': 'optional',
  'common.current': 'Current',
  'common.total': 'Total',
  'common.time': 'Time',
  'common.status': 'Status',
  'common.name': 'Name',
  'common.path': 'Path',
  'common.source': 'Source',
  'common.level': 'Level',
  'common.message': 'Message',
  'common.run': 'Run',
  'common.actions': 'Actions',
  'common.filters': 'Filters',
  'common.confirm': 'Confirm',
  'common.select': 'Select',
  'common.noneSelected': 'Nothing selected',
  'common.start': 'Start',
  'common.stop': 'Stop',
  'common.duration': 'Duration',
  'common.size': 'Size',
  'common.type': 'Type',
  'common.value': 'Value',
  'common.key': 'Key',
  'common.id': 'ID',
  'common.download': 'Download',
  'common.secondsAgo': '{n}s ago',
  'common.minutesAgo': '{n}m ago',
  'common.hoursAgo': '{n}h ago',
  'common.justNow': 'just now',
  'common.notAvailable': '—',

  /* ---- nav ----------------------------------------------------------- */
  'nav.runtime': 'Runtime',
  'nav.logs': 'Logs',
  'nav.network': 'Network',
  'nav.board': 'Board',
  'nav.quality': 'Quality',
  'nav.settings': 'Settings',
  'nav.section': 'Workbench',

  /* ---- shell --------------------------------------------------------- */
  'shell.title': 'Flutter workbench',
  'shell.subtitle': 'client development',
  'shell.noProject': 'No project yet',
  'shell.projectPlaceholder': 'Select a project…',
  'shell.addProject': 'Add project',
  'shell.addProjectTitle': 'Add a Flutter project',
  'shell.addProjectHint': 'Absolute path of the project root (the folder with pubspec.yaml)',
  'shell.addProjectPlaceholder': 'C:\\work\\my_app',
  'shell.addProjectEmpty': 'Enter a project path',
  'shell.removeProject': 'Remove from workbench',
  'shell.removeProjectConfirm': 'Remove “{name}” from the workbench? Files on disk are untouched.',
  'shell.projectAdded': 'Project added: {name}',
  'shell.projectRemoved': 'Project removed',
  'shell.connected': 'Connected',
  'shell.disconnected': 'Disconnected',
  'shell.offlineTitle': 'Cannot reach the workbench host',
  'shell.offlineBody': 'Check that the plugin is enabled, then retry. {message}',
  'shell.palette': 'Command palette',
  'shell.palettePlaceholder': 'Search pages or commands…',
  'shell.paletteEmpty': 'No matching command',
  'shell.palettePages': 'Pages',
  'shell.paletteActions': 'Commands',
  'shell.paletteHint': '↑↓ select · Enter run · Esc close',
  'shell.hintPalette': 'Ctrl/⌘ K palette',
  'shell.hintRefreshLogs': 'R refresh logs',
  'shell.hintEsc': 'Esc close',
  'shell.logsCount': '{n} log lines',
  'shell.errorsCount': '{n} exceptions',
  'shell.runId': 'run {id}',
  'shell.noRun': 'Nothing running',
  'shell.devtools': 'DevTools',
  'shell.vmUri': 'VM service',
  'shell.copyVmUri': 'Copy VM URI',
  'shell.vmUriMissing': 'No VM URI yet',
  'shell.device': 'Device',
  'shell.deviceMissing': 'No device detected',
  'shell.pausePolling': 'Pause polling',
  'shell.resumePolling': 'Resume polling',
  'shell.paused': 'Polling paused',
  'shell.locale': 'Language',
  'shell.switchLocale': 'Switch to Chinese',
  'shell.fallbackTitle': '{page} is not loaded',
  'shell.fallbackBody': 'That page module is not in the client bundle yet — run node scripts/build-client.mjs.',
  'shell.counters': 'Counters',
  'shell.errorBoundary': 'Page render failed: {message}',

  /* ---- phases -------------------------------------------------------- */
  'phase.starting': 'Starting',
  'phase.running': 'Running',
  'phase.reloading': 'Reloading',
  'phase.restarting': 'Restarting',
  'phase.stopping': 'Stopping',
  'phase.stopped': 'Stopped',
  'phase.failed': 'Failed',
  'phase.exited': 'Exited',
  'phase.idle': 'Idle',

  /* ---- devices ------------------------------------------------------- */
  'device.device': 'Device',
  'device.emulator': 'Emulator',
  'device.none': 'No devices available',
  'device.refresh': 'Refresh devices',
  'device.select': 'Select device',
  'device.platform': 'Platform',

  /* ---- run ----------------------------------------------------------- */
  'run.active': 'Current run',
  'run.recent': 'Recent runs',
  'run.empty': 'No runs yet',
  'run.noActiveTitle': 'Nothing running yet',
  'run.noActiveBody': 'Pick a run configuration and press Start.',
  'run.id': 'Run ID',
  'run.phase': 'Phase',
  'run.exitCode': 'Exit code',
  'run.pid': 'PID',
  'run.startedAt': 'Started',
  'run.finishedAt': 'Finished',
  'run.duration': 'Uptime',
  'run.hotReloads': 'Hot reloads',
  'run.hotRestarts': 'Hot restarts',
  'run.vmService': 'VM service',
  'run.httpUri': 'HTTP URI',
  'run.devtools': 'DevTools',
  'run.appId': 'App id',
  'run.device': 'Device',
  'run.project': 'Project',
  'run.program': 'Entry',
  'run.error': 'Error',
  'run.count': '{n}×',

  /* ---- runtime page -------------------------------------------------- */
  'runtime.title': 'Runtime',
  'runtime.subtitle': 'Pick a project, configuration and device, then start, hot reload or hot restart.',
  'runtime.controls': 'Run controls',
  'runtime.project': 'Project',
  'runtime.projectHint': 'Project roots come from the workbench project list',
  'runtime.config': 'Run configuration',
  'runtime.configEmpty': 'No run configuration found',
  'runtime.configEmptyHint': 'Add a project, or check .vscode/launch.json and lib/main.dart.',
  'runtime.configSourceLaunch': 'launch.json',
  'runtime.configSourceEntry': 'entry point',
  'runtime.configSourceManual': 'manual',
  'runtime.configManual': 'Manual configuration',
  'runtime.device': 'Device',
  'runtime.deviceRefresh': 'Refresh devices',
  'runtime.mode': 'Mode',
  'runtime.flavor': 'Flavor',
  'runtime.flavorHint': 'optional, e.g. dev / prod',
  'runtime.dartDefines': 'Dart defines',
  'runtime.dartDefinesEmpty': 'No defines yet',
  'runtime.addDefine': 'Add define',
  'runtime.defineKey': 'Key (e.g. API_URL)',
  'runtime.defineValue': 'Value',
  'runtime.args': 'Extra arguments',
  'runtime.argsHint': 'space separated, e.g. --dart-define-from-file=env.json',
  'runtime.program': 'Entry point',
  'runtime.programHint': 'defaults to lib/main.dart',
  'runtime.start': 'Start',
  'runtime.stop': 'Stop',
  'runtime.reload': 'Hot reload',
  'runtime.restart': 'Hot restart',
  'runtime.starting': 'Starting…',
  'runtime.stopping': 'Stopping…',
  'runtime.reloading': 'Reloading…',
  'runtime.restarting': 'Restarting…',
  'runtime.started': 'Run {id} started',
  'runtime.stopped': 'Stopped {n} run(s)',
  'runtime.reloaded': 'Hot reload done',
  'runtime.restarted': 'Hot restart done',
  'runtime.startFailed': 'Start failed: {message}',
  'runtime.stopFailed': 'Stop failed: {message}',
  'runtime.reloadFailed': 'Hot reload failed: {message}',
  'runtime.restartFailed': 'Hot restart failed: {message}',
  'runtime.noProject': 'Add and select a project first',
  'runtime.noDevice': 'No device available — start an emulator or plug in a phone',
  'runtime.launchFile': 'launch.json: {path}',
  'runtime.launchFileNone': 'No launch.json — using entry-point configs',
  'runtime.warnings': 'Configuration warnings',
  'runtime.refreshConfigs': 'Rescan configs',
  'runtime.configLoadFailed': 'Cannot read configs: {message}',
  'runtime.pendingHint': '{phase}…',
  'runtime.openDevtools': 'Open DevTools',
  'runtime.copyUri': 'Copy URI',
  'runtime.devtoolsNeedsRun': 'Start a run first so DevTools has a VM service URI.',
  'runtime.recentEmpty': 'No runs yet — start one to see a summary here',
  'runtime.definesCount': '{n} defines',
  'runtime.deviceCount': '{n} devices',
  'runtime.modeDebugHint': 'debug: assertions on, VM service available',
  'runtime.modeProfileHint': 'profile: profiling, some debug features off',
  'runtime.modeReleaseHint': 'release: production build, no hot reload',

  /* ---- logs page ----------------------------------------------------- */
  'logs.title': 'Logs',
  'logs.follow': 'Follow',
  'logs.followOn': 'Following',
  'logs.followPaused': 'Paused',
  'logs.searchPlaceholder': 'Search text or regex…',
  'logs.regexInvalid': 'Invalid regex: {message}',
  'logs.levels': 'Levels',
  'logs.sources': 'Sources',
  'logs.emptyTitle': 'No logs yet',
  'logs.emptyBody': 'Start a run, or loosen the filters.',
  'logs.noMatch': 'No log line matches the current filters',
  'logs.showing': 'showing {shown} / {total}',
  'logs.newLines': '{n} new log lines',
  'logs.jumpToBottom': 'Jump to latest',
  'logs.copyAll': 'Copy all',
  'logs.copyAllDone': 'Copied {n} log lines',
  'logs.export': 'Export .log',
  'logs.exported': 'Exported {name}',
  'logs.clear': 'Clear view',
  'logs.cleared': 'Log view cleared',
  'logs.currentRunOnly': 'Current run only',
  'logs.allRuns': 'All runs',
  'logs.meta': 'Metadata',
  'logs.frames': 'Stack',
  'logs.openSource': 'Jump to source',
  'logs.openFailed': 'Cannot open file: {message}',
  'logs.truncated': 'Keeping the newest {n} lines',
  'logs.mark': 'Drop marker',
  'logs.markPrompt': 'Marker text',
  'logs.marked': 'Marker added',
  'logs.expandHint': 'Click a row to expand metadata and stack frames',
  'logs.collapseHint': 'Click to collapse',
  'logs.allLevels': 'All levels',
  'logs.allSources': 'All sources',
  'logs.autoScroll': 'Auto scroll',
  'logs.entries': '{n} lines',
  'logs.totalBuffered': '{n} buffered',
  'logs.filtersActive': 'Filters active',
  'logs.resetFilters': 'Clear filters',
  'logs.virtualized': 'Virtualized ({n} rows)',

  /* ---- network page (dev-ui-data) ------------------------------------ */
  'net.title': 'Network',
  'net.subtitle': 'HTTP requests captured from the Dart VM service',
  'net.method': 'Method',
  'net.status': 'Status',
  'net.uri': 'URI',
  'net.host': 'Host',
  'net.duration': 'Duration',
  'net.size': 'Size',
  'net.request': 'Request',
  'net.response': 'Response',
  'net.headers': 'Headers',
  'net.body': 'Body',
  'net.emptyTitle': 'No HTTP requests yet',
  'net.emptyBody': 'Start the app and trigger a request; entries appear here.',
  'net.errorsOnly': 'Failures only',
  'net.searchPlaceholder': 'Filter by URI…',
  'net.detailTitle': 'Request detail',
  'net.requestHeaders': 'Request headers',
  'net.responseHeaders': 'Response headers',
  'net.noBody': 'No body',
  'net.pending': 'Pending',
  'net.clear': 'Clear',
  'net.copyUri': 'Copy URI',
  'net.allStatus': 'All statuses',
  'net.statusOk': '2xx succeeded',
  'net.statusError': '4xx / 5xx failed',
  'net.count': '{n} requests',
  'net.truncated': 'Content truncated',
  'net.notConnected': 'VM service not connected — no requests to read',
  'net.filterHost': 'Host',

  /* ---- board (dev-ui-data) ------------------------------------------- */
  'board.title': 'Board',
  'board.subtitle': 'Task cards an agent can execute',
  'board.lane.backlog': 'Backlog',
  'board.lane.ready': 'Ready',
  'board.lane.running': 'Running',
  'board.lane.review': 'Review',
  'board.lane.verify': 'Verify',
  'board.lane.done': 'Done',
  'board.newTask': 'New card',
  'board.editTask': 'Edit card',
  'board.deleteTask': 'Delete card',
  'board.deleteConfirm': 'Delete “{title}”? This cannot be undone.',
  'board.archive': 'Archive done',
  'board.archived': 'Archived {n} cards',
  'board.decompose': 'AI decompose',
  'board.decomposeHint': 'Describe a requirement; the agent splits it into cards with acceptance criteria',
  'board.decomposePrompt': 'Requirement',
  'board.decomposeEmpty': 'Write a requirement first',
  'board.decomposed': 'Created {n} cards',
  'board.dispatch': 'Dispatch',
  'board.dispatched': 'Dispatched to session {id}',
  'board.dispatchFailed': 'Dispatch failed: {message}',
  'board.report': 'Report result',
  'board.cancelAgent': 'Cancel agent',
  'board.syncAgent': 'Sync status',
  'board.fieldTitle': 'Title',
  'board.fieldDetail': 'Detail',
  'board.fieldAcceptance': 'Acceptance criteria (one per line)',
  'board.fieldVerify': 'Verify commands (one per line)',
  'board.fieldFiles': 'Files (one per line)',
  'board.fieldDeps': 'Dependencies (one per line)',
  'board.fieldPriority': 'Priority',
  'board.fieldTags': 'Tags (comma separated)',
  'board.priority.low': 'Low',
  'board.priority.normal': 'Normal',
  'board.priority.high': 'High',
  'board.priority.urgent': 'Urgent',
  'board.agent.idle': 'Idle',
  'board.agent.queued': 'Queued',
  'board.agent.working': 'Working',
  'board.agent.blocked': 'Blocked',
  'board.agent.done': 'Done',
  'board.agent.failed': 'Failed',
  'board.blocked': 'Blocked',
  'board.verdict.pass': 'Pass',
  'board.verdict.fail': 'Fail',
  'board.result': 'Result',
  'board.history': 'History',
  'board.emptyLane': 'Drop a card here or press +',
  'board.emptyTitle': 'The board is empty',
  'board.emptyBody': 'Create a card, or let the agent decompose an idea.',
  'board.count': '{n} cards',
  'board.noProject': 'No project bound',
  'board.moveTo': 'Move to {lane}',

  /* ---- quality (dev-ui-data) ----------------------------------------- */
  'quality.title': 'Quality',
  'quality.subtitle': 'Analyzer, tests, exceptions, performance and screenshots',
  'quality.tabAnalyze': 'Analyze',
  'quality.tabTest': 'Tests',
  'quality.tabErrors': 'Exceptions',
  'quality.tabPerf': 'Performance',
  'quality.tabScreenshot': 'Screenshot',
  'quality.analyze': 'Run analyze',
  'quality.analyzing': 'Analyzing…',
  'quality.issues': 'Issues',
  'quality.errors': 'Errors',
  'quality.warnings': 'Warnings',
  'quality.infos': 'Info',
  'quality.noIssues': 'No issues found',
  'quality.runTests': 'Run tests',
  'quality.testing': 'Testing…',
  'quality.passed': 'Passed',
  'quality.failed': 'Failed',
  'quality.skipped': 'Skipped',
  'quality.testDuration': 'Duration',
  'quality.noTests': 'No test results yet',
  'quality.errEmptyTitle': 'No exceptions',
  'quality.errEmptyBody': 'Runtime exceptions are deduplicated by fingerprint and listed here.',
  'quality.errCount': 'seen {n}×',
  'quality.errFrames': 'Stack frames',
  'quality.errOpen': 'Jump to source',
  'quality.perfEmpty': 'No frame statistics yet',
  'quality.jank': 'Jank',
  'quality.frames': 'Frames',
  'quality.worstFrame': 'Worst frame',
  'quality.buildTime': 'Build',
  'quality.rasterTime': 'Raster',
  'quality.screenshot': 'Screenshot',
  'quality.capturing': 'Capturing…',
  'quality.screenshotEmpty': 'No screenshot yet',
  'quality.screenshotSaved': 'Saved to {path}',
  'quality.widgetTree': 'Widget tree',
  'quality.dumpTree': 'Dump widget tree',
  'quality.pubGet': 'pub get',
  'quality.clean': 'clean',
  'quality.build': 'build',
  'quality.doctor': 'doctor',
  'quality.format': 'format',
  'quality.jobRunning': 'Job running…',
  'quality.jobDone': 'Job finished',
  'quality.jobFailed': 'Job failed: {message}',
  'quality.target': 'Build target',
  'quality.openScreenshot': 'Open screenshot',
  'quality.noRun': 'A live run is needed to collect data',

  /* ---- settings (dev-ui-data owns the page) -------------------------- */
  'settings.title': 'Settings',
  'settings.subtitle': 'Workbench and local toolchain configuration',
  'settings.save': 'Save settings',
  'settings.saved': 'Settings saved',
  'settings.saveFailed': 'Save failed: {message}',
  'settings.groupPaths': 'Paths',
  'settings.groupWorkbench': 'Workbench',
  'settings.groupAi': 'AI',
  'settings.groupMcp': 'MCP',
  'settings.flutterPath': 'Flutter SDK path',
  'settings.dartPath': 'Dart SDK path',
  'settings.logCapacity': 'Log buffer size',
  'settings.autoStart': 'Auto-start the last run when the panel opens',
  'settings.dataDir': 'Data directory',
  'settings.editorCommand': 'Editor command',
  'settings.defaultProvider': 'Default AI provider',
  'settings.defaultModel': 'Default AI model',
  'settings.autoRefreshMs': 'Panel refresh interval',
  'settings.networkAutoRefreshMs': 'Network refresh interval',
  'settings.maxTaskConcurrency': 'Board concurrency',
  'settings.analysisEnabled': 'Analyze errors automatically',
  'settings.mcpToken': 'MCP token',
  'settings.mcpEnabled': 'Enable MCP',
  'settings.mcpUrl': 'MCP endpoint',
  'settings.rotateToken': 'Rotate',
  'settings.tokenRotated': 'Token rotated',
  'settings.resolvedPaths': 'Resolved paths',
  'settings.milliseconds': 'ms',
  'settings.descriptorOnly': 'Provided by the host; not editable here',

  /* ---- app state ------------------------------------------------------ */
  'state.offline': 'Cannot reach the workbench host',
  'state.connecting': 'Connecting to the workbench…',
  'state.connectionOk': 'Connected',
  'state.lastOk': 'last success {time}',

  /* ---- boot ---------------------------------------------------------- */
  'boot.placeholder': 'Workbench modules are being built',
  'boot.disabled': 'Workbench is disabled',
}

/** Active UI language; `90-apply.js` syncs it with the host locale service. */
let currentLocale = 'zh'
const LANG = () => currentLocale
function setActiveLocale(next) {
  if (next === 'en' || next === 'zh') currentLocale = next
}

/**
 * Translate a key. `{name}` placeholders are replaced from `vars`.
 * Unknown keys degrade to the key itself so a missing string is obvious but
 * never throws.
 * @param {string} key dictionary key.
 * @param {Record<string, any>} [vars] placeholder values.
 * @returns {string} localized text.
 */
function t(key, vars) {
  if (key === undefined || key === null) return ''
  const dict = LANG() === 'en' ? EN : ZH
  let text = dict[key]
  if (text === undefined) {
    const other = LANG() === 'en' ? ZH : EN
    text = other[key] ?? key
  }
  if (vars !== undefined && vars !== null) {
    for (const name of Object.keys(vars)) text = text.replaceAll(`{${name}}`, String(vars[name]))
  }
  return text
}

/* ====================================================================== *
 * Formatting helpers
 * ====================================================================== */

function padNumber(value, width = 2) {
  return String(value).padStart(width, '0')
}

/**
 * Wall-clock format for log rows, run tables and tooltips.
 * @param {number|null|undefined} at epoch milliseconds.
 * @param {{ms?: boolean, date?: boolean, clock?: boolean}} [options] detail level.
 * @returns {string} formatted time, or an em dash when unknown.
 */
function formatTime(at, options = {}) {
  if (at === null || at === undefined) return t('common.notAvailable')
  const value = Number(at)
  if (!Number.isFinite(value) || value <= 0) return t('common.notAvailable')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return t('common.notAvailable')
  const stamp = `${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}`
  if (options.ms === true) return `${stamp}.${padNumber(date.getMilliseconds(), 3)}`
  if (options.date === true) return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())} ${stamp}`
  if (options.clock === true) return `${padNumber(date.getHours())}:${padNumber(date.getMinutes())}`
  return stamp
}

/**
 * Compact duration: `820ms`, `1.4s`, `2m 03s`, `1h 04m`.
 * @param {number|null|undefined} value milliseconds.
 * @returns {string} human duration.
 */
function formatDuration(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms < 0) return t('common.notAvailable')
  if (ms === 0) return '0ms'
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${padNumber(seconds)}s`
  return `${Math.floor(minutes / 60)}h ${padNumber(minutes % 60)}m`
}

/**
 * Relative time for tables and log metadata.
 * @param {number|null|undefined} at epoch milliseconds.
 * @param {number} [now] reference instant (defaults to Date.now()).
 * @returns {string} relative label.
 */
function formatRelative(at, now = Date.now()) {
  const value = Number(at)
  if (!Number.isFinite(value) || value <= 0) return t('common.never')
  const delta = Math.max(0, Number(now) - value)
  if (delta < 5000) return t('common.justNow')
  if (delta < 60000) return t('common.secondsAgo', { n: Math.round(delta / 1000) })
  if (delta < 3600000) return t('common.minutesAgo', { n: Math.round(delta / 60000) })
  if (delta < 86400000) return t('common.hoursAgo', { n: Math.round(delta / 3600000) })
  return formatTime(value, { date: true })
}

/** Byte size with one unit step. */
function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return t('common.notAvailable')
  if (value < 1024) return `${Math.round(value)}B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

/**
 * Truncate to `max` characters with a single ellipsis.
 * @param {any} text value to shorten.
 * @param {number} [max] maximum length, default 80.
 * @returns {string} shortened text.
 */
function truncate(text, max = 80) {
  const value = String(text ?? '')
  const limit = Math.max(1, Number(max) || 80)
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 1)}…`
}

/** Remove ANSI escape sequences (colour codes, cursors) from terminal text. */
function stripAnsi(text) {
  return String(text ?? '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\u001b[@-_]/g, '')
}

/**
 * Semantic tone for a run phase or a status-ish string.
 * @param {string|null|undefined} value status token.
 * @returns {'ok'|'warn'|'error'|'info'|'neutral'} tone name.
 */
function statusTone(value) {
  switch (String(value ?? '')) {
    case 'running':
    case 'ok':
    case 'connected':
    case 'passed':
    case 'pass':
    case 'done':
    case 'success':
      return 'ok'
    case 'starting':
    case 'reloading':
    case 'restarting':
    case 'stopping':
    case 'queued':
    case 'pending':
    case 'working':
    case 'warn':
    case 'warning':
      return 'warn'
    case 'failed':
    case 'error':
    case 'fatal':
    case 'blocked':
      return 'error'
    case 'info':
    case 'debug':
    case 'trace':
      return 'info'
    default:
      return 'neutral'
  }
}

/** Tone for a log level. */
function levelTone(level) {
  switch (String(level ?? '')) {
    case 'error':
    case 'fatal':
      return 'error'
    case 'warn':
      return 'warn'
    case 'info':
      return 'info'
    default:
      return 'neutral'
  }
}

/** Tone for an analyzer severity. */
function severityTone(severity) {
  switch (String(severity ?? '')) {
    case 'error':
      return 'error'
    case 'warning':
      return 'warn'
    case 'info':
      return 'info'
    default:
      return 'neutral'
  }
}

/** Resolve a tone name into foreground/background/border token mix. */
function toneColors(tone) {
  switch (tone) {
    case 'ok':
      return { fg: T.ok, bg: `color-mix(in srgb, ${T.ok} 16%, transparent)`, border: `color-mix(in srgb, ${T.ok} 42%, transparent)` }
    case 'warn':
      return { fg: T.warnLabel, bg: `color-mix(in srgb, ${T.warn} 18%, transparent)`, border: `color-mix(in srgb, ${T.warn} 42%, transparent)` }
    case 'error':
      return { fg: T.error, bg: `color-mix(in srgb, ${T.error} 16%, transparent)`, border: `color-mix(in srgb, ${T.error} 42%, transparent)` }
    case 'brand':
    case 'info':
      return { fg: T.brand, bg: `color-mix(in srgb, ${T.brand} 16%, transparent)`, border: `color-mix(in srgb, ${T.brand} 40%, transparent)` }
    case 'done':
      return { fg: T.done, bg: `color-mix(in srgb, ${T.done} 16%, transparent)`, border: `color-mix(in srgb, ${T.done} 40%, transparent)` }
    default:
      return { fg: T.textDim, bg: T.tag, border: T.border }
  }
}

/* ====================================================================== *
 * HTTP transport
 * ====================================================================== */

function buildQuery(query) {
  if (query === undefined || query === null) return ''
  if (typeof query === 'string') return query === '' ? '' : `?${query.replace(/^\?/, '')}`
  const params = new URLSearchParams()
  for (const key of Object.keys(query)) {
    const value = query[key]
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      const list = value.filter((item) => item !== undefined && item !== null && item !== '')
      if (list.length > 0) params.set(key, list.join(','))
      continue
    }
    params.set(key, String(value))
  }
  const search = params.toString()
  return search === '' ? '' : `?${search}`
}

/**
 * Resolve a plugin route against the page the UI is served from so a
 * reverse-proxy mount prefix keeps working.
 * @param {string} path route relative to `API`.
 * @param {object} [query] query values (arrays are comma joined).
 * @returns {string} pathname + query usable by `fetch`.
 */
function apiUrl(path, query) {
  const route = String(path ?? '')
  const suffix = route.startsWith('/') ? route : `/${route}`
  let pathname = `${API}${suffix}`
  try {
    if (typeof document !== 'undefined' && document.baseURI) {
      pathname = new URL(`${API.replace(/^\//, '')}${suffix}`, document.baseURI).pathname
    }
  } catch {
    /* keep the root-absolute fallback */
  }
  const search = buildQuery(query)
  return search === '' ? pathname : `${pathname}${search}`
}

/** Build the error shape callers branch on: `{ status, code, message, body }`. */
function apiError(status, code, message, body, cause) {
  const error = new Error(String(message ?? t('common.error')))
  error.status = Number(status) || 0
  error.code = code === undefined || code === null ? 'http' : String(code)
  error.body = body === undefined ? null : body
  if (cause !== undefined && cause !== null) error.cause = cause
  return error
}

/**
 * One JSON request against the workbench host.
 *
 * Resolves with the parsed body only when the response is ok **and** the body
 * is not `{ ok: false }`; every other outcome throws the `apiError` shape.
 * @param {string} path route relative to `API` (e.g. `/state`).
 * @param {{method?: string, body?: any, query?: object, signal?: AbortSignal,
 *   headers?: object}} [options] request options.
 * @returns {Promise<any>} parsed JSON body.
 */
async function api(path, options = {}) {
  const method = String(options.method ?? 'GET').toUpperCase()
  const init = { method, cache: 'no-store', credentials: 'same-origin' }
  if (options.signal !== undefined) init.signal = options.signal
  const headers = {}
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.headers !== undefined && options.headers !== null) Object.assign(headers, options.headers)
  if (Object.keys(headers).length > 0) init.headers = headers
  if (options.body !== undefined) init.body = JSON.stringify(options.body)

  let response = null
  try {
    response = await fetch(apiUrl(path, options.query), init)
  } catch (cause) {
    if (cause !== null && cause !== undefined && cause.name === 'AbortError') throw cause
    throw apiError(0, 'network', `${t('state.offline')} (${String(cause?.message ?? cause)})`, null, cause)
  }

  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }
  let data = null
  if (text !== '') {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  if (response.ok !== true) {
    const message = data !== null && data !== undefined && data.message !== undefined
      ? data.message
      : `HTTP ${response.status}${path ? ` · ${path}` : ''}`
    throw apiError(response.status, data?.code ?? `http-${response.status}`, message, data, null)
  }
  if (data !== null && data !== undefined && data.ok === false) {
    throw apiError(response.status, data.code ?? 'not-ok', data.message ?? t('common.error'), data, null)
  }
  if (data === null || data === undefined) return {}
  return data
}

/** Fire-and-forget POST helper; still returns the parsed body. */
function postJson(path, body, options = {}) {
  return api(path, { ...options, method: 'POST', body: body ?? {} })
}

/* ====================================================================== *
 * Hooks
 * ====================================================================== */

/**
 * Poll a loader on an interval.
 *
 * - runs the loader once immediately, then every `intervalMs` (0 = once);
 * - keeps the previous `data` when a poll fails and records `error`;
 * - `refresh()` always re-runs the loader and resolves with its value;
 * - the interval never overlaps a running load, is skipped while the document
 *   is hidden, refreshes on visibility change, and is cleared on unmount.
 * @param {() => any} load loader; may return a promise.
 * @param {number} intervalMs poll cadence; 0 disables polling.
 * @param {any[]} [deps] extra dependencies that recreate the timer.
 * @param {{enabled?: boolean, initial?: any}} [options] switches.
 * @returns {{data: any, error: Error|null, loading: boolean,
 *   lastOkAt: number|null, refresh: () => Promise<any>}}
 */
function usePoll(load, intervalMs, deps = [], options = {}) {
  const enabled = options.enabled !== false
  const [data, setData] = React.useState(options.initial === undefined ? null : options.initial)
  const [error, setError] = React.useState(null)
  const [loading, setLoading] = React.useState(enabled)
  const [lastOkAt, setLastOkAt] = React.useState(null)
  const loadRef = React.useRef(load)
  loadRef.current = load
  const aliveRef = React.useRef(true)
  const busyRef = React.useRef(false)

  React.useEffect(() => () => { aliveRef.current = false }, [])

  const refresh = React.useCallback(async () => {
    if (busyRef.current === true) return null
    busyRef.current = true
    try {
      const value = await loadRef.current()
      if (aliveRef.current === true) {
        setData(value)
        setError(null)
        setLastOkAt(Date.now())
      }
      return value
    } catch (issue) {
      if (aliveRef.current === true && issue?.name !== 'AbortError') setError(issue ?? new Error('request failed'))
      return null
    } finally {
      busyRef.current = false
      if (aliveRef.current === true) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (enabled !== true) {
      setLoading(false)
      return undefined
    }
    aliveRef.current = true
    setLoading(true)
    void refresh()
    if (!(Number(intervalMs) > 0)) return undefined
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void refresh()
    }, Number(intervalMs))
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void refresh()
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, Number(intervalMs) || 0, refresh, ...deps])

  return { data, error, loading, lastOkAt, refresh, setData, setError }
}

/**
 * A `useState` whose value survives a page switch through sessionStorage.
 * JSON encoded, so primitives and plain objects both work.
 * @param {string} key storage key.
 * @param {any} initial fallback when nothing usable is stored.
 * @returns {[any, (next: any) => void]} state pair.
 */
function useSessionState(key, initial) {
  const [value, setValue] = React.useState(() => {
    try {
      const raw = window.sessionStorage.getItem(key)
      if (raw === null) return initial
      const parsed = JSON.parse(raw)
      return parsed === null || parsed === undefined ? initial : parsed
    } catch {
      return initial
    }
  })
  const update = React.useCallback((next) => {
    setValue((previous) => {
      const resolved = typeof next === 'function' ? next(previous) : next
      try {
        window.sessionStorage.setItem(key, JSON.stringify(resolved))
      } catch {
        /* private mode: keep the value for this session only */
      }
      return resolved
    })
  }, [key])
  return [value, update]
}

/** Hover state + handlers for inline-styled hovers. */
function useHover() {
  const [hover, setHover] = React.useState(false)
  const handlers = React.useMemo(() => ({
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
  }), [])
  return [hover, handlers]
}

/** True when a keyboard event came from a typing surface. */
function isTypingTarget(target) {
  if (target === null || target === undefined || typeof target.tagName !== 'string') return false
  const tag = target.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return target.isContentEditable === true
}

/**
 * Toast queue: up to `max` visible entries, auto-dismissing after a tone based
 * TTL. `show()` is safe to call from actions (it never throws).
 * @param {number} [max] queue length, default 4.
 * @returns {{toasts: object[], show: Function, dismiss: Function, clear: Function,
 *   toast: object|null}} queue plus helpers.
 */
function useToast(max = 4) {
  const [toasts, setToasts] = React.useState([])
  const seqRef = React.useRef(0)
  const timersRef = React.useRef(new Set())

  const dismiss = React.useCallback((id) => {
    setToasts((previous) => previous.filter((item) => item.id !== id))
  }, [])

  const show = React.useCallback((message, tone = 'info', opts = {}) => {
    const text = String(message ?? '')
    if (text === '') return 0
    const id = seqRef.current + 1
    seqRef.current = id
    const entry = { id, message: text, tone: tone === undefined || tone === null ? 'info' : String(tone) }
    setToasts((previous) => {
      const kept = previous.length >= max ? previous.slice(previous.length - max + 1) : previous
      return [...kept, entry]
    })
    const ttl = Number(opts.ttl ?? (entry.tone === 'error' ? 8000 : 4500))
    if (ttl > 0 && typeof window !== 'undefined') {
      const timer = window.setTimeout(() => {
        timersRef.current.delete(timer)
        dismiss(id)
      }, ttl)
      timersRef.current.add(timer)
    }
    return id
  }, [dismiss, max])

  const clear = React.useCallback(() => setToasts([]), [])

  React.useEffect(() => () => {
    for (const timer of timersRef.current) window.clearTimeout(timer)
    timersRef.current.clear()
  }, [])

  return { toasts, show, dismiss, clear, toast: toasts.length === 0 ? null : toasts[toasts.length - 1] }
}

/* ====================================================================== *
 * Clipboard / download helpers
 * ====================================================================== */

/** Copy text, preferring the async clipboard API. Never throws. */
async function copyText(text) {
  const value = String(text ?? '')
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    /* fall through to execCommand */
  }
  try {
    if (typeof document === 'undefined') return false
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', 'readonly')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok === true
  } catch {
    return false
  }
}

/** Trigger a browser download for text content. Returns the file name used. */
function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const name = String(filename ?? 'export.txt')
  try {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return name
    const blob = new Blob([String(text ?? '')], { type: mime })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
  } catch {
    /* download blocked: the caller reports it */
  }
  return name
}

/* ====================================================================== *
 * One injected stylesheet (things inline styles cannot express)
 * ====================================================================== */

const BASE_CSS = [
  '.fwb-root,.fwb-root *{box-sizing:border-box}',
  '.fwb-root{height:100%;min-height:0;font-family:var(--dsw-font-family,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);',
  'font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}',
  '.fwb-root button{font:inherit;color:inherit}',
  '.fwb-root input,.fwb-root textarea,.fwb-root select{font:inherit;color:inherit}',
  '.fwb-root :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
  '.fwb-scroll{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}',
  '.fwb-scroll::-webkit-scrollbar{width:8px;height:8px}',
  '.fwb-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:4px}',
  '.fwb-scroll::-webkit-scrollbar-track{background:transparent}',
  '.fwb-row{transition:background 80ms linear}',
  '.fwb-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.fwb-none{display:none}',
  '@keyframes fwb-spin{to{transform:rotate(360deg)}}',
  '@keyframes fwb-pulse{0%,100%{opacity:.45}50%{opacity:.95}}',
].join('')

/** Inject BASE_CSS exactly once. Cosmetic failure must never break the panel. */
function ensureStyles() {
  try {
    if (typeof document === 'undefined') return
    if (document.getElementById('flutter-workbench-styles') !== null) return
    const holder = document.createElement('div')
    holder.id = 'flutter-workbench-styles'
    holder.style.display = 'none'
    holder.textContent = `<style>${BASE_CSS}</style>`
    document.head.appendChild(holder)
  } catch {
    /* styles are cosmetic */
  }
}

/* ====================================================================== *
 * Icons (16×16, stroke only, currentColor)
 * ====================================================================== */

const ICONS = {
  runtime: ['M5.5 3.6l6 4.4-6 4.4z'],
  play: ['M5.5 3.6l6 4.4-6 4.4z'],
  stop: ['M4.5 4.5h7v7h-7z'],
  reload: ['M13 8a5 5 0 01-8.6 3.4M3 8a5 5 0 018.6-3.4', 'M11.6 2.2v3h-3M4.4 13.8v-3h3'],
  restart: ['M13 8a5 5 0 11-1.9-3.9', 'M13 2.4v3.1h-3.1'],
  logs: ['M3 4h10M3 7h8M3 10h10M3 13h6'],
  network: ['M8 2.6a2 2 0 100 4 2 2 0 000-4z', 'M3 13.4a2 2 0 100-4 2 2 0 000 4z', 'M13 13.4a2 2 0 100-4 2 2 0 000 4z', 'M8 6.6v3.2M8 9.8l-4 1.6M8 9.8l4 1.6'],
  board: ['M3 3.5h3.2v9H3z', 'M7.4 3.5h3.2v5.6H7.4z', 'M11.8 3.5H15v7.4h-3.2z'],
  quality: ['M8 2.6l5 2v4.2c0 2.4-2 4.2-5 4.6-3-.4-5-2.2-5-4.6V4.6z', 'M6 8l1.5 1.5L10.5 6.4'],
  gear: ['M8 5.9a2.1 2.1 0 100 4.2 2.1 2.1 0 000-4.2z', 'M8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6M3.9 3.9l1.1 1.1M11 11l1.1 1.1M12.1 3.9L11 5M5 11l-1.1 1.1'],
  search: ['M7 3a4 4 0 100 8 4 4 0 000-8z', 'M10 10l3.6 3.6'],
  plus: ['M8 3.5v9M3.5 8h9'],
  minus: ['M3.5 8h9'],
  x: ['M4 4l8 8M12 4l-8 8'],
  copy: ['M5.5 5.5h7v7h-7z', 'M10.5 5.5v-2h-7v7h2'],
  external: ['M6.5 3H13v6.5M13 3L7 9M3.5 6v6.5H10'],
  refresh: ['M13 8a5 5 0 01-8.5 3.5M3 8a5 5 0 018.5-3.5M11.5 2v3h-3M4.5 14v-3h3'],
  chevronDown: ['M4 6l4 4 4-4'],
  chevronRight: ['M6 4l4 4-4 4'],
  arrowDown: ['M8 3v9M4.5 8.5L8 12l3.5-3.5'],
  warn: ['M8 2.8l5.2 10.4H2.8z', 'M8 6.4v3.1', 'M8 11.2v.9'],
  clock: ['M8 2.8a5.2 5.2 0 100 10.4A5.2 5.2 0 008 2.8z', 'M8 5v3.2l2 1.3'],
  folder: ['M2.5 4h4l1 1.5h6V13h-11z'],
  filter: ['M3 4h10M5.5 8h5M7.5 12h1'],
  trash: ['M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.6 8.5h4.8l.6-8.5'],
  check: ['M3.5 8.5l3 3 6-6.5'],
  dot: ['M8 6.2a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6z'],
  terminal: ['M4 4.5l3.5 3.5L4 11.5', 'M9 11.5h3.5'],
  device: ['M5 2.5h6v11H5z', 'M7 11.5h2'],
  spark: ['M8 2l1.5 4L14 7.5 9.5 9 8 13 6.5 9 2 7.5 6.5 6z'],
  pause: ['M6 4v8M10 4v8'],
  camera: ['M3 5.5h2.2L6.5 4h3L10.8 5.5H13V13H3z', 'M8 7.4a2.2 2.2 0 100 4.4 2.2 2.2 0 000-4.4z'],
  code: ['M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4'],
  file: ['M4 2.5h5l3 3v8H4z', 'M9 2.5v3h3'],
}

/**
 * Inline icon.
 * @param {{name?: string, size?: number, color?: string, style?: object}} props icon props.
 * @returns {any} svg element.
 */
function Icon({ name, size = 14, color, style }) {
  const paths = ICONS[name] ?? ICONS.dot
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    style: { flex: 'none', color: color ?? 'currentColor', ...(style ?? {}) },
  }, paths.map((d, index) => h('path', { key: index, d })))
}

/* ====================================================================== *
 * UI kit
 * ====================================================================== */

/**
 * Button.
 * @param {{children?: any, onClick?: Function, kind?: string, variant?: string,
 *   size?: 'sm'|'md', icon?: string, disabled?: boolean, title?: string,
 *   style?: object, block?: boolean, type?: string}} props button props.
 * @returns {any} button element.
 */
function Btn(props) {
  const [hover, bind] = useHover()
  const kind = props.variant ?? props.kind ?? 'ghost'
  const small = props.size === 'sm'
  const disabled = props.disabled === true
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: small ? 24 : 28,
    padding: small ? '0 8px' : '0 11px',
    borderRadius: T.radiusSm,
    border: `1px solid ${T.borderStrong}`,
    background: 'transparent',
    color: T.text,
    fontWeight: 500,
    fontSize: small ? T.fsXs : T.fsSm,
    whiteSpace: 'nowrap',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    ...(props.block === true ? { width: '100%' } : {}),
    ...(props.style ?? {}),
  }
  if (kind === 'primary') {
    Object.assign(base, { background: T.btn, borderColor: T.btn, color: T.btnFg, fontWeight: 600 })
    if (hover && !disabled) base.filter = 'brightness(1.08)'
  } else if (kind === 'danger') {
    Object.assign(base, {
      borderColor: `color-mix(in srgb, ${T.error} 45%, transparent)`,
      color: T.error,
      background: hover && !disabled ? `color-mix(in srgb, ${T.error} 12%, transparent)` : 'transparent',
    })
  } else if (kind === 'subtle') {
    Object.assign(base, { borderColor: T.border, background: hover && !disabled ? T.active : T.l1 })
  } else if (kind === 'text') {
    Object.assign(base, { borderColor: 'transparent', height: 'auto', padding: 0, color: hover && !disabled ? T.link : T.textDim })
  } else {
    Object.assign(base, { borderColor: T.border, background: hover && !disabled ? T.hover : 'transparent', color: T.text })
  }
  return h('button', {
    type: props.type ?? 'button',
    title: props.title,
    'aria-label': props['aria-label'] ?? props.title,
    disabled,
    onClick: disabled ? undefined : props.onClick,
    ...bind,
    style: base,
  },
    props.icon === undefined || props.icon === null ? null : h(Icon, { name: props.icon, size: small ? 12 : 14 }),
    props.children)
}

/**
 * Square icon-only button. Accepts `icon` (icon name) or `children` (any node).
 */
function IconBtn(props) {
  const [hover, bind] = useHover()
  const size = props.size ?? 26
  const disabled = props.disabled === true
  return h('button', {
    type: 'button',
    title: props.title,
    'aria-label': props['aria-label'] ?? props.title,
    disabled,
    onClick: disabled ? undefined : props.onClick,
    ...bind,
    style: {
      width: size,
      height: size,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 0,
      border: `1px solid ${props.active === true ? T.border : 'transparent'}`,
      borderRadius: T.radiusSm,
      background: hover && !disabled ? T.hover : props.active === true ? T.active : 'transparent',
      color: props.active === true ? T.text : T.textDim,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      ...(props.style ?? {}),
    },
  },
    props.children !== undefined && props.children !== null
      ? props.children
      : h(Icon, { name: props.icon ?? 'dot', size: props.iconSize ?? 14 }))
}

/**
 * Pill / status tag.
 * @param {{children?: any, tone?: string, style?: object, dot?: boolean, title?: string}} props
 */
function Pill(props) {
  const colors = toneColors(props.tone)
  return h('span', {
    title: props.title,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '1px 7px',
      borderRadius: T.radiusSm,
      border: `1px solid ${colors.border}`,
      background: colors.bg,
      color: colors.fg,
      fontSize: T.fsXs,
      fontWeight: 600,
      lineHeight: '16px',
      whiteSpace: 'nowrap',
      ...(props.style ?? {}),
    },
  },
    props.dot === true ? h('span', { style: { width: 6, height: 6, borderRadius: 6, background: 'currentColor', flex: 'none' } }) : null,
    props.children)
}

/** Toggle chip (filters, quick switches). */
function Chip(props) {
  const [hover, bind] = useHover()
  const active = props.active === true
  const disabled = props.disabled === true
  return h('button', {
    type: 'button',
    title: props.title,
    disabled,
    onClick: disabled ? undefined : props.onClick,
    'aria-pressed': active,
    ...bind,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      height: 22,
      padding: '0 8px',
      borderRadius: T.radiusSm,
      border: `1px solid ${active ? T.borderStrong : T.border}`,
      background: active ? T.selected : hover && !disabled ? T.hover : 'transparent',
      color: active ? T.text : T.textDim,
      fontSize: T.fsXs,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      whiteSpace: 'nowrap',
      ...(props.style ?? {}),
    },
  },
    props.children,
    props.count !== undefined && props.count !== null
      ? h('span', { style: { color: active ? T.textDim : T.textFaint, fontVariantNumeric: 'tabular-nums' } }, String(props.count))
      : null)
}

/** Surface card with an optional header and footer. */
function Card(props) {
  const hasHeader = props.title !== undefined || props.right !== undefined || props.subtitle !== undefined
  return h('div', {
    style: {
      border: `1px solid ${T.border}`,
      borderRadius: T.radius,
      background: T.bgRaised,
      minWidth: 0,
      overflow: 'hidden',
      ...(props.style ?? {}),
    },
  },
    hasHeader
      ? h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: `1px solid ${T.border}`,
          minHeight: 36,
        },
      },
        h('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 } },
          h('div', { style: { fontWeight: 600, fontSize: T.fs, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, props.title),
          props.subtitle !== undefined
            ? h('div', { style: { color: T.textFaint, fontSize: T.fsXs, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, props.subtitle)
            : null),
        props.right ?? null)
      : null,
    h('div', { style: { padding: props.pad ?? 12, minWidth: 0 } }, props.children),
    props.footer !== undefined && props.footer !== null
      ? h('div', { style: { padding: '8px 12px', borderTop: `1px solid ${T.border}`, background: T.l1 } }, props.footer)
      : null)
}

/** Label + control + hint/error wrapper. */
function Field(props) {
  const label = props.label
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, ...(props.style ?? {}) } },
    label === undefined || label === null
      ? null
      : h('label', {
        htmlFor: props.htmlFor,
        style: { fontSize: T.fsXs, color: T.textDim, fontWeight: 500, display: 'flex', gap: 4, alignItems: 'center' },
      },
        label,
        props.required === true ? h('span', { style: { color: T.error } }, '*') : null),
    props.children,
    props.error !== undefined && props.error !== null && props.error !== false
      ? h('div', { style: { fontSize: T.fsXs, color: T.error } }, String(props.error))
      : null,
    props.hint !== undefined && props.hint !== null && props.hint !== false
      ? h('div', { style: { fontSize: T.fsXs, color: T.textFaint } }, String(props.hint))
      : null)
}

/**
 * Text input. `onChange` receives `(value, event)`.
 */
function Input(props) {
  const [focused, setFocused] = React.useState(false)
  const disabled = props.disabled === true
  const invalid = props.invalid === true
  const small = props.size === 'sm'
  return h('input', {
    type: props.type ?? 'text',
    value: props.value === undefined || props.value === null ? '' : String(props.value),
    placeholder: props.placeholder,
    disabled,
    readOnly: props.readOnly === true,
    spellCheck: false,
    autoFocus: props.autoFocus === true,
    'aria-invalid': invalid,
    onChange: (event) => { if (props.onChange !== undefined) props.onChange(event.target.value, event) },
    onKeyDown: (event) => {
      if (props.onEnter !== undefined && event.key === 'Enter') props.onEnter(event.target.value, event)
      if (props.onKeyDown !== undefined) props.onKeyDown(event)
    },
    onFocus: (event) => { setFocused(true); if (props.onFocus !== undefined) props.onFocus(event) },
    onBlur: (event) => { setFocused(false); if (props.onBlur !== undefined) props.onBlur(event) },
    style: {
      height: small ? 24 : 28,
      width: '100%',
      minWidth: 0,
      padding: '0 8px',
      borderRadius: T.radiusSm,
      border: `1px solid ${invalid ? T.error : focused ? T.borderStrong : T.border}`,
      background: T.bgInput,
      color: T.text,
      fontSize: T.fsSm,
      fontFamily: props.mono === true ? T.mono : T.font,
      outline: 'none',
      opacity: disabled ? 0.6 : 1,
      ...(props.style ?? {}),
    },
  })
}

/** Multi-line text input. `onChange` receives `(value, event)`. */
function TextArea(props) {
  return h('textarea', {
    value: props.value === undefined || props.value === null ? '' : String(props.value),
    placeholder: props.placeholder,
    rows: props.rows ?? 3,
    disabled: props.disabled === true,
    spellCheck: false,
    onChange: (event) => { if (props.onChange !== undefined) props.onChange(event.target.value, event) },
    onKeyDown: props.onKeyDown,
    style: {
      width: '100%',
      minWidth: 0,
      padding: '6px 8px',
      borderRadius: T.radiusSm,
      border: `1px solid ${props.invalid === true ? T.error : T.border}`,
      background: T.bgInput,
      color: T.text,
      fontSize: T.fsSm,
      lineHeight: '18px',
      fontFamily: props.mono === true ? T.mono : T.font,
      resize: props.resize ?? 'vertical',
      outline: 'none',
      ...(props.style ?? {}),
    },
  })
}

/**
 * Native select. `options` accepts `[{value,label}]` or `string[]`;
 * `onChange` receives `(value, event)`.
 */
function Select(props) {
  const raw = props.options ?? []
  const options = raw.map((item) => (typeof item === 'string' || typeof item === 'number'
    ? { value: String(item), label: String(item) }
    : { value: String(item?.value ?? ''), label: String(item?.label ?? item?.value ?? '') }))
  return h('select', {
    value: props.value === undefined || props.value === null ? '' : String(props.value),
    disabled: props.disabled === true,
    title: props.title,
    onChange: (event) => { if (props.onChange !== undefined) props.onChange(event.target.value, event) },
    style: {
      height: props.size === 'sm' ? 24 : 28,
      width: '100%',
      minWidth: 0,
      padding: '0 6px',
      borderRadius: T.radiusSm,
      border: `1px solid ${T.border}`,
      background: T.bgInput,
      color: T.text,
      fontSize: T.fsSm,
      outline: 'none',
      opacity: props.disabled === true ? 0.6 : 1,
      ...(props.style ?? {}),
    },
  }, [
    props.placeholder !== undefined && props.placeholder !== null
      ? h('option', { key: '__placeholder', value: '' }, String(props.placeholder))
      : null,
    ...options.map((option, index) => h('option', { key: `${option.value}-${index}`, value: option.value }, option.label)),
  ])
}

/** Checkbox with a clickable label. `onChange` receives `(checked, event)`. */
function Checkbox(props) {
  const checked = props.checked === true
  return h('label', {
    style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: props.disabled === true ? 'not-allowed' : 'pointer', fontSize: T.fsSm, ...(props.style ?? {}) },
  },
    h('input', {
      type: 'checkbox',
      checked,
      disabled: props.disabled === true,
      onChange: (event) => { if (props.onChange !== undefined) props.onChange(event.target.checked, event) },
      style: { accentColor: T.brand, margin: 0, cursor: 'inherit' },
    }),
    props.label === undefined || props.label === null ? null : h('span', { style: { color: T.text } }, props.label))
}

/** Tab strip. `tabs` = `[{id,label,count?}]`. */
function Tabs(props) {
  const tabs = props.tabs ?? []
  return h('div', {
    role: 'tablist',
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 2,
      borderBottom: `1px solid ${T.border}`,
      ...(props.style ?? {}),
    },
  }, tabs.map((tab) => {
    const active = tab.id === props.value
    return h('button', {
      key: tab.id,
      type: 'button',
      role: 'tab',
      'aria-selected': active,
      onClick: () => { if (props.onChange !== undefined) props.onChange(tab.id) },
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 30,
        padding: '0 10px',
        border: 'none',
        borderBottom: `2px solid ${active ? T.brand : 'transparent'}`,
        background: 'transparent',
        color: active ? T.text : T.textDim,
        fontSize: T.fsSm,
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
      },
    },
      tab.label,
      tab.count === undefined || tab.count === null
        ? null
        : h('span', { style: { color: T.textFaint, fontSize: T.fsXs, fontVariantNumeric: 'tabular-nums' } }, String(tab.count)))
  }))
}

/**
 * Modal dialog. Mounted when `open` is undefined or true; Esc and a backdrop
 * click call `onClose`. No portal — the caller's stacking context is used.
 */
function Modal(props) {
  const open = props.open === undefined ? true : props.open === true
  React.useEffect(() => {
    if (open !== true) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        if (props.onClose !== undefined) props.onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, props.onClose])
  if (open !== true) return null
  const width = props.width ?? 520
  return h('div', {
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 60,
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
      padding: '48px 24px 24px',
      background: T.overlay,
      backdropFilter: 'blur(1px)',
    },
    onMouseDown: (event) => { if (event.target === event.currentTarget && props.onClose !== undefined) props.onClose() },
  },
    h('div', {
      role: 'dialog',
      'aria-modal': 'true',
      style: {
        width,
        maxWidth: 'calc(100vw - 48px)',
        maxHeight: 'calc(100vh - 96px)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: T.bgRaised,
        border: `1px solid ${T.borderStrong}`,
        borderRadius: T.radius,
        boxShadow: T.shadow,
        overflow: 'hidden',
      },
    },
      h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderBottom: `1px solid ${T.border}`,
          flexShrink: 0,
        },
      },
        h('div', { style: { flex: 1, fontWeight: 600, fontSize: T.fs } }, props.title ?? ''),
        h(IconBtn, { icon: 'x', title: t('common.close'), onClick: props.onClose })),
      h('div', { className: 'fwb-scroll', style: { padding: 12, overflow: 'auto', minHeight: 0, flex: 1 } }, props.children),
      props.footer !== undefined && props.footer !== null
        ? h('div', {
          style: {
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '8px 12px',
            borderTop: `1px solid ${T.border}`,
            background: T.l1,
            flexShrink: 0,
          },
        }, props.footer)
        : null))
}

/** Toast stack (bottom-right). Pair with `useToast()`. */
function ToastHost(props) {
  const toasts = props.toasts ?? []
  if (toasts.length === 0) return null
  return h('div', {
    style: {
      position: 'absolute',
      right: 14,
      bottom: 34,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      zIndex: 80,
      maxWidth: 360,
      pointerEvents: 'none',
    },
  }, toasts.map((toast) => {
    const colors = toneColors(toast.tone)
    return h('div', {
      key: toast.id,
      role: 'status',
      style: {
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '7px 10px',
        borderRadius: T.radiusSm,
        border: `1px solid ${colors.border}`,
        background: T.bgRaised,
        boxShadow: T.shadow,
        color: T.text,
        fontSize: T.fsSm,
      },
    },
      h('span', { style: { width: 6, height: 6, borderRadius: 6, background: colors.fg, marginTop: 6, flex: 'none' } }),
      h('div', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word' } }, toast.message),
      props.onDismiss !== undefined
        ? h(IconBtn, { icon: 'x', size: 20, title: t('common.close'), onClick: () => props.onDismiss(toast.id) })
        : null)
  }))
}

/** Centered empty state. */
function Empty(props) {
  const hasBody = props.body !== undefined || props.title !== undefined
  return h('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      padding: props.compact === true ? 16 : 32,
      textAlign: 'center',
      color: T.textFaint,
      fontSize: T.fsSm,
      minHeight: props.compact === true ? 0 : 120,
      ...(props.style ?? {}),
    },
  },
    props.icon === undefined || props.icon === null
      ? (props.title === undefined && props.body === undefined && props.text !== undefined ? null : h(Icon, { name: props.icon ?? 'dot', size: 20 }))
      : h(Icon, { name: props.icon, size: 20 }),
    h('div', { style: { color: T.textDim, fontWeight: 600, fontSize: T.fs } }, props.title ?? props.text ?? t('common.empty')),
    hasBody && props.body !== undefined ? h('div', { style: { maxWidth: 420, lineHeight: '18px' } }, props.body) : null,
    props.action === undefined || props.action === null ? null : h('div', { style: { marginTop: 4 } }, props.action))
}

/** Spinner. */
function Spinner(props) {
  const size = props.size ?? 14
  return h('span', {
    role: 'progressbar',
    'aria-label': props.label ?? t('common.loading'),
    title: props.label,
    style: {
      display: 'inline-block',
      width: size,
      height: size,
      borderRadius: size,
      border: `2px solid ${T.border}`,
      borderTopColor: props.color ?? T.brand,
      animation: 'fwb-spin 0.8s linear infinite',
      flex: 'none',
      ...(props.style ?? {}),
    },
  })
}

/**
 * Table with a sticky header. `columns` = `[{key, label, width, align, dim,
 * nowrap, render(row,index)}]`.
 */
function Table(props) {
  const columns = props.columns ?? []
  const rows = props.rows ?? []
  if (rows.length === 0) {
    return h('div', { style: props.style },
      props.empty === undefined ? h(Empty, { text: t('common.empty'), compact: true }) : props.empty)
  }
  const dense = props.dense === true
  const cellPad = dense ? '3px 6px' : '5px 8px'
  return h('div', {
    className: 'fwb-scroll',
    style: { overflow: 'auto', maxHeight: props.maxHeight ?? 'none', minWidth: 0, ...(props.style ?? {}) },
  },
    h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: T.fsSm, tableLayout: props.fixed === true ? 'fixed' : 'auto' } },
      h('thead', null,
        h('tr', null, columns.map((column, index) => h('th', {
          key: column.key ?? index,
          style: {
            position: 'sticky',
            top: 0,
            zIndex: 1,
            background: T.l1,
            textAlign: column.align ?? 'left',
            padding: cellPad,
            borderBottom: `1px solid ${T.border}`,
            color: T.textDim,
            fontWeight: 600,
            fontSize: T.fsXs,
            whiteSpace: 'nowrap',
            width: column.width,
          },
        }, column.label ?? column.key)))),
      h('tbody', null, rows.map((row, rowIndex) => h('tr', {
        key: props.rowKey === undefined ? rowIndex : String(props.rowKey(row, rowIndex)),
        className: props.onRowClick === undefined ? undefined : 'fwb-row',
        onClick: props.onRowClick === undefined ? undefined : () => props.onRowClick(row, rowIndex),
        style: { cursor: props.onRowClick === undefined ? 'default' : 'pointer' },
      }, columns.map((column, columnIndex) => h('td', {
        key: column.key ?? columnIndex,
        style: {
          padding: cellPad,
          borderBottom: `1px solid ${T.border}`,
          verticalAlign: 'top',
          textAlign: column.align ?? 'left',
          color: column.dim === true ? T.textDim : T.text,
          whiteSpace: column.nowrap === true ? 'nowrap' : 'normal',
          wordBreak: column.wrap === true ? 'break-word' : 'normal',
          fontFamily: column.mono === true ? T.mono : 'inherit',
          fontVariantNumeric: 'tabular-nums',
        },
      }, column.render === undefined ? row?.[column.key] : column.render(row, rowIndex))))))),
    props.caption === undefined ? null : h('div', { style: { padding: '4px 8px', color: T.textFaint, fontSize: T.fsXs } }, props.caption))
}

/**
 * Two-pane layout with a draggable divider. Drag state is local; the width is
 * optionally remembered in localStorage under `fwb.split.<storageKey>`.
 */
function SplitPane(props) {
  const children = props.children === undefined || props.children === null
    ? []
    : (Array.isArray(props.children) ? props.children : [props.children])
  const leftNode = props.left ?? children[0] ?? null
  const rightNode = props.right ?? children[1] ?? null
  const minWidth = props.minWidth ?? 240
  const maxWidth = props.maxWidth ?? 760
  const storageKey = props.storageKey
  const [width, setWidth] = React.useState(() => {
    const fallback = Number(props.leftWidth ?? 360)
    if (storageKey === undefined) return fallback
    try {
      const raw = window.localStorage.getItem(`fwb.split.${storageKey}`)
      const parsed = raw === null ? NaN : Number(raw)
      return Number.isFinite(parsed) && parsed >= minWidth ? parsed : fallback
    } catch {
      return fallback
    }
  })
  const dragRef = React.useRef(null)

  React.useEffect(() => {
    const onMove = (event) => {
      const drag = dragRef.current
      if (drag === null) return
      setWidth(Math.max(minWidth, Math.min(maxWidth, drag.startWidth + (event.clientX - drag.startX))))
    }
    const onUp = () => {
      if (dragRef.current === null) return
      dragRef.current = null
      setWidth((current) => {
        if (storageKey !== undefined) {
          try {
            window.localStorage.setItem(`fwb.split.${storageKey}`, String(Math.round(current)))
          } catch {
            /* private mode */
          }
        }
        return current
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [minWidth, maxWidth, storageKey])

  return h('div', {
    style: { display: 'flex', flex: 1, minHeight: 0, minWidth: 0, ...(props.style ?? {}) },
  },
    h('div', { style: { width, flex: 'none', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } }, leftNode),
    h('div', {
      role: 'separator',
      'aria-orientation': 'vertical',
      onMouseDown: (event) => {
        event.preventDefault()
        dragRef.current = { startX: event.clientX, startWidth: width }
      },
      style: { width: 5, flex: 'none', cursor: 'col-resize', background: T.border, ...(props.dividerStyle ?? {}) },
    }),
    h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } }, rightNode))
}

/** Horizontal action row. */
function Toolbar(props) {
  return h('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: props.gap ?? 8,
      padding: props.pad ?? '8px 12px',
      flexWrap: props.wrap === false ? 'nowrap' : 'wrap',
      borderBottom: props.bordered === true ? `1px solid ${T.border}` : 'none',
      minWidth: 0,
      ...(props.style ?? {}),
    },
  },
    props.left ?? null,
    props.children,
    h('div', { style: { flex: 1 } }),
    props.right ?? null)
}

/** Monospace text block. */
function Mono(props) {
  return h('span', {
    style: {
      fontFamily: T.mono,
      fontSize: props.size ?? T.fsSm,
      color: props.dim === true ? T.textDim : T.text,
      whiteSpace: props.wrap === false ? 'pre' : 'pre-wrap',
      wordBreak: 'break-word',
      ...(props.style ?? {}),
    },
  }, props.children)
}

/** Keyboard keycap. */
function Kbd(props) {
  return h('kbd', {
    style: {
      display: 'inline-block',
      padding: '0 4px',
      minWidth: 16,
      textAlign: 'center',
      borderRadius: T.radiusXs ?? T.radiusSm,
      border: `1px solid ${T.border}`,
      borderBottomWidth: 2,
      background: T.l2,
      color: T.textDim,
      fontFamily: T.mono,
      fontSize: T.fsXs,
      lineHeight: '15px',
      ...(props.style ?? {}),
    },
  }, props.children)
}

/** Hover tooltip; falls back to the native title while hovering. */
function Tooltip(props) {
  const [hover, bind] = useHover()
  return h('span', {
    style: { position: 'relative', display: 'inline-flex', minWidth: 0 },
    ...bind,
  },
    props.children,
    hover === true && props.text !== undefined
      ? h('span', {
        role: 'tooltip',
        style: {
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: 0,
          zIndex: 30,
          padding: '3px 6px',
          borderRadius: T.radiusSm,
          border: `1px solid ${T.border}`,
          background: T.bgRaised,
          color: T.text,
          fontSize: T.fsXs,
          whiteSpace: 'nowrap',
          boxShadow: T.shadow,
          pointerEvents: 'none',
        },
      }, props.text)
      : null)
}

/** Determinate progress bar. */
function ProgressBar(props) {
  const max = Number(props.max ?? 100) || 100
  const raw = Number(props.value ?? 0)
  const pct = Math.max(0, Math.min(1, Number.isFinite(raw) ? raw / max : 0))
  const colors = toneColors(props.tone ?? 'brand')
  return h('div', {
    title: props.title,
    style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, ...(props.style ?? {}) },
  },
    h('div', {
      style: { height: props.height ?? 6, borderRadius: 4, background: T.l2, overflow: 'hidden' },
    }, h('div', { style: { width: `${pct * 100}%`, height: '100%', background: colors.fg, transition: 'width 120ms linear' } })),
    props.label === undefined ? null : h('div', { style: { fontSize: T.fsXs, color: T.textFaint } }, props.label))
}

/** Numeric badge for nav counts. */
function Badge(props) {
  const value = Number(props.count ?? 0)
  if (!Number.isFinite(value) || (value === 0 && props.dot !== true)) return null
  const colors = toneColors(props.tone ?? 'neutral')
  const text = value > (props.max ?? 99) ? `${props.max ?? 99}+` : String(value)
  return h('span', {
    title: props.title,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 16,
      height: 16,
      padding: '0 4px',
      borderRadius: 8,
      background: colors.bg,
      color: colors.fg,
      fontSize: 10,
      fontWeight: 700,
      fontVariantNumeric: 'tabular-nums',
      ...(props.style ?? {}),
    },
  }, text)
}

/** Placeholder page used while a fragment is still being built. */
function PageStub(props) {
  return h('div', { style: { padding: 20 } },
    h(Card, { title: props.name ?? t('nav.section') },
      h('div', { style: { color: T.textDim, fontSize: T.fsSm } }, t('boot.placeholder'))))
}

/* Styles are cosmetic but useful before the first page mounts. */
ensureStyles()