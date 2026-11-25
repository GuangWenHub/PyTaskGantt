# AGENTS.md

后续所有API开发遵循“能复用就复用，不能复用再单独请求”：新增调用前先检查现有客户端、进行中的请求、缓存、数据库记录及扫描快照。只有数据语义、查询范围、权限、完整性和时效均满足当前用途时才能复用；不满足则通过统一客户端单独请求，并在DEVELOPMENT.md说明独立请求的原因、范围、刷新策略和采集时间。禁止各功能重复建立相同采集链路，也禁止为了复用牺牲数据准确性或绕过保存前核验。

This file provides guidance to Codex when working in this repository.

## 当前系统

PyTaskGantt 是 Vue 3 + Express 5 + PostgreSQL 的多用户 RPA 排班与执行看板，已集成影刀开放 API。运行时只有 PostgreSQL：不要恢复 file driver、`TASKS_FILE`、`src/data/tasks.json` 回退或整表覆盖保存。CSV/JSON 只用于导入导出和显式旧数据迁移。

任务保留 `task/start/finish/bot` 排班字段，并扩展所有者、创建者、唯一 `scheduleUuid` 绑定、标签、备注、乐观锁版本、软删除、同步状态、绑定历史、执行记录和审计。`Finish < Start` 表示跨天。

## 前置要求与常用命令

必须使用 **Node.js 20.19+**。命令均在 `vue/` 目录执行：

```bash
cp .env.example .env
npm install
npm run migrate
npm run seed:dev -- 用户甲 用户乙
npm start

npm run server
npm run dev
npm run build

npm test
npm run test:vitest
npm run test:node
npm run test:backend
npm run test:frontend
```

`npm run migrate:pg` 是 `npm run migrate` 的兼容别名。仓库没有 lint/format 脚本，不要假定 `npm run lint` 存在。为验证启动的 Vite/Express 服务在测试结束后必须主动停止，释放默认 `:5174` / `:3002`。

多工作树复用 `node_modules` 时，Vite 的依赖缓存必须放在各工作树自身的 `.vite/`，不能复用 `node_modules/.vite`。显式预编译 Vue、Vue Router、Naive UI、vis-data 与 vis-timeline/standalone，避免首次进入懒加载甘特图时出现过期依赖 504。修复此类问题需实际检查页面模块及依赖请求并在浏览器验证，不能仅以 HTML 返回 200 判断启动正常。

## 配置事实

`vue/.env` 不入库。应用启动至少需要：

- `DATABASE_URL`，或完整的 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSWORD`（显式 URL 优先）
- `SESSION_SECRET`
- `YINGDAO_ACCESS_KEY_ID`
- `YINGDAO_ACCESS_KEY_SECRET`
- `AUTH_MODE=feishu` 时还需要 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_REDIRECT_URI`、`APP_BASE_URL`

主要配置分组：

- 服务：`NODE_ENV`、`PORT`、`VITE_DEV_PORT`、`VITE_DEV_HOST`、`CORS_ORIGIN`
- PostgreSQL：拆分连接参数及 `PGPOOL_MAX`、`PGPOOL_IDLE_TIMEOUT_MS`、`PGPOOL_CONNECTION_TIMEOUT_MS`
- 身份：`AUTH_MODE`、`ALLOW_DEV_AUTH_IN_PRODUCTION`、飞书应用凭证、回调/前端 URL、自动建用户和租户白名单
- 会话：`SESSION_MAX_AGE_SECONDS`、`SESSION_COOKIE_NAME`
- 影刀：Base URL、超时、同步周期、计划缓存和可信绑定缓存
- 执行：`EXECUTION_RETENTION_DAYS`、`JOB_LOG_CACHE_SECONDS`、`UI_REFRESH_SECONDS`

生产环境拒绝 `CORS_ORIGIN=*`，也默认拒绝 `AUTH_MODE=dev`。`ALLOW_DEV_AUTH_IN_PRODUCTION=true` 只允许用于隔离、受控的临时环境。

`AUTH_MODE=feishu` 启用正式飞书 OAuth。OAuth `state` 存在 PostgreSQL session 中并一次性消费，回调后必须重建 session。已登录内部用户可主动绑定飞书；禁止按姓名自动合并。`FEISHU_AUTO_PROVISION=false` 时只允许已绑定身份登录，租户白名单由 `FEISHU_ALLOWED_TENANT_KEYS` 控制。

## 数据库与迁移

- `storage/migrations/001-012` 是权威迁移历史。
- `storage/migrate.cjs` 使用 advisory lock、逐版本事务和 SHA-256 checksum。
- `storage/schema.sql` 是面向 psql 的原子快照入口。
- 服务启动只读校验 `schema_migrations`；缺失、落后、过新或 checksum 不一致均拒绝启动，绝不自动 DDL。
- Docker 上线前必须先执行 `npm run migrate`，再启动新容器。
- 不得修改已发布迁移；新增结构变化应追加下一个迁移并同步更新 snapshot/checksum 及测试。

