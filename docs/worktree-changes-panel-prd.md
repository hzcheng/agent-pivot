# Worktree Changes Panel（会话内改动查看）PRD

日期：2026-08-17（v3，第二轮 subagent 产品评审后修订）；2026-08-22（v4 并入 Part II；v4.1 吸收 owner 评审修订）

状态：v1 经五轮批注闭环；v2 吸收第一轮评审（双层模型、SCM 口径、baseline 契约、解析路径）；v3 吸收第二轮评审，修正五个实现前必须修复项（净结果语义、baseline 捕获事务、聚合完整性三态、解析顺序、刷新正确性）并砍减 P0 范围。**v3 P0 已上线；Part I（§0–§9）现为 Current shipped contract（现状真源），§9 的 P0/P1/P2 为历史规划存档，条目去向以 §19/§20 为准。** 依赖的 worktree 组模型见 `docs/worktree-tasks-prd.md`。

v4（2026-08-22）：新增 **Part II（§10–§19）**——v2 功能代际增量：两行式 member 头部、‹ › 循环切换、Collapse/Expand All、Commits 子 tab、vs upstream 标识。四项关键口径经 owner 当面确认 + 产品/可用性/技术三路评审 + owner 评审修订（决策记录 §20 追加三轮，冲突时以后轮为准）。**Part I（§0–§9）内容不变**，仍描述已上线行为与 v3 纪律；Part II 未明确修改的行为，一律以 Part I 及"v3 后体验迭代"为准。命名说明：Part II 的 "v2" 指面板的**功能代际**，Part I 的 "v3" 指本 PRD 的修订轮次，两者不冲突。实施拆解（工作项、commit 切分、验证矩阵）见 `docs/worktree-changes-panel-v2-plan.md`。

## 0. 核心产品承诺

本方案收敛为四句话，后续所有章节都是展开；任何实现决策与这四句冲突时，以这四句为准：

1. **改动信息属于 AI Conversation 视图，不进 open tab 卡片。** 入口是 telemetry 条的 Changes 按钮，详情是右侧边栏的 Changes tab。
2. **面板呈现"相对 task 起点的当前净结果"（Task result）及其中"当前未提交的子集"（Working changes）。** 两者是包含关系而非并列关系；Task result 是 `baseline → 当前工作树` 的净差异，不承诺还原"历史上碰过的所有文件"。
3. **Working changes 的状态字母与点击行为对齐 VS Code Source Control。** 数据分类四类（Merge / Staged / Changes / Untracked），UI 分组三组——Untracked 并入 Changes 组、行内以 `U` 徽标区分（见 §5.3 与“v3 后体验迭代”）；Task result 是本产品自有的视角，不承诺与 SCM 角标数字一致；未知状态显式标注，绝不把未知显示为 0。
4. **面板只读。** 暂存、提交、回滚仍在 Source Control 完成；本面板回答"这个 task 现在变成了什么样、要不要去看"，并提供一键深入（diff / multi-diff / SCM）。

## 1. 背景

Worktree 组模型上线后，一个 task（组）对应一到多个物理 worktree，agent session 在组内写代码。当前用户要知道"这个 session 的 task 改了什么"，唯一路径是记住 worktree 路径、打开对应窗口、看 Source Control——三个断点：

1. **conversation 视图内零信号。** 正在对话时完全看不到 agent 落盘的进展（改了几文件、几个 commit）。
2. **跳转成本高。** 需要离开当前窗口，打断"监控多个 session"的核心场景。
3. **Source Control 的排版不满足监控视角。** 它面向编辑设计：仓库平铺、无 task 层级、无"相对 task 起点"的视角。用户原话："source control 如果能排版好一些，完全满足我的要求，但是它的排版不好"。

已确认的用户数据假设（沿用 worktree-tasks PRD）：跨仓库工作集是少数，多数组只动一个仓库。

### 1.1 两轮评审修订概要

- v1 → v2：单层 Working changes 会把"agent 已提交完成工作"误表达为"No changes"，引入双层；SCM 对齐承诺收敛；补 baseline 字段与权威解析。
- v2 → v3：双层实为包含关系（净结果 ⊃ 未提交子集），文案与聚合口径按此重写；baseline 补捕获事务与失败补偿；聚合引入完整性三态；解析顺序补 retired 环节；刷新模型换成可证明正确的事件驱动方案；P0 范围砍半。

## 2. 目标

- 在 conversation 视图内一眼回答：**这个 task 相对起点变成了什么样 → 其中还有什么没提交 → 要不要介入看细节**。
- 与 telemetry 条现有按钮（position / comments / subagents）的交互同构，不引入新的 UI 范式。
- Working changes 与 SCM 面板并列使用时状态语义不打架；Task result 提供 SCM 没有的 task 起点视角。
- 单仓库窗口下信息密度与操作路径不退化。

## 3. 非目标与已知限制

- 不做暂存、提交、discard、回滚等任何写操作；面板永远只读。
- 不做跨 session / 跨组的改动聚合视图；面板严格跟随当前打开的 session；**跨 member 统一 Review all 不在 P0**（§5.3）。
- 不做自研 diff 渲染增强；单文件 diff 与 Review 均复用 VS Code 原生 diff / multi-diff editor。
- 不做 SCM provider（不把 task 改动注入 Source Control 面板）；不展示 stash、不展示 base 分支自身的提交列表。
- 不归因：Task result 包含 setup 脚本、用户、agent 产生的全部变化，产品口径是"这个 task worktree 的变化"，**不是"可归因于 agent 的变化"**。
- **已知限制：worktree 已被物理删除的 retired session 无改动数据**，面板降级为提示态（§7.3）。
- **已知限制：Adopt / 历史 worktree 无法证明 task 起点**时，Task result 显示 "Baseline unavailable"，不用猜测值冒充（§4.3）；未来可提供显式"选择 baseline"能力，不在 P0。

## 4. 核心概念与数据模型

### 4.1 session → 改动集合的权威解析（v3 修正顺序）

权威解析规则（验收标准，顺序不可交换）：

1. 遥测报告的最新工作目录经 `ConversationWorktreeResolver` 解析为有效 `worktreeKey` 时，它代表 conversation 当前正在操作的 worktree，优先用于本次 Git 视图；初始 identity 解析期间收到的该遥测必须在激活后重放。
2. 遥测目录缺失、不是 Git worktree 或解析失败时，读取 session 持久化的 `worktreeKey`（runtime binding / hydration 结果）作为稳定回退身份。
3. 用上述 key 查当前 manifest：命中则改动集合 = 该组全部 `ready` member（`worktreeKey` 存在者），并默认显示该 key 对应的 member。
4. manifest 未命中 → 查 **retired identity**（含 generation 判断）：命中则走 retired 降级（§7.3）。
5. 无持久化身份时，用 session 初始 `cwd` 经 `ConversationWorktreeResolver` 做 live fallback：解析出则走**退化单 member 视图**。
6. 以上皆无（非 git 会话）：按钮 `hidden`。

跨平台与键值契约（实现前必须修复的现存缺陷）：

- `ConversationWorktreeResolver` 当前只接受 `/` 开头路径，须支持 Windows 绝对路径；
- resolver 必须返回完整 `WorktreeKey`（`repositoryKey` = canonical common git dir，与 manifest 键同源；`canonicalWorktreePath` 规范化），其现返回值 `repoRoot = dirname(commonDir)` 与 manifest 键不一致，不能直接用于比对。

组被 Merge / Adopt 后，历史 session 跟随其 worktreeKey 当前所属的组（与 Worktrees 面板同一权威来源）；此时面板定位为"**当前 task group 的现状**"，不暗示"这个 session 当时写了什么"。

### 4.2 baseline 数据契约与捕获事务（v3 重写，P0 前置）

每个 member 持久化结构化 baseline：

```ts
interface MemberBaseline {
  commitSha: string;           // 冻结的 base commit SHA
  capturedAt: number;
  source:
    | { kind: 'branch'; fullRef: string }   // fully-qualified,可前进
    | { kind: 'tag'; fullRef: string }      // 固定起点
    | { kind: 'commit' };                   // detached,无可移动 base
}
```

捕获事务（与 provisioning 顺序绑定）：

1. 创建确认时先解析 `baseRef^{commit}` 得到精确 SHA；annotated tag 解到 commit。
2. **在任何物理副作用前**，将 SHA 与 provisioning intent 一起持久化。
3. `git worktree add` 使用冻结的 SHA，不使用可能继续移动的短分支名。
4. worktree 创建后、setup 前校验 `HEAD === baseline.commitSha`。
5. baseline 与 `worktreeKey` 一起 checkpoint；member 进入 `ready` 不得丢失已捕获的 baseline。
6. SHA 解析或 intent 持久化失败：**不开始创建**。
7. worktree 已创建但后续持久化失败：进入 retryable partial，**禁止用当前 HEAD 反猜 baseline**。
8. recovery 记录也丢失：worktree 保留可用，永久标记 `baselineUnavailable: 'capture-failed'`；不阻塞使用，不伪造起点。

source 语义：

- branch：保存 fully-qualified ref；base-moved / behind（P1）以此为据。
- tag：固定起点；tag 被强制移动时仅提示 source changed，不用 branch 的 behind 文案。
- commit（detached）：无可移动 base，永不展示 behind / base moved。
- Adopt / 存量 member：无可靠起点，baseline 缺省，Task result 层降级（§3）。
- 刷新时校验 `merge-base --is-ancestor baseline HEAD`；失败即 "History rewritten"，不给出貌似精确的数字；切到无关历史的 branch 同样处理。
- Merge group 后每个 member 保留各自 baseline，聚合文案只能是 "since each worktree baseline"。

### 4.3 MemberChangeSummary 与聚合完整性（v3 新增三态）

单 member 状态机：

```ts
type MemberAvailability =
  | 'available'            // 可读且 baseline 有效
  | 'baselineUnavailable'  // 可读但无 baseline(Adopt/存量/capture-failed)
  | 'historyRewritten'     // baseline 不再是 HEAD 祖先
  | 'unreadable';          // 物理缺失/unsafe/git 不可用
```

跨 member 聚合完整性：

```ts
type AggregateCompleteness = 'complete' | 'partial' | 'unavailable';
```

按钮与 tooltip 的展示规则（未知 ≠ 0）：

