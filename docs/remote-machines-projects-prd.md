# Remote Machines × Environments × Projects 一体化 PRD

日期：2026-09-03

状态：需求决策已确认，待线框与技术方案评审

## 1. 一句话定义

把现有 `PROJECTS` 从“用户 Group 下的项目收藏夹”重构为跨设备同步的开发入口：`Machine` 表示项目在哪台开发机器上，`Environment` 区分宿主机与该机器上的 Dev Container，`Tag` 表示项目是什么；用户既能打开机器或环境的新窗口，也能直接进入具体项目。

## 2. 背景与现状

Agent Pivot 当前已经具备两类相关能力，但尚未形成统一模型：

1. **项目管理：** 保存本地或远端项目，按用户创建的 Group 分组，支持收藏、排序、颜色、名称、描述、搜索和 tag。
2. **远端项目打开：** 远端项目保存为 `vscode-remote://...` URI，并通过现有导航协议在 VS Code 窗口中打开。

当前数据结构的核心是 `Group → Project`。远端机器与 Dev Container 只隐含在项目 URI authority 中，因此存在以下问题：

- 用户无法先看到“我有哪些开发机器”，只能从项目路径推断。
- 同一台机器的宿主环境与 Docker Dev Container 缺少清晰层级。
- 没有项目的 SSH target 无法保存为稳定入口。
- Group 同时承担位置与分类职责，扩展到多机器后语义不稳定。
- 项目目录会跨设备同步，但不同客户端连接同一 Machine 的方式可能不同；直接同步 `Local` 或 SSH alias 会产生错误解释。

当前代码已经实现 tag 字段、tag 展示和多 tag AND 过滤。本 PRD 的 tag 工作重点是 Group 迁移、入口完善以及与机器层级组合，而不是从零增加 tag 能力。

## 3. 产品目标

### 3.1 核心目标

- 用户首先按 Machine 识别项目所在的开发机器，再区分 Host 与 Dev Container Environment。
- Machine 与 Environment 行的左侧 disclosure 只负责展开/收起；Machine 右侧负责打开 Host，Dev Container 右侧负责打开该容器，避免单击行为含糊和重复操作。
- 点击项目可在正确的 Machine 和 Environment 中打开具体目录或 workspace。
- Machine、Environment、Project、tag 和收藏跨设备同步；每台客户端的连接配置保持本地化。
- 多个 tag 采用“匹配全部”的 AND 过滤。
- 保留独立 `FAVORITES` 分组，延续当前使用方式和排序。
- 现有项目、远端 URI、tag、收藏、颜色与排序在升级后无损保留。

### 3.2 成功标准

- Machine、Dev Container 或 Project 行已经可见时，一次明确点击即可发起打开；常用 Project 可从 Favorites 一次点击到达。
- 用户无需阅读完整 URI，即可区分 Machine、Host 和 Dev Container。
- 在任意客户端上，未配置连接方式的同步 Machine 仍然可见，不被误认为数据丢失。
- 迁移后项目数量、路径、tag、收藏与颜色保持一致；旧 Group 内相对顺序保持，跨 Group 使用确定性拼接顺序。
- 在技术设计指定的基准环境中，以 500 个 Project、50 个 Machine 为数据集，展开、搜索和 tag 过滤的 p95 响应低于 100ms。

## 4. 非目标

- 不实现 SSH 协议、终端登录、密钥生成、密码保存或 SSH Agent 管理。
- 不替代 Remote-SSH 的 SSH config 编辑、端口转发、日志和诊断页面。
- 不解析或同步完整 `~/.ssh/config`；首期 Machine 仅来自手动添加或已有项目派生。
- 不通过定时 ping 或后台 SSH 连接判断机器在线状态。
- 不在首期提供远端目录浏览器。
- 不在首期重构 `OPEN` 页面或跨窗口 AI session 协议。
- 不在首期提供通用 Docker 容器管理；只管理由项目 Dev Container 配置定义的环境。
- 不在首期完整管理 WSL、Tunnel 和未知 Remote 生命周期；只保证既有项目可迁移、可见、可打开。
- 不自动判断两个 SSH alias 是否指向同一台物理服务器，也不自动合并 Machine。
- 不建立独立 tag 管理后台、预设 tag 分类或 tag 权限系统。
- 不承诺任意历史插件版本都能无损读取 V2；正式支持的降级目标是发布说明指定的最后一个 V1 兼容版本。

## 5. 用户与核心场景

### 5.1 主要用户

同时使用多台开发机、多个代码仓库和多个 VS Code 窗口的软件工程师。他们希望从一个稳定目录快速进入正确的机器、容器和项目，而不是先理解 URI 或处理连接配置。

### 5.2 核心场景

1. 用户看到 `devbox-a`、`gpu-02` 等 Machine，以及各自的 Host 和 Dev Container。
2. 用户点击 `gpu-02` 行右侧打开按钮，在新窗口连接 SSH Host。
3. 用户展开 `devbox-a / Dev Container · api`，点击项目进入容器中的工作目录。
4. Dev Container 尚未运行时，用户点击其打开按钮，Agent Pivot 使用关联项目配置启动并连接容器。
5. 用户选择 `backend` 与 `urgent` 两个 tag，只查看同时具备两个 tag 的项目；Machine 仍然保留在列表中。
6. 用户在笔记本上通过 `devbox` 连接某 Machine，在办公室电脑上为同一 Machine 配置 `devbox-office`。
7. 同一 Git 仓库在两台开发机上各有一份工作目录，它们作为两个独立 Project 展示。

## 6. 核心概念与身份边界

| 概念 | 定义 | 是否同步 |
| --- | --- | --- |
| Machine | 一台逻辑开发机器，使用稳定 UUID 标识 | 是 |
| Environment | Machine 内的运行环境；首期为 `Host` 或由 `devcontainer.json` 定义的 Dev Container | 是 |
| Project | 某个 Environment 内可由 VS Code 打开的具体目录、workspace 或文件 | 是 |
| Tag | 项目的自由分类标签 | 是 |
| Favorite | 项目的收藏标记及收藏区顺序 | 是 |
| Client | 当前桌面端的 VS Code 安装实例；由 `extensionKind: ui` companion bridge 持有身份，不等同于物理设备或远端 Extension Host | 否，仅由 UI bridge 保存本地 client ID |
| Connection Profile | 当前 Client 如何访问某个 Machine，例如 Local 或某个 SSH target | 否 |
| Runtime state | 窗口、连接请求和临时 Docker container ID 等当前运行状态 | 否 |

### 6.1 Machine、SSH alias 与物理服务器

- `machineId` 是跨设备同步身份，不能由 SSH alias、主机名、IP 或当前客户端推导。
- 手动添加 Machine 时生成随机 UUID；是否立即为当前客户端绑定连接方式由用户选择。
- 在同一客户端分别添加两个 SSH alias，默认生成两个独立 Machine；即使它们最终连接同一物理服务器，也不自动合并。
- 同一同步 Machine 在不同客户端可以绑定不同方式：本机使用 `Local`，笔记本使用 `devbox`，办公室电脑使用 `devbox-office`。
- 未配置 Connection Profile 的客户端仍显示 Machine 及其项目，打开操作显示为 `Configure Connection`。
- 首期每个 Client 最多把一个 Machine 绑定为默认 `Local`；重新绑定必须明确解除旧绑定并确认影响。
- `Set up/Rebind in this VS Code` 只修改 UI bridge 中的本地 Connection Profile，不改变 `machineId`、Environment 或 Project 归属。
- `Create Separate Machine` 才表示创建另一台逻辑 Machine；`Move Project` 是独立的同步归属变更。

### 6.2 Environment 与 Dev Container