旧四列表会原地升级并保留 ID；没有所有者/计划的历史任务只读。旧 CSV/JSON 使用：

```bash
node storage/importLegacyTasks.cjs --file <path>
```

该工具无覆盖插入，主键冲突跳过。页面 `/api/import` 是另一条路径：它要求 `ScheduleUuid`，为当前用户追加任务，不能替换整表。

开发用户通过以下方式 seed，且只允许 `AUTH_MODE=dev`：

```bash
npm run seed:dev -- 张三 李四
DEV_USER_NAMES=张三,李四 npm run seed:dev
```

## 后端结构与权限边界

- `server.cjs`：启动、优雅关闭、静态目录接入。
- `server/app.cjs`：Express、CORS、session、路由和错误处理中间件装配。
- `server/config.cjs`：环境变量验证；不要在其他模块重复解析安全配置。
- `server/db/`：Pool、迁移门禁和 users/tasks/executions/audit/run-request repositories。
- `server/routes/`：auth、tasks/import/export、yingdao 路由。
- `server/services/`：任务 mutation/action、影刀 client、同步、状态归一化和保留期清理。

匿名只允许健康检查、登录相关 API 和静态资源。其余 `/api` 必须经过 PostgreSQL session 校验；写请求还要经过 origin allowlist。Cookie 为 HttpOnly、SameSite=Lax，生产启用 Secure。

后端权限规则是安全边界：

- 任意已登录用户可查看全员任务、执行历史、作业和日志。
- `/api/my/tasks` 只返回当前用户拥有且已绑定的任务。
- 新建/导入任务归当前用户。
- 编辑、删除、拖拽落库、换绑、转交、立即执行和单任务同步仅限当前所有者或管理员，最终由后端校验。
- 历史未归属任务仍可查看，但 `can_edit=false`。
- 不依赖前端隐藏按钮或显示名称做授权。

## Mutation 保存约束

前端保存到 `POST /api/tasks/batch`，只发送实际变更：

- `create` 带临时 ID 和必填 `schedule_uuid`；正式 BIGINT ID 由服务端生成。
- `update` 带 `id`、`version` 和变化字段，不允许在普通 update 中改所有者或绑定。
- `delete` 带 `id` 和 `version`，后端软删除并释放绑定。
- batch 在单事务执行；每项锁行、校验所有者/版本并写审计；任一失败整批回滚。
- 换绑和转交走专用端点与事务。

禁止重新引入 `POST /api/tasks` 全量数组、根据客户端缺失行推断跨用户删除、`DELETE FROM rpa_tasks` 导入、前端自增正式 ID 或服务失败时本地数据兜底。

## 影刀集成约束

- 新任务必须绑定一个在影刀存在且当前未被活跃任务占用的 `scheduleUuid`。
- 活跃绑定由数据库部分唯一索引保证；换绑用 `rpa_task_binding_history` 保存时间区间。
- 后台启动时恢复活动执行轮询、做一次全局增量同步，随后按默认 60 秒周期同步。
- 手动同步个人任务/单任务按执行保留窗口查询历史。
- 执行按绑定区间归属；换绑前历史不能移动到新任务。
- 同步失败只写 `sync_error`，不能抹掉上次有效状态。
- 立即执行使用幂等 UUID，阻止同任务并发活动实例，并异步轮询至终态。
- 完整日志不落库，只按需查询并短期缓存；任何日志/错误不得泄露 Access Key 或 Token。

改影刀请求时保留 Token single-flight、401 单次刷新、限流、有限退避重试、超时、缓存可信年龄和敏感信息脱敏。

## 前端结构

以公司新版 KK AntD UI 的绿色品牌主题及 CSS tokens 为准，本地扩展的弹窗、历史记录、按钮与开关也使用同一主题，不保留旧版蓝色硬编码。桌面布局保留左侧甘特图和任务列表、右侧筛选与操作记录；右侧顶部对齐甘特图，操作记录底部对齐任务列表，窄屏切换为单列。甘特图标签沿用新版 DOM 渲染以保留 class/SVG，并补充循环与候选机器标识。

三条业务路由：

- `/login`：dev 用户选择或飞书 OAuth 登录；配置飞书后，已登录未绑定用户可从页头主动绑定。
- `/schedule`：全员甘特图。
- `/my-tasks`：个人任务、筛选、同步和执行操作。

关键文件：

- `src/router.js`：会话路由守卫、401 跳转和跨页未保存确认。
- `src/pages/SchedulePage.vue` / `MyTasksPage.vue`：页面编排。
- `src/stores/taskDraftStore.js`：两页各自的草稿、mutation 列表、版本和保存；这是未保存状态的真相源。
- `src/services/apiClient.js`：统一 `credentials: include`、错误解析和 401 处理。
- `src/services/authService.js` / `taskService.js` / `yingdaoService.js`：API 门面。
- `src/components/GanttChart.vue`：vis-timeline 拖拽；只允许 `can_edit` 任务更新。