| 场景 | 按钮 | tooltip 说明 |
| --- | --- | --- |
| 完整 | `3 · ↑2` | 常规逐 member 分解 |
| ahead 部分未知 | `3 · ↑?` | `2 commits known; baseline unavailable for 1 repository` |
| working 部分不可读 | `3+ · ↑2` | 标注 partial 与不可读 member 数 |
| baseline 全部不可用、working 可读 | `3 · ↑—` | Task result 层整体降级 |
| 全部不可读 / retired | 禁用态 | 说明原因，不显示 0 |

单 member 采集字段：

| 字段 | 含义 | 采集方式 |
| --- | --- | --- |
| `workingItemCount` | 四组 SCM resource 行数之和（同文件 staged+unstaged 计两项） | 自采集 `git status --porcelain=v1 -z --untracked-files=all` 按 XY 列分类 |
| `workingFileCount`（可选） | 按路径去重的真实文件数 | 同上推导 |
| `aheadCount` | 相对 `baseline.commitSha` 的 commit 数 | `git rev-list --count <baseline>..HEAD`；文案为 "branch history since baseline" |
| `taskFilesCount` | Task result 净文件数 | `git diff --name-only <baseline>` 与 working tree 变化的并集计数（详情采集时） |
| `behindCount`（P1） | 相对 `baseRef` 当前位置落后数（仅 source=branch） | `git rev-list --count HEAD..<baseRef>` |
| `lastCommit`（P1） | HEAD subject + 时间戳 | `git log -1 --format=%s%n%ct` |

术语纪律：按钮可用 item count，但 tooltip 必须写 "N uncommitted changes"，**禁止写 "N files"** 指代未提交项。

详情级（懒加载，仅当前选中 member）：`workingFiles[]`（四组文件行，porcelain `-z` 解析保证空格/换行路径与 rename 正确）与 `taskFiles[]`（`git diff --numstat <baseline>` ∪ untracked）。

untracked 口径：面板**自采集**且固定 `--untracked-files=all`，不跟随 `git.untrackedChanges` 配置——保证"固定单独成组"承诺与用户 SCM 配置无关。Git API 的用途是事件订阅与 diff/SCM 衔接（§5.4），不作为四组数据真源（避免配置差异）。

### 4.4 按钮数字口径

- 双维度：`<workingItemCount聚合> · ↑<ahead聚合>`，按 §4.3 完整性规则降级为 `?` / `+` / `—`。
- working tree 干净但有提交：`0 · ↑2`，**绝不只显示 `0`**。
- 全干净：`0 · ↑0`，不隐藏（空间稳定性）；是否长期显示 `0 · ↑0` 由 §8 使用数据验证。
- 数字为全 member 聚合；面板内切换 member 不改变按钮数字。

## 5. 产品行为

### 5.1 入口：telemetry 条 Changes 按钮

位置：telemetry 条右侧按钮组，与 position / comments / subagents 并列（验收以名称与稳定标识为准，不依赖序号）。样式、尺寸、tooltip 机制（`conversation-telemetry-tooltip`）、`aria-pressed` 切换行为与现有按钮完全一致。

- **图标**：git branch 图标。与 telemetry 左侧已有 worktree 按钮（表示"我在哪"）职责区分；左侧按钮 tooltip 收敛为位置描述，去掉 "Click to show changes" 引导。
- **数字**：口径见 §4.4；aria-label 完整读出单位与 partial 状态（如 "3 uncommitted changes, 2 commits since baseline; 1 repository unreadable"）。
- **降级**：非 git 会话隐藏；部分 member 不可读时按钮保持可用并按 §4.3 标注；全部不可读 / retired 才禁用，不显示 0。
- **点击**：打开/聚焦右侧边栏并选中 Changes tab；`aria-pressed` 跟随。
- **可访问性**：tooltip 内容键盘可达；计数变化的 live-region 通知在 P1。

### 5.2 按钮 hover tooltip（多行）

```
Task result · 5 files, 2 commits since each worktree baseline
Uncommitted · 3 changes
api (fix-login) · 2 uncommitted · ↑2
web (fix-login-ui) · 1 uncommitted · ↑0
Base main has moved · ↓1 behind        ← P1
Last commit: "fix: token refresh race" · 2h ago   ← P1
```

单 member 时省略逐 member 行；partial 场景按 §4.3 表格追加说明行。

### 5.3 Changes 侧边栏面板

作为右侧边栏的一个 tab（与 outline / comments / subagents 并列），复用现有 tab 框架（`data-sidebar-tab`、面板状态持久化、resizer）。两层按**包含关系**呈现（v3 修正）：

```
┌─ Changes ─────────────────────────────┐
│ [api · ⎇ fix-login · 3 · ↑2      ▾]  │ ← member 下拉选择框
│ 3 changes in 2 other repositories     │ ← 多 member 聚合提示(仅部分场景)
│ ───────────────────────────────────── │
│ Task result compared with start       │
│   5 files · 2 commits                 │
│   Includes committed and uncommitted  │
│   [Review this repository]            │ ← 选中 member 的 baseline→工作树 multi-diff
│ Uncommitted now · 3 changes           │
│ ▾ Changes                             │
│    M  src/auth/login.ts               │
│    M  src/auth/session.ts             │
│ ▸ Staged Changes                      │
│ ▸ Merge Changes                       │
│ ▾ Untracked Changes                   │
│    U  src/auth/login.test.ts          │
│ ───────────────────────────────────── │
│ ● "fix: token refresh race" · 2h ago  │ ← P1
│ [Open this worktree in Source Control]│
└───────────────────────────────────────┘
```

行为明细：

- **member 下拉选择框**：每次只选一个 member。选项文案 = `repo · branch · <workingItemCount> · ↑<aheadCount>`。单 member 退化为只读标题。P0 默认选中 = 上次选择可用则恢复，否则 primary member；智能优先级（conflict → 有改动 → 有 ahead）与按 session 持久化的完整版在 P1。
- **跨 member 提示**：按钮聚合与当前 member 不一致时，面板顶部显示 "N changes in M other repositories"；"跳到下一个有改动的仓库"导航在 P1。
- **Task result 层**：选中 member 的净结果摘要（`N files · M commits`，注明 "Includes committed and uncommitted changes"）+ **Review this repository**（打开 baseline → 当前工作树的原生 multi-diff，经 `vscode.changes` 命令；capability 缺失时 fallback 为逐文件 diff 列表）。跨 member 统一 Review all 在 P1。baseline 缺失 / 历史改写时整层显示 "Baseline unavailable" / "History rewritten"。
- **Working changes 层**：固定组序 Merge → Staged → Changes（Untracked 并入 Changes——行级 U 徽标已承载区分，不再单列组头）；空组折叠不渲染。目录树对齐 Source Control 的压缩行为：只含单子目录且无直属文件的目录链合并为一行（`a/b/c`），折叠状态锚定链尾目录。
- **文件点击行为矩阵**（P0 验收标准）：
  | 状态 | 点击行为 |
  | --- | --- |
  | unstaged（Changes 组） | diff editor：`index ↔ working tree` |
  | staged（Staged 组） | diff editor：`HEAD ↔ index` |
  | 同一文件 staged + unstaged | 两行分别出现，各开各的 diff |
  | untracked | 直接打开文件（对齐 SCM，非空白 diff） |
  | conflict（Merge 组） | 打开与 SCM 相同的冲突入口（merge editor） |
  | rename | 显示 `old → new` |
  | deleted | 对齐 SCM 的删除 diff |
  | binary / submodule（P1） | P0 无法原生 diff 时明确跳 SCM；精细展示在 P1 |
  | 点击瞬间文件已消失 | toast 提示并触发刷新，不报错弹窗 |
- **点击文件一律在当前窗口打开，不跳窗口**。
- **Open this worktree in Source Control**：面板底部常驻按钮，在当前窗口经 Git API 打开该 worktree 仓库并聚焦 SCM 面板；不承诺精确 reveal 到该 repository（现有实现约束），不定义跨窗口聚焦。
- **空态**：选中 member 无 working 且无 task result 时显示 "No changes"，面板不隐藏。
- **last commit 行（P1）**：HEAD subject + 相对时间。

### 5.4 刷新策略（v3 重写：正确性优先）

P0 采用可证明正确的事件驱动方案，自定义 watcher 优化后置：

- **主通道**：订阅 VS Code Git API `Repository.state.onDidChange`（覆盖 commit、stage、工作区文件编辑等全部状态变化）。
- **强制刷新时机**：面板首次打开、重新获得可见性、切换 session 时。
- **手动 Refresh**：面板右上角常驻。
- **无 Git API 可用的 fallback**：短 TTL 缓存 + 面板可见时到期刷新（不是"仅失效才刷"）。
- **P1 优化**：自建 common git dir / worktree watcher（注意 linked worktree 的 `.git` 是文件，真实 HEAD/index 在 common dir 下，须 `git rev-parse --git-common-dir` 解析）、working/HEAD/base 分类缓存失效、精细 Stale 状态机。
- **保护**：git 命令超时、取消旧请求、session 切换丢弃在途结果；status 行数硬上限（超出提示 "Too many changes · open in Source Control"，精细截断 UI 在 P1）。
- **面板状态**：P0 为 Loading / Partial / Error 三态；Stale 时间戳等精细状态在 P1。刷新不抢焦点。

## 6. 边界与降级

### 6.1 非组 session

历史 session / unmanaged worktree 走 §4.1 第 4 步的退化单 member 视图：按钮正常显示，下拉为只读单项；baseline 通常缺省，Task result 层按 §4.2 降级。

### 6.2 单仓库窗口

改动集合恒为单 member，下拉退化为只读标题，其余行为不变。

### 6.3 Retired / 失败 / 工作区外 member

- `failed` / `deleting` member 不出现在下拉里，也不计入聚合。
- **`detached`（仓库在工作区外但物理可读）member 保留在集合中**，下拉标注 "Outside workspace"，状态/diff 只读可用；不可读时按 unreadable 计入 partial（§4.3），不静默从聚合中删除。
- 部分 member 不可读：其余 member 正常使用，按钮/面板标注 partial；全部不可读 / retired：按钮禁用态，面板显示 retired 提示，查看对话不受影响。
- repo unsafe / git 不可用：Working 与 Task result **分别**降级，不统一当作 "0 changes"。

## 7. 侧边栏宽度与可读性

现有侧边栏默认 240px（范围 192–420px）。P0：文件路径中间省略、hover 显示全路径、长列表按路径排序；Review this repository multi-diff 承担批量审阅主路径。P1：Changes tab 首开推荐加宽（约 320px）、宽度按 tab 记忆、目录折叠与搜索。