- 每个 Machine 固定拥有一个 `Host` Environment。
- Dev Container 是 Machine 的子级，而不是与 Machine 并列的远端类型。
- Dev Container Environment 使用稳定 UUID；迁移场景使用确定性 migration ID。临时 Docker container ID 不参与同步身份。
- 容器停止、删除或重建后仍是同一个 Environment。
- Environment 保存独立 launch anchor，包括 Host 内的配置根目录和规范化 `devcontainer.json` 路径；`sourceProjectId` 仅用于回溯来源，不是唯一启动依据。
- 容器未运行时，可以从 launch anchor 自动启动并连接。
- 同一配置明确指向同一 Environment 时可承载多个 Project；仅容器显示名相同不能作为合并依据。
- 多个候选配置不得静默选择；用户必须选择或重新配置 launch anchor。
- 删除、移动或改路径会破坏 launch anchor 时，必须先选择替代锚点、同时移除空 Environment，或将其显式标记为 `Needs Setup`。
- 空 Dev Container Environment 可以 Rename、Reconfigure 或 `Remove from Agent Pivot`；这些动作都不删除真实容器或配置文件。

### 6.3 Project

- Project 表示“某台 Machine 的某个 Environment 中的一份具体工作目录”，不是跨机器合并的逻辑仓库。
- 同一个 Git 仓库位于两台 Machine 时是两个独立 Project。
- Project 必须且只能归属于一个 Environment；Environment 必须归属于一个 Machine。
- 不设置 `Unassigned` 作为常规归属，避免破坏层级不变量。
- V1 本地 Project 来源无法判定时可以暂存在仅供迁移修复的 `Needs Assignment` 收件箱；完成迁移后它不构成长期导航层级。

## 7. 信息架构

`OPEN` 与 `PROJECTS` 继续回答不同问题：

| Tab | 用户问题 | 本次变化 |
| --- | --- | --- |
| `OPEN` | 我现在有哪些窗口和 AI 会话？ | 保持现状 |
| `PROJECTS` | 我的开发机器、环境和项目在哪里？ | 改为 Favorites + Machine → Environment → Project |

### 7.1 PROJECTS 页面结构

```text
PROJECTS
├── Toolbar
│   ├── Search
│   ├── Tags (N) · 打开 Matches all 筛选面板
│   └── Add · Machine / Project
├── FAVORITES                     ← 与当前一致的独立镜像分组
│   ├── agent-pivot               · devbox-a / Host
│   └── api                       · devbox-a / Dev Container · api
├── devbox-a                      [在新窗口打开 Host]
│   ├── Host                      ← 只展开/收起
│   │   └── agent-pivot
│   └── Dev Container · api       [在新窗口打开]
│       └── api
└── gpu-02 · 未配置连接            [配置连接]
    └── Host
        └── training-platform
```

### 7.2 Favorites

- `FAVORITES` 延续当前虚拟分组语义，是收藏 Project 的镜像，不改变其真实 Machine/Environment 归属。
- 收藏项目按 V2 `favoritePosition` 独立排序；降级时才投影回 V1 `favoriteOrder`。
- Favorites 项目行必须展示 `Machine / Environment` 上下文，避免同名项目混淆。
- 在 Favorites 中取消收藏只移除镜像，不删除 Project。
- 搜索和 tag 过滤同时作用于 Favorites 镜像与原位置，过滤语义保持一致。
- Favorites 是主目录树之外的独立 section/landmark；读屏名称使用“Favorite shortcut to {Project}, on {Machine}, {Environment}”。
- Favorites 与原位置引用同一 Project 实体；编辑、状态和取消收藏立即同步，结果计数按唯一 Project 计算。
- Favorites 内拖动只改变 `favoritePosition`；没有收藏或过滤后无匹配时不渲染空 section。

### 7.3 排序

- Machine 默认使用用户稳定顺序；没有历史顺序的新 Machine 按名称稳定排序。
- “当前客户端”“已在 N 个窗口打开”等状态只显示 badge，不触发动态重排。
- Environment 固定先显示 Host，再显示 Dev Container；Dev Container 按用户顺序或名称稳定排序。
- Project 沿用所属 Environment 内的用户顺序。
- Favorites 使用独立收藏顺序，不改变项目原位置排序。
- Machine、同一 Environment 内 Project 和 Favorites 通过专用 drag handle 排序；菜单提供 Move Up/Down 键盘替代。
- 跨 Machine/Environment 的拖动不作为排序手势，必须使用显式 Move 流程。

### 7.4 布局与滚动所有权

- 页面只有一个纵向主滚动容器；Favorites、Machine、Environment 和 Project 均处于同一滚动流。
- Toolbar 保持 sticky，Machine 与 Environment 内不得创建独立纵向滚动区域，也不逐层使用 sticky header。
- 大列表通过 Project 级增量渲染或虚拟化优化，不能用嵌套滚动条规避。
- 视觉采用 VS Code Explorer 式平面列表，通过缩进、Codicon 和字重表达层级，不为每层创建独立大卡片。
- 每行固定为名称区、非交互状态区、一个主动作与 overflow menu；状态区最多显示一个高优先级状态，优先级为：`Needs Repair/Not configured` > `Opening/Failed` > 窗口数 > `This VS Code`。状态不能伪装成按钮，窄宽度下可移到名称下方或 tooltip，但主动作仍可辨认。

## 8. 功能需求

### 8.1 Machine 来源与添加

首期只展示两类稳定 Machine：

- 用户在 Agent Pivot 中手动添加的 Machine；
- 从已有项目可靠派生的 Machine。

首期不抓取 Remote-SSH 主机列表，也不解析或持续同步 SSH config。当前窗口信息只用于匹配已有 Machine、显示运行状态和辅助保存项目，不自动产生长期 Machine 记录。

#### Add Machine

- `Add Machine` 创建新的同步 Machine，用户填写展示名，并可选择是否立即在当前客户端绑定。
- 绑定时选择 `Local` 或输入 Remote-SSH 可识别的 SSH target；表单分区明确标注“跨设备同步”与“仅保存在此设备”。
- `Set up in this VS Code` 为已有 Machine 新建 UI bridge 本地 Connection Profile；`Rebind in this VS Code` 原地替换本地 Profile，不移动任何同步内容。
- 输入 SSH target 不立即发起网络连接。
- 不保存密码、私钥路径、token 或 Remote-SSH 凭据。
- Remote-SSH 未安装时可保存 Machine，但打开按钮提供安装扩展入口。

### 8.2 Machine 与 Environment 行交互

首期使用两个语义化 nested list/disclosure section：Favorites 命名为 `Favorite projects`，主目录命名为 `Development machines`。不声明 `role=tree/treegrid`，避免把多动作行伪装成不完整 composite。每行结构固定为：

- 外层语义 `li` 不可交互；左侧 primary control 与右侧 pointer actions 是同级 DOM，不在 button/link 中嵌套控件。
- Machine/Environment primary button 覆盖 chevron、类型图标和名称，只展开或收起；Project/Favorite primary link 打开 Project。
- 名称区之后依次是非交互 status slot、固定 primary action slot 与 `…`；状态文字不得承担打开、继续或配置动作。
- primary action 放置 `Open in New Window`、`Open another window`、`Set up` 或 `Retry`；`+` 是 `…` 的同级控件，窄宽度下收入 `…`。
- Machine 菜单包含 Rename、Set up/Rebind in this VS Code 和 Remove；Environment 菜单包含 Add Project、Rename、Reconfigure 和 Remove。

打开行为：

- Machine 行是 Host 打开动作和 Host 窗口状态的唯一视觉所有者。
- Host Environment 行只展开/收起并承载 Host Project，不重复显示打开按钮或 Host 状态。
- Host 使用当前客户端的 Local 或 SSH Connection Profile 打开空 Host 窗口。
- Dev Container 使用保存的配置启动上下文打开；未运行时允许自动创建/启动。
- 未配置 Connection Profile 时，status 显示 `Not configured in this VS Code`，Machine 行主动作替换为 `Set up`。Setup 表单固定提供 `Cancel`、`Save` 和主按钮 `Save & Open`；只有选择后者才发起窗口。Rebind 表单使用相同三个结果，不从入口位置猜测是否自动打开。
- Machine 与 Dev Container 的打开操作默认新建窗口，不复用当前窗口。