甘特图打开或刷新时的自动定位由“设置”内的“自动滚动”开关控制，默认关闭；偏好只存浏览器 Cookie `pytaskgantt.timelineAutoScroll`（一年、进入续期），与登录 Cookie 独立。不要在切回标签页或窗口重新获得焦点时自动定位，不注册相关 focus/visibilitychange 定位监听。开关不控制后台同步，不在轮询时重置视窗；手动“重置”始终可用。

轮询刷新必须保留本地 mutation 字段，同时合并服务端运行状态。离开路由、退出和刷新时继续保护未保存草稿。

所有时间先规范为 `HH:MM:SS`。vis-timeline 使用虚拟日期表示时间条；`Finish < Start` 时结束日期推到次日。改时间逻辑必须覆盖跨天测试。

任务有 `single` / `cron` 两种展示模式，旧任务默认 single。任务类型从绑定计划的规则自动识别，新增和编辑均不提供手动类型页签；五段 Cron 在每日模板中只有一次触发时使用 single，多次触发时使用 cron。预计单次时长为 1–86400 整数秒。只在同一条任务轨道展开每日时间模板，不按实际日期过滤；日/月/周字段保留并校验。标签仅按明确的影刀周期规则默认填写每日/每周/每月，复杂日历规则不猜测；标签保留人工修改，循环任务也显示标签选择。🔁 是展示标识，不写入 tags。循环片段禁止拖拽，点击编辑原任务；密集触发按视窗聚合。影刀缓存不随历史回退，换绑清空缓存并按绑定区间和同步代次保护回写。

`executeScope=any` 且存在多台候选机器的影刀计划作为共享任务展示。`schedule_dispatch` 只缓存策略及机器 ID/名称，不存应用参数。甘特图与任务列表按候选机器投影，正式任务 ID 不变，`view_id` 只用于组件行标识；所有操作必须映射回源任务，禁止候选条目拖拽。统计和操作记录按源任务去重。甘特图标题栏保留“自适应”“重置”“设置”，“自动滚动”位于设置内；“显示隐藏任务”移入设置，默认关闭；仅按数据库rpa_tasks.is_hidden过滤，不再自动隐藏共享任务。开关Cookie `pytaskgantt.showHiddenTasks`保存一年，与旧共享任务Cookie独立。设置中NSwitch即时切换显示，标题栏“设置”按钮打开HiddenTasksDialog；不使用长按、指针捕获或手势计时。筛选卡片不再提供这两个按钮。名单全员共用，添加可按循环/共享/普通任务及名称检索；按源任务ID保存，过滤发生于候选机器投影之前，甘特图、任务列表与操作记录保持一致。同步失败保留有效缓存；换绑、恢复不同绑定时清空缓存，并检查绑定区间及同步代次。执行历史里的实际机器来自执行记录，不从候选列表推断。`all` 不视作随机共享任务；机器组没有展开列表时不猜测候选机器。

影刀 `minute` 规则仅在间隔整除 60 且 `nextTime` 提供有效分钟基准时无损转成五段每日模板（包含分钟偏移）；不能把 7 分钟间隔直接写成 `*/7`。无法准确转换时提示错误并保留有效缓存。

## 测试与提交注意事项

Cron语法以影刀官方文档https://www.yingdao.com/yddoc/rpa/zh-CN/710696135703605248和已核实的真实API为依据。共享解析器支持五段基础语法及日期字段独立L；L须原样保留，并以lastDayOfMonth表达动态日历语义，不能展开为31、不能按浏览器当前日期过滤任务。日与周仍要求至少一项为*，星期0–6；不要因支持L就默认放行Quartz的?/W/#或六/七段格式。错误须指出字段和具体值，不把无法识别的字符误报为数字越界。Cron兼容修改需覆盖官方示例、月末单段/循环模板、周期标签、影刀目录与差异扫描，保留minute偏移及跨天测试。

012追加rpa_plan_creation_whitelist，按影刀计划UUID保存未绑定计划的新增提醒白名单，不伪造本地任务ID或修改011。统一规则API使用task_id:null、field:plan；属性白名单仍要求有效任务ID和属性枚举。白名单全员可读，待新增任一已登录用户可加入，加入人/管理员可恢复；不可通过重复加入抢占管理权。可见差异过滤create计划白名单，实际新增接口也从DB重读并拦截被忽略计划，不能仅前端隐藏。后续已绑定任务的update差异不受plan规则影响。统一列表、独立row.key和混合批量恢复需支持两种规则，事务校验并锁定所有相关任务与计划规则，任一无权限全部回滚。入口为“查看并新增”下方同样的灰色无底色文字按钮，白名单页显示“新增提醒（整个计划）”并提供恢复。