## 8. 成功指标

只采集计数与动作，不记录仓库名、分支名、文件路径：

- 从打开 Conversation 到定位首个改动文件的中位时间；
- 无需跳转 SCM 即完成"这个 task 改了什么"判断的比例（弱代理，后续结合 diff 点击、停留与会话关闭行为修订）；
- Changes → 单文件 diff、Changes → Review、Changes → SCM 的点击率；
- 刷新 P95 延迟、Partial / Error 态占比；
- `0 · ↑0` 长期占位是否值得保留的使用数据。

## 9. 里程碑切分（v3 历史规划 · 存档）

> P0 已上线；本节 P1/P2 为历史规划存档，各条目去向（提前至 Part II / 保留 P1 / 取消）以 §19 里程碑与 §20 决策记录为准。

- **P0 前置（数据契约）**：`MemberBaseline` 持久化 + 捕获事务（§4.2）；session→group 权威解析（§4.1，含 resolver 的 Windows 路径与完整 WorktreeKey 修复）。
- **P0**：完整性三态聚合；telemetry Changes 按钮（双维度 + partial 标注 + 准确 tooltip）；基础 member selector（默认=上次选择或 primary）；Task result 摘要 + Review this repository（含 capability fallback）；Working 四组（自采集 porcelain `-z -uall`）；文件点击矩阵的常见项；Git API 事件 + 打开/可见/切换强制刷新 + 手动 Refresh；Loading/Partial/Error 三态；Open this worktree in Source Control；基础键盘/焦点/ARIA。
- **P1**：behind / base-moved（仅 branch source）、last commit、commit 列表；增删行数（numstat）；智能默认选择五级优先级 + 按 session 持久化；tab 独立宽度与首开加宽；自建 watcher + 分类失效 + 精细 Stale 状态机；live-region 计数通知；binary/submodule 精细展示；Too many changes 精细截断；跨仓库统一 Review all、next-member 导航、目录折叠与搜索。
- **P2**：保守 merged 检测（文案限 "HEAD is contained in base" / "Base has moved" / Unknown，**不推断 squash merged**；"可清理"仅在删除预检确认干净、无活动 session、无阻断项后出现）；与 worktree 清理流程联动；展示偏好设置；Adopt member 的显式"选择 baseline"能力。

### v3 后体验迭代（2026-08-17，dogfooding 反馈）

| 决策点 | 结论 |
| --- | --- |
| worktree telemetry 芯片 | 删除。其"我在哪"职责由 Changes 按钮 tooltip（路径）与面板 member 下拉（title 显示完整路径）承担；"Open in Source Control" 在 Changes 工具栏的图标按钮上 |
| 侧边栏 tab 行 | 删除。telemetry 右侧四个按钮即视图切换器；面板打开且对应该视图时按钮显示 pressed 背景；Escape 仅在焦点位于面板内时关闭 |
| 按钮数字格式 | 只保留裸数字 `4 · 2`（无 ↑ 箭头、无 — 减号）；ahead 未知显示 `?`；retired 不显示数字 |
| retired 按钮 | 保持可点击（样式区分），否则用户无法打开面板看到删除说明 |
| 文件列表 | 按目录的 tree view（对齐 SCM view as tree），行内只显示 basename，hover 显示完整路径 |
| diff 协议 bug | open-file 的 porcelain XY 校验曾拒绝带空格的 ' M'/'M '（最常见状态）导致点击静默失败；已修复并锁定全部 XY 形态 |

---

# Part II · v2 功能代际（成员导航 · 折叠控制 · 提交历史）

日期：2026-08-22（v2.2，经三路评审 + owner 评审修订）

状态：四项关键口径已经 owner 当面确认（§20 第一轮）；三路评审 + owner 评审修订已吸收（§20 第二、三轮）。

Part II 是 Part I 的增量增强；凡 Part II 未明确修改的行为，一律以 Part I 及"v3 后体验迭代"为准。设计素材回收自会话 `01a00960` 的未实施设计稿，并补上该稿缺失的 Collapse/Expand All。

## 10. 核心产品承诺（Part II）

1. **Task 视角优先于仓库考古视角。** Commits 子 tab 默认口径 `baseline..HEAD`（Since start），其计数与**同一 member** 的 Files tab 摘要行 commits 数同源同数；多 member 时 telemetry 按钮数字为**全 member 聚合值**（Part I §4.4），逐 member 分解见按钮 tooltip 与各 tab 摘要行——三处数字各有明确归属，绝不互相冒充。
2. **每个数字都有明确参考系且可解释。** baseline（task 起点）、upstream（远端跟踪分支）、base 分支是三个不同参考系，绝不混排；未知 ≠ 0，降级显式标注（沿用 Part I 纪律）。
3. **导航效率可验收。** 相邻 member 切换 1 次点击；任意 member ≤ 2 次点击（‹ › 循环或下拉直达）；commit 的文件改动在 Commits tab 内 ≤ 2 次点击（展开 → 点文件），从 Files tab 出发 ≤ 3 次（切 tab → 展开 → 点文件）。
4. **面板只读。** 不新增任何写操作（含 push/fetch/commit/revert/cherry-pick）；深度操作仍交还 Source Control 与用户自装的 Git Graph / GitLens。

## 11. 背景：四个可复现的痛点（Part II）

2026-08-22 owner 反馈的四个痛点，根因均已代码核实：

| # | 痛点 | 根因（现状实现） |
| --- | --- | --- |
| P1 | 看不到完整分支名 | 第一行是原生 `<select>`，`repo · ⎇ branch` 单行挤压；侧边栏默认 240px 下截断后只剩 repo 名；tooltip 只给 worktree 路径 |
| P2 | 多仓库切换繁琐 | 唯一切换手段是下拉：点开 → 扫描 → 点选，≥2 次点击 + 视觉扫描 |
| P3 | 无法一键合上/展开全部改动 | 折叠能力只到单目录行；组头（Merge/Staged/Changes）是纯文本 `<div>` 不可折叠；无全局折叠 |
| P4 | 看不到提交记录及每个提交的文件改动 | 数据层只有 `rev-list --count`（数量），无任何 `git log` 能力；无 commit 视图 |

会话 `01a00960`（2026-08-19）已就 P1/P2/P4 形成完整设计稿但未实施，Part II 整体回收该稿并修订；P3 为该稿缺失项，本文新设计（§15.3）。

## 12. 目标（Part II）

- 分支名在任何面板宽度下可辨认：独占一行 + 中间省略 + tooltip 给全名。
- 相邻 member 切换一次点击完成，当前位置 `(i/n)` 始终可见。
- 一键把文件树合到组头 / 全部展开。
- 在面板内查看**当前分支中自 task start 以来保留下来的提交**及每个提交的文件变化：commit 列表 → 单个 commit 的文件级改动 → 原生 diff / multi-diff，全程不跳窗口。能力边界：`baseline..HEAD` 只展示当前 HEAD 可达的提交，**不还原**被 squash / amend / rebase 丢弃的历史，也不覆盖未提交过程。
- 不破坏 Part I 已上线的任何行为（分组、点击矩阵、Review、刷新策略、降级文案、Open in Source Control 出口）。

## 13. 非目标（Part II）

- 不做 graph 自研渲染；不做 commit 级写操作（cherry-pick / revert / checkout / reset）。
- 不做 push / fetch / pull 按钮；tracking 标识仅展示，不可点击触发任何写操作；数字反映**本地 remote-tracking refs 的状态**（不主动 fetch，tooltip 注明）。
- **不持久化 task branch 的发布目标**，因此不给 pushed / not pushed 结论——只陈述 tracking 事实（§14.1）。
- 不做 base 分支 moved / behind 标识（Part I P1 顺延，见 §20 第二轮决策）。
- 不做"正在写入"live 脉冲标识（P1）。
- 不做 commit 搜索 / 过滤 / 多选 diff（P1 评估）。
- Commits 子 tab 不提供跨 member 聚合视图；严格跟随当前选中 member。

## 14. 核心概念与数据模型（Part II）

### 14.1 三个参考系与标识口径（验收标准）

标识统一为**两行明确语言**——不用 `↑`/`⇡` 箭头符号区分参考系（双箭头要求用户记忆符号语义，且在 192–240px 宽度下必然截断）：

| 文案 | 参考系 | 语义 | 数据来源 | 降级 |
| --- | --- | --- | --- | --- |
| `Since start · N files · M commits`（Files 摘要区第一行）/ `Since start · M commits`（Commits 标题区第一行） | baseline（冻结 SHA） | 自 task 起点以来的净文件数与 commit 数（已有口径） | `rev-list --count baseline..HEAD` 等 | Part I 完整性三态沿用 |
| `Tracking <upstream> · N ahead · M behind`（摘要区第二行） | upstream（远端跟踪分支） | 本地与 tracking branch 的分叉计数 | 事实查询链（四命令，§14.1 附注） | 无 tracking → `No tracking branch`；采集失败 → `Tracking unknown` |
| `No tracking branch` | — | 分支未设置跟踪分支（agent worktree 分支的常态） | upstream 配置查询成功但为空 | 本身即事实陈述态 |

纪律：

- **只陈述 tracking 事实，不给 pushed / not pushed 结论。** 无 tracking branch ≠ 从未推送；commit 不在当前 upstream ≠ 未推送到其他 branch / remote；upstream 甚至可能指向 `origin/main` 而非 task branch 的远端副本。除非持久化"task branch 发布目标"（非目标，§13），禁止任何 pushed 语义文案。
- 分叉计数照常显示 `0 ahead · 0 behind`（空间稳定纪律，与 Part I `0 · ↑0` 一致）。
- `<upstream>` 显示实际解析出的短名（如 `origin/fix-x`；fork / 多 remote 场景不写死 origin）；tooltip（§17 可聚焦机制）给完整 ref + "Based on local remote-tracking refs; no fetch was performed"。
- 标识**显示在各 tab 的摘要区**（§15.4/§15.5），与同一参考系的数字同处，不单独占头部行。
- 采集挂在现有 member 采集链路上；upstream 采集失败独立降级，不影响 baseline 数字。