### 8.3 可观测状态

Agent Pivot 只展示自身能够可靠确认的状态：

| 状态 | 含义 |
| --- | --- |
| `Opening a new VS Code window…` | 正在调用 VS Code 打开命令；只在命令未返回时禁用重复操作 |
| `Finish connecting in the new window` | VS Code 已接受命令，但当前窗口无法确认认证或最终连接结果 |
| `N windows` | 跨窗口注册信息确认该环境已有活动窗口 |
| `VS Code couldn’t start the window` | 打开命令在当前扩展侧直接失败，同一 action slot 提供 Retry |

SSH 认证失败、网络超时、Host Key 等详细错误由新 VS Code 窗口和 Remote-SSH 展示。不得把“命令已接受”表述为“Connected”，也不得推断无法观测的 `Connection failed`。

- 打开命令返回后立即解除按钮禁用；成功交接时 status 短暂展示 `Finish connecting in the new window`，主动作显示 `Open another window`；5 秒后 status 回到 Idle、主动作回到 `Open in New Window`。
- 空 Host 窗口可能无法进入跨窗口 registry，因此 `Finish connecting in the new window` 可以是最终可观测结果。
- 用户在提示消失后可再次打开；提示仍存在时再次操作需要明确为 `Open another window`。
- Dev Container status 依次为 `Starting…`、`Finish connecting in the new window`，仅收到窗口注册后显示 `N windows`；它们均为非交互文本，操作始终由相邻主动作承担。
- `Starting…` 超过 30 秒后解除本窗口的 pending 状态，status 展示非交互文案 `Setup may still be continuing in the new VS Code window`，并提供 Retry、Update configuration 与 Open Remote logs。

### 8.4 Project 打开

- 点击 Project 主区域沿用现有打开控制器语义：当前项目不重复打开，其他项目默认新建窗口。
- Project 菜单继续提供 `Open in New Window`、`Open in Current Window`；本地项目继续提供 `Add to Workspace`。
- 打开时使用 Project 的同步归属与当前客户端 Connection Profile 生成实际 URI，不把其他客户端的 SSH alias 当成本地 authority。
- 找不到 Connection Profile、Environment 启动配置或有效路径时保留项目，并提供对应修复入口。
- 打开失败不得删除、隐藏或静默重写项目。

### 8.5 添加与保存 Project

`Save Current Project` 是首选入口；手动输入路径是 Advanced 流程。Dev Container 不要求用户手写完整 Remote URI。

#### 从 Environment 下添加

- 点击 Environment 的 `+` 后锁定 Machine 与 Environment。
- 用户输入该 Environment 内的绝对路径、workspace 路径或兼容的现有 URI。
- 表单同时支持名称、描述、tag、颜色与 Favorite。
- 表单实时展示解析后的 `Machine / Environment / Path`；无法验证时明确标记 `Saved without validation`。
- Host Project 使用 Connection Profile 生成实际打开 URI。
- Dev Container Project 需要关联稳定的 Dev Container 配置来源。

#### 保存当前 Project

- 当前窗口能够匹配已有 Machine/Environment 时，直接保存到对应位置。
- 无匹配项时，引导用户选择已有 Machine 或创建 Machine，不静默根据临时 authority 合并。
- 当前 Client 绑定为 `Local` 的 Machine 显示“此 VS Code”标记。
- 相同 Environment + 规范化路径视为重复 Project；不同 Machine 上相同路径允许并存。

### 8.6 编辑、移动与删除

- 编辑 Project 支持名称、描述、路径、Environment、tag、颜色与 Favorite。
- `Rebind in this VS Code` 只修改当前 Client 的 Connection Profile，不创建 Machine，也不移动 Project；确认页显示旧 target、新 target、仅本安装实例保存、其他 Client 不受影响，Cancel 与校验失败均零写入。
- `Move to another Machine/Environment` 是独立向导，逐项展示 Environment、Project、原路径、目标路径和 launch anchor 依赖。
- 每项支持 Keep path、Edit path 或 Skip；无法验证的结果必须标记 `Will require repair`。
- 移动提交采用全成或全不成；失败时保持原归属。成功后保留可撤销记录，直到下一次相关目录修改。
- Undo 仅在 moved Project、源/目标 Environment 及其 launch anchor 均未被后续 mutation 或 sync conflict 修改时有效；失效后保留只读 Move Report，不执行猜测性反向移动。
- 删除 Project 只删除 Agent Pivot 记录，不操作真实文件。
- 有 Project 或 Dev Container Environment 的 Machine 不允许直接删除；必须先显式移动或删除其内容。
- 任何来源的空 Machine 在不存在迁移恢复引用时都可以 `Remove from Agent Pivot`。
- 空 Dev Container Environment 可以 `Remove from Agent Pivot`；非空时必须先移动或删除 Project。
- 不把删除 Machine 后的 Project 自动移动到 `Unassigned`。
- 删除确认必须显示受影响的 Machine/Environment 名称和数量，并明确“Files, SSH configuration, and containers will not be deleted”。
- 只有用户明确认为目标是另一台逻辑机器时才 `Create Separate Machine`；当前 VS Code 安装实例使用的 SSH alias 变化只执行 Rebind。

### 8.7 Tag 与旧 Group

- 每 Project 正常情况下最多 8 个 tag；单个 tag 最长 32 字符。
- trim、移除开头 `#`、忽略空值、大小写不敏感去重，并保留第一次输入的大小写。
- tag 是自由输入，不设置中央词表；候选值从现有 Project 聚合。
- 新建 Project 时即可添加 tag。
- 旧 Group 不再保留结构层级；迁移为每个原 Project 的同名普通 tag。
- 空 Group 不生成 tag；Group 名与已有 tag 大小写不敏感去重。
- 迁移导致超过 8 个 tag 时必须完整保留并展示；在用户删回上限前禁止继续新增，不得静默截断。
- 迁移得到的 Group tag 超过 32 字符时同样完整保留，UI 可视觉截断但编辑与 tooltip 显示全文；在用户删短前禁止新增 tag。
- 超限 Project 修改名称、颜色、Favorite 等非 tag 字段时必须原样保留全部 tag；用户可逐个删除，降至 8 个后恢复普通规则。

#### Tag 过滤

- `All` 表示未启用 tag 过滤。
- 多选 tag 使用 AND：Project 必须包含全部选中 tag。
- Toolbar 使用紧凑 `Tags (N)` 按钮打开 VS Code 风格 Quick Pick/Popover；`Matches all` 放在面板内。
- 勾选 tag 后即时应用；`Done` 与 Escape 都只关闭面板并保留当前选择，结果摘要旁唯一的 `Clear filters` 清空全部 tag 条件。首期不显示含义不明确的 facet 数量。
- 面板使用原生 checkbox，并以 `Matches all` 作为可读 group/fieldset 说明；面板外最多展示两个已选 tag，其余收敛为 `+N`，tag 不得无界换行占用主列表高度。
- Tag 只过滤 Project，Machine 和 Environment 始终保留，以保证连接入口稳定。
- 没有匹配 Project 的 Machine 保留为单行并显示 `0 matches`；Machine disclosure 仍可用。用户手动展开后显示 Host/Dev Container Environment 及其打开动作，但不显示不匹配 Project；清除过滤后恢复过滤前的基础展开状态。
- Favorites 镜像与原位置使用同一可见性判断。
- 结果摘要显示唯一 Project 数和有命中的 Machine 数，Favorites 镜像不重复计数；Clear 紧邻摘要。
- 清除过滤后恢复过滤前的展开状态、顺序与滚动位置。

### 8.8 搜索