同步弹窗的五个页签均需提供可用的勾选与所选操作，待新增不得禁用合法记录的复选框；需人工处理支持只读重新核验，白名单按rule.key独立勾选并批量恢复。无权限/有草稿的业务写入项仍禁选，选中数需过滤过期/失权项。异常重查POST `/:id/recheck`只接收异常条目ID，重读所选计划并保存重新分类后的快照，读取启用/停用清单核实状态，只重读所选详情；已绑定停用计划转待移除，未绑定停用计划忽略，不因列表缺失推断删除、不重置全量扫描时间和写入期限；需核验操作者登录和来源。白名单批量恢复DELETE `/yingdao/reconciliation/whitelist/batch`复用全局策略锁，事务中锁任务、逐项校验所有者与绑定、原子删除所选规则，禁止部分越权生效。完成快照从数据库读取，不能被进程内旧结果覆盖。

右栏必须使用可收缩的单列网格，卡片、筛选网格和输入组件设置min-width:0；按钮组、排序、历史操作及时间元数据允许换行。历史筛选与分页不得flex压缩，分页使用紧凑模式；隐藏测量行不能套固定最大高度，ResizeObserver按自然内容高度重新分页并保留至少一条完整行的空间。左右空间足够时继续对齐，空间不足时右栏允许自然增高，禁止overflow:hidden掩盖控件截断。

同步弹窗不显示顶部共享说明。忽略入口置于操作列“同步此任务”下方，使用无底色的浅色文字按钮，通过下拉菜单选择属性。待新增支持 `bulk_create: true` 的一键新增（包括其他分页），只允许纯create且不接收自定义form。服务端读取每个计划最近10次无重试、无异常成功记录的最大耗时向上取整至整分钟，无有效历史采用确认过的60秒默认值；不得把历史值或耗时上限静默截断。读取历史有界并发，失败需停止剩余工作，重校验源指纹与唯一绑定后复用单事务batch写入和审计；不修改或执行影刀任务。

planSyncStore 的 `result` 与 `job` 从 PostgreSQL 共享状态读取，不能把旧浏览器快照或白名单上传为服务端权威数据。只在浏览器保存按账号隔离的已读回执。登录先读 GET `/api/yingdao/reconciliation/state`，仅首次无缓存或距上次核对满30分钟才发起扫描；普通15秒状态轮询（扫描中1.5秒）绝不发起扫描。开始扫描或失败不能覆盖已有 result，查看缓存不触发影刀全量请求。

011追加 `rpa_plan_sync_whitelist` 与 `rpa_plan_scan_snapshots`。白名单按任务ID、绑定UUID、字段唯一；全员读、所有者/管理员管理。服务端执行前重新读取白名单，保留对应本地字段；任务仓库的后台cron/dispatch回写也须尊重白名单。白名单与应用使用同一数据库锁，扫描使用另一把全局锁；锁使用独立连接，不能占着业务池连接再嵌套申请导致小池死锁。扫描快照只存归一化配置和差异，不保存凭证、Token、应用参数或日志。最近20份快照外仍保留最后成功结果，60分钟写入期限与可查看期限分离。进程重启后从数据库读取并重新计算权限，中断扫描需识别为失败。仅手动触发计划和本地未绑定任务不进入需人工处理，其他异常仍提示。

计划差异同步由 `server/services/scheduleReconciliation.cjs` 提供服务，路由为 POST `/api/yingdao/reconciliation`、GET `/:id`、POST `/:id/apply`。全量清单分别读取 enabled=true/false 的分页并严格检查总量、重复及结束条件，不使用过期缓存；未绑定停用计划忽略，已绑定停用计划列为待移除并标明已停用，仅在用户确认后软删除本地任务；缺失绑定仍需再次查详情。执行旧快照前重新读取完整清单，拒绝新增已停用计划或移除已重新启用计划。影刀详情不含enabled，不能用详情存在与否代替启用状态。扫描状态与快照保存在PostgreSQL，由全员共享；全局锁限制为一次扫描，保留最近20份及最后成功结果，写入期限60分钟，重启后从数据库恢复读取。客户端仅提交快照条目ID及新增时的名称/标签/备注/耗时，不能提交任意影刀权威字段。执行前重新读取计划并对比快照指纹，同时复核本地配置、版本和权限；每批最多500项，整批事务失败回滚。普通后台状态同步继续运行。

差异写入复用 taskMutationService 的受控 syncPlans 服务端参数，绝不可从普通 batch API 接收该参数。更新计划缓存时递增 sync_generation，防止旧后台请求覆盖，写真实操作者、管理员越权标记和 plan_sync 审计及操作历史。备注、人工标签、所有者、已有预计时长保留；常规开始时间变动保留原时长并联动结束时间。新增归当前操作人、保持唯一绑定；历史未归属任务不自动移除。共享白名单与快照由新增011迁移管理。

