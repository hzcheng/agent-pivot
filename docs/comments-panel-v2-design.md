# Comments 面板 v2 设计实现文档

日期：2026-08-22

状态：P1/P2 已实现（P3 窗口级作用域待实现）

关联：`comments-panel-v2-prd.md`（需求与决策的唯一权威）；本文是其实现设计。

基线：`7f142e5b`（`agent-pivot/comment-panel-refact` 分支头，2026-08-22）

修订记录：

- 2026-08-22 v1 初稿。
- 2026-08-22 v2 按三路评审（技术准确性/符合性/可实施性）修订：①clamp 测量新增 ResizeObserver 重测机制（B1）；②迁 key 语义改 copy+delete（B2，快照内嵌 target 使 rename 不可读）；③迁移后强制刷新 controller 内存（B3）；④存量迁移惰性化并与迁 key 共用串行点（B4）；⑤D7 重写为内存 lastKey + globalState alias 表 + empty-window 双向豁免；⑥P2 删除清单/gate/pendingRoots/测试清单补全；⑦契约矩阵补全；⑧架构守卫（architecture-modules.json）与 scss 构建盲区入册；⑨行号/函数名勘误（E1-E3、S6、S7）。
- 2026-08-22 P1/P2 实现完成；P3 仍按本文后续独立交付。

## 1. 范围

本文覆盖 PRD 四项决策的实现设计，按 PRD §10 分期组织：

- **P1**：telemetry pill 双计数（§5.1）+ 卡片自动截断（§5.2）；
- **P2**：Comments 面板子 tab 化（§6）；
- **P3**：Workspace 笔记窗口级作用域（§7）+ 存量迁移 + 术语更名。

非目标与 PRD §3 一致。本文新增的范围约束：**P2 不拆分前端脚本文件**（只做文件内结构重排；脚本拆分作为 P3 之后的独立任务，决策 D6）。

## 2. 现状关键锚点（设计依赖的事实）

全部经代码核实（行号基于基线 commit；`src/webview/*.js` 与 `media/*.js` 逐字节相同，规范路径是只改 `src/webview/` 再经 gulp `copyWebviewAssets` 生成 `media/`）：

| 锚点 | 位置 |
| --- | --- |
| 前端 comments 单体 | `src/webview/conversationCommentsScripts.js`（3303 行 IIFE，注册 `window.__agentPivotConversation.comments`，L3302） |
| 双栈描述符 | `sessionStack` L148-272 / `projectStack` L274-356（队列/结算/拖拽/渲染已参数化） |
| pill 更新 | `updateCommentControls` L486-539（pill 段 L505-535，现格式 `open/total`）；`projectStack.afterSettle = updateCommentControls`（L298）——**project 结算路径已会刷新 pill**（D1 经全路径核实：9 种 mutation op 均经 settle → afterSettle） |
| pill 初始 markup | host 侧 `conversationTelemetryController.ts:453-461`（初始 `'0'`） |
| 统一过滤条 | `renderCommentsFilterBar` L2331-2433（合并两栈 chips L2333-2370）；filter 持久化 `conversationCommentsPanelFilter`（L724-769）；chip 点击 L2699-2717 |
| 卡片构建 | session 卡片在 `renderComments()` **内联构建**（`<article>` L822 起，正文 `.conversation-comment-body` L967，quote L972）；project 卡片 `buildProjectCommentCard` L2151 起。**不存在 `buildCommentCard`** |
| 分区折叠/sash | state 字段 `projectSectionCollapsed`/`sessionSectionCollapsed` **L76-77**；函数群 L1849-2082（read/save/apply/toggle/expand/clamp/reset + sash L2013 起）；state key `conversationCommentsSections`、`conversationCommentsSessionRegionHeight` |
| sidebar 状态 | `conversationSidebarScripts.js`：`conversationSidebar` key（L61-67）；`setSidebarView(view, open, persist)` L152-159；默认 view `'outline'`（L28）；`commentsRoot.hidden = view !== 'comments'`（L134） |
| comments 面板骨架 | `viewerDocument.ts` L337-495（filter bar L341、Workspace 区头 L345-376、Workspace 内容 L377-430、sash L431-436、Session 区头 L437-464、Session 内容 L465-493）；选区气泡 L567-579 |
| `commentUiAvailable` gate | `conversationViewerScripts.js` L259-265（`commentsSectionSash`、**`sessionCommentsCount` L263、`projectCommentsCount` L281** 均为必要元素）；装配 options L508-556（`updateToggle` L555 为死传递） |
| click 委托 | 共 **4 处**：`commentsRoot` L2661（session 卡）、`projectCommentsRoot` L2906（project 卡）、两区头 L2819/L2878 |
| 宿主端双栈 | `commentController.ts` / `projectCommentController.ts`（后者 L76-80 `toStoreTarget = { projectId }`） |
| 存储 | `KeyedSnapshotFileStore`（`snapshotFileStore.ts` L47-235；空列表 save 即删文件 L88-97；digest L159-163；**`readPersisted` 校验文件内嵌 target（L180，`targetsMatch`）——rename 文件后不可读**）；`loadStrict` L118 / `saveIfAbsent` L130（protected 原语） |
| freeze/drain | `queuedMutationController.ts` L152（frozen→'stale'）、L275-278（基类默认 false）、`enqueueTask` 串行队列 L98-102；freeze 范例 `commentController.ts` L81-99（**无 unfreeze，`onReset` 复位**） |
| viewer | 每窗口单例（`composition.ts:384`）；restore 路径两处 `viewer.ts` L628-631 与 **L1258-1260**；controller 装配 L391-401 |
| 身份 | `workspaces/identity.ts`（`createWorkspaceUriIdentity` L27-29）；`contextResolver.ts` L99-113（`resolveKind` L50-57 只看 `workspaceFile` 有无）；`'empty-window'` 哨兵 `openWorkspaces/dashboardController.ts:367-368` |
| 当前 workspace | `dashboard.ts` L909-917；根目录变化监听 L3104-3107；Save As 的 pending-intent 模式 `workspaces/pendingWorkspaceSaveStore.ts` + `savedWorkspaceProjectAdapter.ts` |
| 存量迁移线索 | `tmuxRuntimeBindingStore.listKnown()`（L119-121，binding 含 `workspaceNavigationIdentity`/`cwd`，tmuxBindingRecords.ts L20-52）；活跃 runtimes 来源 `aiSessionRuntimeCoordinator.getActive()`；路径匹配 `projects/openProjectMatcher.ts`（接 `vscode.Uri`；字符串比较用 `normalizeComparableProjectPath` L60，remote authority 用 `projectPathMatchesWorkspaceUri` L37-55，**需 cwd→Uri 适配层**） |
| 协议 | project-comment 消息 envelope 含 `projectId/provider/sessionId`（viewer 路由身份，**非存储 key**），`viewerProtocol.ts` L68-92、L551-596 |