- 搜索范围包括 Machine/Environment 展示名、Project 名称、描述、路径摘要和 tag；本地 SSH target 只在当前客户端可搜索，不进入同步索引。
- Project 可见公式固定为 `matchesAllSelectedTags && (matchesProjectText || parentMachineMatchesText || parentEnvironmentMatchesText)`；父级名称命中只放宽文本条件，不能绕过 tag。
- 命中 Project 时展示所属 Machine/Environment 与命中项；命中 Machine 时只展示其中满足 tag 条件的 Project。
- 搜索可以收敛无关 Machine；tag 单独过滤时不能隐藏 Machine。
- 搜索结果不得把不同 Machine 上的同路径 Project 合并。
- 全局 Dashboard 搜索结果增加 `Machine / Environment` label。
- Project 名、tag 或路径命中时高亮对应片段；Machine 名命中时在 Machine 级提供一次轻量说明，不在每个 Project 重复。

### 8.9 展开、折叠与状态保持

- 每个 Machine 和 Environment 独立保存折叠状态，但只保存在当前 Client，不参与目录同步。
- Collapse All 只收起子层级，不隐藏 Machine 行。
- 搜索或过滤期间可临时展开有命中的层级；退出后恢复此前状态。
- 增量刷新、运行状态变化和跨窗口更新不得重置滚动位置、过滤条件或焦点。

## 9. 页面状态

| 状态 | 页面表现 | 可执行动作 |
| --- | --- | --- |
| 全新用户 | 解释 Machine 目录与本地连接的区别 | Save Current Project、Add Machine |
| 已同步但当前 VS Code 未配置 | 完整显示同步内容与 `Not configured in this VS Code` | Set up；表单内选择 Save 或 Save & Open |
| V1 迁移用户 | 优先展示 Migration Report 摘要与待处理数量 | Review、Assign、Retry、Restore |
| Remote-SSH 未安装 | Machine 保留，SSH Profile 标记依赖缺失 | Install Remote-SSH |
| UI bridge 缺失或协议过旧 | 同步目录仍可读，Client-local Profile/迁移操作标记暂不可用 | Install/Update Agent Pivot UI Bridge、Retry |
| Idle | 显示 Machine、Environment 与 Project 数量 | 展开、打开、添加 |
| Opening | 打开按钮槽显示进度，仅命令未返回时禁用 | 等待 |
| Handed off | 短暂显示 `Finish connecting in the new window` | Open another window、Open Remote logs |
| Open | 显示 `N windows` | Open in New Window |
| Environment 无 Project | 展开后显示空态 | Add Project；Dev Container 可 Remove |
| Dev Container 已停止 | Environment 保留，按钮文案仍为统一打开动作 | Open in New Window |
| Dev Container 缺少锚点 | 显示 `Needs Setup` | Update configuration、Remove |
| Project 无效 | Project 保留并标记 Needs Repair | Edit、Move、Remove |
| Tag 无匹配 | Machine 保留并显示 `0 matches` | Clear filters、Open Machine |
| 搜索无结果 | 显示空结果 | Clear search |
| 同步冲突 | 保留可恢复副本，不静默覆盖 | Review Conflict |
| 迁移中断 | V1 保持权威，显示失败步骤 | Retry、Open Migration Report |
| 准备插件降级 | 展示 V1 可导出项、降级项和无法转换项 | Prepare for Downgrade、Cancel |
| 降级已准备 | V2 已备份，UI bridge projection 与目标 V1 backend materialization 已校验 | Install supported V1 version、Undo preparation |

## 10. 数据与同步要求

### 10.1 建议数据模型

```ts
type VersionVector = Record<string, number>;

interface CausalVersion {
    dot: { actorId: string; counter: number };
    context: VersionVector; // everything observed before this mutation
}

interface FieldCandidate<T> {
    value: T;
    version: CausalVersion;
}

interface FieldRegister<T> {
    candidates: Array<FieldCandidate<T>>;
    baselines: Array<FieldCandidate<T>>; // causal history set used to derive a common resolved display value
}

interface EntityRecord<T> {
    fields: { [K in keyof T]: FieldRegister<T[K]> };
    tombstones: CausalVersion[];
}

interface DevelopmentMachine {
    id: string; // stable UUID, synced
    displayName: string;
    position: string;
    source: 'manual' | 'derived' | 'migration';
}

interface DevelopmentEnvironment {
    id: string;
    machineId: string;
    kind: 'host' | 'devContainer' | 'legacyRemote';
    displayName: string;
    launchAnchor?: {
        hostPath: string;
        configPath: string;
        sourceProjectId?: string;
    };
    position: string;
}

interface SavedProjectV2 {
    id: string;
    environmentId: string; // Machine is derived from the Environment
    name: string;
    description?: string;
    path: string;
    position: string;
    tags?: string[];
    favorite?: boolean;
    favoritePosition?: string;
    color?: string;
    remoteType?: string; // migration compatibility; remove only after all callers migrate
    legacyPlacement?: {
        groupId?: string;
        groupName?: string;
        groupOrder?: number;
        projectOrder?: number;
        favoriteOrder?: number;
    };
}

interface CatalogConflict {
    id: string;
    entityType: 'machine' | 'environment' | 'project';
    entityId: string;
    field: string;
    candidates: Array<FieldCandidate<unknown>>;
    kind: 'same-field' | 'placement' | 'delete-vs-update' | 'missing-parent' | 'missing-host' | 'duplicate-host';
}

interface ProjectCatalogDocumentV2 {
    schemaVersion: 2;
    canonicalizationVersion: 1;
    versionVector: VersionVector;
    machines: Record<string, EntityRecord<DevelopmentMachine>>;
    environments: Record<string, EntityRecord<DevelopmentEnvironment>>;
    projects: Record<string, EntityRecord<SavedProjectV2>>;
    revision: string;
}

interface CatalogRevisionSlot {
    revision: string;
    checksum: string;
    document: ProjectCatalogDocumentV2;
}

interface ProjectCatalogBackendV2 {
    schemaVersion: 2;
    activeRevision?: string;
    previousRevision?: string;
    candidateRevision?: string;
    revisions: Record<string, CatalogRevisionSlot>; // active, previous, candidate only
}

interface LocalConnectionProfile {
    machineId: string;
    type: 'local' | 'ssh' | 'wsl' | 'legacyRemote';
    target?: string;
    resolverAuthority?: string;
}

interface LocalProjectsViewState {
    collapsedMachineIds: string[];
    collapsedEnvironmentIds: string[];
    selectedTags: string[];
}
```

同步数据中不得包含 `LocalConnectionProfile`、`LocalProjectsViewState`、client ID、临时 Docker container ID、连接状态或包含客户端 alias 的 legacy URI。旧 Project 完整 value、未知字段和原始 URI 进入 UI bridge 的 migration snapshot/recovery copy；只有全部调用点完成迁移后，才能通过独立版本删除 `remoteType` 等兼容字段。

V2 并发合同：

- UI bridge 的 `clientId` 只界定 Profile scope，不能作为 catalog writer actor。每个并行 workspace Extension Host writer 在 activation 时生成唯一 `catalogActorId`，由 service 在该 writer 内串行递增 counter；同一桌面 Client 的 Local、SSH 与 Dev Container host 因而不会产生相同 dot。
- 每次 mutation 的 `context` 复制写入前已观察到的完整 document vector，再产生 `{catalogActorId, nextCounter}` dot。`A → B` 的顺序写由 B 支配 A；`A || B` 的离线写保留为并发候选。
- 不同实体及同一实体不同字段的非并发候选按 causal context 合并；删除写 causal tombstone，不立即抹除记录。
- `CatalogConflict` 从 multi-value field candidates 与 tombstones **确定性派生**，不作为可陈旧的独立同步真相。同一字段并发值进入 conflict；Project `environmentId` 冲突必须保留两个候选归属，不使用 last-write-wins。
- 即使并发 candidates 的值相同也保留每个 causal dot；是否显示冲突只按 distinct value 派生。`baselines` 以集合并集收敛，展示值只从所有 live candidates 的共同 causal ancestor 中确定性选择，保证 merge 交换且结合。
- Delete vs Update、Environment 跨 Machine 移动及 Project Move 冲突必须进入 Review；解决前保留最后一个无冲突可见版本和全部候选。
- Resolve mutation 的 context 必须合并并支配全部候选 causal context，再写新 dot；旧副本重新同步时不能让已解决 conflict 复活。
- Machine、Environment、Project 和 Favorites 同层顺序使用稳定 position key；并发 reorder 以 position、version、entity ID 稳定收敛，不删除实体，不产生需要阻断打开的冲突。V1 `favoriteOrder` 迁移为 `favoritePosition` 并在 `legacyPlacement` 保留原值供降级。
- parser 验证 `Project.environmentId → Environment.machineId` 唯一链路。Project 不冗余 `machineId`；孤儿和循环关系 fail closed 并进入 recovery report。