附注（三态采集链，`rev-parse @{upstream}` 失败无法区分 none/unknown，不可用）：① `git symbolic-ref -q HEAD` 取当前分支 ref（空 = detached HEAD → `none`）；② `git for-each-ref --format=%(upstream) <branchRef>`——**成功且为空 = `none`，命令失败/超时 = `unknown`**；③ 有 upstream 时 `git rev-parse HEAD <fullRef>`（单进程取 headSha + upstream sha）；无 upstream（none/unknown）时单独 `git rev-parse HEAD`——失效签名对无 tracking 的 member 也需要 HEAD（§14.3 第 2 条）；④ `git rev-list --left-right --count <fullRef>...HEAD`（**左数 = behind，右数 = ahead**，实现别写反）。③④ 失败同样归 `unknown`。每 member 新增 ≤4 个 git 进程。

### 14.2 Member 顺序与位置指示（验收标准）

- ‹ › 循环顺序 = **manifest member 固定顺序**（仅 `state === 'ready'` 且有 `worktreeKey` 者，与 Part I §6.3 一致；detached member 保留在序列中并标注 Outside workspace）。`filter` 保持 manifest 数组顺序、消息序列化保序、webview 不重排——webview 端持有的 members 数组顺序即 manifest 顺序。
- 顺序在**两次刷新之间**稳定；手动/事件刷新会按新 manifest 重解析（add-repo、组合并后顺序可变），切换逻辑始终按最新数组计算，不缓存下标。
- unmanaged 兜底会话产生单个 `unmanaged-<hash>` 合成 member，‹ › 与 `(i/n)` 本就隐藏，不受影响。
- 位置指示 `(i/n)` 在 n>1 时恒显；到达端点循环回转（末位按 › 回到首位），`aria-live` 报读 "api, 2 of 3"。
- 默认选中沿用 Part I（上次选择可用则恢复，否则 primary）；‹ › 切换与下拉选择完全等价，复用同一 `changes-select` 消息与 `lastSelectionBySession` 记忆——webview 侧已持有完整有序 members 列表，自行算出目标 memberId 后发既有消息，**协议无需新增 next/prev 命令**。

### 14.3 Commit 数据契约（新增）

Commits 数据**不走** Part I 的单一权威状态推送（`conversation-viewer-changes`），改为**请求/响应式懒加载**，避免加重常态刷新链路。

**消息集（四类；请求全部携带 `version: 1` + `requestId`，响应另带 `subscriptionGeneration` + `memberId` 并回传 `requestId`）**：

```
webview → host:
  conversation-viewer-commits-list      { version, requestId, memberId, scope: 'since-start' | 'full', offset, historyHead? }
  conversation-viewer-commit-detail     { version, requestId, memberId, sha }
  conversation-viewer-commit-open-file  { version, requestId, memberId, sha, path, oldPath? }
  conversation-viewer-commit-review     { version, requestId, memberId, sha }

host → webview:
  conversation-viewer-commits           { version, requestId, subscriptionGeneration, memberId, scope, offset, historyHead,
                                          commits: CommitSummary[], hasMore, sectionComplete?, baselineRow?, degraded? }
  conversation-viewer-commit-detail     { version, requestId, subscriptionGeneration, memberId, sha,
                                          files: CommitFile[], totalFiles, filesTruncated, degraded? }
```

- `requestId`：webview 生成的单调 id，同 member 同 scope 只认最新请求——**旧列表响应不得覆盖新刷新结果**（`subscriptionGeneration` 只覆盖跨 session，盖不住同 member 的新旧请求竞态）。
- `open-file` / `review` 为动作消息、无响应：host 先 `git cat-file -e <sha>` 验证，commit 已消失（rebase 改写）→ host 侧 toast "Commit no longer exists (history rewritten)" 并推送最新 changes-state（经失效签名比对自然触发重取）；diff/review 打开失败同样 host 侧 toast——与现有 `changes-open-file` 的静默失败处理同路径。

```ts
interface CommitSummary {
  sha: string;            // 全 SHA，UI 显示短 7 位
  subject: string;        // ≤1024 字符，超出 host 截断
  authorName: string;     // ≤256 字符；原样展示（不做 you/agent 映射——agent 与用户共用 git config，无可靠区分依据）
  authorTime: number;     // unix 秒，%at（author time，rebase 保留）
  inTrackingBranch?: boolean;  // 仅 tracking=tracked 时有值；undefined = 不显示行级徽标
}
interface CommitFile {
  path: string; oldPath?: string;   // ≤4096 字符；oldPath 仅 rename
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';
  additions?: number; deletions?: number;  // 非负整数 ≤1e7；binary 文件缺省（numstat 输出 '-'）
}
interface BaselineRow {
  sha: string;            // member baseline 冻结 SHA
  subject?: string;       // `git log -1 --format=%s <sha>` 采集；失败时缺省，UI 仅显示短 SHA
}
type CommitsDegraded =
  | 'unreadable'       // member 不可读
  | 'timeout'          // git 超时（5s）
  | 'history-moved'    // historyHead 与当前 HEAD 不一致（分页期间历史已变）
  | 'unknown-commit'   // sha 不存在（rebase 改写）
  | 'error';           // 其他 git 失败
```

**分页模型（消灭"空翻页"与"缺失中段"）：**

- **冻结历史头**：每个 scope 的第一页响应携带 `historyHead`（当时的 HEAD）；后续页请求必须回传同一 `historyHead`，host 比对当前 HEAD 不一致 → 响应 `degraded: 'history-moved'`，webview 丢弃已分页数据并回到该 scope 第一页（不展示陈旧列表）。
- **since-start 段**（baseline 有效）：范围 `<baseline>..<historyHead>`，页大小 50（`--max-count=51 --skip=<offset>`，多取 1 条判 `hasMore`）；最后一页 `sectionComplete: true` 并携带 `baselineRow`——**baseline 收尾行只在真实边界出现**，分页中途不渲染。
- **full（Earlier commits）段**：前置条件 = since-start 已 `sectionComplete`。范围 = **baseline 的祖先**（`git log <baselineSha>`；首条为 baseline 本身，webview 按 sha 去重跳过，因 baseline 行已渲染）——**直接从边界继续，不从 HEAD 翻页**，无空翻页、无缺失中段。
- **baseline 缺失 / 历史改写**：无分段，整 tab 为 `Current branch history` 单流（范围 = `historyHead` 分页），顶部保留 Baseline unavailable / History rewritten 说明条；无 Show full 按钮（列表本身即完整历史）。
- webview 按 sha 维护已渲染集合，跨页去重防御。

采集命令（实现锚点；以下均已经本仓库 git 2.51.1 实测验证）：

- since-start 页：`git log --no-decorate --format=%H%x00%s%x00%an%x00%at --max-count=51 --skip=<offset> <baseline>..<historyHead>`；Earlier 页：同式对 `<baselineSha>`（baseline 缺失时对 `<historyHead>`）；记录 `\n` 分隔、字段 NUL 分隔；**按新到旧排序**。
- **列表口径 = 完整可达 DAG**（不加 `--first-parent`）：与 aheadCount 的 `rev-list --count baseline..HEAD` 严格同口径，守住"同源同数"纪律；merge 合入的支线提交属于"自 baseline 以来进入该分支的提交"的事实陈述（task 分支常态为线性，merge flood 是边缘场景）。merge commit 行的文件明细永远按 first-parent（相对主线的净变化）。P1 评估：若 dogfooding 出现 merge flood 痛点，提供 first-parent 过滤视图。
- inTrackingBranch 集合：tracking=tracked 时 `rev-list @{upstream}..HEAD` 一次求"未进入 tracking"集合，逐 commit 回填 `inTrackingBranch`（集合外 = true）。
- commit 文件明细**必须拆两条命令**（一条命令同时给 `--name-status --numstat` 时 numstat 会被静默丢弃）：
  - `git diff-tree --no-commit-id -r -z -M --name-status <sha>`（root commit 加 `--root`；merge commit 改 `-m --first-parent`——单独 `--first-parent` 输出为空）
  - `git diff-tree --no-commit-id -r -z -M --numstat <sha>`（同上）
  - `-M` 不可省：diff-tree 是 plumbing，不适用 `diff.renames=true` 默认，无 `-M` 时 rename 输出为 D+A 两条。
  - rename 的 `-z` 字节格式为 `R100\0<oldPath>\0<newPath>\0`（**old 在前**，与 porcelain status `-z` 的 "to-path first" 正好相反，解析器别写反）。
- 超时口径与 changesCollector 一致：**5s**。

**失效与刷新纪律（验收标准——懒加载数据不得静默过期）：**

1. 行 3 的 `⟳` 同时重采 changes 快照与当前 member 的 commits 列表（两路独立降级）。
2. changes-state 推送到达时，比对**失效签名**——`HEAD sha`、`baseline sha / availability`、`upstream fullRef`、`upstream resolved sha`、`upstream ahead/behind` 任一分量变化 → 该 member 的 commits 缓存作废。**push / fetch / tracking 变更即使不改变 commit 列表，也会改变标题区分叉计数与行级 tracking 徽标**，必须覆盖（member 视图需携带上述字段，见 §14.4）；若 Commits tab 正在展示该 member，**静默重取**（不抢焦点、不清空展开状态以外的滚动位置；数据量小，直接重取而非"N new commits"提示条）。
3. 切换 member：Commits 区**立即清空并进入列表级 loading**，绝不残留上一 member 的列表（张冠李戴比空白更糟）；commits 缓存按 member 保留，切回时若未失效则即时渲染。
4. 所有 commits 响应纳入 **`requestId` + `subscriptionGeneration` 双重丢弃**：同 member 同 scope 仅最新 requestId 的响应生效；generation 覆盖 session / member 切换的在途请求（沿用 Part I 保护）。
5. webview 校验上限（与现状 validState 纪律一致，`exactKeys` 拒绝多余字段）：requestId `[A-Za-z0-9-]{1,64}`；sha / historyHead 为 40 位 hex；offset 为非负整数 ≤1e6；commits ≤200/响应（页大小 50，上限为防御值）；files ≤400 + totalFiles ≤1e6；scope / degraded / status 枚举白名单；subject ≤1024、authorName ≤256、path ≤4096。

### 14.4 协议与接线同步点（实现提示，已代码核实）

member 视图新增字段时同步 **3 处**：`types.ts`（`ConversationChangesMemberView`）→ `conversationChangesController.ts`（memberView）→ `conversationChangesScripts.js`（`validMember` 白名单，`exactKeys` 会拒绝多余字段导致整个 state 消息校验失败）。本次新增字段：`headSha?: string`（unreadable member 缺省）与 `upstream` **三态判别联合**：`{ status: 'tracked'; fullRef: string; sha: string; ahead: number; behind: number } | { status: 'none' } | { status: 'unknown' }`——`none` = 未设置 tracking（摘要区 `No tracking branch`），`unknown` = 采集失败（摘要区 `Tracking unknown`；未知 ≠ 事实陈述，§10 第 2 条），fullRef 经 `git rev-parse --symbolic-full-name @{upstream}` 采集；失效签名所需字段同源携带（§14.3 第 2 条）。`viewerProtocol.ts` 只校验 webview→host 消息，**仅在新增 commits 四类消息时涉及**。

