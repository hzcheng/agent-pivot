# Webview 开发 Harness 提效 PRD

## 背景

Agent Pivot 的 webview 质量体系是"机器强制 + 多层验证"：版本化消息协议
（exact-keys 校验）、Host 权威状态、行为契约目录、四层测试、字节级双拷贝
（`src/webview/` 规范源 ↔ `media/` 运行时拷贝）、sha256 钉死的版本兼容
strip 链、PR 审批门禁。这套体系对 AI agent 主导开发的仓库是必要的——它把
"靠 reviewer 记得检查"换成了"CI 不过就进不去"。

2026-08 的 telemetry 图标状态特性暴露了这套体系的边际成本问题。一个
"图标加状态色环 + 点击清除 attention"的小功能（webview 脚本侧核心逻辑约
95 行），最终改动 18 个文件、+740 行（`git show --stat 11fd2f22`），并
出现两次返工：

1. **CSS 伪元素冲突**：状态色环用 `::after` 实现，与 tooltip 气泡占用的同
   名伪元素冲突，导致色环不可见、hover 时 tooltip 被染色。该 bug 穿透了
   全部四层测试，直到人工安装后才被发现——DOM 断言对渲染结果天然失明
   （review-fix-commit-loop skill 已写明该盲区，但无可执行入口）。
2. **协议接线回归**：可选回调被包成恒存在的闭包，破坏了"reader 缺席"
   语义，产生幽灵消息——**被既有集成测试当场拦截**，说明现有 harness
   在协议层是有效的；本 PRD 不改动这一侧。

同时记录到的高摩擦点：

- webview 脚本存在双拷贝：浏览器测试读 `src/webview/`（JS），运行时与
  CSS 读 `media/`。字节一致性目前**已被 CI 部分强制**——
  `scripts/run-dashboard-webview-checks.js` 对 dashboard `webview*` 脚本
  做逐字节断言；缺口在 `conversation*` 脚本，靠开发者记得跑
  `npx gulp copyWebviewAssets`，遗漏即静默发霉；
- 版本兼容测试用一长串 `.replace()` 字符串手术（strip 链）把当前脚本
  变换回"上一版"并以 sha256 钉死。**经审计，该链包含大量语义变换**
  （用旧实现整体替换当前实现块，见 tests/browser/conversationViewer.test.js
  :3886 起的 fixture 重建段），且两个钉死的 fixture SHA **不对应任何
  release tag**（v1.1.1 的两脚本 SHA 与 pin 值均不匹配）。即：当前兼容
  测试的语义是"当前版本 ↔ 合成的相邻代际"，而非"当前 ↔ 最近发布版"。
  失败时该机制显红（哈希不匹配），真实成本是每次改动都要做字符串级
  手术的高维护劳役；
- 本地迭代闭环是"打包 → 安装 → reload 窗口 → 人工观察"，周期数分钟。

## 目标

在保证全部机器强制不减弱的前提下，降低小规模 webview 改动的边际成本：

1. 把"靠纪律维持的不变量"改为"靠构造保证 + CI 断言兜底的不变量"；
2. 首批关键区域的视觉回归具备自动拦截能力——首批视觉覆盖仅含
   provider 图标环带与底部状态点两个区域；header 截断由 DOM 布局
   oracle 覆盖（见 P0-B），不声称属于视觉覆盖；
3. 沉淀进 skill 的高价值教训具备机械检查能力，而非纯文字。

量化口径（以 telemetry 图标特性 diff 重放为参照基线，方向性参考）：

- `conversation*` 脚本的双拷贝纪律性维护动作消失——仓库中不再存在第二份
  拷贝（验收：`git ls-files media/` 中 direct-copy 镜像文件数为 0，构造上
  不可能再发生"忘记同步"）；
- 版本兼容 fixture 的维护从"每次 webview 脚本改动都要做字符串手术"降为
  "发布后一次 fixture 滚动 PR"；
- 首批覆盖区域内的视觉回归由自动化拦截，不再穿透到人工测试。

## 非目标

- 不减弱以下任何机制：消息协议 exact-keys 校验与版本化、Host 权威与
  禁止乐观更新、merge-approval 绑定精确 head SHA、PR body 门禁
  （Skill harvest / Owner approvals）、行为契约目录；除 P1-C 明确记录的
  version-skew 兼容语义替换（合成相邻代际 → 最近发布版完整闭包）外，
  四层测试的覆盖面不缩减。