前端入口为 FilterPanel 的“同步影刀计划”和 ScheduleReconciliationDialog，扫描生命周期由全局 planSyncStore 管理，不能在弹窗开关时重新扫描或停止轮询。AppShell 登录后读取数据库共享结果和白名单，仅按用户从localStorage恢复已读回执；距上次核对满30分钟才自动扫描，首次也扫描。同用户重复挂载不得重复启动，退出需停止前端轮询并隔离旧请求，后台扫描不写任务。差异/错误显示红点，仅查看完成结果时消除；未查看关闭浏览器仍保留。缓存不是写权限来源，过期结果执行仍须重扫。扫描与临时预览分离，成功后仅清除被同步任务的预览；无权或另有待保存草稿的项不能执行。差异新增使用 TaskEditor 的 persisting 模式，明确“确认新增任务”，不是“应用到预览”；缺少有效历史耗时必须由用户手动确认。没有定时规则的手动触发计划直接忽略；其他规则/机器无法可靠识别时仍进入“需人工处理”，不自动猜测时间。

耗时输入框点击或聚焦即展开滑条并保持可编辑，右侧使用时钟图标；Popover 手动控制开合，点击输入框内不得反复关闭，点击外部及 Escape 关闭。弹层不重复显示顶部耗时。分钟滑条范围0–59，连续拖动，只在5分钟刻度附近微弱吸附，不能再限制为5分钟步长；键盘方向键仍逐分钟调整，手动输入不限5分钟倍数。开始、耗时、结束标签统一居中。

时钟选择器每次打开（包括关闭后重新打开）默认选择分钟，保留原时间值。时、分、秒三个可编辑小框位于表盘下方，与完成按钮同一行。单位切换使用 keyed Transition 的 out-in 淡出/淡入，表盘容器尺寸固定，拖动中不触发切换动画；遵循 prefers-reduced-motion。小时完成后仍切分钟，分钟完成后仍停留分钟。

时钟弹层不显示提示文案或顶部整段时间大输入框；直接在时、分、秒三个小框内输入，保留各自范围校验。小时在表盘选中或拖动松手后自动切换分钟，拖动中不切换；分钟完成后停留在分钟，不自动切换秒。键盘选择小时同样自动切换分钟，秒始终可以主动选择。

ClockTimePicker 的外部时间框整块点击打开表盘；手动时间输入位于弹层顶部。Popover 必须 teleport 到 body 并允许 flip，时间行的 FormItem blank 及控件根节点都须 min-width:0，防止结束时间超出卡片。数字按钮不拦截 pointerdown；由表盘容器捕获 pointer，持续处理 pointermove，末端圆点跟随拖动，松开/取消/失去捕获后结束拖动。数字按钮的鼠标 click 不得将拖动结果改回起点，键盘 click 仍可选数字。组件保留本地响应值，拖动不等待父组件回写。

时间控件统一使用 ClockTimePicker（24小时双圈时钟表盘、分钟/秒表盘，保留手动输入）和 DurationPicker（时/分/秒三条滑条，保留 HH:MM:SS 输入）。新增和编辑均可调整开始/结束时间，元数据读取期间暂禁开始时间及耗时。耗时修改立即按开始时间计算结束时间，跨午夜保留跨天语义；结束时间手动修改后回显新耗时。普通任务耗时上限23:59:59，循环单次时长上限24:00:00，最少1秒。人工改过耗时后，异步历史统计不能再改写时长或结束时间。桌面开始/耗时/结束三列等宽，窄屏将耗时放到下一行；弹出面板使用 Popover 避免被任务卡片滚动容器裁切。以下旧说明中与本段冲突的开始时间只读限制不再适用。

甘特图编辑模式现允许临时修改开始时间、候选机器和循环规则；新增时仍由绑定计划读取开始时间及机器。机器预览需修改 schedule_dispatch 并参与预览差异检测，轮询不能覆盖人工候选机器；刷新后恢复服务端配置，不调用保存接口。编辑窗口和页面常驻说明刷新会丢失预览；刷新按钮确认须说明去影刀控制台修改实际计划，浏览器刷新通过 beforeunload 触发原生确认（文案由浏览器控制），卸载时移除监听。尚未应用到时间轴的表单预览修改也应触发刷新确认。

甘特图页面的拖动及移除仅为临时方案预览；已落库任务的编辑可显式保存到本地，默认应用仍只预览；“预览/新增任务”默认也只预览，但绑定有效且未占用计划后可显式“保存到本地”。无绑定时不显示本地保存按钮，允许填写名称、机器、时间并应用预览。保存本地复用POST /api/tasks/batch，仅发送当前这一个create及白名单字段，不提交其他草稿、客户端Cron/dispatch缓存或临时ID为正式ID。数据库仍禁止无绑定新增。`scheduleTaskStore` 使用 previewOnly 模式，与“我的任务”的持久化草稿隔离；不参与未保存离页确认。预览任务以红框和列表标识提示，调整时提示用户去影刀控制台修改实际计划后同步。普通轮询保留预览并合并运行状态；刷新/离页清除全部预览，成功同步并重新读取后清除对应任务预览。影刀绑定或编辑权限变化时丢弃旧预览。甘特图编辑表单开始时间和机器灰色只读，循环规则允许临时编辑，不写数据库。现有循环/共享候选片段禁止拖拽的规则保留。

