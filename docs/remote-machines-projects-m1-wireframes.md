# Remote Machines × Projects — Milestone 1 低保真线框

> 状态：待 Owner 验收。线框只确定层级、操作位置、状态和响应式行为；颜色、
> 间距与图标细节会在实现中沿用 VS Code theme tokens 与 Codicon 微调。

总览图：[`assets/remote-machines-projects-m1-wireframes.svg`](./assets/remote-machines-projects-m1-wireframes.svg)

窄宽度图：[`assets/remote-machines-projects-m1-narrow-wireframes.svg`](./assets/remote-machines-projects-m1-narrow-wireframes.svg)

## 1. 视觉与交互方向

- 采用 VS Code Explorer 式平面列表，不延续每个 Project 一张大卡片的结构。
- 行高目标：Machine 28px、Environment 26px、Project 24px；真实实现允许跟随
  VS Code density/theme 调整，不把数值写成用户设置。
- 左侧 disclosure 只展开/收起；右侧 action slot 才执行打开/配置。
- Machine 使用较强字重，Environment 用类型图标与缩进，Project 使用普通文本；
  层级不能只靠颜色区分。
- 每行依次为名称区、非交互状态区、一个主动作和 overflow menu；状态不能伪装
  成按钮。最多显示一个高优先级状态，避免名称被多个 badge 挤压。
- Toolbar sticky，整个页面只有一个纵向滚动容器。
- Project 名称区域是明确的打开链接/按钮，hover、focus-visible 与 active 均覆盖名称
  区；drag handle 和次要动作只在 hover/focus-within 显示，overflow menu 始终能
  通过 pointer button 或当前行的 Shift+F10 等价菜单到达。
- 实现优先复用 `webviewIcons.ts` 中验证过的 Codicon，语义映射为 Machine=remote/
  server、Host=vm、Dev Container=package、new window=empty-window、setup=settings-
  gear、more=ellipsis；最终图标必须有完整 accessible name，不能单靠 glyph 表义。
- 中性未配置状态使用 `descriptionForeground`/普通边框；只有依赖缺失、启动失败和
  高风险报告使用 warning token。focus 使用 `focusBorder`/outline；high contrast 与
  forced colors 下不依赖背景色或动画区分状态。

## 2. W1 — 日常浏览与打开

```text
┌ PROJECTS ─────────────────────────────┐
│ [ Search projects and machines... ]   │
│ [Tags] [Add ▾]                        │
├───────────────────────────────────────┤
│ ▾ FAVORITES                           │
│   ★ agent-pivot                       │
│     devbox-a › Host                    │
│   ★ api                               │
│     devbox-a › Dev Container · api     │
│                                       │
│ ▾ 󰒋 devbox-a                 [↗] [⋯] │  Machine disclosure / Host open
│   ▾ 󰌽 Host                            │  no duplicate Host open; + is in … below 360px
│       agent-pivot              [⋮⋮] [⋯]│
│   ▾ 󰆍 Dev Container · api      [↗] [⋯]│
│       api                      [⋮⋮] [⋯]│
│                                       │
│ ▸ 󰒋 gpu-02       Not configured [⚙] [⋯]│
└───────────────────────────────────────┘
```

合同：

- 点击 `devbox-a` 左侧区域只折叠/展开，不打开机器。
- `↗` 始终表示在新窗口打开；Machine 的 `↗` 打开 Host。
- Host 行可以添加 Project，但不重复 Host 状态和打开按钮。
- Favorites Project 固定两行显示名称与完整 `Machine › Environment` 上下文；
  取消收藏不删除原 Project。
- drag handle 只用于同层排序；菜单提供 Move Up/Down。

## 3. W2 — Tag 过滤与 0 matches

```text
┌ PROJECTS ─────────────────────────────┐
│ [ Search... ]                         │
│ [Tags (2)]  api  active               │
│ ┌ Tags ─────────────────────────────┐ │
│ │ Matches all                      │ │
│ │ [✓] api                          │ │
│ │ [✓] active                       │ │
│ │ [ ] docs                         │ │
│ │                           [Done] │ │
│ └───────────────────────────────────┘ │
│ 1 project on 1 machine [Clear filters]│
│ ▾ FAVORITES                           │
│   ★ agent-pivot                       │
│     devbox-a › Host                    │
│ ▾ devbox-a                        [↗] │
│   ▾ Host                              │
│       agent-pivot      #api #active   │
│ ▸ gpu-02              0 matches   [↗] │
└───────────────────────────────────────┘
```

合同：

- 多 tag 固定 AND；筛选面板内明确写 `Matches all`。checkbox 即时应用，Done 与
  Escape 都只关闭并保留当前选择；首期不展示 facet 数字。