## 3. 总体设计

```text
P1  ├─ host: conversationTelemetryController.ts 初始 markup（'0 · 0' + 新文案）
    └─ webview: updateCommentControls 改两栈 open 计数；卡片 clamp
                （CSS 级 + 整卡 toggle + ResizeObserver 重测）

P2  ├─ host: viewerDocument.ts comments 骨架重写（tablist + 两 tabpanel，删 sash/折叠/count）
    └─ webview: comments 脚本内 tab 状态机 + filter 按栈拆分 + 删除分区机制
                viewer 主脚本装配与 commentUiAvailable gate 同步

P3  ├─ host: workspaceComments.ts / workspaceCommentStore.ts / workspaceCommentController.ts
    │       （自 projectComment* 更名，target = { navigationIdentity }，新补 freeze）
    │       workspaceCommentScopeSync.ts（新：迁 key，aiSessions/conversation/）
    │       legacyProjectCommentMigration.ts（新：存量迁移，dashboard/sections/，见 §7.4 落点论证）
    ├─ 装配: composition.ts / conversationStack.ts / dashboard.ts（注入 identity resolver）
    └─ 协议: 线协议字符串冻结（决策 D5）；TS 类型更名
```

关键数据流（改动后）：

- **mutation 流**（不变）：webview `postStackOperation` → host 串行队列 → 先持久化 → settlement 完整回传 → 前端整栈重渲染。P3 仅换 store key 派生，管线不动。
- **pill 更新流**（P1）：session settle → `renderComments` → `updateCommentControls`；project settle → `afterSettle` → `updateCommentControls`；初始化/切 session → `resetSession`/`initializeComments` → `renderComments`。所有数据变化路径均收敛于 `updateCommentControls`（D1）。
- **clamp 测量流**（P1）：渲染尾部同步测量（可见时立即可靠）+ ResizeObserver 监听列表容器（面板打开/view 切换/宽度拖拽/tab 切换时尺寸变化触发重测）（D9）。
- **迁 key 流**（P3）：controller restore/enqueue 前 `await scopeSync.ensureCurrent()`（单 flight 记忆化）→ 检测/迁移/刷新内存/解冻，全串行。

## 4. 设计决策记录（DR）