新增/编辑任务共用 TaskEditor，已删除文件夹类型页签及相关样式。绑定影刀计划后通过已登录只读接口 `/api/yingdao/schedules/:scheduleUuid/editor` 填写名称、机器、开始时刻、周期标签并识别类型。名称和标签可人工修改，机器及开始时间灰色只读；甘特图循环规则允许临时预览修改。编辑保留本地人工名称、标签、结束时间、预计时长和已调整的预览字段，不能被较晚的响应覆盖。无法准确识别的新计划应显示错误并阻止错误的新建。Naive UI 的内容容器实际为 `.n-card-content`，任务弹窗需 `min-height: 0`、内部滚动并保留固定头部/底部，避免内容超出视口。

编辑窗口在 UUID 后显示影刀计划名，以 UUID 精确查询并核对返回绑定；异步结果须防止旧请求覆盖新表单。影刀候选机器统一显示在 Bot 多选框中，只读并保留原 bot 字段，`any` 多候选显示共享标识，`all` 标明全部执行。“我的任务”的循环规则使用只读输入框，甘特图允许临时预览修改；全部触发时刻放入限高、可键盘访问的滚动区域，不截断时刻列表。

`/api/yingdao/schedules/:scheduleUuid/recent-runs` 按影刀游标有界分页，最多10页、每页20条、最多检查200条候选，补足最近10条无重试且无异常成功记录；禁止复用会遍历全部历史的 listTaskHistory。详情最多两条并发，需核验Task与所有Job成功、实际起止有效、执行过程dispatchCount=1且同应用同机器没有多次尝试；累计runTimes不是重试次数。详情或过程无法核验时跳过，失败、停止、重试后成功也不能凑入10条。多机器分别一次成功可正常纳入。结果仅返回展示白名单，30秒缓存、同计划 single-flight，缓存最多40个计划。表单底部纵向排列横向耗时柱图，显示实际开始/结束及耗时；仅统计已核验的无重试、无异常成功记录，候选不足时不虚构样本。头部显示最大运行时间、最小运行时间及平均耗时，去掉建议文案；所有耗时统一使用 HH:MM:SS，小时允许超过24，平均值显示到整秒。新增时用最大耗时向上取整到分钟填写结束时间及预计单次时长，不能覆盖人工输入或历史实际时间。时间框下方显示实时预计耗时，覆盖跨天。没有有效样本不捏造统计值。无需数据库迁移。

修改后按风险运行对应测试，通常至少：

```bash
npm test
npm run build
```

数据库迁移、会话权限、mutation、影刀同步或前端草稿相关改动必须运行对应 backend/frontend/node:test 套件。`npm test` 会顺序运行 `test:vitest` 与 `test:node`。测试不得依赖真实影刀凭证，也不得输出 secret。

不要提交 `.env`、`dist/` 或 `node_modules/`。未经用户明确要求，不要执行 `git commit`、推送或新建/切换分支。保留用户已有的工作树修改，只改任务范围内文件。

任务隐藏偏好由013迁移追加is_hidden BOOLEAN NOT NULL DEFAULT FALSE，不新建表，不初始化自动隐藏名单。PATCH /api/tasks/visibility为独立的全员共享展示设置：仅管理员可调整，包括他人任务；普通用户只读名单并可切换本浏览器显示开关；必须经session/origin校验，仅接受去重的精确任务ID、is_hidden和expected_hidden，禁止注入排班字段。单事务有序锁行、核对原标志、只更新is_hidden，并写审计；冲突或删除整批回滚。不改任务配置版本、不修改或运行影刀计划。普通mutation/同步保留is_hidden，导入新任务默认false；普通草稿不接受该字段。历史快照记录可选is_hidden，普通用户还原配置时必须保留当前隐藏值，只有管理员能改变隐藏状态。轮询以LIVE_FIELDS合并is_hidden，保留本地预览调整。个人任务页仍提供完整任务用于执行管理。

TaskEditor底部为已落库任务提供灰色文字“隐藏任务”，新增或临时任务不显示；已隐藏时禁用为“已隐藏”。确认框须提示从标题栏设置恢复、隐藏不保存当前未应用编辑且不影响影刀执行。确认后复用visibility端点，成功才关闭并刷新对应页面；失败保留弹窗和编辑内容，不发submit/delete。

TaskEditor用allowLocalSave区分甘特图创建入口，submit只应用预览，save-local才触发持久新增；差异新增仍经applyPlanChanges，普通入口复用saveTaskMutations。保存中禁止重复操作，失败保留表单，成功刷新正式任务与已加载的个人任务。操作记录仅接收正式正整数任务ID，临时预览不得进入task_ids和任务下拉筛选。

