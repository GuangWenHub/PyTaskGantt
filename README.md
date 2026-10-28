# PyTaskGantt

面向团队的 RPA 任务排班与执行看板。系统以 Vue 3 + Express 5 提供全员甘特图和个人任务页，以 PostgreSQL 作为唯一运行时数据源，并通过影刀开放 API 关联计划、同步执行状态、查看历史与日志、立即执行任务。

![Vue](https://img.shields.io/badge/Vue-3-42b883?logo=vuedotjs&logoColor=white)
![Naive UI](https://img.shields.io/badge/Naive%20UI-2-63e2b7)
![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-required-4169e1?logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-2496ed?logo=docker&logoColor=white)

> [!IMPORTANT]
> 当前版本不再支持 file driver，也不会在后端不可用时回退到 `tasks.json`。CSV/JSON 只用于导入导出，PostgreSQL 是任务、用户、会话、绑定、审计和执行记录的唯一持久化来源。

## 功能概览

- **全员任务**：已登录用户可以查看全部未删除任务；只有任务所有者可以编辑、拖拽或删除自己的任务。
- **我的任务**：个人页仅返回当前用户拥有且已绑定影刀计划的任务，支持搜索、标签和状态筛选。
- **安全保存**：页面保留“修改后点击保存”的交互，但只提交实际发生的 `create` / `update` / `delete` mutation，不再发送或覆盖整张任务表。
- **并发保护**：更新和删除携带任务 `version`，后端同时校验所有权和版本；冲突会拒绝写入，不会静默覆盖他人修改。
- **影刀绑定**：新任务必须选择唯一的 `scheduleUuid`；支持所有者换绑、转交、手动同步和立即执行。
- **运行可观测性**：集中同步影刀执行记录并归一化状态，支持查看执行历史、作业和按需日志。
- **软删除与审计**：删除只影响本平台并立即释放计划绑定；创建、修改、删除、换绑、转交、导入和立即执行均记录审计。
- **CSV/JSON 传输**：导入会为当前用户新增任务，导出当前登录用户可见的任务；导入不是整表替换。
- **服务端会话**：会话保存在 PostgreSQL `app_sessions`，所有业务 API 都由后端执行登录和权限校验。

时间字段仍使用 `HH:MM:SS`。当 `Finish < Start` 时表示任务跨越午夜，例如 `23:30:00 → 01:15:00` 记为次日结束。

### 🔁 循环任务

新增窗口顶部用“常规任务 / 循环任务”文件夹页签切换：页签顶部凸起，选中项与内容面板连成一体。编辑窗口保持普通表单，不提供类型切换，直接按已有类型展示内容。常规任务显示标签与起止时间；循环任务自动显示 🔁，不提供标签选择。新增时切换类型保留已填内容，原有分类标签不会因隐藏而被清空。弹窗按视口限制高度，表单内部滚动，底部操作按钮始终保留。

新增时选择“循环任务”，填写单次预计时长（1–86400 秒）；编辑时沿用已有类型。规则只读自绑定的影刀计划，不会修改影刀计划。旧任务保持单段模式。

支持影刀五段表达式（分、时、日、月、周）的列表、范围和步长及英文月/星期；不接受 Quartz 的秒、`?`、`L`、`W`、`#`。日与周至少一项为 `*`。所有任务统一展示每日时间模板：日/月/周字段保留并校验，不依实际日期隐藏任务，原有分类标签不变。

例如 `0 0-8/2 * * *`、预计 60 秒，在同一任务行显示 00:00、02:00、04:00、06:00、08:00 五个片段。🔁 标识循环任务，密集触发缩小时聚合、放大后展开，悬停查看时刻和数量。片段不可拖拽，点击编辑整条任务。预计时长跨午夜时延续到次日。

展示模式与预计时长参与草稿保存、操作历史还原及 CSV/JSON 导入导出（`TimingMode`、`ExpectedDurationSeconds`）。Cron 缓存由同步维护，失败保留上次有效规则并提示；换绑会清空旧缓存。迁移 `009` 为任务追加配置及缓存字段；`npm run migrate`、新库快照和上线校验均包含该迁移。

影刀“每 N 分钟”规则在间隔整除 60 且有有效触发基准时，可准确转换为每日模板，保留分钟偏移。例如每 10 分钟执行一次显示每日 144 次；每次时长仍由看板配置。无法准确转换的间隔会提示，不改写影刀规则。

### 共享机器任务

影刀设置“任意一台执行”（`executeScope=any`）并有多台候选机器时，甘特图和任务列表分别在每台候选机器下显示条目，采用半透明与虚线边框，并标注“共享 · 任选1台”。右侧“显示共享任务”默认关闭，蓝色表示开启、灰色表示关闭，浏览器 Cookie 保存一年。

候选条目是同一任务的不同展示，编辑、删除、执行及历史操作都作用于原任务，计数和操作记录不会重复。候选条目不允许拖拽；按机器筛选时只显示相应候选条目。执行历史单独显示实际执行机器。当前按影刀返回的候选列表展开，不猜测未展开的机器组成员，`all` 策略不按随机共享任务处理。

编辑卡片在计划 UUID 后显示影刀计划名称；Bot 多选框展示影刀返回的候选机器，共享计划标注“共享 · 任选1台”，候选配置只读。循环规则使用只读输入框，全部触发时刻在限高区域内滚动查看。

迁移 `010` 增加只读的策略及候选机器缓存；不保存应用参数。后台同步更新，失败保留上次有效缓存，换绑清空；历史还原不会回退影刀缓存。`npm run migrate`、新库快照和上线验证均同步至版本 10。

## 技术栈

| 层 | 技术 |
|:---|:---|
| 前端 | Vue 3 · Vue Router · Naive UI · vis-timeline |
| 后端 | Express 5 · express-session · Zod |
| 数据库 | PostgreSQL · `pg` · connect-pg-simple |
| 外部集成 | 影刀开放 API |
| 构建与测试 | Vite 8 · Vitest · node:test · Supertest |
| 部署 | Node.js 20 · Docker 多阶段构建 · Traefik（可选）|

## 快速开始

### 前置要求

- **Node.js 20.19+** 和 npm（Vite 8 的最低要求）
- **PostgreSQL 13+**
- PostgreSQL 客户端工具（上线验证、备份和恢复需要 `psql`、`pg_dump`、`pg_restore`）
- 可用的影刀开放 API Access Key ID / Secret
- Docker（仅容器部署需要）

### 1. 安装并配置

```bash
cd vue
cp .env.example .env
npm install
```

至少修改 `.env` 中的以下值：

```dotenv
PGHOST=localhost
PGPORT=5432
PGDATABASE=pytaskgantt
PGUSER=pytaskgantt
PGPASSWORD=change-me
AUTH_MODE=dev
SESSION_SECRET=replace-with-a-random-secret
YINGDAO_ACCESS_KEY_ID=replace-me
YINGDAO_ACCESS_KEY_SECRET=replace-me
```

也可以只配置完整的 `DATABASE_URL`。显式连接串非空时优先；否则服务、迁移器和 Node 维护工具会根据完整的五项 `PG*` 自动生成，并对用户名、密码和数据库名进行 URL 编码。

### 2. 执行数据库迁移

```bash
npm run migrate
```

`npm run migrate:pg` 是同一命令的兼容别名。迁移器按顺序执行 `storage/migrations/001` 到 `009`，记录 SHA-256 checksum；应用启动只校验版本，不会自动执行 DDL。数据库缺少迁移、版本落后、版本过新或已执行迁移文件被改写时，服务都会拒绝启动。

### 3. 创建开发用户

```bash
npm run seed:dev -- 用户甲 用户乙
# 或
DEV_USER_NAMES=用户甲,用户乙 npm run seed:dev
```

该命令只在 `AUTH_MODE=dev` 时可用，重复执行会保留已有同名开发用户。

### 4. 启动开发环境

```bash
npm start
```

访问：

- 前端：<http://localhost:5174>
- 后端健康检查：<http://localhost:3002/api/health>

也可以分别启动或构建：

```bash
npm run server       # 仅 Express，默认 :3002
npm run dev          # 仅 Vite，默认 :5174
npm run build        # 生产构建，产物在 dist/
```

### 内网访问

内网试用可先执行 `npm run build`，再由 Express 提供构建后的页面与 `/api`，统一访问 `http://<本机内网IP>:3002`，不必对其他计算机开放 Vite 的 5174 端口。前端代码修改后需重新构建，接口配置修改后需重启后端。

将该地址作为精确 origin 追加到本机 `.env` 的 `CORS_ORIGIN`，保留原有来源；不要配置 `*`。Windows 防火墙只放行当前专用网络、本机地址、TCP 3002 和获准的内网来源网段，不开放 PostgreSQL 端口。本机需保持运行并连接内网，IP 变化后同步更新访问地址、origin 与防火墙规则。

`AUTH_MODE=dev` 允许访问者直接选择已有开发用户身份，适用于已明确授权的临时内网试用；正式团队使用应配置飞书登录。不同计算机拥有独立浏览器会话，查看同一数据库中的任务。

## 身份、会话与权限

当前支持开发用户切换和飞书 OAuth：

- `AUTH_MODE=dev` 时，`/login` 从 `app_users` 读取有效的 dev 用户并创建服务端会话。
- `AUTH_MODE=feishu` 时，`/login` 跳转飞书授权；回调按 `union_id`，或 `tenant_key + open_id` 定位内部用户并创建服务端会话。
- dev 模式完整配置飞书参数后也会显示飞书入口，便于现有内部用户先登录再从页头主动绑定；绑定不会按显示名称自动合并。
- `FEISHU_AUTO_PROVISION=true` 允许未绑定飞书身份首次登录时创建用户；设为 `false` 时只允许已绑定身份。可用 `FEISHU_ALLOWED_TENANT_KEYS` 限制租户。
- OAuth `state` 一次性保存在 PostgreSQL session 中，默认十分钟过期；成功回调会重建 session，防止会话固定。
- 会话 Cookie 为 HttpOnly、SameSite=Lax，生产环境启用 Secure，并采用滚动过期。
- 除 `GET /api/health`、登录相关接口和前端静态资源外，所有业务 API 都要求有效会话。
- 写请求还会检查 `CORS_ORIGIN`；生产环境禁止使用 `*`。
- 权限使用不可变的内部 `user_id` 判断，不使用显示名称作为身份主键。

| 操作 | 权限 |
|:---|:---|
| 查看全员任务、执行记录、作业和日志 | 任意已登录用户 |
| 查看“我的任务” | 仅返回当前用户任务 |
| 新建、导入任务 | 任意已登录用户；新任务归当前用户 |
| 编辑、拖拽、删除、换绑、转交、立即执行、单任务同步 | 仅当前所有者 |
| 同步“我的任务” | 仅同步当前用户拥有的任务 |

> [!WARNING]
> 不要使用姓名匹配飞书账号。现有任务用户应在受控 dev 环境登录原账号后点击“绑定飞书”，再切换生产 `AUTH_MODE=feishu`。当前 `AUTH_MODE=dev` 仅适用于本地、测试或其他受控环境；`NODE_ENV=production` 默认拒绝 dev 模式。

飞书开放平台需要创建企业自建应用、启用网页应用能力，并登记与 `FEISHU_REDIRECT_URI` 完全一致的重定向 URL。生产环境建议先保持 `AUTH_MODE=dev` 且完整填写飞书配置，让已有用户逐一从页头绑定；确认完成后再切换为 `AUTH_MODE=feishu`。若不希望未知飞书用户自动进入系统，设置 `FEISHU_AUTO_PROVISION=false`。

## 页面路由

| 路径 | 说明 |
|:---|:---|
| `/login` | 开发用户选择或飞书登录页；未登录访问业务页会跳转至此 |
| `/schedule` | 全员甘特图，展示全部未删除任务并按 `can_edit` 控制编辑能力 |
| `/my-tasks` | 当前用户的个人任务列表、筛选、同步、换绑、转交和立即执行入口 |

`/` 重定向到 `/schedule`。API 返回 401 时，前端统一清理会话和草稿状态并跳回 `/login`；跨页面离开和退出登录时会提示未保存修改。

## 任务保存模型

前端为两个业务页面分别维护任务草稿，并只记录发生变化的任务：

```json
{
  "mutations": [
    { "type": "create", "temp_id": "tmp:...", "task": "日报", "start": "09:00:00", "finish": "09:30:00", "bot": "机器人A", "schedule_uuid": "...", "tags": [], "note": "" },
    { "type": "update", "id": "42", "version": 3, "changes": { "start": "09:10:00" } },
    { "type": "delete", "id": "51", "version": 2 }
  ]
}
```

保存请求发送到 `POST /api/tasks/batch`，整个批次在一个数据库事务中处理：

1. 新建任务由 PostgreSQL 分配 BIGINT identity，后端返回临时 ID 到正式 ID 的映射。
2. 更新和删除先锁定任务，再校验所有者和 `version`。
3. 更新只写 mutation 中列出的字段并递增版本。
4. 删除采用软删除，关闭绑定历史并立即释放当前 `scheduleUuid`。
5. 任一 mutation 失败时整批回滚。

轮询刷新会更新运行状态等服务端字段，同时保留尚未保存的本地草稿。

甘特图标题栏“重置”右侧的“自动滚动”开关默认关闭，蓝底表示开启，灰底表示关闭。开启时立即定位当前时间；后续打开或刷新页面时动画定位当前时间，切回标签页或窗口重新获得焦点不会触发定位。轮询不改变用户视窗，“重置”仍可随时手动定位。偏好保存在浏览器 Cookie `pytaskgantt.timelineAutoScroll`，有效期一年，每次进入续期，与登录会话独立；清除站点 Cookie 后恢复默认关闭。

## 操作记录与单任务还原

全员任务页右侧提供操作记录卡片，可按任务和操作人筛选、添加备注、预览并还原单条历史操作。

操作记录跟随主面板的任务名称、机器人和所有者筛选，卡片底部与任务列表对齐。列表按记录实际内容高度分页，在行高上下限内分配剩余空间，灰白交替显示；可点击每条记录查看完整详情。

- 页面中的一次成功保存，按每个任务生成记录；未保存的草稿不记入历史。编辑、拖拽、新增、导入、删除、换绑、转交和管理员恢复均保存完整前后快照。
- `rpa_task_operation_history` 每个任务保留最近 50 条（含新增、导入和还原）；修改记录备注不增加条数。清理只影响这张业务历史表，原始 `rpa_task_audit_log` 不随之删除。
- 备注独立于任务备注，仅原操作人可修改，并检查备注版本。已登录用户可查看记录，当前任务所有者或管理员才可还原；恢复到历史只读状态仅管理员可操作。
- 选择较早记录会将该任务完整配置恢复到该次操作之前，包括所有者、计划、时段、标签、任务备注及软删除状态；后续对该任务的修改效果会被覆盖。其他任务不受影响。
- 还原新增或导入等价于软删除该任务。版本继续递增，创建者、执行历史和原始审计保持不变。计划绑定从还原发生时新建有效区间，不倒改历史绑定时间。
- 还原前检查完整快照、权限、当前版本、原所有者有效性、计划占用及活动执行。前端先显示当前与目标的对比，再发送确认；后端在事务内重新检查。涉及绑定或删除状态变化时，活动执行或待发送请求会阻止还原。
- 迁移 `008` 将原审计中每个任务最近 50 条引入列表；这些旧记录没有完整快照，只支持查看和备注。立即执行记录可查看，不能撤回影刀运行。

升级时先备份数据库并停止旧服务，执行 `npm run migrate` 至 schema version 10，再运行只读验证和更新运行账号权限，最后启动新服务。迁移不会自动在应用启动时执行。

API：`GET /api/task-history`、`PATCH /api/task-history/:id/annotation`、`GET /api/task-history/:id/restore-preview`、`POST /api/task-history/:id/restore`。客户端不能提交或改写历史快照。

## CSV / JSON 导入导出

CSV 示例：

```csv
Task,Start,Finish,Bot,ScheduleUuid,Tags,Note
数据同步,09:00:00,09:25:00,机器人A,schedule-uuid-1,日报;财务,工作日运行
日志分析,23:30:00,01:15:00,机器人B,schedule-uuid-2,夜间,跨天任务
```

- 导入的 `Task`、`Start`、`Finish`、`Bot`、`ScheduleUuid` 都是必填项。
- CSV 标签用分号分隔；JSON 中 `tags` 可使用数组。
- 导入复用 create mutation：逐条校验计划存在且未被绑定，任务归当前用户，已有任务不会被删除或覆盖。
- 导出包含任务元数据和所有者信息，不包含执行历史和完整日志。
- 旧四列 CSV/JSON 不能通过页面导入为可编辑新任务；如需迁移历史数据，请使用“旧数据导入”命令。

旧数据无覆盖导入：

```bash
node storage/importLegacyTasks.cjs --file ../ShadowBot_tasks.csv
```

该工具保留可用的旧 ID，主键冲突时跳过，不覆盖现有行；导入结果的 `owner_user_id` 和 `schedule_uuid` 为空，因此会在全员任务中作为历史只读任务显示，不进入“我的任务”。

确认计划 UUID 后，使用原子补齐工具同时写入所有者、当前绑定时间、绑定历史和审计；不要直接只改任务表中的两个列：

```bash
npm run backfill:task -- \
  --task-id 42 \
  --owner-user-id 7 \
  --schedule-uuid schedule-uuid-1 \
  --bound-at 2026-07-22T12:00:00+08:00
```

`--actor-user-id` 可选，默认等于所有者；省略 `--bound-at` 时以执行命令的当前时间作为绑定生效时间。

## 影刀配置与同步

核心配置：

| 变量 | 默认值 | 说明 |
|:---|:---|:---|
| `YINGDAO_ACCESS_KEY_ID` | 无 | 必填，不得提交真实值 |
| `YINGDAO_ACCESS_KEY_SECRET` | 无 | 必填，不得提交真实值 |
| `YINGDAO_BASE_URL` | `https://api.yingdao.com` | 开放 API 根地址 |
| `YINGDAO_REQUEST_TIMEOUT_MS` | `15000` | 单次请求超时 |
| `YINGDAO_SYNC_INTERVAL_SECONDS` | `60` | 后台全局增量同步周期 |
| `YINGDAO_SCHEDULE_CACHE_SECONDS` | `60` | 计划列表/详情新鲜缓存 |
| `YINGDAO_BIND_CACHE_MAX_AGE_SECONDS` | `300` | 远端失败时允许用于绑定校验的可信缓存上限 |
| `EXECUTION_RETENTION_DAYS` | `30` | PostgreSQL 执行记录保留期 |
| `JOB_LOG_CACHE_SECONDS` | `300` | 作业日志进程内缓存时间；完整日志不长期落库 |
| `UI_REFRESH_SECONDS` | `10` | 前端读取 PostgreSQL 最新状态的周期，最小 5 秒 |

服务启动后会恢复未结束执行的轮询，立即做一次全局增量同步，此后按配置周期继续同步。用户还可以在个人页同步自己的全部任务，或同步单个任务。同步记录依据计划绑定时间区间归属到任务，换绑前的历史仍保留在原任务下；同步失败只记录 `sync_error`，不会覆盖上次有效执行状态。

无法识别的影刀状态会保留原始值并按活动状态保守处理：页面显示“未知状态”，后台继续轮询，并暂时阻止同一任务再次立即执行，直到取得可识别的终态。这是实施计划“未知值保守处理”的具体行为，避免状态枚举变化造成重复启动。

立即执行先把稳定幂等 UUID 持久化到 outbox，再在数据库事务外调用影刀；远端成功而本地提交失败或服务重启时会复用同一 UUID 恢复，避免重复启动。影刀 Token、限流、有限重试和凭证脱敏由服务端统一处理。影刀无时区时间固定按 `Asia/Shanghai` 解析和格式化。

## 运行时配置

`vue/.env`（不入库，从 `.env.example` 复制）是本地运行配置源：

| 分组 | 变量 |
|:---|:---|
| 服务 | `NODE_ENV`、`PORT`、`VITE_DEV_PORT`、`VITE_DEV_HOST`、`CORS_ORIGIN` |
| PostgreSQL | `DATABASE_URL`，或 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSWORD`；可选 `PGSSLMODE`、证书路径、`PGAPPNAME` 及 pool 参数 |
| 身份与会话 | `AUTH_MODE`、`ALLOW_DEV_AUTH_IN_PRODUCTION`、`SESSION_SECRET`、会话参数；飞书的 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_REDIRECT_URI`、`APP_BASE_URL`、自动建用户/租户/超时参数 |
| 影刀 | `YINGDAO_ACCESS_KEY_ID`、`YINGDAO_ACCESS_KEY_SECRET`、`YINGDAO_BASE_URL`、请求/同步/缓存参数 |
| 执行与页面 | `EXECUTION_RETENTION_DAYS`、`JOB_LOG_CACHE_SECONDS`、`UI_REFRESH_SECONDS` |

完整数据库说明见 [vue/POSTGRESQL.md](vue/POSTGRESQL.md)。

## 测试与构建

在 `vue/` 目录运行：

```bash
npm test                              # 全部测试（Vitest + node:test）
npm run test:vitest                   # Vitest 会话、API 与前端测试
npm run test:node                     # node:test 数据库、影刀与同步测试
npm run test:backend                  # 后端、影刀与执行同步测试
npm run test:frontend                 # 前端 API 与草稿状态测试
npm run test:postgres                 # 真实 PostgreSQL 事务与权限测试（需 TEST_DATABASE_URL）
npm run build                         # 生产构建验证
```

真实 PostgreSQL 测试会反复清空应用表，只能连接已完成迁移的专用隔离数据库，不能使用开发、共享或生产数据库：

```bash
export TEST_DATABASE_URL='postgresql://test_user:test_password@localhost:5432/pytaskgantt_integration'
DATABASE_URL="$TEST_DATABASE_URL" npm run migrate
npm run test:postgres
```

未设置 `TEST_DATABASE_URL` 时，`test:postgres` 会明确失败，不会把跳过集成测试当作成功。常规 `npm test` 不连接真实数据库；数据库集成门禁应单独执行。更完整的隔离库说明见 [vue/POSTGRESQL.md](vue/POSTGRESQL.md#真实-postgresql-集成测试)。

仓库当前没有 lint/format 脚本，不要假定 `npm run lint` 存在。

## Docker 部署

镜像使用 Node 20 Alpine，多阶段构建前端，并在生产层复制 `server/`、`lib/`、`storage/` 和迁移文件。容器不会自动迁移数据库，应用启动也只做只读 schema 校验，因此每次上线包含新迁移的版本前必须先执行迁移：

### 本地 Docker Compose 测试

本地测试使用 [docker-compose.test.yml](vue/docker-compose.test.yml)。它与生产部署保持相同的单应用服务、生产镜像和手动迁移流程，不内置 PostgreSQL，也不会覆盖任何数据库变量；应用容器的运行时环境全部从 `vue/.env` 读取。

先自行创建本地测试数据库，再确认 `.env` 中 `DATABASE_URL` 或完整五项 `PG*` 指向该数据库。若 PostgreSQL 运行在宿主机，容器内不能使用 `localhost`，应设置 `PGHOST=host.docker.internal`；使用 `DATABASE_URL` 时也要把其中的主机名改成 `host.docker.internal`。本地 HTTP/dev 登录建议保留 `NODE_ENV=development`、`AUTH_MODE=dev`，并让 `CORS_ORIGIN` 包含 `http://localhost:3002`。

```bash
cd vue

# 构建与生产部署相同的最终镜像。
docker compose -f docker-compose.test.yml build

# 使用同一个应用镜像创建/升级 001-010 表结构。
docker compose -f docker-compose.test.yml run --rm pytaskgantt npm run migrate

# 创建本地开发登录用户，然后启动应用。
docker compose -f docker-compose.test.yml run --rm pytaskgantt npm run seed:dev -- 苕尖
docker compose -f docker-compose.test.yml up -d pytaskgantt
docker compose -f docker-compose.test.yml ps

# 访问 http://localhost:3002/login
# 查看日志：docker compose -f docker-compose.test.yml logs -f pytaskgantt

# 只停止应用容器；外部数据库由你自行保留或清理。
docker compose -f docker-compose.test.yml down --remove-orphans
```

如需使用其他本地开发用户名，可在 seed 命令末尾传入名称，或在 `.env` 中设置 `DEV_USER_NAMES=用户甲,用户乙`。此 Compose 文件不会运行 `npm run test:postgres`；真实 PostgreSQL 集成测试会执行 `TRUNCATE ... RESTART IDENTITY CASCADE`，必须继续使用单独的可丢弃数据库，不能复用这里的界面联调库。

### 生产 Compose 模板

```bash
cd vue
cp docker-compose.yml.example docker-compose.yml

# 配置 DATABASE_URL 或完整 PG*，以及 CORS_ORIGIN、SESSION_SECRET、影刀凭证和认证模式后：
docker compose build
docker compose run --rm pytaskgantt npm run migrate
docker compose up -d
```

若迁移失败，不要启动新应用版本；修复数据库或配置后重新执行迁移。部署时还需注意：

- `CORS_ORIGIN` 使用实际 HTTPS 地址，不能是 `*`。
- `SESSION_SECRET` 在生产环境至少 32 个字符。
- 数据在外部 PostgreSQL 中持久化，应用容器不使用任务文件数据卷。
- `AUTH_MODE=feishu` 必须完整注入飞书应用凭证、HTTPS 回调和 `APP_BASE_URL`，并在飞书开放平台登记完全一致的重定向 URL。
- 仅在隔离、受控的临时环境中使用 `AUTH_MODE=dev`，并显式传入 `ALLOW_DEV_AUTH_IN_PRODUCTION=true`。
- Compose 模板默认通过已有 Traefik external 网络暴露服务；证书解析器、域名和网络名必须与实际环境一致。

常用命令：

```bash
docker compose ps
docker compose logs -f pytaskgantt
docker compose run --rm pytaskgantt npm run migrate
docker compose up -d --build
```

## 项目结构

```text
PyTaskGantt/
├── RPA_KANBAN_IMPLEMENTATION_PLAN.md
├── README.md
└── vue/
    ├── server.cjs                  # 启动、关闭和静态资源托管
    ├── server/                     # 配置、路由、中间件、仓储、影刀与同步服务
    ├── storage/
    │   ├── migrations/             # 001-010 有序数据库迁移
    │   ├── migrate.cjs             # migration runner
    │   ├── seedDevUsers.cjs        # 开发用户 seed
    │   ├── importLegacyTasks.cjs   # 旧 CSV/JSON 无覆盖导入
    │   ├── backfillLegacyTask.cjs  # 历史任务所有者/绑定/审计原子补齐
    │   └── schema.sql              # psql 原子快照入口
    ├── src/
    │   ├── router.js               # /login、/schedule、/my-tasks
    │   ├── pages/                   # 登录、全员任务、个人任务页
    │   ├── stores/taskDraftStore.js # mutation 草稿与保存状态
    │   └── services/                # 会话、任务、影刀 API 客户端
    └── test/                        # 后端、数据库、同步和前端测试
```