- 不改变任何运行时行为与用户可见界面。
- 不引入前端框架；webview 脚本保持无依赖、可直接加载的形态。
- 第一阶段不做消息协议 code 生成（见 P2-E，仅登记方向）。
- 不动 `media/` 下的 vendored 第三方文件（`purify.min.js`、`mermaid.min.js`
  等）与样式源（`media/conversationTelemetry.css` 手写源、`*.scss`）的
  追踪方式。

## 问题分析与方案

### P0-A：webview 脚本单一事实源

**现状**：`src/webview/*.js` 是规范源；`media/` 中由 `copyWebviewAssets`
写入的同名拷贝也提交进 git。浏览器测试读 `src/webview/`；运行时与发布包
读 `media/`。

**保证**：发布包中的脚本字节 == `src/webview/` 源（测试跑的就是源）。

**方案**：

1. **不新建清单**，复用既有 `docs/testing/architecture-webview-manifest.json`
   （checkWebviewManifest.js 已对全部 webview 脚本做 exact-once 成员校验）。
   注意分发关系**不是**互斥的逐脚本分类：dashboard 的每个源脚本既被
   direct-copy 到 `media/`，又同时是 dashboard bundle 的输入。因此模型
   改为两个正交维度：
   - **脚本侧**：每个源脚本条目可选声明 `directCopy: "media/<name>"`
     （有则意味着存在字节镜像拷贝）；
   - **bundle 侧**：单独声明 bundle 产物 `{ output, scripts, vendor }`
     （`media/webviewDashboardBundle.js`，由 builder 拼接多文件与 vendor
     资源，不属于任何单一源文件）。
   清单即 copy 映射的唯一来源，`copyWebviewAssets` 与发布检查都从它
   派生，避免第二份需要手工维护的文件列表。
   **闭合规则（fail-closed）**：凡被单独加载的脚本（出现在
   viewerDocument 脚本标签/加载顺序中）必须声明 `directCopy`；只有显式
   标记 `bundledOnly: true` 的脚本才允许省略。否则新增脚本漏登
   `directCopy` 时，拷贝逻辑与发布检查会从同一份不完整清单一致地漏掉
   该文件而保持绿色。架构守卫检查此规则，缺失即失败。
2. 声明了 `directCopy` 的 `media/*.js` 从 git 删除（`git rm --cached`）并加入
   `.gitignore`；`scripts/build-dashboard-webview-bundle.js`
   （`test-compile` 已调用）前置执行拷贝，保证任何测试/打包路径前拷贝
   必然重新生成。vendored 第三方文件与样式源保持 tracked 不动。
3. 发布检查（`run-release-packaging-checks.js`）按维度断言：
   - `directCopy`：包内字节 == `src/webview/` 源字节；
   - bundle：现场重跑 builder 两次输出逐字节一致（确定性验证），
     且包内字节 == 本次构建输出。
4. 本地安装链路无需变更：`scripts/build-test-package-install.sh` 本就先
   跑 `test-compile` 再打包，构建期拷贝天然覆盖 install 场景。

**已确认的权衡（接受）**：

- `git checkout <旧 tag>` 得到的不再是可以直接加载扩展的树（需先
  `npm run test-compile` 生成拷贝）。对 bisect webview 回归增加一步
  构建；由发布检查的字节断言兜底正确性。
- 裸跑 `node --test`（未先 `test-compile`）在干净树上会因缺拷贝失败；
  与现状一致（`out/` 同样需编译），AGENTS.md 已把 `test-compile`
  定义为最小验证入口。

**配套文档更新（同 PR 交付）**：AGENTS.md 的 Key paths 与常用命令；
`.skills/review-fix-commit-loop`（gulp 同步纪律条款改写为"构建期自动"）；
`.skills/resilient-webview-mutation-protocols`（双拷贝条款同步修订）。

### P0-B：关键区域视觉断言（定点、门禁内；不做全量截图套件）

**现状**：DOM 断言对渲染结果失明。本次色环 bug 穿透四层测试后由人工
发现。

**设计约束**：本仓库合并门禁为 `approve <full-head-sha>`，head 一动批准
即过期；CI flake 会强制 owner 重新走批准流程。因此**不做**门禁级全量
像素对比套件——flake 成本高、且每次有意的视觉变更都要更新基线，恰好
对本 PRD 想优化的"小改动"征收新税。

**方案**：

1. 像素读取路线（两处修正）：截取用 Playwright `page.screenshot({ clip })`
   ——先取 `locator.boundingBox()`，向四周外扩 ≥4px（ring 为 1.5px spread
   的 box-shadow，位于 border box 之外，`locator.screenshot()` 只截取
   border box 会把它裁掉）——再用仓库既有依赖 `sharp`（0.35.3）解码为
   raw pixels 断言。不引入新依赖。