- **D1 pill 计数收敛单点**：双计数只改 `updateCommentControls` pill 段，不新增触发挂钩——project 结算已由 `projectStack.afterSettle`（L298）覆盖；本地 UI 操作（展开 done、tag 编辑器）不改计数。浏览器测试兜底"project mutation 后 W 刷新"。
- **D2 截断为整卡单 toggle**：每卡最多一个「Show more / Show less」，同时控制正文与 quote；溢出判定 `scrollHeight > clientHeight`（先加 `is-clamped` 再测）。CSS 级截断，DOM 文本全文保留。展开 Set 渲染时按现存 id 修剪（仿 `expandedDoneComments` L811-815 的 pruning）。**done 卡豁免**（维持现有折叠单行 + chevron）。
- **D3 filter 单容器按栈渲染**：过滤条保留一个 DOM 容器，按激活 tab 渲染对应栈 chips；过滤状态每栈独立（§6.4）。
- **D4 区头计数收敛到 tab 标签**：删除 `data-session-comments-count`/`data-project-comments-count`；`updateSectionCount` 改造为 tab 标签更新；与 pill 构成三方一致。**gate 同步删除这两个必要元素（§6.5，否则 UI 静默失效）**。
- **D5 线协议字符串冻结**：消息 type 字符串、webview state key、契约 id 均不更名（稳定锚，更名无收益徒增 diff）。P3 更名范围 = TS 类型/文件/store 目录；线协议字符串加注释说明为历史名。
- **D6 P2 不拆脚本文件**：`checkWebviewManifest` + `EXPECTED_MAIN_ENTRIES` 使新增脚本有真实成本；拆分留作 P3 后独立任务（PRD §9.4/§10 已回签）。
- **D7 迁 key 身份跟踪（v2 重写）**：**内存 lastKey + globalState alias 表**双机制：
  - 转换即时路径：`ensureCurrent` 检测 lastKey≠current → freeze → migrate → 写 alias `{from, to, at}`（globalState key `agentPivot.workspaceComments.keyAliases.v1`，追加式、cap 50 LRU、迁移成功后删除对应条目；按 `to` 定向查询，多窗口并发安全）；
  - 启动领养路径：`lastKey === null`（host 重启）→ 当前 key 有文件则采纳；无文件则查 alias 表 `to === current` 且 `from` 文件存在 → 迁移；无命中**不猜测**（不扫描目录领养陌生文件）；
  - **empty-window 双向豁免**：`'empty-window'` 既不作 source 也不作 destination（Close Workspace 到空窗口不把笔记迁入共享桶；反向也不迁出）；identity 为 empty 时 `ensureCurrent` 仅更新 lastKey；
  - 平台行为假设（手动测试验证，§8.4）：`resolveKind` 只看 `workspaceFile`（contextResolver L50-57），故「untitled/saved 工作区删到 1 根仍多根 kind、key 不变」依赖 VS Code 不在删根时清除 workspaceFile——代码侧成立，平台侧列为假设；「增删根不 reload 窗口」「Save Workspace As host 存活」同理（Save As 有 `savedWorkspaceProjectAdapter` 就地转换的代码旁证）。
- **D8 合并超限只禁新增**：合并后条目可超 50、tag 词表可超 20——全部保留；仅禁止新增，回落限内自动恢复。
- **D9 clamp 重测机制**：ResizeObserver 监听两栈列表容器；`display:none` ↔ 可见、宽度变化均触发尺寸回调（含 P2 后 tabpanel 的 hidden 切换）。渲染尾部同步测量保留（测试预置 `view:'comments'` 时可预测）。
- **D10 迁移后强制刷新内存**：`migrateTarget` 返回非 `'noop'` 后，controller 必须重读快照（restore 路径自然覆盖；enqueue 路径在迁移后先强制 restore 再放行）——mutation 用内存态整快照覆盖写，不刷新则 merge 成果被 clobber。
- **D11 存量迁移惰性化**：legacy 迁移不在激活时 fire-and-forget（与正常 save 无对账、互相覆盖），而是**首次使用 Workspace 栈时**（`ensureCurrent` 启动分支内）与迁 key 共用 freeze 串行点执行；幂等（旧文件已删则无源）。

## 5. P1 详细设计

### 5.1 pill 双计数

**host**（`conversationTelemetryController.ts` L453-461）：初始值 `'0'` → `'0 · 0'`；aria-label/title/data-tooltip 初始文案改 `0 open session comments · 0 open workspace notes — click to review`。

**webview**（`conversationCommentsScripts.js` `updateCommentControls` pill 段 L505-535）：

- `S = commentStatusCounts().open`（注意：**无参函数**，闭包读 `state.comments`，L458-463）；
- `W = projectCommentsAvailable ? <对 state.projectComments 归约 status==='open' 计数> : 0`（新写归约）；
- pill 文本 `` `${S} · ${W}` ``；tooltip/aria-label `` `${S} open session comments · ${W} open workspace notes — click to review` ``；
- `hidden = false` 恒可见不变。区头计数与 `commentCount` 旧元素 P1 不动（测试 7922-7925 断言 `[data-comment-count]` 行为，相容）。

**测试**：更新 7 处既有断言（conversationViewer.test.js:5609、5638、7605-7606、7673-7674、7743-7744、7926-7930、8193-8197）；新增 project mutation 后 W 刷新用例（D1 兜底）；`CONVERSATION-TELEMETRY-CONTROLLER-001` 补 pill 初始文案断言。

### 5.2 卡片自动截断

**落点（E1 勘误）**：session 卡片 = `renderComments()` 内联段（L822 起，正文 L967、quote L972）；project 卡片 = `buildProjectCommentCard`（L2151 起）。

**DOM/样式**（`media/conversationViewer.scss` → `npx gulp buildStyles` 生成 css，gulpfile.js L19-23）：