隐性第 4 处：`src/webview/conversationChangesScripts.js` 与 `media/conversationChangesScripts.js` **字节级双份镜像**（WEBVIEW-ASSET-IDENTITY-001 强制），改一处不改另一处 CI 直接红。

完整接线面（新功能一次列全）：`viewerDocument.ts` 面板 markup → `media/conversationViewerScripts.js` 的 `changes.create({...})` 传 DOM 句柄 → `viewerProtocol.ts` 新消息校验（含 §14.3 上限）→ `viewer.ts` 分发 → `conversationChangesController.ts` 新方法 → 样式走 `media/conversationViewer.scss` 编译出 css（入库）→ 重写受影响的 `WORKTREE-CHANGES-PANEL-001` browser 测试（select 与组头断言）→ `docs/testing/behavior-contracts.json` 登记新行为。

## 15. 产品行为（Part II）

### 15.1 Member 头部：两行 + 子 tab 行

```
┌─ Changes ──────────────────────────────┐
│  ‹  [api ▾]                     (2/3) › │ ← 行 1：repo 行
│  [SCM] fix/harness-registry…nsumption 10↑ 34↓ │ ← 行 2：SCM 出口 + 分支及远端差异
│  2 more changes in web, infra · Go to web →  │ ← 跨 member 提示（条件渲染，可点击）
│  [ Files | Commits ]            ⌃  ⟳  ◉ │ ← 行 3：子 tab + 折叠、刷新、Review 图标（§15.3/§15.4）
```

- **行 1**：`‹` `›` 为图标按钮（chevron-left/right）。中间 repo 名的可实现形态 = **可见 label + 透明原生 `<select>` 覆盖层**（select 绝对定位覆盖 label、`opacity: 0`、宽 100%）——原生 select 的闭合文本就是 selected option 文本，CSS 无法让闭合态与 popup 用两套 label；覆盖层方案下：闭合态是自定义 DOM（repo 名 + `▾`，可自由截断/灰化），popup 是原生 option（键盘方向键 / type-ahead / Esc / listbox 语义与读屏能力保留，且不被面板 `overflow: hidden` 裁剪）。option 文案维持现行 `repo · ⎇ branch` 并**保留 `(outside workspace)` 后缀**（popup 内可预先辨认 detached member；计数按现行纪律活在 tooltip 与面板，不进选项文本）。
- **行 1 退化**：单 member 时 ‹ › 与 `(i/n)` 隐藏，**repo 名渲染为普通文本标题**而非 disabled select——禁用态的语义是"不可用"且会退出 Tab 序，与"静态标题"不符（改变现状行为，见 §20 第三轮）。多 member 才渲染 select。
- **行 2**：**Source Control 图标**（不用 `↗`——动作发生在当前窗口，`↗` 易被理解为外部打开）占据最左侧的操作位，后接分支名及相对其远端 tracking branch 的提交差（如 `10↑ 34↓`）；与行 1 的上一仓库按钮占位一致，使分支文字与 repo 文字对齐。分支名中间省略，差异计数固定在右侧可见；完整分支名、worktree 路径、tracking ref 与本地 remote-tracking 限制经 §17 tooltip overlay 展示（不依赖原生 `title`）。没有 tracking branch 或查询未知时不显示计数，更不伪造为 0；branchName 缺失（unmanaged 合成 member）时显示 `(no branch)`。
- **行 3 与标识条**：v2 草案曾有独立的第三行标识条，评审后与各 tab 摘要行合并（见 §15.4/§15.5）——`↑n since start` 与 Task result 行的 commits 数本是同一数字，同参考系的信息同行展示，头部省一整行。
- **行 3 的 Review**：Review 是与 Collapse/Expand All、Refresh 并列的图标按钮（eye）；不再在 Files 内容区保留常驻的 Task result / tracking 两行或文字按钮。hover 或键盘聚焦时，§17 tooltip overlay 展示 `Since start · N files · M commits`、净结果口径、tracking 全引用及其本地 remote-tracking 限制；没有可靠 baseline 或没有可 review 的变化时隐藏，避免出现无效入口。
- **跨 member 提示行**：从纯文本升级为**可点击**，文案直接说明动作与目标：`<N> more changes in <repo 列表> · Go to <目标 repo>`——现行 `+N in <repo 列表>` 只汇总量不说明点击目的，视觉承诺与实际动作不一致（Part I 文字稿的 "N changes in M other repositories" 从未实现，不采用）。repo 列表超过 2 个时截断为 `<a>, <b> +M more`，完整分解经 §17 tooltip 展示；**计数与跳转候选同一集合：`availability !== 'unreadable'` 的 readable member**（baselineUnavailable / historyRewritten 的 Working changes 仍可读，必须计入；unreadable 的状态由按钮 partial 标注承载）；计数 = 其他 readable member 的未提交改动 item 数之和；点击目标 = 固定顺序下一个 `workingItemCount > 0` 的 readable member；若改动全部来自当前 member 则不渲染（闭环 Part I P1 的 next-member 导航）。
- **detached 标注**：闭合态在行 1 label 旁的**独立小字元素** "Outside workspace"；popup option 文本同时保留 `(outside workspace)` 后缀（双承载：闭合态可见、popup 内其他 detached member 可预先辨认）。沿用 Part I §6.3 语义。
- **键盘与 ARIA**：详见 §17。

### 15.2 ‹ › 循环切换

- 顺序与默认选中见 §14.2；切换与子 tab **正交**：在 Commits tab 切 repo 即看另一个 repo 的提交，不弹回 Files。
- 每 member 的 UI 上下文（折叠态、滚动位置、Commits 展开项）在面板生命周期内独立记忆，来回切换不丢；commits **数据缓存**按 member 保留、按 §14.3 失效规则作废；`resetSession` 沿用现状清空。
- 切换不触发新增 git 采集（members 摘要已在聚合态里），但仍是一次完整 state 推送（含选中 member 的 detail items）——成本为"无新增 git 进程的状态推送"。
- `‹`/`›` 激活后**焦点驻留**，可连续 Enter 循环；切换后 `aria-live="polite"` 报读位置。

### 15.3 组头可折叠 + Collapse / Expand All（P3 新设计）

现状修正：组头（Merge / Staged / Changes）从纯文本升级为**可折叠按钮**（chevron + 标题 + 计数），这是 Collapse All 的前置能力。

- **组头行**：展开 `▾ Staged Changes · 2`，折叠 `▸ Staged Changes · 2`；计数恒显，口径为 **item 行数**（同文件 staged+unstaged 计 2，与 Part I `workingItemCount` 一致——防止误读为文件数）。空组不渲染（沿用 Part I）。
- **Collapse All**：当前 member 的所有目录 + 所有组头收起 → 只剩组头行列表，一屏看清改动分布。
- **Expand All**：所有组 + 所有目录展开。
- 行 3 右侧用一个切换式折叠按钮：存在展开项时为 Collapse all，全部收起时为 Expand all；图形采用与刷新按钮同色、同笔触的单 chevron，语义由 §17 可聚焦 tooltip（"Collapse all" / "Expand all"，键盘可达）与 `aria-label` 说明——二者分工、不互相替代，不依赖原生 `title`。
- **Commits tab** 复用同一按钮展开或收起已加载的 commit 行；没有已加载提交时禁用。Files tab 无改动空态同样禁用。
- 作用域 = 当前选中 member；折叠状态沿用内存态（`collapsedFolders` + 新增 `collapsedGroups`），不持久化，`resetSession` 清空——与现状纪律一致。
- ARIA：组头 button 带 `aria-expanded`。

### 15.4 子 tab 框架：Files | Commits

- **命名**：内层 tab 命名为 `Files | Commits`——外层 sidebar 视图已叫 "Changes"（telemetry 按钮），内层再叫 Changes 会形成"Changes 里的 Changes"两级同名，评审、测试、读屏报读三层都会绕。
- **定位说明**：这是**面板内二级分段控件**，是一个新范式——Part I 体验迭代删除的是侧边栏 tab 行（视图切换器上收到 telemetry 按钮），本子 tab 不构成该决策的回退。规格：`role="tablist"` + `role="tab"` + `aria-selected`，`←`/`→` 方向键切换 tab。
- 选中态持久化进 webview state（`conversationSidebar.changesSubTab`，新增键向后兼容），reload 后恢复；切 session 不重置（与 sidebar view 行为一致）。
- **Files tab** 内容 = Part I §5.3 的 Working changes 树；Task result 摘要、tracking 事实与 Review action 收敛至行 3 的 Review 图标 tooltip（§15.1），不再占用常驻面板高度。tooltip 保留 "Includes committed and uncommitted" 口径；tracking 按 §14.1 降级。

### 15.5 Commits 子 tab

```
│  [ Files | Commits ]                      │
│  ───────────────────────────────────────  │
│  ▾ ● a1b2c3d  fix: token refresh race     │
│      hzcheng · 2h ago                     │
│      M  src/auth/login.ts        +12 −3   │
│      M  src/auth/session.ts       +4 −1   │
│      [Review this commit]                 │
│  ▸ ● b2c3d4e  chore: setup script         │
│      hzcheng · 3h ago                     │
│  ○ c3d4e5f  (baseline) main · merged #241 │ ← 收尾行，不可展开
│  ───────────────────────────────────────  │
│  [Show full branch history]               │
```

行为明细（验收标准）：