2. 采样稳定性：每个用例固定 theme fixture、viewport、`deviceScaleFactor=1`，
   并 `page.emulateMedia({ reducedMotion: 'reduce' })`——attention 脉冲动画
   在采样时处于静止态（ring 本体仍在，动画关闭），消除帧间抖动。
3. 首批覆盖矩阵（与"目标 #2"一致，每项含故障注入）：

   | 区域 | 断言 | 状态矩阵 | 故障注入（必须变红） |
   |---|---|---|---|
   | telemetry bar provider 图标 | 外扩 clip 内、图标四周 1-3px 环带存在/不存在满足色距（RGB Δ ≤ 32）的状态色像素 | running/attention/idle/无状态 × 默认 700px 宽 × 固定 theme | 重新引入 `::after` 色环 bug；删除 ring 的 box-shadow 规则 |
   | 底部 session 状态点 | 状态点区域存在状态色（`--session-status-color` 驱动的 border/background/color）像素、禁用态变灰 | running>0、attention>0、全 0 禁用 × 默认宽度 | 删除各 kind 的 `--session-status-color` 颜色规则（**不是**删 `conversation-session-status-active`——它只携带动画，reduced-motion 下本就关闭，删它截图无变化） |

   上表即首批**视觉**覆盖的完整范围。另有 header 截断一项，**不属于
   视觉断言**：

   - header 用 **DOM 布局 oracle**：对不允许截断的段落断言
     `scrollWidth ≤ clientWidth`；ellipsis 在 identity 段落是既有设计
     （conversationViewer.scss 的 `.conversation-identity span`），列入显式
     "允许截断"白名单；状态矩阵为默认 700px 与最小 240px 两档 × 固定
     theme；故障注入为"人为缩短容器宽度使非白名单段落截断"，断言必须
     变红。
   - 不做 header 的像素基线对比：文本渲染的字体/抗锯齿跨环境不稳定，
     golden image 在本仓库的高频合并流下 flake 成本高于收益；header 的
     布局类变更仍由 review-fix-commit-loop skill 的逐改动截图核查要求
     （默认/最小宽度）把关，那是开发期流程要求，不是 CI 门禁。
4. Flake 策略：该文件内视觉用例在 node:test 层重试一次，再失败才算失败；
   不允许静默跳过。
5. 新增行为契约条目（如 `CONVERSATION-TELEMETRY-VISUAL-001`），owner
   指向该测试文件。全区域截图 diff 未来如需扩展，仅以非门禁定时任务
   形式存在（另行评审，不在本 PRD 范围）。

### P1-C：冻结版本兼容 fixture（钉死基线 tag + 滚动 PR），替代 strip 链

**现状与审计结论**：strip 链含语义变换而非纯删除，且现 fixture 不对应
任何 release tag（见"背景"）。因此"冻结 tag fixture 且语义不变"不可兼得，
**明确选择**：把兼容测试重新定义为 **"当前版本 ↔ 最近发布版本"**——这
正是用户升级的真实路径，语义上比"相邻合成代际"更有价值。被放弃的旧
语义（对任意中间合成版本的兼容）在 release notes 级别的测试说明中记录，
不再保留。

**被否决的替代方案**：保留 strip 链 + 机械生成 strip 字面量的"提案生成器"。
否决原因：它保留的是"合成代际"语义，且生成器本身要理解语义变换的
方向，复杂度高于收益。

**方案**：

1. **冻结完整的脚本依赖闭包**，而非仅 viewer/outline 两个文件。实证：
   v1.1.1 的 viewer 直接读取 9 个独立旧 globals（`__agentPivotConversation
   Comments/Find/Mermaid/Outline/ReadingAnchor/Reconcile/Sidebar/Subagents/
   Telemetry`），且 v1.1.1 中不存在 registry 脚本（单一
   `__agentPivotConversation` 命名空间是后引入的）；只冻结 viewer+
   outline、配上当前 companion 脚本，旧 viewer 初始化即失败。因此
   `tests/fixtures/webview-previous/` 保存基线 tag 的**全部
   `conversation*Scripts.js`**（按 tag 的 viewerDocument 脚本标签枚举），
   并在 manifest 中记录加载顺序与 globals 形态（有无 registry）。
2. `tests/fixtures/webview-previous/manifest.json` **钉死基线 tag**
   （如 `{ "baselineTag": "v1.1.1", "scripts": [...], "loadOrder": [...] }`），
   而不是隐式取"最新 tag"——这是解除发布死锁的关键（见下）。
