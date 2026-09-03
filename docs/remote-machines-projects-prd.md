# Remote Machines Projects PRD

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

本次重构只改变呈现和导航，不建立第二套项目目录。

## 2. 产品目标

1. Projects 页按 `Machine → Environment → Project` 展示。
2. Host 和 Docker Dev Container 必须是不同 Environment。
3. 点击 Machine 行只展开或收起；右侧按钮在新窗口打开其 Host。
4. 点击 Project 行沿用当前 Project 打开行为。
5. Project 支持 tag 展示，并按多个 tag 的 AND 关系过滤。
6. Favorites 是 Project 的镜像入口，不重复计数。
7. 当前 Group 名在新视图中作为兼容 tag 展示。
8. 功能开关关闭后立即恢复原 Projects 页面。

## 3. 非目标

- 不引入 Project V2、CRDT、影子目录或迁移流程。
- 不把 Machine、Environment 作为新的持久化实体。
- 不新增 Connection Profile、Setup、Assign、Repair 或 Preview 状态。
- 不修改 UI Bridge 的 Project 协议或保存任何本机 SSH alias。
- 不在本次实现 Machine/Environment 的增删改、拖拽和手动重排。
- 不改变现有 Project、Favorite、Group 和设置同步格式。

## 4. 数据事实源

唯一事实源仍为现有 `Group[]` 与其中的 `Project[]`：

- `Project.id`：打开、收藏等操作的身份；
- `Project.path`：本地路径或完整 remote URI；
- `Project.remoteType`：旧数据兼容提示；
- `Project.tags`：用户 tag；
- `Project.favorite` / `favoriteOrder`：收藏及顺序；
- `Group.groupName`：兼容期映射为一个展示 tag。

视图每次从这些字段重新派生。不得把派生 Machine ID、Environment ID 或 Host
地址写回同步数据。

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
- Local 或没有可安全推导 Host 的 Machine 不显示该按钮。

最终仍调用既有 `ProjectOpenController` 与 saved-project navigation。不得新增 UI
Bridge command、握手或配置存储。

## 7. 视图与交互

默认结构：

```text
FAVORITES
  API                         devbox › Host

devbox                                      [open Host]
  Host
    API                       #Backend #api
  workspace (Dev Container)
    Worker                    #Backend #worker
```

- Machine、Environment、Favorites 都可独立展开/收起；
- 顶部 Expand/Collapse All 对 Projects 页全部 disclosure 生效；
- Project 名称、Machine、Environment、路径、tag 都参与文本搜索；
- tag 筛选使用复选框，选择多个 tag 时必须全部匹配；
- 结果数按唯一 Project 和 Machine 计算，Favorite 镜像不重复计数；
- 过滤为零时可临时收起 Machine，清除过滤后恢复过滤前状态；
- Machine Host、Project 与 Favorite 按钮均可通过键盘访问；
- 不显示 Setup、Assign、Preview、Migration Report 或 UI Bridge 状态。

## 8. Tag 兼容规则

展示 tag 为 `Project.tags + 当前 Group.groupName`，忽略空值并按大小写去重。
Group 名只做派生兼容映射，不在后台批量改写 Project，也不改变旧页面的数据结构。

后续若提供“删除旧 Group tag”的能力，必须是一次显式、可预览的普通 Project tag
编辑操作；不属于本次纯视图重构。

## 9. 同步、兼容与回退

- 同步完全沿用现有 Project 存储；不同机器看到同一 URI，因此能得到相同层级；
- 本功能不增加同步 key，不执行数据迁移，不写 recovery copy；
- `agentPivot.remoteMachineProjects.enabled=false` 时使用原 Projects renderer；
- 因为没有数据格式变化，代码或功能开关回退无需转换数据；
- 已安装的 UI Bridge 继续服务原有窗口/Project 导航，本功能不要求升级。

## 10. 验收标准

- [ ] 同一 SSH Machine 下能区分 Host 和每个 Dev Container。
- [ ] 不同 SSH authority 显示为不同 Machine。
- [ ] WSL 显示为独立 Machine。
- [ ] Project 行点击可打开原 Project，包括 Dev Container Project。
- [ ] 页面没有 Setup、Assign、Preview 或 Migration UI。
- [ ] Machine 行点击只收起/展开，右侧按钮在新窗口打开 Host。
- [ ] 只有 Dev Container Project 的远程 Machine 也能打开外层 Host。
- [ ] Local 或无法安全派生 Host 时不展示误导性的远程打开按钮。
- [ ] tag 多选按 AND 过滤，Group 名可作为 tag 过滤。
- [ ] Favorites 不重复计数，收藏按钮不误触 Project 打开。
- [ ] 顶部 Expand/Collapse All 对当前 Projects 层级有效。
- [ ] 260px 宽度下无水平滚动，核心操作仍可访问。
- [ ] 关闭功能开关后原 Projects 页立即恢复，Project 数据无变化。

## 11. 交付节奏

所有实现继续留在当前分支。Owner 按验收项逐项体验；发现问题后继续修复。全部功能
验收完成后只创建一个最终 PR。
