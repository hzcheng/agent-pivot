# Remote Machines Projects PRD

> Superseded by [Managed Remote Machines PRD](./managed-remote-machines-prd.md).
> This document describes an abandoned URI-derived design and is not current
> product behavior.

状态：Owner 验收中

范围：Projects 页信息架构重构
原则：现有 Project 数据继续是唯一事实源；本功能只是派生视图

## 1. 背景

Agent Pivot 已保存 Project 的完整路径。远程 Project 的路径本身包含 VS Code
Remote authority，例如 SSH、WSL、Dev Container 以及嵌套在 SSH 上的 Dev
Container。该数据会沿用现有项目设置和同步机制跨机器保存。

当前 Projects 页按 Group 展示，无法快速回答：

- Project 位于哪台开发机器；
- Project 位于该机器的 Host 还是某个 Dev Container；
- 如何直接打开远端 Host；
- 如何用 tag 过滤跨 Machine 的 Project。

本次重构不建立第二套用户可见目录；ProjectService 在内部合并本机 Local 存储和现有
Remote 同步存储，继续复用原有模型与导航链路。

## 2. 产品目标

1. Projects 页按 `Machine → Environment → Project` 展示。
2. Host 和 Docker Dev Container 必须是不同 Environment。
3. 点击 Machine 行只展开或收起；右侧按钮在新窗口打开该 Machine；Local 打开空白本地窗口。
4. 点击 Project 行沿用当前 Project 打开行为。
5. Project 支持按多个 tag 的 AND 关系过滤，tag 不重复占用 Project 行空间。
6. Favorites 是 Project 的镜像入口，不重复计数。
7. 当前 Group 名在新视图中作为兼容 tag 展示。
8. 功能开关关闭后立即恢复原 Projects 页面。
9. Machine 支持修改同步的显示名称，但不改变连接信息。
10. Local Project 只保存在当前物理机器；远端 Project 继续跨机器同步。

## 3. 非目标

- 不引入新的 Project 模型、用户可见目录或恢复界面。
- 不把 Machine、Environment 作为新的持久化实体。
- 不新增 Connection Profile、Setup、Assign、Repair 或 Preview 状态。
- 不修改 UI Bridge 的 Project 协议或保存任何本机 SSH alias。
- 不在本次实现 Machine/Environment 的新增、删除、拖拽和手动重排。
- 不把显示名称当成新的连接身份或独立 Machine 实体。

## 4. 数据事实源

唯一事实源仍为现有 `Group[]` 与其中的 `Project[]`：

- `Project.id`：打开、收藏等操作的身份；
- `Project.path`：本地路径或完整 remote URI；
- `Project.machineDisplayName`：同一派生 Machine 共享的可选显示名称；
- `Project.remoteType`：旧数据兼容提示；
- `Project.tags`：用户 tag；
- `Project.favorite` / `favoriteOrder`：收藏及顺序；
- `Group.groupName`：兼容期映射为一个展示 tag。

视图每次从这些字段重新派生。不得把派生 Machine ID、Environment ID 或 Host
地址写回同步数据。

Machine 改名时，把规范化后的 `machineDisplayName` 写入该 Machine 当前所有 Project；
新增 Project 即使尚未携带该字段，也从同 Machine 的已有 Project 投影出同一名称。重置
名称会删除这些可选字段。该字段只影响显示与搜索，不参与 Machine ID、连接 authority
或 Project 打开 URI 的计算。

本地文件路径、本地 Dev Container 和 Attached Container 写入 Extension
`globalState['localProjects.v1']`，不进入 VS Code Settings Sync。SSH、WSL、远端容器及
其他 remote URI 继续写入用户选择的 Project 存储。ProjectService 在读取时合并两类记录，
因此 Favorites、计数、搜索和编辑链路不需要区分存储来源。

## 5. 派生规则

| Project 路径 | Machine | Environment |
| --- | --- | --- |
| 本地文件路径 | Local | Host |
| `ssh-remote+target` | target | Host |
| `wsl+distro` | distro（WSL） | Host |
| `dev-container+…@ssh-remote+target` | target | 独立 Dev Container |
| 本地 `dev-container+…` / `attached-container+…` | Local | 独立 Dev Container |
| 其他 remote authority | authority 的可读名称 | Host |

规则要求：

- 同一个 SSH authority 下的 Host Project 和 Dev Container Project 归到同一
  Machine；
- 不同 Dev Container authority 形成不同 Environment；
- 每个 Machine 固定展示一个 Host Environment，即使当前只有容器 Project；
- WSL 视为独立 Machine；
- 派生 ID 只用于 DOM、折叠状态和点击时防止陈旧目标，不是持久化身份；
- 无法识别的路径仍保留为可打开 Project，不进入“待分配”状态。
- Local Machine 的归属由本机存储决定，不以本地绝对路径是否碰巧存在作为判断。

## 6. 打开行为

### 6.1 Project

Project 行点击发送既有 `selected-project` 消息和 `Project.id`。Host 端重新读取
当前 Project，并调用既有 `ProjectOpenController`。原始 `Project.path` 不被重写，
因此 SSH、WSL、Dev Container 和其他已支持路径保持原行为。

- 普通左键：沿用 Default；
- Ctrl/Cmd + 左键：沿用 Current Window；
- 中键：沿用 New Window；
- Favorite 点击只切换收藏，不触发打开。

### 6.2 Machine Host