- 正文/quote 容器加 `.conversation-comment-clampable` + `.is-clamped`；max-height 以 em 表示（正文 ≈7 行、quote ≈3 行）；`.is-clamped` 时 `overflow:hidden` + 底部渐隐遮罩（**真实 `div`**，不用伪元素——仓库教训：tooltip-bearing 元素禁伪元素装饰）。
- toggle：`button.conversation-comment-clamp-toggle`（**不带** `data-comment-action`/`data-project-comment-action`、**不在** `.conversation-comment-actions` 内、带 `aria-expanded`），卡片底部。

**逻辑**：

- state 新增 `expandedClampedComments` / `expandedClampedProjectComments`（两栈对称 Set，内存态；渲染时按现存 id 修剪，D2）。
- 渲染尾部同步测量：先加 `is-clamped` 再读 `scrollHeight > clientHeight`（正文或 quote 任一溢出），仅溢出卡显示 toggle。
- **重测（D9）**：ResizeObserver 挂两个列表容器，回调内重测该栈全部卡片。
- toggle 点击：在 `commentsRoot`（L2661）与 `projectCommentsRoot`（L2906）**两处**委托前部拦截（S6 勘误：委托共 4 处，卡片在 2 处），更新展开 Set + 重渲染该栈。纯前端。注意 toggle 点击→整栈重渲染后焦点丢失（与 toggle-done 现状一致，接受）。
- `revealCommentCard`（L1115-1145）：目标卡加入 `expandedClampedComments`（注意 reveal 先 render 后 setSidebarView，L1131-1135——隐藏测量由 D9 补测兜底）。
- `CONVERSATION-COMMENTS-LAYOUT-001` 语义更新（"fully visible cards" → clamp 语义）；相关断言在 conversationViewer.test.js:7024-7026（scrollHeight）与 7020-7023（textContent 全文，**保留**——clamp 不裁 DOM）。

**测试约束**：新用例只锚 `[data-comment-id]` 卡片内部结构；既有短卡 fixture 不触发 clamp；ResizeObserver 回调异步，断言前需等待（playwright `waitFor`）。

## 6. P2 详细设计（子 tab 化）

### 6.1 DOM 骨架（`viewerDocument.ts` L337-495 重写）

```html
<section id="conversation-comments-panel" ...>
  <div class="conversation-comments-tabs" role="tablist" aria-label="Comments scope">
    <button role="tab" data-comments-tab="session" aria-selected="true"
            aria-controls="conversation-comments-panel-session">
      Session <span data-comments-tab-count="session"></span></button>
    <button role="tab" data-comments-tab="workspace" aria-selected="false" tabindex="-1"
            aria-controls="conversation-comments-panel-workspace">
      Workspace <span data-comments-tab-count="workspace"></span></button>
  </div>
  <section role="tabpanel" id="conversation-comments-panel-session"
           data-comments-panel="session" aria-labelledby="...tab-session">
    <!-- 区头操作行（＋ ✈ eraser trash；删 count、删折叠 toggle）+ composer + list + filter-empty + empty -->
  </section>
  <section role="tabpanel" id="conversation-comments-panel-workspace"
           data-comments-panel="workspace" aria-labelledby="...tab-workspace" hidden>
    <!-- 区头操作行 + composer（含 source 快照）+ list + empty -->
  </section>
  <div class="conversation-comments-filter-bar" data-comments-filter-bar ...></div>
</section>
```

删除：sash（L431-436）、两个区头折叠 toggle、区头 count 元素（D4）。filter bar 保留单容器（D3），但固定在面板底部，避免其出现/消失推动上方内容。

### 6.2 tab 状态机（comments 脚本）

- state 新增 `activeTab: 'session' | 'workspace'`、`previousTab: ... | null`（仅 composer 跨 tab 流）。
- 持久化：新 key `conversationCommentsActiveTab`（读取校验，非法/缺失 → `'session'`）；**存量 webview state 缺省 Session tab**。
- `setActiveTab(tab, { persist })`：写 state → panel `hidden` 切换 + `aria-selected`/roving tabindex → 重渲染 filter bar（D3）→ 持久化。panel 由 hidden 转可见时 ResizeObserver 触发 clamp 重测（D9 覆盖）。
- 键盘：←/→ **移动焦点并激活**（自动激活模式，PRD §4.4 已回签）；Home/End 跳首末（PRD 外附加，良性）。
- 切 tab 副作用：复位两栈 clear-all 两步确认态（`resetStackClearAllConfirmation` L473-484）。
- 状态文案（含本节的切换反馈、迁移提示等）统一复用 `data-conversation-status` 元素（`aria-live="polite"`，viewerDocument.ts:211；现状先例 L1490 'Selection sent…'）——读屏可达（PRD §4.4）。

### 6.3 跨 tab composer 流（对称）

