# Remote Machines Projects 线框与交互合同

## 默认状态

```text
┌────────────────────────────────────────────┐
│ [ Search Projects ]     [collapse] [gear] │
│ OPEN   PROJECTS   AI                       │
├────────────────────────────────────────────┤
│ [Tags]                              [Add] │
│ 3 projects on 2 machines                  │
│                                            │
│ ▾ FAVORITES  1                            │
│     ★ API                 devbox › Host    │
│                                            │
│ ▾ devbox                         [open ↗] │
│   ▾ Host                                  │
│       API                  #Backend #api   │
│   ▾ workspace (Dev Container)             │
│       Worker               #Backend #job  │
│                                            │
│ ▾ Ubuntu (WSL)                    [open ↗] │
│   ▾ Host                                  │
│       CLI                         #tools   │
└────────────────────────────────────────────┘
```

- 点击 Machine 名称区域只切换展开状态。
- 点击 Machine 右侧 `[open ↗]` 在新窗口打开 Host。
- 点击 Project 行按保存的完整 URI 打开 Project。
- 星标按钮只切换 Favorite。

## Tag 过滤

```text
┌────────────────────────────────────────────┐
│ [Tags (2)]  Backend  active         [Add] │
│ 1 project on 1 machine                    │
│                                            │
│ ▾ FAVORITES  1                            │
│     ★ API                 devbox › Host    │
│                                            │
│ ▾ devbox                         [open ↗] │
│   ▾ Host                                  │
│       API                  #Backend #api   │
└────────────────────────────────────────────┘
```

两个 tag 使用 AND 关系。Favorite 与目录行是同一 Project，不重复计数。

## 260px 窄宽度

```text
┌──────────────────────────┐
│ [ Search ] [collapse][⚙] │
│ OPEN  PROJECTS  AI       │
├──────────────────────────┤
│ [Tags]             [Add] │
│ 2 projects on 1 machine  │
│ ▾ devbox          [↗]   │
│   ▾ Host                 │
│       API        #Backend│
│   ▾ workspace (Container)│
│       Worker      #worker│
└──────────────────────────┘
```

不得出现水平滚动。长名称截断但通过 title/accessible name 保留完整身份。

## 不应出现的状态

本视图没有 Setup、Rebind、Assign、Repair、Preview、Migration Report、Update UI
Bridge 或连接配置表单。无法安全派生 Host 的 Machine 只省略 Host 打开按钮；其 Project
仍按现有打开链路工作。