Backend revision 合同：

- synced 与 workspace-host-local backend 都把 pointer 与最多三个自包含 revision slot 存在同一个 V2 envelope key；普通 V2 mutation、migration、rollback 和 backend switch 使用同一流程。
- 第一次写 envelope 时加入完整 `candidateRevision` slot但不改变 active；校验通过后第二次写入仍携带完整 candidate document，同时把 `activeRevision` 指向它并把旧 active 记为 previous。Settings Sync 即使乱序到达，任何可激活 envelope 都自带目标 document。
- 读取端只有在 active pointer、slot revision 与 checksum 全部匹配时才切换。active 缺失/损坏时继续使用已验证 previous；两者都不可用且 V1 尚未激活切换时回到 V1，否则进入只读 Recovery Required，绝不选择 candidate 猜测恢复。
- 非发起 Client 不依赖发起方本地 journal即可按上述规则读取；发起方 journal只用于完成/撤销跨 V1 snapshot、report 与 backend envelope 的多步骤操作。
- Synced store 沿用 V1 的本地 replica + reconcile 思路：每个 workspace writer 在自己的 local state 保留最后一个已验证 envelope/未确认 mutation，收到 Settings Sync 值时按 causal document merge 后发布新 revision；配置层的覆盖或 write echo 不能直接丢弃本地未合并候选。

### 10.2 跨设备行为

1. `agentPivot.storeProjectsInSettings=true` 时，完整 V2 catalog（Machine、Environment、Project、tag、Favorite 与稳定排序）使用独立 synced backend；`false` 时完整 catalog 使用当前 workspace Extension Host 的 local backend，不拆分同步 Machine 与本地 Project。
2. 每个客户端的 Connection Profile、client ID、view state、downgrade projection 权威副本和 recovery journal 由 `extensionKind: ui` companion bridge 存储；workspace extension 不直接把自己的 `globalState` 当成 Client 存储。
3. 新客户端首次看到 Machine 时状态为未配置，直到用户绑定 Local 或 SSH target。
4. 同一 Machine 在不同客户端可以使用不同 SSH alias。
5. 连接配置缺失不会删除、隐藏或重写同步目录。
6. Profile 的目标值可能敏感，不写入 Settings Sync；如果未来支持 Profile 同步，必须单独设计用户选择与安全说明。
7. 折叠、搜索、筛选、滚动、焦点和临时展开均为当前 Client 视图状态，不参与同步。
8. 切换 `storeProjectsInSettings` 时先冻结目录 mutation，分别快照源/目标 backend，用同一 V2 merge 合并到目标，最后更新 backend activation pointer；失败继续使用原 backend，旧副本保留为只读 recovery，不能在下次启动时重新成为权威。

### 10.3 V1 → V2 迁移

迁移必须幂等、对用户可原子切换、可回滚，并在写入 V2 前保存完整 V1 快照。底层多 key 不具备事务能力，因此实现使用可恢复提交协议：先写 UI bridge 本地 prepare journal，再写并校验 V1 snapshot、Migration Report 与含完整 candidate slot 的 V2 backend envelope，最后写入仍携带完整 document 且更新 activation pointer 的 envelope；崩溃重试按 journal 幂等完成或回到 V1：

1. SSH 迁移 Machine ID 使用固定 namespace 的 UUIDv5，由规范化 V1 resolver authority 与 remote type 生成；Host Environment ID 由 `machineId + host` 生成。该确定性规则只用于同一批旧记录并发迁移收敛，不用于自动合并用户分别添加的 Machine。
2. 当前客户端可为迁移出的 SSH Machine 创建匹配的本地 Connection Profile；Profile 明确区分用户输入 `target` 与 VS Code 使用的 `resolverAuthority`。
3. SSH Host 项目进入其 Machine 的 Host Environment。
4. 在生成任何 shadow catalog 或 Migration Preview 前，必须完成嵌套 SSH Dev Container parser corpus 探针。能可靠拆解时，Environment migration ID 由规范化父 Machine 身份与可恢复配置来源生成；不能可靠拆解的记录从第一次迁移起就保持稳定 `legacyRemote + Needs Setup`，原 URI 只进入本地 snapshot，不得在后续版本静默换 ID。
5. V1 本地 Project 没有可信来源设备时不得被首个升级客户端静默认领。迁移预览询问是否归到“此设备”；未确认项进入 `Needs Assignment`，等待用户选择 Machine。
6. WSL 项目按规范化 distro 名生成确定性 derived Machine 与兼容 Environment；当前 Client 在 UI bridge 保存 WSL profile，其他 Client 显示未配置。未知 Remote 按规范化 scheme + authority 生成确定性 derived Machine 和 `legacyRemote` Environment；当前 Client 可保存本地 resolver profile，无法建立 profile 时进入 Needs Setup。
7. 旧 Group 名转换为普通 tag；空名称忽略，大小写不敏感去重。超过 32 字符的 Group 名作为受保护 legacy tag 完整保存，UI 截断但 tooltip/编辑器显示全文；在用户删短前禁止新增 tag，非 tag 编辑不得截断。
8. 超出 8 个 tag 时同样完整保留，并阻止新增直至回到上限。
9. `favorite`、`favoriteOrder` 和颜色原样保留；普通 Project 先按旧 Group 顺序、再按各 Group 内顺序拼接，保持每个旧 Group 内的相对顺序。
10. 不因同路径、同仓库或同 SSH 物理终点自动合并 Project/Machine。
11. 双客户端离线迁移后再同步时，确定性迁移记录必须收敛；同一 Project 被并发分配到不同 Machine 时进入 Conflict，不使用 last-write-wins 静默选择。
12. Migration Report 持久保存 Project 数、Machine 数、Dev Container 数、Group tag 数、Needs Assignment、Needs Repair 与冲突项，可从 Projects 菜单再次进入，不使用一次性 toast。

### 10.4 迁移体验与回滚

- 切换前展示只读 Migration Preview：旧 Group/Project 数、将生成的 Machine/Environment、Group tag、超限 tag，以及分组后的 `Ready`、`Will be kept for review`、`Cannot open until repaired` 和 `Blocking` 项。
- snapshot/校验失败、损坏输入或无法写入目标 backend 属于 Blocking，修复前不可继续。Needs Assignment、Needs Setup 和超限 tag 可延期，记录完整进入 V2；CTA 显示 `Migrate and review N items`，并明确其中哪些 Project 暂时不可打开。
- Blocking 只允许 Repair/Retry/Cancel，不能跳过。可延期项使用 `Review later`：记录完整迁入、持续出现在修复队列，Needs Assignment/Setup 在修复前不可打开；不得把该动作命名为 Ignore。Compatibility/Re-upgrade Review 中的 `Ignore V1 change` 仅表示不应用该次 V1 差异并保留 V2，差异副本仍进入已处理历史。
- 用户确认后才通过 activation pointer 切换到已校验的 V2 revision；任何步骤失败都保持 V1 为当前权威数据，并提供 Retry。不得声称底层多个 storage key 具有事务性。
- Migration Report 与逐项修复队列必须和迁移能力同时交付，不得晚于数据切换。
- 回滚入口至少保留两个稳定版本；移除入口需要独立版本公告。
- V2 已产生新修改时，回滚前显示会受影响的记录，并先保存完整 V2 recovery copy；回滚不得静默丢弃迁移后的编辑。
- 回滚只恢复 Agent Pivot 目录，不修改真实文件、SSH config、Dev Container 配置或容器。
- Synced backend 的 activation pointer 是跨 Client 权威：回滚产生新 revision 并同步 pointer，其他 V2 Client 合并未同步修改后切换；冲突进入 Review。Workspace-host-local backend 的回滚只影响该 Extension Host。
- UI bridge 在 `globalStorageUri` 中用跨进程锁和原子 rename 保存单一版本化 Client state（client ID + Profile）；大型 snapshot、journal payload 和 recovery copy 也使用文件。`globalState` 只作为旧数据导入源和带 checksum/version 的小型 recovery 索引，不能作为多窗口并发写权威。校验失败时不激活目标 revision。
- 迁移前 V1 snapshot 至少保留两个稳定版本；最近 recovery copy 按原因和 revision 列表展示，达到容量上限时先要求用户导出或确认清理，不静默删除唯一可恢复副本。
- Machine 删除后的 Profile 先 tombstone；只要 migration/rollback/Move Undo 仍引用该 Machine 就不得物理清理。