- 正向 🔖（`saveSelectionAsProjectNote` L2107-2128 改造）：`previousTab = activeTab` → `setActiveTab('workspace')` → 打开 workspace composer（quote 进 source 快照逻辑保留）。
- 反向 💬（`openCommentComposer` L1493 起）：`previousTab = activeTab` → `setActiveTab('session')` → 打开 composer（删 `expandSessionSection` 调用 L1496）。
- composer 取消（Esc 或 ✕，✕ 为 PRD 外良性扩展）：关闭后若 `previousTab` 非空且 ≠ 当前 tab → 切回并清空。确认提交不返回（新卡片落在目标 tab，用户已见）。
- pending 期间允许切 tab；`settleCommentsResult` 尾部 `focusStackDragHandle`（L1372）加守卫：目标栈 panel 隐藏时跳过。

### 6.4 filter 拆分（D3）

- `renderCommentsFilterBar(stack)` 参数化：统计/chips 只取对应栈（拆分 L2333-2370 的合并逻辑）；tag 词表消失重置 filter 的守卫按栈处理。
- chip 点击（L2699-2717）：写对应栈 filter + 只重渲染该栈。
- 持久化：`conversationCommentsPanelFilter` 形状改 `{ session: Filter|null, workspace: Filter|null }`；旧单值在读路径迁移为 `{ session: 旧值, workspace: null }` 并立即写回，避免 legacy 形状在下一次加载复活。
- **pendingRoots 重划（I3）**：现状 `sessionStack.pendingRoots` 含 `projectCommentsHeader`（L229-234，session pending 会禁用 workspace 区头）——tab 化后重划为本栈元素（sessionStack: [sessionPanel 内区头+内容]；projectStack: [workspacePanel 内区头+内容]），filterBar 单独判定：pending 栈 === activeTab 栈时才禁用。

### 6.5 装配、gate 与删除清单（I1/I2 补全）

- **gate**（`conversationViewerScripts.js` L259-265）：必要元素删 `commentsSectionSash`、**`sessionCommentsCount`（L263）、`projectCommentsCount`（L281）**，增 tab 条/两 panel；`create(options)` 传递同步（L537/L542 删 count、L508-556 增 tab 元素）；顺带清理 `updateToggle` 死传递（L555）。
- **删除函数全量清单**（除设计 v1 已列 7 个外补充）：`applySectionToggle`（L1890）、`toggleSessionSection`（L1929）、`toggleProjectSection`（L2069）、`expandProjectSection`（L2082）、`clampSessionRegionHeight`（L1937）、`resetSessionRegionHeight`（L1965）、常量 `SESSION_REGION_MIN_HEIGHT`（L1935）；两个区头 click 折叠监听器（session L2878-2888、project L2874 兜底分支）；`openProjectCommentComposer` 内 `expandProjectSection()` 调用（L2095）；`attach()` 内 `attachCommentsSectionSash()`（L2598）与 `initializeComments` 的三连调用（L3217-3219）。
- `updateSectionCount` 改造为 tab 标签更新后，注意 project 侧调用点 L2455-2462 一并改。
- state 字段删 `projectSectionCollapsed`/`sessionSectionCollapsed`（L76-77）；旧 key `conversationCommentsSections`/`conversationCommentsSessionRegionHeight` 读取处删除，自然作废。
- scss：tab 条样式、panel 全高布局、删 sash/分区高度样式（`npx gulp buildStyles` 重新生成 css）。
- 相邻代际兜底：tab 化 Viewer 装配传入新元素；若旧一代 Viewer wrapper 尚未传这些 options，新 Comments 模块从当前 tab DOM 自取。Host 文档保留三个 hidden v1 selector 哨兵，仅用于避免旧 wrapper 的 v1 gate 静默关闭 Comments，不参与 v2 布局。

### 6.6 测试改写（I4 补全）

- **统一过桥策略**：workspace 交互测试预置 `initialWebviewState.conversationCommentsActiveTab: 'workspace'`（harness 先例 6109/6211/12097 预置 sidebar state）或先点 tab。
- 5687（PROJECT-COMMENTS-UI-001）：sash/折叠/高度段（5997-6098）整段重写为 tab 用例；
- **6101**（'keeps the workspace composer fully visible…'，含 session-region 定高断言 L6179-6181）、**6202**（'toggles, edits, and deletes notes…'）：预置 workspace tab + 删定高断言（v1 遗漏）；
- 7482 过滤段（7625-7650）按 per-tab filter 重写；
- 12081 意图重写为 per-tab chips；12046（无契约标签）按缺省 Session tab 重挂入口；
- 3859 跨代际钉住片段**人工核对**；5241/6466/6535 依赖缺省 tab=Session 保证卡片可见。

## 7. P3 详细设计（窗口级作用域）

### 7.1 更名映射与影响面（D5 边界内）

| 现状 | 新名 |
| --- | --- |
| `projectComments.ts` | `workspaceComments.ts`（`ProjectComment` → `WorkspaceComment` 等） |
| `projectCommentStore.ts`（`'project-comments/v1'`） | `workspaceCommentStore.ts`（`'workspace-comments/v1'`） |
| `projectCommentController.ts` | `workspaceCommentController.ts`（+freeze） |
| `ProjectCommentTarget { projectId }` | `WorkspaceCommentTarget { navigationIdentity }` |
| 消息 type 字符串 / state key / 契约 id | **冻结不动**（D5） |
| 测试 `projectComment*.test.js` | `workspaceComment*.test.js` |