1. **默认口径 Since start**（`<baseline>..<historyHead>`，完整可达 DAG，§14.3），按新到旧排序，**50 条/页分页**：范围未穷尽时底部 `Load more`，穷尽（`sectionComplete`）后才渲染 baseline 收尾行——未达真实边界不渲染（不暗示中间无遗漏）。`Since start · N files · M commits` 与 tracking 信息仅在行 3 的 Review tooltip 中出现（§15.1）；Commits 不重复渲染两行标题，列表直接开始。多 member 时 telemetry 按钮为聚合值，Review 为当前 member，二者参考系不同、不互相比对（§10 第 1 条）。
2. **commit 行**：chevron + tracking 徽标 + 短 SHA + subject（尾部省略）+ 第二行 `authorName · 相对时间`。**行级 tracking 徽标显示矩阵**（只陈述事实，§14.1 纪律；tooltip 用 §17 可聚焦机制）：
   | upstream | inTrackingBranch | 行级显示 |
   | --- | --- | --- |
   | 存在 | `false` | `●`（tooltip: "Not in tracking branch"） |
   | 存在 | `true` | `✓`（tooltip: "In tracking branch"） |
   | 缺失 | `undefined` | **不显示**（分支级 `No tracking branch` 已由标题区承载，逐行重复是噪音） |

   徽标为非聚焦元素，其语义**折叠进 commit 行的 `aria-label`**（如 "a1b2c3d, fix: token refresh race, not in tracking branch"），tooltip 随行级元素经 §17 机制展示——不依赖徽标自身可聚焦。
3. **点击 commit = 行内展开文件列表**（非跳转）：状态徽标 + basename（全路径经 §17 tooltip overlay 展示）+ `+a −d` numstat；再点收起。文件明细懒加载（§14.3），展开中显示行内 loading；单 commit 文件明细上限沿用 `MAX_DIFF_FILES = 400`：超出时响应带 `totalFiles` + `filesTruncated`，UI 显示 `Showing 400 of N files`——**Review this commit 同受此上限，不暗示 Review 能看到全部**；超大 commit 的完整审阅出口是 Source Control / 外部 Git 工具（§13 不做自研增强）。
4. **点击文件 = `parent ↔ commit` 原生 diff**（当前窗口打开，不跳窗；added/deleted 的空侧复用 Review 链路的 EMPTY_REF 模式）；merge commit 按 first parent；点击瞬间 commit 已消失（rebase 改写）→ toast 提示并触发刷新，不报错弹窗（沿用文件点击矩阵纪律）。
5. **Review this commit**：该 commit 的 multi-diff——**新增 `openCommitReview` 兄弟函数**（`openTaskResultReview` 的语义固定为 baseline→工作区，不能直接复用），共享其三样零件：`GitDiffContentProvider`（任意 ref 内容）、`vscode.changes` 三元组结构、capability fallback。
6. **baseline 收尾行**：空心 `○`、灰色、不可展开，文案 `(baseline) + subject`；**仅当 since-start 段分页到达真实边界（`sectionComplete`）时渲染**——让 Since start 的边界可见，避免"为什么只有 3 条"的疑惑；分页中途不渲染（不暗示中间无遗漏）。
7. **Show full branch history**：前置条件 = since-start 段已分页到边界（`sectionComplete`，baseline 行已渲染）。点击后在 baseline 收尾行下方追加 "Earlier commits" 段，**直接从 baseline 祖先继续分页**（不从 HEAD 翻页——无空翻页、无缺失中段，§14.3 分页模型）；分页按钮 `Load earlier commits`，加载中禁用 + 行内 spinner，防重复点击。baseline 缺失 / 历史改写时**无此按钮**（整 tab 即 `Current branch history` 单流）。**scope 恢复**：切 member 再切回，恢复该 member 的 scope（since-start / full）与滚动位置（§15.2 UI 上下文记忆），数据按 §14.3 失效纪律重取。
8. **空态**：无 ahead → "No commits since start" + baseline 行仍显示。
9. **降级**（`degraded` 枚举，§14.3）：`unreadable` → 整 tab 提示态且不影响 Files tab；`timeout` / `error` → Error 态 + 手动重试；`history-moved` → 丢弃已分页数据、回首行重取；`unknown-commit`（明细/打开时）→ host 侧 toast + 触发刷新（**不报错弹窗**，沿用文件点击矩阵纪律）；baseline 缺失 / 历史改写 → `Current branch history` 单流 + 顶部 Baseline unavailable / History rewritten 说明条（**不伪造 Since start 边界**，与第 7 条同一流程）。
10. **状态反馈（评审补充，验收标准）**：首次进入 = 列表级 loading；切 member = 立即清空 + loading（§14.3 第 3 条）；commit 明细加载失败 = 行内 "Failed · Retry"；列表重取不抢焦点。

### 15.6 宽度策略（P1 根因修复之一）

- Changes 视图**首开一次性推荐 320px**。现状 state 在任何持久化动作时都会写入 width=240，`Number.isFinite(saved.width)` 无法区分"系统自动保存的默认 240"与"用户明确拖到 240"——因此新增两个显式状态位：`widthUserResized: boolean`（新代码首次持久化时写 `false`，**仅在拖拽 handler 内置 `true`**）与 `changesWidthRecommendationApplied?: boolean`。规则：首次打开 Changes 视图时，若 `widthUserResized === false && changesWidthRecommendationApplied !== true` → 设为 320、持久化、置 applied=true；用户拖拽永久优先（不做"按 tab 记忆"——per-view 宽度会在每次切视图时引发主对话区 reflow 振荡，监控场景下是持续干扰；全视图共享单一宽度）。
- 存量用户（存档中 `widthUserResized` 为 undefined）视为已有布局偏好，**不触发推荐**、不迁移、不弹提示；首开推荐只对新代码下产生的 state 生效。
- 截断规范：分支名中间省略；repo 名尾部省略；commit subject 尾部省略；**所有截断处的全文必须经 §17 可聚焦 tooltip 可达**（键盘 / 读屏可靠，不依赖原生 `title`）。

## 16. 边界与降级汇总（Part II）

| 场景 | 行为 |
| --- | --- |
| 单 member（多数派场景） | ‹ › 与 `(i/n)` 隐藏、repo 名渲染为普通文本标题（非 disabled select，§15.1）；头部为行 1 标题 + 行 2 + 行 3 共三行——**记录决策：接受该垂直成本**，换取单/多仓库信息架构统一（行 2 分支恒可见对单仓库同样是 P1 修复） |
| detached member | 保留可切换，行 1 标注 Outside workspace；upstream 标识独立降级 |
| unmanaged 合成 member | 单 member 退化同上；branchName 缺失时行 2 显示 `(no branch)` |
| 无 tracking branch | Review tooltip 显示 `No tracking branch`；commit 行不显示徽标；**不推断"从未推送"**（§14.1 纪律） |
| tracking 指向不同名分支（如 origin/main） | Review tooltip 照常按事实显示 `Tracking origin/main · N ahead · M behind`——语义依然成立（"相对跟踪分支的分叉"） |
| upstream 分叉（diverged） | ahead / behind 双非零照常显示 |
| baseline 缺失 / 改写 | Commits 顶部保留降级说明条；full history 仍可用 |
| member unreadable | Files 沿用 Part I partial 标注；Commits tab 提示态 |
| retired session | 沿用 Part I retired 降级，查看对话不受影响 |
| git 命令失败 / 超时（5s） | Commits 区独立 Error 态 + 重试，不拖垮 Files tab |
| 面板极端窄（<240px） | 头部各行各自省略，不换行不溢出；子 tab 文字不压缩 |
| 多窗口同 workspace | 各窗口 webview state 与 host controller 天然独立，无须特殊处理 |

## 17. 视觉与交互规范（Part II，UI 摘要）

- 图标：‹ › = chevron-left/right；Collapse/Expand All = 与 ⟳ 同色、同笔触的单 chevron（状态由方向与 tooltip 表达）；Review = eye，与 Collapse/Expand All、⟳ 使用同一图标按钮样式；SCM 出口 = **Source Control 图标**（不用 `↗`——动作发生在当前窗口，↗ 易被理解为外部打开）；commit 徽标 ●/○/✓。
- **Tooltip 基础设施 = 面板级 JS overlay（新组件）**：纯 CSS 伪元素方案（`conversation-telemetry-tooltip`）**逃不出面板与文件列表的 `overflow: hidden/auto` 裁剪容器**（滚动区顶部/底部文件行、右侧按钮、192px 窄宽都会截断），且 `content: attr(data-tooltip)` 不是可靠的读屏描述——因此实现 JS tooltip overlay：单一节点挂 body、`position: fixed` 逃出所有裁剪容器、按触发元素 JS 定位、`data-tooltip` 属性驱动、hover/focus 触发、Esc/blur/滚动/面板关闭时关闭、`aria-describedby` 关联触发元素（**可见提示与读屏描述同源**）。`aria-label` 承载可访问名称，tooltip 承载视觉提示，二者分工、不互相替代；**不依赖原生 `title`**；现状 ⟳/SCM 按钮的原生 `title` 一并迁移。
- 色彩：全部沿用 vscode 主题变量；`No tracking branch` 与 `●`（Not in tracking branch）用中性 `descriptionForeground`，**不用 warning 色**（无 tracking 是 agent task 的常态，不应被误读为告警）。
- 密度：头部行与子 tab 行均为紧凑行高（≈22px）；Commits 文件行与 Files 文件行同高、同缩进体系。
- 动画：不做布局动画（沿用现状即时重排）；‹ › 切换不做滑动动画（兼容老 Chromium webview，不引入超出现状用法的 CSS 特性）。
- **完整 Tab 序**：‹ → repo select → › → SCM 按钮 → 分支 → 跨 member 提示（渲染时）→ 子 tab → Collapse/Expand All → ⟳ → Review（可用时）→ 内容区（组头/目录/文件行）。
- **内容区键盘模型（对齐 VS Code 树形惯例，验收标准）**：
  - roving tabindex：整个内容区一个 Tab 停靠点，`↑`/`↓` 在可见项间移动；
  - `←`：已展开节点 → 折叠，已折叠或叶子节点 → 移到父节点；`→`：已折叠节点 → 展开，已展开节点 → 移到第一个子节点；
  - `Home`/`End`：第一个 / 最后一个可见项；
  - `Enter`/`Space`：激活当前项（目录 / 组头 = 切换折叠；commit 行 = 切换展开；文件行 = 打开 diff）；
  - **焦点恢复**：刷新后原焦点项消失 → 落最近的同级或父级可见项；Collapse All 后焦点位于被隐藏子项 → 移到所属组头；
  - 子 tab：tablist 自身 roving tabindex，`←`/`→` 移动并激活（automatic activation），tab 以 `aria-controls` 关联对应 `tabpanel`。
  现状每行一个 Tab 停靠点在 Commits 长列表下是键盘灾难，Part II 上线时按 PR 切分一并改造（§19）。
- ‹ › 激活后焦点驻留可连续 Enter；Esc 行为沿用现状（原生 select 的 Esc 由控件自身处理，无分层冲突）。
- 样式走 `media/conversationViewer.scss` 编译链路，产物 css 入库（webview checks 强制）。