- 面板外最多两个 tag，更多显示 `+N`；不让 chips 多行占据列表高度。
- Tag-only 过滤始终保留 Machine；0 命中 Machine 临时压缩成一行，Host 打开动作
  仍可用。disclosure 仍能手动展开 Host/Dev Container 行与它们的打开动作，但
  不显示不匹配 Project。
- 搜索与 tag 同时存在时，结果摘要按唯一 Project 计数，不计算 Favorites 镜像。
- Escape 关闭 popover 并把焦点还给 `Tags (N)`；结果摘要旁唯一的 Clear filters
  清空全部 tag 并恢复过滤前状态。

## 4. W3 — 当前 VS Code 未配置 / Dev Container 启动

```text
未配置 Machine
┌───────────────────────────────────────┐
│ ▾ gpu-02                              │
│   Not configured in this VS Code      │
│   Machine and projects are synced.    │
│   No connection has been set up here. │
│                                       │
│   [Set up]                     [⋯]    │
│   ▾ Host                              │
│       training-platform               │
└───────────────────────────────────────┘

Dev Container 行状态变体（status 与 action 分离）
┌──────────────────────────────────────────────┐
│ ▾ Dev Container · api            [Open ↗] [⋯]│
│ ▾ Dev Container · api  Starting…  [Open]  [⋯]│
│ ▾ Dev Container · api  Finish… [Open another]│
│ ▾ Dev Container · api  Needs Setup [Set up][⋯]│
└───────────────────────────────────────┘
```

合同：

- 设置表单分为“同步的 Machine 信息”和“只保存在此 VS Code 安装实例的
  Connection”两个区块。
- 输入 SSH target 不立即连接；Machine 行只显示 `Set up`，表单内选择 `Save` 或
  `Save & Open`，只有后者才打开。
- `Starting…` 是非交互 status，命令 pending 时相邻 Open 暂时禁用。命令交接后
  status 显示 `Finish connecting in the new window`，主动作变为 `Open another
  window`；不显示 Connected，超过 30 秒恢复可操作状态。
- Needs Setup 菜单同时提供 Reconfigure、Remove 和 Open Remote logs。

## 5. W4 — Migration / Downgrade 报告

```text
┌ MIGRATION PREVIEW ────────────────────┐
│ V1 remains active until you confirm.  │
│                                       │
│  12 Projects       3 Machines         │
│   2 Dev Containers 4 Group tags       │
│                                       │
│ ✓ 9 ready                             │
│ ! 3 will be kept for review           │
│   2 cannot open until repaired         │
│   1 project keeps 10 tags              │
│                                       │
│ [Review items]                         │
│ [Cancel]      [Migrate and review 3]  │
└───────────────────────────────────────┘

┌ PREPARE FOR DOWNGRADE ────────────────┐
│ A V2 recovery copy will be kept.      │
│ Recovery is kept in this VS Code.     │
│                                       │
│ ✓ 10 available in V1                  │
│ !  3 unavailable in V1                │
│   Kept in V2 recovery; review required │
│ Scope: shared safe V1 view             │
│                                       │
│ Target: last supported V1 release     │
│ [Cancel]         [Prepare downgrade]  │
└───────────────────────────────────────┘
```

合同：

- Preview 在确认前不修改权威数据；snapshot/校验/目标 backend 不可写属于
  Blocking，修复前禁用主按钮。
- `Will be kept for review` 可带问题迁移但记录不丢失；`Cannot open until
  repaired` 明确迁移后暂不可打开。数字可展开；Blocking 只提供 Repair/Retry/
  Cancel，可延期项使用 `Review later` 并持续留在 Assign/Repair 队列。
- Prepare for Downgrade 明确 UI bridge 权威副本属于当前 VS Code；逐项列出
  `Unavailable in V1`，说明旧版本中不会显示或无法打开，但仍保留在 V2 recovery。
- Downgrade Preview 必须显示 backend scope：local 时为目标 workspace Extension
  Host；synced 时为所有旧 V1 Client 共用的 safe compatibility subset，并明确旧
  插件实际读取 backend materialization、不会读取 UI bridge projection。
- 迁移/降级报告不是侧栏内嵌 modal 或一次性 toast，而是独立全宽 WebviewPanel；
  从 Projects `…` 可以再次打开。总览 SVG 中的两个卡片是两条独立 route 的并排
  状态样例，不会同时出现在实际页面。

## 6. 补充任务流

### W5 — Setup / Rebind 确认合同

```text
SET UP CONNECTION                   REBIND CONNECTION
Machine: gpu-02                     Machine: gpu-02
Saved: this VS Code only            Old target: gpu-old
Type: SSH                           New target: gpu-02
Target: [gpu-02________]            Other VS Code installs: unchanged
[Cancel] [Save] [Save & Open]       Projects moved: none
                                    [Cancel] [Save] [Save & Open]
```