### 10.5 Schema 兼容合同

- V2 使用独立同步 key，V1 数据与迁移快照不得和 V2 共用可被旧解析器覆盖的设置项。
- V2 是 Machine/Environment 关系的唯一权威源；V1 compatibility projection 只用于旧版本可见性，不具备关系写入权。
- Compatibility projection 只包含 V1 能安全表达的记录：迁移自 V1 且仍有原始 legacy URI 的远端 Project 可以沿用该 URI；V2-only 远端 Project 在没有安全 URI 时不进入 projection，并记录在 Compatibility Report。旧客户端不保证看到或打开 V2-only Project。
- 混版期间不承诺旧客户端可安全直接编辑 V2 目录。V2 客户端检测到 V1 projection 变化时保留为待审阅 recovery item，不能自动覆盖 V2。
- Group 只在首次迁移时转换为 tag；之后的 V1 Group 改名或移动不再改变 V2 tag 或 Machine 关系。

| 旧客户端 V1 操作 | V2 处理 |
| --- | --- |
| 新增 Project | 作为候选记录进入 `Needs Assignment`，用户确认后导入 |
| 修改名称、描述、tag、颜色或 Favorite | 生成可审阅差异，用户选择 Apply V1 change 或 Ignore V1 change |
| 修改路径/Remote URI | 生成 Conflict，不自动改写 Environment 或 launch anchor |
| Group 改名或移动 | 仅保留在 V1 recovery 数据中，不改变 V2 结构或 tag |
| 删除 Project | 生成待确认删除，不自动删除 V2 Project |
| V2 中移动 Machine/Environment | 更新 V2；V1 仅获得尽力而为的基础 Project 投影，不表达新关系 |

- 本功能在同一分支完成全部 Owner 验收后才创建唯一最终 PR，不依赖提前合并或发布过渡版本。旧版本无法理解 `catalogUpgradeState`，因此只允许继续读写隔离的 V1 key，永远不能覆盖 V2。
- 安装最终版本的 Client 在用户确认 Migration Preview 前继续以 V1 为权威；确认后该 catalog 的 V2 activation pointer 生效。仍运行旧版本的 Client 对 V1 的后续修改只生成 recovery review，不自动进入 V2，也不承诺看到 V2-only Project。
- Compatibility projection 至少维护两个稳定版本；停止投影需要版本公告和最低支持版本说明。
- 无法无损处理的跨版本修改生成 recovery copy，并进入 Migration Report。

### 10.6 插件版本降级协议

插件代码回退与目录数据回滚必须分别处理：

`V1 compatibility projection` 与 `V1 downgrade projection` 是不同数据：前者只为旧版本提供 V1 能安全表达的基础记录，不含本地 Profile；后者的权威副本由 UI bridge 为当前 Client 保存，并按目标 V1 backend 生成可读取的 legacy materialization。

- **V2 切换前：** V1 仍是权威数据，shadow migration 和 feature flag 可以直接关闭；代码回退不需要转换目录。
- **V2 切换后：** 用户必须先执行 `Prepare for Downgrade`，再安装发布说明指定、继续读取既有 V1 backend 的最后一个 V1 兼容版本。旧版本不读取 UI bridge projection；后者只用于备份与重新升级比较。
- **任意更老版本：** 只保证不会删除 V2 数据，不保证能够看到 V2 期间的最新修改。
- **直接降级但未准备：** 属于不支持路径；旧版本最多读取保留的迁移前 V1 数据，不能把它视为当前目录。

`Prepare for Downgrade` 必须执行以下流程：

1. 创建当前 V2 的完整、带 revision 和时间戳的 recovery copy，不覆盖迁移前 V1 快照。
2. 展示 Downgrade Preview：可转换 Project 数、无法转换项、将恢复的 Group、只存在于 V2 的空 Machine/Environment，以及当前 Client 缺少 Connection Profile 的 Machine。
3. 使用 UI bridge 中当前 Client 的 Connection Profile 生成 downgrade projection 权威副本，不把本地 SSH alias 写回跨设备 V2 数据。若 V1 使用 local backend，Prepare 以**目标 workspace Extension Host**为范围，向其既有 V1 local key 写入带 alias 的 materialization，不影响其他 host/client。若 V1 使用 synced backend，Prepare 使用共享 compatibility subset，Preview 明确“所有旧 V1 Client 将读取同一共享视图”；只能投影原 V1 已含 legacy URI 的记录，V2-only 远端 Project 不得把本地 alias 写入同步设置。
4. 已迁移 Project 优先使用 `legacyPlacement` 恢复原 Group 和相对顺序；V2 新建或无法恢复旧位置的 Project 进入兼容 `PROJECTS` Group。
5. Favorite、`favoriteOrder`、tag、颜色、名称和描述在 V1 能表达的范围内保留。
6. Host/Dev Container Project 优先使用本地 migration snapshot 中仍有效的 legacy launch URI；仅 local backend 可以根据当前 Client Profile 和 launch anchor 生成新的 V1 URI，synced backend 无安全 legacy URI 时必须列为 unavailable。
7. 无 Profile、无 launch anchor、synced V1 backend 无安全 legacy URI 或无法生成 URI 的 Project 不得伪造为可打开记录；确认页显示 `Unavailable in V1` 数量和逐项原因，明确它们仍在 V2 recovery 中、旧版本中不会显示或无法打开。
8. recovery copy/目标 backend 不可写属于 Blocking；用户确认后通过 prepare journal 写入 UI bridge projection 与目标 backend materialization。local backend 标记目标 Extension Host；synced backend 标记共享 V1 revision 及其影响范围。失败时不改变当前 V1/V2 活跃数据。

V2 无法在 V1 中完整表达的内容包括：

- Machine → Environment 层级与空 Machine/Environment；
- 每个 Client 的 Connection Profile 语义；
- Needs Assignment、Needs Setup、迁移冲突和其他 V2 修复状态；
- V1 字段上限之外的元数据。

这些内容始终保留在 V2 recovery copy 中。`Remove from Agent Pivot`、准备降级和安装旧版本都不得删除真实文件、SSH config、Dev Container 配置或容器。

#### 降级后的重新升级

- V1 兼容版本产生的新增、修改和删除不能直接覆盖原 V2 backup。
- 重新安装 V2 时比较 V1 downgrade projection、降级后 V1 数据与原 V2 revision，展示 Re-upgrade Review。
- 用户逐项选择采用 V1 变化、保留 V2，或创建 recovery copy；Machine/Environment 关系默认保留 V2。
- 完成合并前不得删除任一侧备份；合并成功后生成新的 V2 revision。
- UI bridge downgrade projection 按 Client 保存，只用于 recovery/re-upgrade；V1 插件不读取它。local backend materialization 按目标 workspace Extension Host 生效；synced backend materialization 是共享 safe subset，会影响所有旧 V1 Client。其他仍运行 V2 的 Client 始终继续使用 V2。