## 18. 验证与成功指标（Part II）

**本仓库当前没有任何事件埋点设施**，量化指标依赖的基础设施不存在，不写成承诺。本期验证方式为 dogfooding 人工验收清单：

- 多仓库 task（n≥3）：相邻切换 1 次点击、任意切换 ≤2 次点击达成；`(i/n)` 始终正确；
- 分支名在 240px / 320px / 420px 三档宽度下均可辨认（截断处全文经 tooltip overlay 可达）；
- Collapse All 后只剩组头行；Expand All 完整还原；切 member 再切回折叠态保留；
- Commits tab：挂着监控期间 agent 新提交 commit，列表随推送静默更新、与摘要行数字始终一致；
- commit → 展开 → 点文件 → parent↔commit diff；Review this commit 开 multi-diff；
- tracking 语义：无 tracking branch / tracking 指向不同名分支（如 origin/main）/ diverged 三态文案正确；push 或 fetch 后（HEAD 不变）分叉计数与行级徽标随失效签名刷新；
- 边界提交：baseline 缺失、history rewritten、merge commit（first-parent 明细）、root commit；
- 上限：since-start 200 条截断标注；单 commit 超 400 files 走 Review；
- 显示：192px / 200% zoom / 高对比度主题下头部 action 行无溢出；Review tooltip 可读且不被裁剪；
- 键盘与读屏：全键盘完成 §17 全部操作；所有图标按钮与徽标的可访问名称正确；
- tooltip overlay：滚动区顶部/底部文件行、192px 窄宽、头部右侧按钮均无裁剪/错位；
- 性能实测：tracking 采集增量 P95 ≤150ms（每 member ≤4 个新增 git 进程）；commits 首屏 P95 ≤300ms；
- 焦点恢复：Collapse All、刷新、member 切换后焦点落点符合 §17 规则；
- full history：分页期间 HEAD 变化 → 重置回 Since start 并重取；
- 量化指标（切换点击数分布、Commits tab 打开率、懒加载 P95、首开宽度分布）列为 **P1 埋点设施探索项**的输入，设施就位后再采集。

## 19. 里程碑（Part II）

- **本期，拆两个串行 PR**（每个都是完整产品增量，无半成品态），外加一个前置缺陷修复小 PR：
  - **PR-0（前置缺陷修复，独立小 PR）**：Task result 目前**排除 untracked**——`taskFileCount` 只跑 `git diff --name-only <baseline>`（tracked 差异），Review 同样只读 tracked diff——与 Part I §4.3"Task result ⊃ Working changes（含 untracked）"的承诺矛盾（Working 里看得到的 untracked 文件，Task result 数字与 Review 里没有）。修复为 tracked diff ∪ untracked 并集（Review 中 untracked 的 original 侧用 EMPTY_REF），含回归测试。**修实现，不改承诺**。
  - **PR-A（头部 + Files 完成态）**：最终头部结构（行 1 repo 行：可见 label + 透明 select 覆盖层 / 行 2 分支行）、tracking 采集与 3 处协议同步（§14.4 字段）、行 3 Review 图标及其 task/tracking tooltip（§15.1/§15.4）、‹ › 循环 + `(i/n)`、跨 member 提示升级（readable 口径）、组头可折叠 + Collapse/Expand All、**Files 内容区完整键盘模型（§17）**、**Files 滚动位置按 member 记忆（§15.2）**、**tooltip overlay 基础设施（§17，含现状 `title` 迁移）**、首开 320px 推荐（双状态位）。**PR-A 中间态定义**：行 3 仅渲染右侧 action slot（Collapse/Expand All），不渲染子 tab 控件，Files 为唯一视图；markup / 样式 / browser 测试按最终结构一次到位，避免两个 PR 重复重写；含受影响的 WORKTREE-CHANGES-PANEL-001 browser 测试重写与 behavior-contracts 登记。
  - **PR-B（Commits tab）**：子 tab 框架（Files | Commits，装入行 3 左槽）、§14.3 数据契约（四类消息 + requestId/generation 双重丢弃 + 分页模型）与失效纪律、Commits 列表 / 展开 / 分页 / 降级、parent↔commit 单文件 diff 与 `openCommitReview`、Commits 内容区键盘行为（§17 模型在 Commits 列表的实例化）、Commits 滚动位置与展开项按 member 记忆。
- **P1**：base moved 标识（Part I 顺延）；live 脉冲标识；Graph ↗ 出口（探测 git-graph / GitLens 命令，缺失隐藏）；commit 搜索；目录搜索（Part I P1 保留）；Files 文件行 numstat（Part I P1 保留）；MRU / 智能切换顺序评估（先用固定顺序的 dogfooding 反馈验证）；跨 member Review all；事件埋点设施探索（§18）。
- **P2**：commits 与 worktree 清理流程联动——"可清理"信号需先持久化 task branch 的 publication target 再评估（tracking 事实不足以推断 pushed，§14.1 纪律）。

## 20. 决策记录

### v1 批注闭环（2026-08-16）

| 决策点 | 结论 |
| --- | --- |
| 入口形态 | telemetry 右侧 Changes 按钮，行为对齐现有按钮；不进 open tab 卡片 |
| 详情位置 | AI Conversation 右侧边栏 Changes tab |
| 多仓库浏览 | 下拉单选 member；单项目窗口退化为只读 |
| 点击文件 | 当前窗口开原生 diff editor，不跳窗口 |
| 零改动显示 | 按钮显示 0，不隐藏 |
| 非组历史 session | 退化单 member 视图，不隐藏按钮 |

### v2 第一轮评审修订（2026-08-16）

| 决策点 | 结论 |
| --- | --- |
| 单层模型缺陷 | 引入 Task + Working 两层；按钮双维度 |
| SCM 对齐承诺 | 收敛为分组/字母/点击行为对齐；不承诺角标数字一致 |
| baseline 来源 | member 持久化 baseline；缺失/改写显式降级 |
| session→group 解析 | 权威路径为 worktreeKey/cwd → manifest；Merge/Adopt 后跟随当前组 |
| 文件点击 | 行为矩阵（staged/unstaged/both/untracked/conflict/rename/deleted） |
| member 默认选中 | 上次选择 → conflict → 有改动 → 有 ahead → primary |
| SCM 出口文案 | "Open this worktree in Source Control"，当前窗口聚焦 |

### v3 第二轮评审修订（2026-08-17）

| 决策点 | 结论 |
| --- | --- |
| 双层语义 | 改为包含关系：Task result（净结果）⊃ Working changes（未提交子集）；文案 "Includes committed and uncommitted changes" |
| baseline 捕获 | 先冻结 SHA → 持久化 intent → 用 SHA 建 worktree → 建后校验 → 随 worktreeKey checkpoint；失败分级补偿，禁止反猜 |
| baseline 结构 | `MemberBaseline{commitSha, capturedAt, source: branch/tag/commit}`；tag 固定、detached 无 behind |
| 聚合未知态 | `complete/partial/unavailable` 三态；按钮 `↑?` / `+` / `↑—`；未知不显示为 0 |
| 解析顺序 | 持久化身份 → manifest → retired → live fallback → hidden；工具 cwd 不覆盖身份；resolver 返回完整 WorktreeKey + Windows 路径 |
| 刷新正确性 | P0 = Git API `onDidChange` + 打开/可见/切换强刷 + 手动 Refresh；自建 watcher 移 P1 |
| untracked 真源 | 面板自采集 `-z -uall`，不跟随用户 SCM 配置 |
| 术语 | `workingItemCount`（resource 行数）；tooltip 写 "uncommitted changes" 不写 "files" |
| Review 命名 | "Review this repository"（选中 member）；跨仓库统一版移 P1 |
| 版本兼容 | Git API 字段与 `vscode.changes` 做 capability detection + fallback，不提升最低 VS Code 版本 |
| P0 砍范围 | numstat、智能选中、tab 宽度、自建 watcher、live-region、精细截断、跨仓库 Review 全部移 P1 |

### 2026-08-22 Part II 第一轮（owner 当面确认）

| 决策点 | 结论 |
| --- | --- |
| Commits 默认口径 | **Since start 优先**（baseline..HEAD）；完整历史走底部入口分页加载 |
| 领先/落后标识 | **只做 vs upstream**；upstream 缺失显示 `not pushed`；base moved / behind 顺延 P1 |
| Collapse All 范围 | **合到组头**；组头因此从纯文本升级为可折叠按钮（前置能力） |
| ‹ › 切换顺序 | **manifest 固定顺序**循环 + `(i/n)` 位置指示；智能排序移 P1 评估 |
| 会话 01a00960 设计稿 | 整体回收：两行式头部、‹ › 切换、子 tab、commit 行内展开 + numstat、Review this commit、baseline 收尾行；其中 Graph ↗ 与 live 标识按原稿顺延 P1 |
| Collapse/Expand All | 01a00960 稿缺失，Part II 新设计（§15.3） |
| Commits 数据通道 | 请求/响应式懒加载，不进 Part I 的单一权威状态推送，避免加重常态刷新链路 |

### 2026-08-22 Part II 第二轮（三路评审修订：产品 / 可用性 / 技术）