3. CI 校验（只读，三道）：(a) fixture 文件 ==
   `git show <baselineTag>:src/webview/<name>` 逐字节一致；(b) 从
   `<baselineTag>:src/aiSessions/conversation/viewerDocument.ts` 重新提取
   脚本标签，断言其**文件集合与顺序**和 fixture manifest 的
   `scripts`/`loadOrder` 完全一致——滚动时漏列 companion 或 loadOrder
   漂移都会失败；(c) vendor 脚本（purify/mermaid 等第三方库）明确使用
   **当前版本**（由 package-lock 钉定，不属于本仓库演进代码）；若基线
   滚动跨越了 vendor 版本差异且导致旧脚本不兼容，必须在滚动 PR 的
   REMOVED-SINCE 清单中记录。CI checkout 需 `fetch-tags: true`（落地时
   核查 `.github/workflows/*.yml` 的 checkout 配置并补齐）。失配即失败。
4. 首次 bootstrap：M2 合并时，fixture 由 manifest 钉住的既有 tag
   （`git show <tag>:src/webview/<name>`）生成，而非当前源。
5. **发布后的事务顺序**（解决"新 tag 前提交当前快照必挂 / tag 后无人
   提交 / 滚动前普通 PR 全挂"的死锁）：release 发布后，由**一次明确的
   fixture-roll PR**（人工触发或定时任务起草）在同一提交内完成：
   (a) `baselineTag` Bump 到新 tag；(b) 用新 tag 内容重生成整个闭包
   fixture；(c) 生成/更新 `REMOVED-SINCE-<tag>.md` 清单（自上个基线以来
   新增的协议能力与 webview 行为列表，供评审——替代 strip 链今天的
   provenance 价值）。在滚动 PR 合入前，CI 校验仍针对**旧** pinned tag，
   常绿；普通 PR 完全不受影响。
6. 浏览器测试改为直接读取 fixture 闭包并按 manifest 的加载顺序注入，
   删除 strip 链与 sha256 pin。

**兼容性声明（收窄，诚实版）**：正向 = "当前宿主文档与消息流 ↔ 最近
发布版的完整脚本闭包能正常初始化与交互"。反向（旧文档 ↔ 当前脚本）
仍由 `transformHostDocument` 的 regex 手术**合成模拟**，本轮保留并显式
标注为合成语义；待后续按同思路处理（本 PRD 不排期）。只有正向 + 完整
闭包冻结后，才能声称"当前版本 ↔ 最近发布版本"的兼容性。

### P1-D：伪元素 ownership 的 CSS 约定 + 结构化登记与双向校验

**现状与修正**：纯 CSS 扫描无法证明伪元素所有权——同一 DOM 元素可
同时携带 tooltip class 与业务 class（如 provider 图标同时有
`conversation-telemetry-tooltip` 与 `conversation-telemetry-provider`），
装饰规则可以只写后者（alias selector），绕过任何"禁止 tooltip class 上
写伪元素"的天真规则。更复杂的是，tooltip 系统自身会**合法地**通过业务
alias selector 调整伪元素位置（conversationTelemetry.css:385-400 用
`.conversation-telemetry-position::before` 等调整气泡方位）——检查器无法
仅从 selector 判定一条伪元素规则是 owner 的合法调整还是违规装饰。

**方案**（约定先行，再机械校验）：

1. **CSS 约定重构（同 PR 完成，改动极小）**：凡是作用于 tooltip 承载元素
   的 `::before/::after` 规则，selector 必须复合携带 owner class（如
   `.conversation-telemetry-tooltip.conversation-telemetry-position::after`）。
   现有 alias 调整规则按此改写（选择器特异性随之升高，需确认样式回归
   测试绿色）。约定落地后，"归属"变为可机械判定：**selector 里没有
   owner class 的伪元素规则 = 违规**。
2. 结构化 ownership manifest（如
   `docs/testing/webview-pseudo-ownership.json`）逐元素登记：
   `{ element: "[data-telemetry-provider]", classes: [...], pseudoOwner:
   "conversation-telemetry-tooltip" }`。
3. 检查脚本（挂入 `test:architecture-policy`）双向校验：
   - **CSS 侧**：扫描已追踪样式源（`media/*.css`、`media/*.scss`）中所有
     `::before/::after` 规则，凡 selector 命中的 class 属于某登记元素的
     class 集合而 selector 未复合携带登记的 `pseudoOwner` class，失败；
   - **markup 侧**：从宿主渲染模板（viewerDocument.ts、
     conversationTelemetryController.ts 等）与 webview 脚本的动态 class
     接线中提取"同一元素实际携带的 class 集合"，与 manifest 登记比对，
     元素新增/摘除 class 而不同步 manifest 时失败；
   - **失败闭合**：输入为空、登记的 class 在 markup 中找不到（被改名）、
     或元素出现在 markup 中但未登记且命中任何伪元素规则——均失败，
     不存在静默通过。