编辑弹窗不再显示顶部整段预览提示。allowLocalSave且为已绑定正式任务时同时提供应用到预览/保存到本地；编辑保存只按服务端基线计算变化字段，提交当前任务id/version和普通update白名单，禁止覆盖其他草稿、绑定或所有者。保存失败保留表单；成功刷新后只清除当前任务预览。循环表达式和多机候选列表的手动预览变更不能经普通update持久化，必须明确拒绝整次保存，不能部分保存后误报成功。

任务名称叠层由GanttChart.showTaskNames控制，SchedulePage默认通过Cookie pytaskgantt.showTaskNames启用并记忆一年，入口在甘特图设置。叠层为独立不可交互point，仅有安全DOM textContent；时间戳始终在原任务可见区间内，不参与拖拽/编辑、不扩大自适应范围。文本透明底配白色text-shadow，从首个可见片段表情后左对齐，每条轨道仅一次；不可重复到每个Cron片段。rangechange按帧只刷新名称叠层，rangechanged重算聚合；卸载清理名称帧请求，异步侧栏布局更新须检查timeline已销毁。名称启用时默认折叠左侧名称栏，禁用时展开；图表左上角箭头允许当前页面手动切换，redraw后保留时间视窗。折叠用零宽样式保留轨道高度测量，不删除group或任务。

今日运行状态默认关闭，Cookie pytaskgantt.showRunStatus保存一年，设置中即时切换。GET /api/tasks/today-executions要求登录、最多500个去重BIGINT任务ID，仅返回当前绑定与绑定起点之后、上海当日、source_type=period且非本地立即执行的记录及刷新元数据；禁止返回凭证、参数、日志。开启后按最新今日明细核对策略运行，关闭/卸载中断并隔离迟到响应。后台以日期/任务/绑定区间缓存、单批两并发、至少60秒间隔调用影刀游标历史并复用syncCoordinator.applyRecords落入现有执行表；读取不完整不得标ready，失败保留旧数据且明确提示。影刀result/pageDTO及超安全整数游标需无损解析，不可使用累计runTimes判断重试。底部4像素灰/蓝/绿/红，等待运行用蓝，重试终态成功用绿，不应用最近10次纯净成功样本过滤。循环按trigger/create时间归属今天各触发，不按结束时间；聚合保留分段颜色；候选机器只按执行实际clientID着色，缺机器信息提示无法匹配。不改变任务条原始时间/视窗、名称叠层不加状态条。无DDL，不修改或运行影刀计划。


显示偏好统一在src/services/browserPreferences.js定义Cookie默认值、读写及renewDisplayPreferences；authService.applySession仅在有效登录时续期全部已知显示Cookie一年，保留原值，不动登录Cookie。新增开关要加入统一清单。显示隐藏任务不得重新放回标题栏。名称避让使用taskNameLayout实际文字Range矩形末端，首次无DOM按emoji字素预留，不能恢复固定24px偏移；updateData、视窗及尺寸变化重测量。任务条26px，底部状态层继承父圆角并裁切底部4px；bot_1默认#b7791f。

API采集复用规范见DEVELOPMENT.md。执行历史分页统一经YingdaoClient.getExecutionPage：完整范围参数为缓存键，15秒TTL、400页上限、相同查询并发合并、返回深拷贝、保留真实fetched_at，失败不缓存且不回退过期值。当天状态与最近十次候选统一20条无起止条件游标页，当天完整性仍需读到昨日或明确结束；历史显式范围不同则隔离。不得让newest/list的最新一次代表全天完整，也不得让状态条的重试成功记录直接当作无重试样本。保留配置scanned_at、业务完成completed_at、采集fetched_at和既有last_synced_at的不同语义，不新增表或修改既有迁移。


页头在今日运行状态关闭时只用planSyncStore.state.result中state=ready的scanned_at显示计划配置缓存截至时间；扫描中或失败保留上次成功快照，无快照明确提示。禁止执行时间last_synced_at/sync_cutoff或扫描开始时间冒充配置缓存，不额外调用影刀。今日明细核对现按页面激活状态暂停和恢复，详见下文最新规则。当前时间线独立prop showCurrentTimeLine、Cookie pytaskgantt.showCurrentTimeLine默认关闭并纳入统一登录续期；每秒用getCurrentTimeWindow中心时间映射上海时钟至虚拟日期，setCustomTime(schedule-current)，绝不setWindow或调用API。关闭/卸载清理interval及标记，午夜回到模板零点，不与8:30参考线共用ID。复用最大缩放阈值与文字彩蛋CSS，绿色虚线区分固定灰线，所有子元素禁指针交互。

8:30与17:30参考线共用showReferenceLines、Cookie pytaskgantt.showReferenceLines（默认开启、登录续期一年），同时控制schedule-reference和schedule-reference-evening，不再创建5:30参考线。兼容旧showEarlyReferenceLine偏好作为新键首次缺失时的迁移值，不让旧键覆盖新键。两条固定线共用虚线与经文彩蛋，不影响当前时间线与视窗。当前时间线绿色#008c45。设置卡片限高、内容滚动、头尾不收缩。