## 11. 隐私与安全

- 同步 Machine 只包含 UUID、展示名和布局信息，不包含当前客户端 SSH target。
- Connection Profile、client ID 与 downgrade projection 权威副本只由桌面 UI bridge 保存在当前 VS Code 安装实例，不读取或复制私钥、密码、SSH Agent 内容。
- V1 downgrade projection 可能包含当前 Client 的 SSH alias；alias 只能进入 UI bridge 权威副本或 V1 local backend 的 legacy materialization，不得新写入 Settings Sync。重新升级完成后允许用户删除该投影，但保留 V2 recovery copy 直至用户确认。
- Project 路径与 Dev Container 配置路径仍可能敏感，遵循现有项目同步开关并在设置说明中明确。
- UI 只展示去敏错误摘要；完整日志不得包含密码、私钥或 token。
- 不对 Machine 进行后台端口扫描、ping 或定时连接。
- 连接与打开行为遵循 VS Code Workspace Trust 和 Remote 扩展自身的安全流程。

## 12. 可访问性与窄宽度

- Favorites 与主目录分别使用带可读 heading 的原生 `section > ul/li`；Environment/Project children 使用嵌套 `ul`。不声明 `role=tree/treegrid`，不进入读屏 application-mode composite。
- 每个可见行只有左侧 primary button/link 进入正常 Tab 顺序，因此 500 Project 时不会按 actions 数量成倍增加停靠点。Machine/Environment button 使用 `aria-expanded`、`aria-controls`；Project/Favorite link 的 Enter 打开 Project。
- 右侧 Open/Set up/overflow 等 pointer controls 保持可见和具名，但 `tabindex=-1`；当前行按 `Shift+F10` 打开包含同等全部动作的菜单，这是键盘执行 Machine/Environment 打开、配置、Retry 和 More 的权威路径。菜单项使用原生 Up/Down/Home/End 行为。
- 不为普通 list 模拟 Left/Right/Home/End/type-ahead tree 导航。Enter/Space 在 Machine/Environment primary button 上只切换 disclosure，不触发打开。
- Escape 关闭菜单/对话框并返回该行 primary control。折叠含焦点子树时回到父 disclosure；删除或过滤后按稳定 ID 回退到同一 Project 的另一 Favorites/原位置表示、相邻项、父 Environment、父 Machine、对应 section 首项、Toolbar。
- 异步状态使用文本与图标共同表达；`aria-live="polite"` 只播报用户刚触发的动作并去重，避免多行刷新形成播报风暴。
- Tag filters 使用原生 checkbox，并通过 fieldset/legend 或等价可读分组提供 `Matches all` 说明。
- Favorites 快捷项的无障碍名称必须包含 Project、Machine 和 Environment，并与原 Project 共享实体状态。
- Project 主树默认一行名称，第二行最多两个 tag 与 `+N`；路径和描述进入 tooltip/详情。Favorites 固定为名称与 `Machine › Environment` 两行。
- Hover 才出现的操作在键盘 focus 和无 hover 设备上同样可发现。
- 兼容 VS Code 深色、浅色、高对比度、forced colors、缩放和 reduced motion。

窄宽度布局矩阵：

| 宽度 | 常驻内容 |
| --- | --- |
| `≥360px` | 名称、一个状态槽、打开、添加、更多 |
| `280–359px` | 名称、一个状态槽、打开、更多；添加收入菜单 |
| `<280px` | 截断名称、打开图标、更多；tag、路径与次要计数隐藏 |

所有档位都必须在 200% zoom 下验证；不设置阻止用户缩小侧栏的固定最小宽度。可点击目标至少 24×24 CSS px，tooltip 和 accessible name 保留完整目标名称。

### 12.1 暂定 UI 文案

| 场景 | 统一文案 |
| --- | --- |
| 新建同步 Machine | `Add Machine` |
| Machine 行缺少连接 | `Set up` |
| 修改当前 VS Code 安装实例连接方式 | `Rebind in this VS Code` |
| Setup/Rebind 保存并打开 | `Save & Open` |
| Setup/Rebind 仅保存 | `Save` |
| Machine/Dev Container 正常打开 | `Open in New Window` |
| Project 迁移归属 | `Move to another Machine or Environment` |
| 移除目录记录 | `Remove from Agent Pivot` |
| 缺少连接 | `Not configured in this VS Code` |
| 缺少容器启动锚点 | `Needs setup` |
| 打开命令已交接 | `Finish connecting in the new window` |

`Forget`、`Delete Machine` 和 `Start and Open` 不作为首期 UI 文案；删除真实文件、SSH 配置或容器从来不是这些操作的含义。

## 13. 性能与可靠性

- Machine、Environment 和 Project identity 在 Extension Host 侧规范化；Webview 只消费已解析 view model。
- 页面刷新沿用 revision/sequence 机制，避免旧消息覆盖新状态。
- 打开环境是显式用户动作，不能由 hover、展开、筛选或同步自动触发。
- 使用 50 Machine、500 Project 的固定合成数据集，在技术设计记录的 CI 基准环境中分别测量展开、搜索和 tag 过滤，热身后的 p95 目标低于 100ms。
- 单条脏数据、连接失败或同步失败不得阻塞其余目录加载。
- 迁移、同步、手动编辑和当前窗口识别共享同一 schema 校验规则。
- Machine 列表不得因短暂连接状态发生动态重排。

## 14. 验收标准

### 14.1 Machine 与跨设备连接

- [ ] Machine 使用稳定 UUID 同步，SSH alias 不作为全局身份。
- [ ] 同一 Machine 可在不同客户端绑定 Local 或不同 SSH target。
- [ ] Rebind 只修改当前 Client；创建独立 Machine 和移动 Project 是另外两个明确流程。
- [ ] 每个 Client 首期最多绑定一个默认 Local Machine。
- [ ] 未配置连接的 Machine 仍展示全部 Environment 和 Project。
- [ ] 两个单独添加的 SSH alias 默认形成两个 Machine，不自动合并。
- [ ] 非空 Machine 不可直接删除；无恢复引用的空 Machine 可以 Remove from Agent Pivot。

### 14.2 Environment

- [ ] 每个 Machine 有 Host，SSH 上的 Dev Container 显示为其子 Environment。
- [ ] Machine/Environment disclosure 只展开或收起；Machine 右侧按钮打开 Host，Host 行不重复显示打开按钮。
- [ ] Dev Container 右侧按钮在新窗口打开，停止时可从独立 launch anchor 自动启动。
- [ ] launch anchor 被移动或删除时必须先修复、替换或进入 Needs Setup。
- [ ] 容器重建后 Environment identity 不因 Docker container ID 改变。
- [ ] 空 Dev Container Environment 可单独 Reconfigure 或 Remove。

### 14.3 Project 与 Favorites

- [ ] Project 始终归属一个 Machine/Environment，同仓库的不同机器副本不合并。
- [ ] 打开 Project 使用当前客户端 Connection Profile。
- [ ] Favorites 保持独立分组、独立顺序，并显示 Machine/Environment 上下文。
- [ ] Favorites 和原位置引用同一实体，结果数量不重复计算，读屏名称明确其为快捷项。
- [ ] 跨 Machine/Environment Move 在单个 V2 document mutation 中提交，并在确认前展示路径与启动依赖影响。
- [ ] 删除 Agent Pivot 记录不会操作真实文件。

### 14.4 Tag、过滤与搜索

- [ ] 旧 Group 名迁移为普通 tag，超过 8 个或 32 字符时都不丢数据。
- [ ] 超限 Project 修改任何非 tag 字段时仍完整保留全部 tag。
- [ ] 多 tag 采用 AND 语义，界面明确显示 `Matches all`。
- [ ] Tag 过滤只隐藏不匹配 Project；Machine 保留 `0 matches` 单行，Environment 临时收起。
- [ ] 搜索与 tag 严格使用包含父 Machine/Environment 名称的已定义公式，且不跨 Machine 错误去重。
- [ ] 清空查询后恢复展开状态、顺序、滚动位置与焦点。