### P2-E（中期，暂不启动）：协议消息声明式定义

每条 `conversation-viewer-*` 消息目前要手改 5+ 处。中期可做声明式
消息表生成类型与 parser 骨架。**严格性保留，样板删除。** 本 PRD 只
登记方向，不排期。

## 里程碑与迁移

| 里程碑 | 内容 | 预估 | 顺序约束 |
|---|---|---|---|
| M1 | P0-A 单一事实源 + P0-B 定点视觉断言 | 1-2 天 | 先合 |
| M2 | P1-C 冻结 fixture + 滚动 PR 流程 + P1-D ownership 校验 | 2-3 天 | 基于 M1 之后的树设计；P1-C 需配合一次已完成的 release 做首次滚动演练；**M2 开工前置 spike**：验证 v1.1.1 完整闭包（全部 companion 脚本 + 旧 globals 形态）在当前宿主文档与消息流下能初始化运行——若失败，仅允许测试/harness 侧适配（本 PRD 非目标禁止顺带修改运行时兼容逻辑），或改选能成功初始化的最近 tag 作为基线，或将 P1-C 延期，三选一在 spike 报告中决定 |

（仓库纪律为每个 job 串行 PR，"里程碑独立成 PR"仅指概念可分开评审；
实际落地 M2 叠加在 M1 之上。）

**迁移计划（M1 合并时）**：

- 在途 worktree/分支：凡是已提交 `media/*.js` 镜像编辑的分支，rebase
  到新 main 时按指引执行 `git rm --cached <镜像文件>` 并丢弃镜像侧
  冲突改动（源文件在 `src/webview/`），发布检查兜底验证；
- M1 之前切出的 release 分支保持双拷贝纪律直至其生命周期结束，
  不把新机制 backport 到旧分支。

## 验收标准

1. M1 合并后：`git ls-files media/` 中声明 `directCopy` 的镜像文件数为 0；
   删除 `media/` 下任意镜像 `.js` 后直接运行 `npm run package:release`，产物
   仍包含与 `src/webview/` 逐字节一致的脚本（构建期再生成是机制本体，
   发布检查的字节断言是防御纵深）；bundle 的确定性断言（连续两次构建
   输出一致）通过；删除任一被单独加载脚本的 `directCopy` 声明（且未标
   `bundledOnly`）时，architecture policy 检查必须失败（fail-closed）。
2. 人为重新引入本次的 `::after` 色环 bug，P0-B 的 provider 环带断言
   必须失败；删除状态点颜色规则、构造 header 非白名单段落截断，对应
   断言均须变红；恢复后通过；视觉用例在 CI 上试运行期连续 20 次无
   flake。
3. M2 合并后：向 `conversationViewerScripts.js` 添加任意新函数，版本
   兼容测试无需任何测试文件编辑即可通过；篡改 fixture 或 manifest 中
   的 `baselineTag`，CI 失败；模拟"release 已发布但滚动 PR 未合入"，
   普通 PR 的 CI 保持绿色（校验仍针对旧 pinned tag）；fixture 闭包
   缺任一 companion 脚本或加载顺序错误时，兼容测试在初始化阶段失败
   （而非绿着跳过）。
4. 在登记元素上用未复合携带 owner class 的 selector 新增 `::after`
   规则，`test:architecture-policy` 失败；既有 alias 调整规则改写为复合
   selector 后检查通过；把登记的 tooltip class 改名而不同步 manifest，
   检查同样失败（失败闭合）。
5. 全部既有检查（`test:ci:linux`）保持绿色；除 P1-C 明确记录的
   version-skew 兼容语义替换外，无其他测试覆盖面缩减。

## 保留不动清单（显式确认）

以下机制本次评审后认为成本极低、防灾价值极高，明确保留：

- 消息协议 exact-keys 校验与 `version` 字段（本次真实拦截 6-key 漏洞）；
- Host 权威状态与禁止乐观更新；
- merge-approval 门禁（owner 评论绑定精确 head SHA）；
- PR body 门禁（Skill harvest / Owner approvals 段落）；
- 行为契约目录与 owners/evidence 机械校验；
- unit / contract / integration / browser 四层测试。