- 输入 target 不连接；Save 只保存，Save & Open 保存后发起窗口，两者均以按钮
  文案明确表达，不根据入口隐式决定。
- Cancel、空值/非法值、bridge protocol 不匹配、Remote-SSH 缺失均零写入。
- 保存成功而窗口连接失败时保留 Profile，并显示 Retry/Open Remote logs。

### W6 — Add / Save / Move 流程合同

- `Save Current Project`：匹配唯一 Machine/Environment 时预选；无匹配或歧义时
  必须选择/创建，提交前预览 `Machine › Environment › normalized path`。
- Environment `+`：归属锁定，仅输入相对该 Environment 的路径和 Project
  metadata；重复 `environmentId + normalizedPath` 阻止提交。
- `Move`：独立向导逐项提供 Keep path/Edit path/Skip，展示 launch anchor 影响；
  Cancel/验证失败零写入，并发 placement/delete 冲突进入 Review。
- 进入对应实现 milestone 前，为正常、歧义、重复、无效路径、取消和写入失败建立
  可交互 fixture；线框不把 Add、Rebind 和 Move 合并成一个通用表单。

## 7. 窄宽度矩阵

| 宽度 | Toolbar | Row action | Project context |
| --- | --- | --- | --- |
| `>= 360px` | Search + Tags + Add | 主动作 + `+` + `…` | Favorites 显示两行完整位置文本 |
| `280–359px` | Search 独占一行；Tags/Add 下一行 | 仍保留主动作；`+` 收入 `…` | Machine/Environment context 截断但 tooltip/aria-label 完整 |
| `< 280px` | Search + icon toolbar，两行上限 | 主动作缩为 icon；状态进入 tooltip/次行 | Project 名优先，描述隐藏 |

任何宽度下：

- 不产生横向页面滚动；popover 钳制在 viewport 内。
- 名称使用中间或尾部省略，但 accessible name 保留完整 Machine、Environment、
  Project 与状态。
- 200% zoom 时允许 Toolbar 两行，不把 Machine/Environment 做成横向卡片。
- 高对比度下用 border/outline/文字共同表达选中、焦点和状态。

## 8. 键盘与焦点合同

Favorites 与主目录是两个带 heading 的原生 nested list section，不声明
`role=tree/treegrid`：

1. 每个可见行只有 disclosure 或 Project/Favorite 主链接进入正常 Tab 顺序；
   外层 `li` 与右侧 pointer action 不增加 Tab stop，避免 500 Project 时按动作数倍增。
2. Machine/Environment button 的 Enter/Space 只切换 disclosure；Project/Favorite
   link 的 Enter 打开 Project。不模拟 Left/Right/Home/End/type-ahead tree 导航。
3. 当前行按 Shift+F10 打开含 Open/Set up/Retry/More 等同等动作的原生菜单；菜单
   使用 Up/Down/Home/End，Escape 返回该行 primary control。右侧 pointer buttons
   保持可见、具名并设 `tabindex=-1`。
4. 外层语义 `li` 内的 primary control 与 pointer actions 是同级 DOM，禁止
   button/link 嵌套；children 使用原生嵌套 `ul`，disclosure 维护
   `aria-expanded`/`aria-controls`。
5. 折叠含焦点子树时回父 disclosure；过滤/刷新移除当前项时，按稳定 ID 优先
   恢复到同一 Project 镜像、相邻项、父 Environment、父 Machine、section 首项，
   最后才回到结果摘要。
6. 从菜单执行打开后焦点返回原行 primary control；运行状态通过去重的礼貌
   `aria-live` 摘要播报，不让 registry 刷新抢焦点。

可测试名称模板：`Expand {Machine}`、`Collapse {Environment}`、`Open Host on
{Machine} in a new window`、`Open Dev Container {Environment} on {Machine} in a
new window`、`Set up connection for {Machine} in this VS Code`、`Rebind connection
for {Machine} in this VS Code`、`Add project to {Environment} on {Machine}`、
`Retry opening Host on {Machine}`、`Open another Host window on {Machine}`、
`Set up Dev Container {Environment} on {Machine}`、`More actions for Machine
{Machine}`、`More actions for {Environment} on {Machine}`、`More actions for
{Project}`、`Open {Project} on {Machine}, {Environment}`、`Favorite shortcut to
{Project}, on {Machine}, {Environment}`。

## 9. 需要本次验收的视觉问题

- Machine 行右侧固定 `Open in New Window`，Host 子行没有重复打开入口。
- Favorites 保持独立 section，但采用紧凑 Project 行而非大卡片。
- 0 matches Machine 压成单行，同时保留打开入口。
- 未配置状态以内联说明展开，而不是每个 Project 重复警告。
- Migration 与 Downgrade 使用可回访报告页/对话框，不使用一次性通知。