| 决策点 | 结论 |
| --- | --- |
| "任意切换 ≤1 次点击"不可验收 | 改为"相邻 1 次、任意 ≤2 次（循环或下拉直达）"（§10 第 3 条/§18） |
| "N 与按钮 ↑n 同源同数"参考系错误 | 按钮 = 全 member 聚合；Commits N 对齐**同 member** 的 Files 摘要行 commits 数（§10 第 1 条/§15.5 第 1 条） |
| Commits 懒加载失效语义缺失 | 新增失效纪律五条：⟳ 双路重采、推送变化作废缓存并静默重取、切 member 即清不残留、响应纳入 generation 丢弃、校验上限（§14.3） |
| SCM 出口失踪 | 落位行 2 右侧（⟳ ↗ 并排），进完整 Tab 序（§15.1/§17） |
| 自绘 member 浮层三缺口（裁剪/键盘/Esc） | **保留原生 `<select>`** 样式化为"repo 名 ▾"按钮，不换自绘浮层（§15.1） |
| git 命令实测错误 | diff-tree 拆两条、`-M` 必带、rename `-z` old-path-first、merge 用 `-m --first-parent`、root 显式 `--root`、`%at` 替代 `%ct`、left-right 左=⇣右=⇡（§14.3） |
| "4 处协议同步"不准确 | 实为 3 处 + 双份文件镜像；补全完整接线面清单（§14.4） |
| "复用 openTaskResultReview" | 改为新增 `openCommitReview` 共享三零件；文件上限对齐 `MAX_DIFF_FILES=400`（§15.5 第 3、5 条） |
| 头部 5 行 chrome 过重 | 独立标识条取消，标识并入各 tab 摘要行（同参考系数字同行），头部收敛为 2 行 + 子 tab 行（§15.1） |
| 子 tab 命名撞车 | 内层命名 `Files | Commits`；定位为面板内新范式并补 tablist ARIA 规格（§15.4） |
| 宽度按 tab 记忆 → reflow 振荡 | 改首开一次性推荐 320px + 全视图共享单宽度 + 用户拖拽优先（§15.6） |
| "vs origin" 文案 | 改 "vs upstream"（fork/多 remote 场景 upstream 未必是 origin）（§14.1） |
| you/agent 作者映射无数据支撑 | 直接显示 authorName；行级 push 状态按 upstream 存在与否的显示矩阵（§15.5 第 2 条） |
| ⤒⤓ 纯图标无可发现性 | 用 VS Code collapse-all/expand-all 图形 + `title` 可见提示；Commits tab 下禁用而非隐藏（§15.3） |
| 成功指标无埋点载体 | 降级为 dogfooding 验收清单；量化指标列 P1 埋点探索输入（§18） |
| 键盘流不完整 | 完整 Tab 序 + 内容区 roving tabindex + 子 tab ←→ + ‹ › 焦点驻留（§17） |
| 跨 member 提示文案 | 以现行实现（`+N in <repo 列表>`）为准，仅升级为可点击（§15.1） |
| 基线 P1 条目去向 | last commit 行由 Commits tab 首条取代（取消）；behind vs baseRef 随"只做 vs upstream"取消；目录搜索、Files 行 numstat 保留 P1（§13/§19） |

### 2026-08-22 Part II 第三轮（owner 评审修订）

| 决策点 | 结论 |
| --- | --- |
| `not pushed` 语义不成立 | 无 tracking ≠ 从未推送；commit 不在当前 upstream ≠ 未推送到其他 branch/remote；upstream 可能指向 origin/main。统一改事实型文案：`No tracking branch` / `In tracking branch` / `Not in tracking branch`，tooltip 注明 "Based on local remote-tracking refs; no fetch was performed"；字段 `pushed` 更名 `inTrackingBranch`。**取代第一轮的 `not pushed` 文案决策**（§13/§14.1/§15.5） |
| "一步步长出来"过度承诺 | 目标改述为"自 task start 以来**保留下来的**提交"（不还原被 squash/amend/rebase 丢弃的历史）；列表口径 = **完整可达 DAG**（与 aheadCount 同口径，守同源同数），merge 明细按 first-parent；first-parent 过滤视图列 P1（§12/§14.3） |
| Part I 基线自相冲突 | §0 修正为"数据分类四类 / UI 分组三组（Untracked 并入 Changes，行内 U 徽标）"；Part I 定位改为 **Current shipped contract**，§9 标注历史规划存档（文首状态/§0/§9） |
| PR-A/PR-B 半成品态 | PR-A 含最终头部结构 + Files 内容区**完整键盘模型**；行 3 中间态 = 仅右侧 action slot、不渲染子 tab 控件；markup/样式/测试一次到位避免重复重写。PR-B 只做 Commits 增量（§19） |
| full history IA/协议未闭环 | 模型闭环：Since start 段保留 + baseline 行下方追加 Earlier commits 段；baseline 缺失/改写 → `Current branch history` 单列表；新增 `BaselineRow` 类型与采集；分页 = 冻结 `historyHead` + `--skip` + sha 去重 + HEAD 变化即重置；scope 按 member 记忆恢复（§14.3/§15.5） |
| Commits 失效签名漏 upstream | 签名 = HEAD sha + baseline sha/availability + upstream fullRef + upstream resolved sha + ahead/behind；member 视图新增 `headSha` 与 `upstream` 字段（§14.3/§14.4） |
| 摘要行符号不可读 | 放弃 ↑/⇡ 箭头区分参考系，改为 Review tooltip 中的明确语言 `Since start · …` / `Tracking <upstream> · N ahead · M behind`（§14.1/§15.1/§15.5） |
| 原生 `title` 不可靠 | 可见提示一律复用现有可聚焦 tooltip 机制（`conversation-telemetry-tooltip` 模式）；`aria-label` 与 tooltip 分工、不互相替代；全文禁止依赖原生 `title`（§17 及各处分发） |
| disabled select 当静态标题 | 单 member 渲染普通文本标题，多 member 才渲染 select（改变现状行为，§15.1/§16） |
| Commits 下禁用折叠按钮 | 改隐藏按钮内容、保留固定宽度 action slot（§15.3） |
| 键盘树规范不完整 | 补 ←/→、Home/End、Enter/Space、焦点恢复规则、tablist roving tabindex + automatic activation + `aria-controls`/`tabpanel`（§17） |
| 跨 member 提示文案不说明动作 | 改 `<N> more changes in <repo 列表> · Go to <repo>`，含截断规则、完整 tooltip、available 口径（§15.1） |
| 验收清单扩充 | 补 tracking 三态、push/fetch 后刷新、边界提交（baseline 缺失/rewritten/merge/root）、200/400 上限、192px/zoom/高对比、全键盘与读屏、焦点恢复、分页期间 HEAD 变化（§18） |

### 2026-08-22 Part II 第四轮（实施计划评审修订）

| 决策点 | 结论 |
| --- | --- |
| `upstream` 二态字段无法表达 `Tracking unknown` | 改**三态判别联合** `tracked / none / unknown`（§14.4）；`none`=未设置、`unknown`=采集失败，未知不冒充事实 |
| `headSha` 对 unreadable member 无定义 | 改 `headSha?: string`，unreadable 时缺省（§14.4） |
| detached "Outside workspace" 与原生 select 冲突 | 行 1 select 旁加**独立小字元素**（原生 select 闭合态无法局部灰化；不沿用 option 文本后缀）（§15.1） |
| commit 徽标 tooltip 键盘不可达 | 徽标语义折叠进 commit 行 `aria-label`；tooltip 随行级元素展示（§15.5 第 2 条/§17） |
| 现状 ⟳/↗ 按钮用原生 `title` | PR-A 中一并替换为可聚焦 tooltip 机制（§17 纪律的现状清理） |
| 截图宽度档口径 | 自动截图 192/240/320 三档（需扩展截图脚本）+ 420px 档留人工 dogfooding（§18 实施注记） |

### 2026-08-22 Part II 第五轮（owner 评审修订：协议 / 接线 / 可实现性）

| 决策点 | 结论 |
| --- | --- |
| Commits 协议只有列表/明细两类消息 | 补齐四类：`commits-list` / `commit-detail` / `commit-open-file` / `commit-review`；全部携带 `version` + `requestId`，响应回传 `requestId` + `subscriptionGeneration`——requestId 解决同 member 新旧请求竞态（generation 只覆盖跨 session）（§14.3） |
| 响应 schema 不完整 | §14.3 给出完整 TS interface：`degraded` 五枚举（unreadable/timeout/history-moved/unknown-commit/error）、`historyHead` 回传、`offset` 回传、`sectionComplete`、`totalFiles`/`filesTruncated`、全部字段长度与数值上限 |
| Earlier commits 从 HEAD 翻页产生"空翻页"；200 截断后 baseline 行误暗示无遗漏 | 分页模型重写：since-start 段 50/页，未达边界不渲染 baseline 行；Earlier 段**从 baseline 祖先直接继续**（不从 HEAD 翻页）；`historyHead` 回传比对，不一致即 `history-moved` 重置；撤销 200 硬上限（§14.3/§15.5 第 1/6/7 条） |
| Task result 排除 untracked（现存实现缺陷） | `taskFileCount` 与 Review 均只读 tracked diff，破坏"Task result ⊃ Working changes"。列为 **PR-0 前置修复**：tracked ∪ untracked 并集（untracked original 侧 EMPTY_REF）——修实现，不改承诺（§19） |
| 原生 select 闭合态无法两套 label | 可见 label + 透明原生 select 覆盖层（闭合态自定义 DOM，popup 原生 option）；option 保留 `(outside workspace)` 后缀，闭合态独立小字——双承载（§15.1） |
| 纯 CSS tooltip 逃不出 overflow 裁剪 | 改**面板级 JS tooltip overlay**（`position: fixed` 挂 body、JS 定位、`aria-describedby` 同源）；现状 ⟳/SCM 的原生 `title` 一并迁移（§17） |
| 跨 member 提示只统计 `available` | 改 `readable = availability !== 'unreadable'`（baselineUnavailable / historyRewritten 的 Working changes 仍可读）；计数与 Go to 候选同一集合（§15.1） |
| Files 滚动位置记忆落在 PR-B | 前移到 PR-A（PR-A 即"Files 完成态"，§15.2 承诺）；PR-B 只补 Commits 侧滚动/展开项（§19） |
| 首开 320px 无法区分"系统保存的 240"与"用户拖的 240" | 新增显式状态位 `widthUserResized` + `changesWidthRecommendationApplied`；存量用户（标志位 undefined）不触发推荐（§15.6） |
| 400 files 降级出口自相矛盾 | 明细响应带 `totalFiles` + `filesTruncated`，UI 显示 `Showing 400 of N files`；Review 同受 400 上限、不暗示完整；超大 commit 完整审阅出口 = SCM / 外部 Git 工具（§15.5 第 3 条） |
| tracking 三态采集不可区分 none/unknown | 弃用 `rev-parse @{upstream}` 单判，改事实查询链：`symbolic-ref -q HEAD` → `for-each-ref --format=%(upstream)`（成功且空 = none；失败 = unknown）→ `rev-parse HEAD <fullRef>`（单进程双 sha）→ `rev-list --left-right --count`；性能口径修正为 ≤4 新增进程/member + P95 目标（§14.1 附注/§18） |
| baseline 缺失流程第 7/9 条矛盾 | 统一：`Current branch history` 单流 + 顶部说明条，无 Show full 按钮（§15.5 第 7/9 条） |
| 文档残留 | §18 "title 全文"改 tooltip overlay 口径；§19 P2 "全部已推送"改"持久化 publication target 后再评估"；SCM 出口图标 ↗ 改 Source Control 图形（§15.1/§17） |