Machine 右侧按钮携带 Machine 派生 ID 和一个当前 Project ID。Host 端必须从最新
Project 数据重新推导并校验 Machine，再从 Project URI 提取外层 Host authority：

- SSH Machine 打开 `vscode-remote://ssh-remote+target/`；
- WSL Machine 打开 `vscode-remote://wsl+distro/`；
- 其他可解析 remote Machine 打开其 authority 根；
- 只有远程 Dev Container Project 时，使用其外层 SSH authority 打开 Host；
- Local Machine 使用同一按钮打开空白本地窗口；
- 没有可重新验证的 Project 身份时不显示该按钮。

最终仍调用既有 `ProjectOpenController` 与 saved-project navigation。不得新增 UI
Bridge command、握手或配置存储。

## 7. 视图与交互

默认结构：

```text
3 projects on 2 machines                         [tag] [add]

FAVORITES
  ● API                         devbox › Host  [★] […]

devbox                                  [open Host] […]
  Host
    ● API                                      [★] […]
  workspace (Dev Container)
    ● Worker                                   [☆] […]
```

- Machine、Environment、Favorites 都可独立展开/收起；
- 顶部 Expand/Collapse All 对 Projects 页全部 disclosure 生效；
- Project 名称、Machine、Environment、路径、tag 都参与文本搜索；
- tag 筛选使用复选框，选择多个 tag 时必须全部匹配；
- 结果数按唯一 Project 和 Machine 计算，Favorite 镜像不重复计数；
- 过滤为零时可临时收起 Machine，清除过滤后恢复过滤前状态；
- 工具栏左侧显示结果数，右侧紧邻放置 tag 和 Add 图标按钮；
- Project 行显示原有颜色标识，不内联显示 tag；
- Project 的 `…` 菜单提供当前窗口打开、编辑 Project、编辑颜色与删除；
- Machine 的 `…` 菜单提供 Rename Machine；改名后同时提供恢复派生名称；
- Machine、Project、Favorite 与更多操作均可通过键盘访问；
- 不显示 Setup、Assign、Preview、Migration Report 或 UI Bridge 状态。

## 8. Tag 兼容规则

展示 tag 为 `Project.tags + 当前 Group.groupName`，忽略空值并按大小写去重。
Group 名只做派生兼容映射，不在后台批量改写 Project，也不改变旧页面的数据结构。

后续若提供“删除旧 Group tag”的能力，必须是一次显式、可预览的普通 Project tag
编辑操作；不属于本次纯视图重构。

## 9. 同步、兼容与回退

- Remote Project 沿用现有 Project 存储和 Settings Sync；Local Project 只保存在当前
  Extension Host 的 `globalState['localProjects.v1']`，不写入 `projectData` 或
  `projectSyncData`；
- Machine 显示名称作为 Project 的可选字段沿用现有同步 key 与冲突处理，不执行数据迁移；
- 升级时先把同步目录中的 Local Project 写入本机存储，写入成功后再从同步目录删除；
  如果中途失败，来源副本仍保留，下次启动可以重试；
- 历史 Local Project 没有来源信息，因此由首台完成升级迁移的计算机接收；
- Machine → Environment → Project 视图默认启用，不再提供额外的用户配置开关；
- 回退代码不会删除本机 Local 数据，但不认识 `localProjects.v1` 的旧插件无法显示这些
  Local Project；重新安装本版本即可恢复，Remote Project 不受影响；
- 已安装的 UI Bridge 继续服务原有窗口/Project 导航，本功能不要求升级。

## 10. 验收标准

- [ ] 同一 SSH Machine 下能区分 Host 和每个 Dev Container。
- [ ] 不同 SSH authority 显示为不同 Machine。
- [ ] WSL 显示为独立 Machine。
- [ ] Project 行点击可打开原 Project，包括 Dev Container Project。
- [ ] 页面没有 Setup、Assign、Preview 或 Migration UI。
- [ ] Machine 行点击只收起/展开，右侧按钮在新窗口打开对应 Machine。
- [ ] Local Machine 的右侧按钮打开空白本地窗口。
- [ ] 只有 Dev Container Project 的远程 Machine 也能打开外层 Host。
- [ ] tag 多选按 AND 过滤，Group 名可作为 tag 过滤。
- [ ] Project 行不显示冗余 tag，保留颜色标识。
- [ ] Project `…` 菜单可以编辑 Project、颜色以及删除 Project，点击外部即可关闭。
- [ ] 结果数、tag 与 Add 在同一紧凑工具栏内对齐。
- [ ] Favorites 不重复计数，收藏按钮不误触 Project 打开。
- [ ] 顶部 Expand/Collapse All 对当前 Projects 层级有效。
- [ ] 260px 宽度下无水平滚动，核心操作仍可访问。
- [ ] 关闭功能开关后原 Projects 页立即恢复，Project 数据无变化。
- [ ] Machine 可以修改和重置显示名称；名称跨设备同步且不改变连接 URI。
- [ ] 两台物理机器各自新增的 Local Project 不进入 `projectData`/`projectSyncData`，只在
      本机 Projects 视图、Favorites、计数和搜索中出现。
- [ ] Remote、SSH、WSL 与远端 Dev Container Project 在不同物理机器上仍保持可见。

## 11. 交付节奏

所有实现继续留在当前分支。Owner 按验收项逐项体验；发现问题后继续修复。全部功能
验收完成后只创建一个最终 PR。