import 影响面全量（≈13 处）：`viewerProtocol.ts`（L11-13）、`viewerDocument.ts`（L8）、`viewer.ts`、`composition.ts`、`conversationStack.ts`、`dashboard.ts`、3 个测试文件 + 2 个新文件 + `behavior-contracts.json`（owners/evidence 路径必须存在）+ **`docs/testing/architecture-modules.json`**（I5：`projectCommentStore.ts` 等被 MOD-AI-SESSION-CONVERSATION 显式登记，更名/新增必须同步登记，且新模块依赖须落在 mayDependOn 内）。

### 7.2 key 派生与注入

- 新增注入 `options.getWorkspaceCommentTarget: () => WorkspaceCommentTarget`，dashboard 提供：`() => ({ navigationIdentity: getCurrentOpenWorkspace()?.navigationIdentity ?? 'empty-window' })`。
- 装配链：dashboard → `composition.ts` options（L161-163 附近）→ `viewer.ts` L391-401。
- viewer restore 两条路径（L628-631、L1258-1260）不变：同窗口同 key，restore 幂等重读。

### 7.3 迁 key：`workspaceCommentScopeSync.ts`（新，`src/aiSessions/conversation/`）

```ts
export class WorkspaceCommentScopeSync {
    constructor(private readonly options: {
        store: WorkspaceCommentStore;
        getCurrentNavigationIdentity: () => string;
        freeze: () => Promise<void>;
        unfreeze: () => void;
        aliasStore: { read(): Promise<KeyAlias[]>; write(aliases: KeyAlias[]): Thenable<unknown> };
        runLegacyMigration: () => Promise<void>;   // §7.4，首次使用时执行
    }) {}
    private lastKey: string | null = null;
    private legacyMigrationDone = false;
    private inFlight: Promise<void> | null = null;  // 单 flight（I6）

    async ensureCurrent(): Promise<boolean /* migrated */> {
        if (!this.inFlight) this.inFlight = this.ensureCurrentUnlocked()
            .finally(() => { this.inFlight = null; });
        return this.inFlight;
    }
    // ensureCurrentUnlocked:
    // 1. lastKey===null（启动）：当前 key 有文件→采纳；无文件→查 alias 表领养（D7）；
    //    随后首次执行 runLegacyMigration()（D11，freeze 保护内）。
    // 2. lastKey!==current（转换）：empty-window 双向豁免（D7）；
    //    freeze → migrateTarget → 成功写 alias → 返回 true（调用方强制刷新内存，D10）。
    // 3. lastKey===current：noop。
}
```

- **迁移语义（B2 勘误）**：`store.migrateTarget(previous, next)` = copy+delete——`loadStrict(previous)` → 以 **next target** 写入（`saveIfAbsent`/临时文件+rename 原子写，`snapshotFileStore.ts` L205-213 会内嵌新 target）→ 删旧文件（空列表 save 即删语义 L88-97 或显式 unlink）。两侧都有文件 → 按 id 合并（`updatedAt` 新者胜，超限全保留 D8）后写入 next + 删旧。返回 `'copied'|'merged'|'noop'`。崩溃窗口留下双文件 → 下次走 merge 分支兜底。
- **freeze 配对计数（S4/I8）**：范例无 unfreeze（`onReset` 复位）——scopeSync 用配对计数而非裸标志，防 viewer reset（viewer.ts L1250）在迁移中途静默解冻；这是对 freeze 语义的扩展，在代码注释中注明。
- **串行（I6）**：`ensureCurrent` 单 flight 记忆化；restore（viewer Promise.all 内）与 enqueue 并发进入时共享同一 Promise。
- **内存刷新（D10/B3）**：`WorkspaceCommentController.enqueue` override——`await scopeSync.ensureCurrent()` 返回 `true` 时先 `await this.restore(当前 target/generation)` 再放行 `super.enqueue`；restore 路径本身迁移后继续正常 load 流程，天然读到迁移后内容。
- revision 说明：store save 无 CAS、不比 revision，「合并写回 revision 取两侧最大+1」并非保护手段（v1 论证错误）——真正的不变量是 D10（迁移后刷新内存态）；合并写回 revision 仅取两侧最大值以保持单调。

### 7.4 存量迁移：`legacyProjectCommentMigration.ts`（新，**落点 `src/dashboard/sections/`**）

**落点论证（I5）**：需依赖 `projects/openProjectMatcher`（MOD-PROJECT-CATALOG）与 `workspaces/currentWorkspaceSessionAuthority`（MOD-WORKSPACE-IDENTITY），MOD-AI-SESSION-CONVERSATION 的 mayDependOn 不含这两个——放 `src/dashboard/sections/`（MOD-DASHBOARD-SHELL 依赖齐全，`conversationStack.ts` 有同时 import 两者的先例），避免新增架构边声明。

