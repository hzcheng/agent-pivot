# Remote Machines Projects 实施计划

> Superseded by [Managed Remote Machines PRD](./managed-remote-machines-prd.md)
> and its technical design. This historical plan is not current product behavior.

本计划以“现有 Project 是唯一事实源”为边界，替代此前的 V2/Profile 方案。

## 实现边界

- 保留：现有 Project 存储、同步、Favorite、打开控制器和 saved-project navigation。
- 新增：URI 派生视图模型、Machine/Environment HTML、同步的 Machine 显示名称、
  Local/Remote 存储分流、tag AND 过滤、折叠交互。
- 删除：V2 catalog、CRDT、迁移/降级、Connection Profile、Setup/Assign/Preview、
  新增 UI Bridge Project commands。
- 视图：Machine → Environment → Project 默认启用，不增加用户配置开关。

## 依赖方向

```text
Group[] / Project[]
        │
        ▼
machineProjectsViewModel (pure projection)
        │
        ▼
webviewMachineProjectsContent + Scripts

Project click ──► selected-project ──► ProjectOpenController
Machine click ──► open-machine-host ─► URI-derived synthetic Host
                                      └► ProjectOpenController
```

UI Bridge 不属于新增依赖。它只继续承担仓库原有的 saved-project navigation。

## 工作阶段

### 1. 安全网

- 固化 SSH Host + 嵌套 Dev Container 的派生结果；
- 固化 WSL 独立 Machine、本地容器归入 Local；
- 固化 Project 完整 URI 不被改写；
- 固化 container-only Machine 可派生外层 SSH Host；
- 固化 HTML 不出现 Setup/Assign/Preview/Migration/UI Bridge。

### 2. 纯视图模型

- 从 authority 派生 Machine 与 Environment；
- 生成仅供视图使用的稳定 hash ID；
- 保留 Project ID/path/Favorite/顺序；
- 把 Group 名加入展示 tag；
- 点击 Host 时从最新 Project 重新校验目标。
- Machine 显示名称作为现有 Project 的可选字段同步，不改变派生 ID 或 URI。
- Local 路径和本地容器只写入 Extension `globalState` 的 `localProjects.v1`；Remote
  Project 才进入所选共享存储。ProjectService 负责合并两者，上层视图仍只处理一个列表。
- 升级清理遵循 local-first：先持久化 Local 副本，再从同步目录删除对应记录。

### 3. Webview

- 保留 Machine、Environment、Favorites 层级；
- 保留 tag AND 过滤、文本搜索与唯一计数；
- 接入顶部 Expand/Collapse All；
- Project 整行点击发送 `selected-project`；
- Machine 右侧按钮发送 `open-machine-host`；
- Local Machine 通过同一消息打开空白本地窗口；
- Machine 的 `…` 菜单支持修改和重置显示名称；
- Project 恢复颜色点并提供可自动关闭的 `…` 操作菜单；
- 结果数与 tag/Add 图标组成一个紧凑工具栏，Project 行不重复展示 tag；
- 删除状态菜单、Setup 与异步 settlement。

### 4. 清理

- 删除 V2/Profile/UI Bridge 新增文件及测试；
- 恢复 UI Bridge 版本和打包合同；
- 删除迁移、恢复、并发和 profile 架构清单；
- 将 PRD 和线框图改为纯视图方案。

### 5. 验证与交付

- `npm run test-compile`；
- Machine Projects 单元、合同和浏览器测试；
- Dashboard Webview 检查、behavior contracts、lint、release packaging；
- `git diff --check`；
- 构建并安装本地主扩展供 Owner 验收；
- Owner 完成全部验收后再创建唯一最终 PR。