自定义机器颜色入口MachineColorsSettings，machineColorPreference在页面共享颜色覆盖且不改任务数据；每机器独立Cookie pytaskgantt.machineColor.<URL编码bot名>、一年并在登录时续期，恢复默认只删对应键。状态色唯一来源shared/runStatusColors.mjs，machineColors.mjs仅以OKLab距离<0.075排除很近的状态色，不能再按整个色系或低饱和度禁用，UI、保存和Cookie读取均校验；不得接受任意CSS值。仅覆盖显示color，保留源任务、预览、版本、候选身份。所有候选描述复用candidateExecutionText，从源任务完整clients取全部机器，不受筛选后的单条投影限制；Gantt悬浮/侧栏、TaskList标记保持一致。开发规范详见DEVELOPMENT.md。

今日明细GET /tasks/today-executions支持refresh=force/due/cache与refresh_ids子集：只读缓存模式绝不请求影刀；强制模式跳过已完成分页缓存但合并在途同查询；到期模式只更新指定ID。前端首次打开/刷新强制核对、失败仍强制重试，之后60秒只核对未成功计划，处理中15秒只读缓存。用户明确选择循环任务“任一次成功即停止”，不等待全部触发完成；刷新/重开或上海跨天重查，成功标记只在当前页面内存。标签页隐藏或失焦时继续轮询，恢复可见或窗口聚焦时仅补查已到期且尚未成功的计划。请求15秒超时后提示并自动重试，关闭开关或离页时清理计时器和请求，忽略迟到响应。已入队后台批次继续，同进程全员两worker并发队列，不能因已有flight遗漏后续请求。原全局增量同步独立运行。焦点事件仅用于核对策略，严禁恢复窗口激活自动滚动时间轴。

当前时间线设置不显示文字彩蛋等说明，彩蛋功能保留。机器颜色仅用调色板及饱和度，取消推荐色与原生任意选色/HEX输入；禁用色直接灰色背景disabled，不使用圆形覆盖。使用0.075的窄色差规则，黑白及明显不同的深浅色允许，保存和Cookie读取继续校验。缓存位置与最新策略在DEVELOPMENT.md说明，浏览器只保存偏好、回执及临时显示状态，不把服务端扫描数据挪入浏览器持久存储。


## 审查修复约束

- 编辑已有任务时，以本地已保存的开始/结束时间为初始值；计划详情只在新增时自动填写开始时间，迟到的响应不得覆盖编辑中的本地时间。
- 耗时与跨天判断按秒计算；不得把30秒显示为0分钟或漏判同一分钟内的次日结束。
- 最近十次统计区分不合格记录与接口核验失败，返回verification_failed_count/incomplete；有核验失败时不自动建议耗时、不进入30秒统计缓存。一键新增遇到核验失败整体终止，不得当作无记录使用1分钟默认值；无记录且采集完整时保留原有明确提示的默认策略。
- 同步应用通过taskMutationService.applyBatch内部beforeCommit回调，把已应用扫描快照用同一数据库事务连接保存；快照保存失败必须连任务、审计、操作历史一起回滚，不允许提交任务后另行保存快照。
- 隐藏与恢复显示除底层审计外，还写入每任务50条操作历史。JSON快照增加可选is_hidden/operation_scope，无DDL；只有前后快照都标为visibility且其他配置一致才允许由管理员还原。还原此类记录只更新is_hidden，不改任务版本/配置/绑定、不请求影刀；正常配置还原仍检查所有权，旧快照缺少is_hidden时保留当前隐藏状态。
- 设置中“显示隐藏任务”一项合并开关与“设置名单”按钮，后者进入二级菜单；不要拆成两个设置项。当前时间线显示用途说明，不透露彩蛋。


TaskEditor在编辑真实已绑定任务且服务端can_edit=true时显示换绑入口，emit rebind复用SchedulePage/MyTasksPage既有换绑确认流程，不把schedule_uuid夹带普通保存。表单输入、时长/机器/标签等编辑需先保存或取消；父页面仍检查任务草稿。换绑成功保持编辑窗口并更新任务版本，列表旧缓存不可覆盖新绑定；刷新失败明确提示已保存。无需新增后端接口或DDL。最近运行起止时间经formatRunDateTime统一上海时区及星期，无时区影刀时间按+08:00解释。


隐藏名单权限：PATCH /tasks/visibility在路由和repository均检查actor.isAdmin；非管理员返回ADMIN_REQUIRED且不得写入。TaskEditor仅canManageHidden（来自有效会话is_admin）时显示隐藏入口；HiddenTasksDialog普通用户显示“查看名单”，保留开关、禁用全部增删/保存操作。隐藏操作历史的can_restore仅管理员为true，restore-preview/restore服务再次校验管理员。普通配置历史还原也必须保留当前is_hidden，堵住间接变更路径。不得为此自动提升现有账号角色，不新增迁移或修改数据库权限数据。