- 触发：D11 惰性——由 scopeSync 启动分支首次调用（fire-and-forget 的激活抢跑方案已否决，B4）。
- legacy reader 内嵌本文件（I7）：旧目录常量 `'project-comments/v1'` + 旧 hooks（`isValidTarget`/`targetsMatch`/`digestIdentity: { projectId }`，自 `projectCommentStore.ts` L41-46 复制冻结）。
- 收集 candidate projectId：①`tmuxRuntimeBindingStore.listKnown()` 过滤 `workspaceNavigationIdentity === 当前窗口` → cwd；②活跃 runtimes（`aiSessionRuntimeCoordinator.getActive()`，S5 修正来源）→ cwd；③cwd→`vscode.Uri` 适配层 → `openProjectMatcher` 匹配 savedProjects → projectId（remote 场景借 `projectPathMatchesWorkspaceUri` 的 authority 逻辑）；④`currentWorkspaceSessionAuthority.getProjectId(...)` legacy id。
- 逐 projectId 读旧文件 → 按 §7.3 合并规则写入当前窗口 key → 删旧文件。幂等；无法归属的旧文件保留磁盘。
- 完成后：CHANGELOG 条目（随 P3 PR）+ webview 状态行一次性 dismissible 提示（「Workspace 笔记已合并为本窗口共享」，复用 `data-conversation-status`，§6.2）。

### 7.5 空窗口

`getCurrentOpenWorkspace()` 为 `null` → resolver 产出 `'empty-window'`；写入正常允许，迁 key 双向豁免（D7）。

## 8. 测试设计

### 8.1 契约变更矩阵

| 契约 | 分期 | 变更 |
| --- | --- | --- |
| CONVERSATION-COMMENTS-LAYOUT-001 | P1+P2 | P1：语义改 clamp（7024-7026 scrollHeight 断言改写；7020-7023 textContent 全文断言保留）；P2：堆叠描述改 tab |
| CONVERSATION-COMMENTS-UI-001 | P1+P2 | P1：7 处 pill 断言；P2：per-tab filter |
| CONVERSATION-TELEMETRY-CONTROLLER-001 | P1 | 补 pill 初始文案断言 |
| PROJECT-COMMENTS-UI-001 | P2+P3 | P2：sash/折叠段重写 + 6101/6202 过桥；P3：空态作用域文案 |
| PROJECT-COMMENTS-CONTROLLER-001 / PERSISTENCE-001 | P3 | target/freeze/key 措辞（owners 文件更名同步；evidence 含 viewer.ts/dashboard.ts 保留） |
| CONVERSATION-SESSION-REBIND-001 | P2 边缘 + P3 | 缺省 tab 可见性；P3 补 project 豁免断言 |
| CONVERSATION-OUTLINE-NAVIGATION-001 | P2 边缘 | 钉住片段人工核对 |
| CONVERSATION-COMMENTS-DOM-STABILITY-001 / PROJECT-COMMENTS-001 | — | 不变更 |

### 8.2 新增契约

| id | 分期 | 内容 | owner |
| --- | --- | --- | --- |
| CONVERSATION-COMMENTS-PILL-001 | P1 | `S · W` 口径、`0 · 0` 恒显、tooltip 完整信息、project mutation 后 W 刷新（D1）；P1/P2 为 projectId 口径、P3 起窗口口径（契约措辞分期更新） | tests/browser/conversationViewer.test.js |
| CONVERSATION-COMMENTS-CLAMP-001 | P1 | 溢出才出现 toggle、展开内存态+pruning、编辑豁免、**done 卡豁免**、reveal 自动展开、全文在 DOM、**两栈一致**、240px/800px 下 clamp 后单屏 ≥3 卡 | tests/browser/conversationViewer.test.js |
| CONVERSATION-COMMENTS-TABS-001 | P2 | 切换/持久化/缺省 Session、键盘导航（自动激活）与 tablist a11y、跨 tab composer 对称流、Esc/✕ 取消返回原 tab、pending 切 tab 跳过焦点恢复、切 tab 复位确认态 | tests/browser/conversationViewer.test.js |
| WORKSPACE-COMMENTS-SCOPE-001 | P3 | 迁 key：copy+delete、合并、freeze 拒绝写入、单 flight、empty-window 双向豁免、alias 领养、**identity 不变→无迁移**、迁移后内存刷新（D10） | tests/unit/aiSessions/workspaceCommentScopeSync.test.js（新） |
| WORKSPACE-COMMENTS-MIGRATION-001 | P3 | 存量迁移：收集/合并/幂等/不可归属保留/串行对账（D11） | tests/unit/aiSessions/…（落点随实现文件，dashboard sections 测试目录） |
| WORKSPACE-COMMENTS-WINDOW-001 | P3 | 同一 viewer 切到另一 project 的 session 后笔记一致 + source/dispatches 原样展示不过滤（harness 现成：tests/integration/dashboard/conversationViewer.test.js L289-334 有 createViewer mock 注入与多 target 切换先例，新文件或并入均可） | tests/integration/dashboard/ |