### 14.5 状态、迁移与兼容

- [ ] UI 不把打开命令已交接误报为 Connected，临时状态按时复位并允许重试。
- [ ] 迁移前后 Project、tag、Favorite 和颜色数量一致；旧 Group 内相对顺序保持。
- [ ] 迁移可重复执行，第二次不产生额外 Machine、Environment、tag 或 Project。
- [ ] 两个客户端离线迁移后再同步，确定性 migration ID 不产生重复节点。
- [ ] V1 本地 Project 未经确认不会被首个升级客户端认领。
- [ ] V1 客户端不能静默降级覆盖 V2 专有关系。
- [ ] 同步冲突与异常迁移均有可恢复快照或 recovery copy。
- [ ] 两个 V2 Client 并发修改不同字段可合并；归属冲突、同字段冲突和 Delete vs Update 不使用静默 last-write-wins。
- [ ] `storeProjectsInSettings` 切换通过 recovery journal 和 activation pointer 完成；失败时原 backend 仍是权威，Profile 始终不参与 catalog 同步。
- [ ] Migration Preview、持久 Report、Needs Assignment/Repair 队列与回滚入口可访问。
- [ ] V2 切换前关闭 feature flag 并回退代码时，V1 数据无需转换即可继续使用。
- [ ] V2 切换后，Prepare for Downgrade 会先备份 V2，再通过可恢复提交生成当前 Client 的 V1 投影与目标 backend materialization。
- [ ] Downgrade Preview 逐项说明不能由 V1 表达或无法生成 URI 的记录，不能把它们静默丢弃或伪装为可打开 Project。
- [ ] 支持版本降级后重新升级时，通过 Re-upgrade Review 合并 V1 变化，不直接覆盖原 V2 关系。
- [ ] 一个 Client 的降级准备不会修改其他 Client 的 V2 目录或 Connection Profile。

### 14.6 Accessibility

- [ ] 仅使用键盘可完成展开、打开、配置连接、打开 Project 和 tag 过滤。
- [ ] 读屏能区分 disclosure 与 `Open in New Window`。
- [ ] 高对比度模式下当前客户端、打开中、已打开、未配置和选中 tag 均可辨识。
- [ ] 页面只有一个纵向滚动容器，并在 `<280px`、`280–359px`、`≥360px` 与 200% zoom 下通过布局检查。

## 15. 建议交付阶段

### Phase 1 — V2 影子模型与兼容底座（同一开发分支）

- 引入 Machine、Environment、Project V2 与本地 Connection Profile。
- 使用独立 key 建立只读 shadow migration，旧 UI 与 V1 写入继续工作。
- 完成 V1 快照、兼容投影、Prepare for Downgrade、回滚和冲突测试；此阶段不创建 PR、不发布版本。
- 在写入 shadow catalog 前，从既有 URI 验证 SSH Host 与嵌套 Dev Container 的解析边界。

### Phase 2 — Feature flag 后的完整 Host 纵切

- 在关闭的 feature flag 后同时交付 Machine/Environment 页面、Favorites、Connection Profile、Host/Project 打开和本地视图状态。
- 提供 Migration Preview/Report、Needs Assignment/Repair、recovery copy 和回滚入口。
- 此阶段保持 V1 权威，不向普通用户切换数据。

### Phase 3 — Dev Container 启动闭环

- 完成独立 launch anchor、Reconfigure/Remove、停止后启动、状态复位和异常修复。
- 验证 SSH Host 与嵌套 Dev Container 的跨客户端连接映射。

### Phase 4 — 可恢复切换与最终验收

- 通过 prepare journal 与 activation pointer 执行 Group → tag、Favorites 保留和 Machine/Environment 迁移，再切换 V2 写入权并打开 feature flag。
- Release 1 必须包含：安全迁移、Machine/Environment 页面、本地 Profile、Host/Project 打开、Dev Container 识别与启动、Favorites、tag AND 过滤、数据回滚、支持版本降级和可访问性。
- 所有阶段都只生成本地验收包；Owner 完成功能验收后才创建唯一最终 PR。最终版本中用户确认 Migration Preview 前仍使用 V1，确认后才启用完整 V2 纵切，不允许出现“数据已迁移但入口未就绪”的状态。

### Phase 5 — 后续增强与兼容收口

- Should：全局搜索增加 Machine/Environment 上下文、进一步的大列表优化和批量管理。
- 维持 V1 compatibility projection 至少两个稳定版本，再通过单独公告停止 V1 投影。
- 完成大数据量、多窗口、多客户端、窄宽度、键盘、读屏、主题和异常恢复矩阵。

## 16. 已确认的产品决策

1. 信息层级为 `Machine → Environment → Project`；Environment 首期重点区分 Host 与 Dev Container。
2. Dev Container 属于 SSH Machine 的子环境，身份来自稳定配置，不来自运行时 container ID。
3. Machine 和 Environment 的 disclosure 只展开/收起；Machine 右侧打开 Host，Dev Container 右侧打开容器，Host 子行不重复打开动作。
4. Dev Container 未运行时允许通过关联项目配置自动启动。
5. 首期 Machine 只来自 Agent Pivot 手动添加或已有项目派生，不解析 SSH config。
6. 旧 Group 删除层级并迁移为普通 tag。
7. Favorites 与当前一致，继续作为独立镜像分组展示。
8. 多 tag 使用“匹配全部”的 AND 语义。
9. Tag 只过滤 Project，Machine/Environment 保持可见。
10. 不同 SSH alias 默认视为独立 Machine，不自动判断物理服务器身份。
11. Machine/Environment/Project 参与同步；每个客户端的 Connection Profile 仅本地保存。
12. 未配置连接的 Machine 仍完整展示，打开入口改为配置连接。
13. 同一仓库在不同 Machine 上的工作目录是不同 Project。
14. 非空 Machine 不可直接删除；当前 Client 的 SSH alias 变化使用 Rebind，只有逻辑 Machine 变化才新建并显式迁移。
15. 连接状态只陈述 Agent Pivot 能可靠观测的事实。

## 17. Review 后补充的实现约束

- Add Machine、Rebind 和 Move 是三个独立流程。
- Host 打开动作及状态只归 Machine 行所有，避免重复主操作。
- Dev Container 使用独立 launch anchor，并具备 Needs Setup、Reconfigure 和 Remove 生命周期。
- V1 本地 Project 不能静默认领；并发迁移使用确定性 migration ID。
- V2 使用独立同步 key，混版修改进入 recovery review，不允许旧结构覆盖新关系。
- 插件版本降级必须先生成 Client-local V1 projection；V2 recovery copy 始终保留，重新升级需人工合并降级期变化。
- 迁移采用 shadow migration、feature flag 和完整纵切发布，迁移报告与回滚不能后置。
- 页面采用单滚动容器、紧凑 tag 面板、嵌套 disclosure list 和明确窄宽度矩阵。

Milestone 1 实施蓝图与低保真线框：

- [`remote-machines-projects-m1-plan.md`](./remote-machines-projects-m1-plan.md)
- [`remote-machines-projects-m1-wireframes.md`](./remote-machines-projects-m1-wireframes.md)
- [`remote-machines-projects-m1-wireframes.svg`](./assets/remote-machines-projects-m1-wireframes.svg)
- [`remote-machines-projects-m1-narrow-wireframes.svg`](./assets/remote-machines-projects-m1-narrow-wireframes.svg)

交付节奏：同一分支完成全部实现，在 Milestone 1（方案）、Milestone 2（V2/Host 纵切）和 Milestone 3（Dev Container/迁移恢复闭环）分别由 Owner 验收，最终只提交一个 PR。
