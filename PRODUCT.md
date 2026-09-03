# Product

<!-- impeccable:product-schema 1 -->

> 状态：基于当前仓库与产品需求推定，待产品负责人确认。下文标为“代码事实”的内容来自现有实现；其余产品判断均为本次 PRD 的工作假设。

## Platform

web

## Users

- 主要用户是同时维护多个代码项目、多个 VS Code 窗口，并使用 Codex、Claude 或 Kimi 辅助开发的软件工程师。
- 典型用户会在本机、Remote SSH、WSL、Dev Container 等不同开发环境间切换，需要快速找到项目、进入正确机器，并继续已有 AI 会话。

## Product Purpose

Agent Pivot 是 VS Code 内的开发工作台，用于切换、监控和恢复分布在不同工作区中的 AI 编码会话，同时管理已保存项目、开发环境、工作树、Prompt 和 Skills。

成功意味着用户能够在一个紧凑入口中回答三个问题：当前有哪些开发窗口和 AI 会话、目标项目在哪台机器上、下一步应该进入哪个项目或会话。

## Positioning

Agent Pivot 不是通用 SSH 客户端或独立项目启动器。它以 VS Code 工作区为运行边界，把开发机器、项目、Git worktree 和 AI 编码会话组织成一条可恢复的工作上下文链路。

## Operating Context

- 产品运行在 VS Code Extension Webview 中，沿用 VS Code 的窗口、主题、命令、Remote URI 和扩展生态。
- 用户可能同时打开多个本地或远端 VS Code 窗口，并通过侧边栏在窗口、项目和 AI 会话间切换。
- 项目目录可能是普通文件夹、`.code-workspace`、Remote SSH URI、WSL URI 或 Dev Container URI。
- 项目目录与同步信息可能包含敏感的机器别名和路径；凭据、密钥及密码不得进入项目目录或 Settings Sync。

## Capabilities and Constraints

- **代码事实：** `OPEN` 页面展示当前窗口及其他已打开窗口；`PROJECTS` 页面保存项目目录。
- **代码事实：** 已保存项目支持用户分组、收藏、排序、名称、描述、颜色、tag、搜索以及 tag 多选过滤。
- **代码事实：** 远端项目以 VS Code Remote URI 保存，当前支持 SSH、WSL、Dev Container 和其他 Remote 类型。
- **代码事实：** 项目目录可保存在 VS Code extension global state，或通过 Settings Sync 同步。
- **代码事实：** Webview 使用原生 HTML/CSS/JavaScript 与 VS Code 主题变量，不依赖 React、Vue 或 Tailwind。
- **代码事实：** 主扩展以 workspace Extension Host 运行；仓库另有 `extensionKind: ui` 的 companion bridge，可承载同一桌面 VS Code 安装实例跨 Local/SSH/Dev Container 共享的本地状态。
- Remote SSH 管理首先复用 VS Code Remote-SSH 的连接能力，不自行实现 SSH 协议、凭据管理或连通性探测。
- 机器和项目数据的迁移必须无损、可重复，并继续兼容同步冲突恢复。
- Connection Profile、Client ID 与包含本地 alias 的降级数据必须留在 UI bridge，不得写入同步目录。

## Brand Commitments

- 产品名称为 **Agent Pivot**。
- 界面语言当前以简洁英文为主，语气直接、工具化，不使用营销式文案。
- 产品应保持 VS Code 原生感、高信息密度和清晰的键盘操作，不创建与宿主编辑器割裂的独立视觉系统。

## Evidence on Hand

- 产品能力说明：`README.md`。
- Extension 命令与配置：`package.json`。
- 项目模型与远端类型：`src/models.ts`。
- 项目目录和同步：`src/services/projectService.ts`、`src/projects/projectCatalogSync.ts`。
- 远端项目解析与打开：`src/projects/remoteProjectResolver.ts`、`src/projects/projectOpenController.ts`。
- Projects Webview：`src/webview/webviewContent.ts`、`src/webview/webviewFilterScripts.js`。
- 当前没有经确认的用户研究、可用性数据或遥测数据；后续工作不得虚构这些证据。

## Product Principles

1. **先恢复上下文，再管理资源：** 用户进入正确机器、项目、窗口和 AI 会话的路径应尽可能短。
2. **机器是环境边界：** 相同路径在不同远端机器上不是同一个项目，任何身份、搜索和同步逻辑都必须保留机器上下文。
3. **状态必须真实：** 不把“已配置”展示成“在线”，不通过隐式网络探测制造不可靠的在线状态。
4. **组织方式正交：** 机器表达项目在哪里，tag 表达项目是什么；不再用同一种分组同时承担两种含义。
5. **保留用户资产：** 升级、同步冲突和异常数据都不得静默丢失项目、tag、收藏或排序信息。

## Accessibility & Inclusion

- 所有主要操作需要支持键盘访问、可见焦点和读屏语义。
- 不以颜色作为连接状态、当前机器、收藏或过滤状态的唯一表达。
- 遵循 VS Code 的高对比度、forced colors、缩放和 reduced motion 设置。