### 8.3 单元测试落点

- P3：`workspaceCommentStore.test.js` 全量重写（+`migrateTarget` 用例）；`workspaceCommentController.test.js` 中幅重写（+freeze）；`workspaceComments.test.js` 仅 require 路径更名。
- P1：telemetry controller 单测补 pill 初始文案；pill 计数口径由浏览器测试覆盖（前端无独立单测设施），host 侧由 telemetry controller 单测覆盖初始值。
- `check-changed-coverage`：P3 全部新 src 代码须确定性单测覆盖。

### 8.4 手动测试

新增 `docs/manual-tests/comments-panel-v2.md`（P3 前落地）：untitled 多根工作区重启后身份恢复（D7 平台假设）、Save Workspace As 后 alias 领养、增删根目录不丢笔记、empty-window 行为。

## 9. 构建与 CI 守卫清单

- `npm run test-compile`；`npm run lint`；
- `media/` 镜像：只改 `src/webview/*.js`，跑 gulp `copyWebviewAssets`（L35-39）；
- **scss**：源在 `media/*.scss`，`npx gulp buildStyles` 生成 css（L19-23）；**盲区：`conversationViewer.css` 无新鲜度守卫**（release packaging 只查存在性）——忘跑 gulp 不会红，PR 检查清单须人工核对（后续可考虑补对等校验，不在 v2）；
- `check-behavior-contracts.js`：新契约 id 字面出现在 owner 文件；更名文件同步 owners/evidence；
- **`test:architecture-policy`**（I5）：`checkClosedWorld` 要求新生产文件登记 `docs/testing/architecture-modules.json`；`checkModuleBoundaries` 约束依赖方向（§7.4 落点论证）；
- `checkWebviewManifest.js` / `EXPECTED_MAIN_ENTRIES`：P2 不新增脚本（D6），本 v2 不触发；
- 每个 PR 前：`git diff --check` + focused tests。

## 10. 分期交付

- **P1 PR**：pill 双计数 + 卡片截断。文件：`conversationTelemetryController.ts`、`conversationCommentsScripts.js`（+media 镜像）、`conversationViewer.scss/css`、conversationViewer.test.js（7 断言 + clamp 用例）、behavior-contracts.json（LAYOUT-001 语义、PILL-001/CLAMP-001 新增）、telemetry controller 单测。
- **P2 PR**：子 tab。文件：`viewerDocument.ts`、`conversationCommentsScripts.js`（+镜像）、`conversationViewerScripts.js`、scss/css、浏览器测试改写（§6.6）、behavior-contracts.json（TABS-001 + LAYOUT/UI 更新）。
- **P3 PR**：窗口级作用域。文件：§7.1 影响面全量（含 `architecture-modules.json`、`behavior-contracts.json`）+ `workspaceCommentScopeSync.ts` + `legacyProjectCommentMigration.ts` + 装配四件（viewer/composition/conversationStack/dashboard）+ 单测重写/新增 + **`CHANGELOG.md`** + `docs/manual-tests/comments-panel-v2.md`。

每期独立绿：P1/P2 后既有 `CONVERSATION-COMMENTS-*`（除列明更新项）保持绿；P3 后 PROJECT-COMMENTS 三条完成演进。

## 11. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| clamp 测量时机遗漏（隐藏/宽度变化） | D9 ResizeObserver 统一重测 + 渲染尾部同步测量 |
| 迁 key「rename」导致文件不可读 | copy+delete 语义（§7.3）；SCOPE-001 覆盖 |
| merge 后内存态 clobber 丢笔记 | D10 强制刷新；enqueue override 先 restore 再放行 |
| 存量迁移与正常 save 互相覆盖 | D11 惰性化 + 与迁 key 共用 freeze 串行点 |
| host 重启恰逢身份转换 → 孤儿 key | D7 alias 表启动领养；empty-window 双向豁免 |
| 双重迁移并发 | ensureCurrent 单 flight 记忆化（I6） |
| viewer reset 中途解冻 | freeze 配对计数（§7.3） |
| P2 删 sash/count 遗漏 gate 同步 → UI 静默不可用 | §6.5 列为必改项（含 L263/L281） |
| 3859 钉住片段 replace 失配静默弱化 | 实施时人工核对 |
| P3 迁移误合并（cwd 错配 project） | 匹配取规范化路径全等；归属不确定不迁移 |
| 架构守卫红（未登记/越界依赖） | §7.4 落点 dashboard/sections/；§9 清单含 architecture-modules.json |

## 12. 开放实现细节（实施时定，不阻塞）

- clamp 行数阈值（正文 6–8 行、quote 2–3 行）在浏览器测试中调定；
- tab 条在 192px 最小宽度下的折行/截断样式；
- 存量迁移一次性提示的确切文案；
- ~~`updateToggle` 死传递清理~~（已定为 P2 顺带进行，§6.5）。
