# Remote Machines Projects 线框与交互合同

## 默认状态

```text
┌────────────────────────────────────────────┐
│ [ Search Projects ]     [collapse] [gear] │
│ OPEN   PROJECTS   AI                       │
├────────────────────────────────────────────┤
│ 3 projects on 2 machines        [tag][+] │
│                                            │
│ ▾ FAVORITES  1                            │
│     ● API          devbox › Host  [★][…] │
│                                            │
│ ▾ devbox                      [open ↗][…] │
│   ▾ Host                                  │
│       ● API                       [★][…] │
│   ▾ workspace (Dev Container)             │
│       ● Worker                    [☆][…] │
│                                            │
│ ▾ Ubuntu (WSL)                    [open ↗] │
│   ▾ Host                                  │
│       CLI                         #tools   │
└────────────────────────────────────────────┘
```

- 点击 Machine 名称区域只切换展开状态。
- 点击 Machine 右侧 `[open ↗]` 在新窗口打开 Host；`[…]` 可修改或重置显示名称。
- 点击 Project 行按保存的完整 URI 打开 Project。
- 星标按钮只切换 Favorite。
- `…` 菜单提供当前窗口打开、编辑、改色和删除，点击菜单外部即关闭。
- `Local` 的右侧打开按钮创建空白本地窗口。

## Tag 过滤

```text
┌────────────────────────────────────────────┐
│ 1 project on 1 machine          [tag²][+] │
│                                            │
│ ▾ FAVORITES  1                            │
│     ● API          devbox › Host  [★][…] │
│                                            │
│ ▾ devbox                      [open ↗][…] │
│   ▾ Host                                  │
│       ● API                       [★][…] │
└────────────────────────────────────────────┘
```

两个 tag 使用 AND 关系。Favorite 与目录行是同一 Project，不重复计数。

## 260px 窄宽度

```text
┌──────────────────────────┐
│ [ Search ] [collapse][⚙] │
│ OPEN  PROJECTS  AI       │
├──────────────────────────┤
│ 2 projects / 1 machine [tag][+] │
│ ▾ devbox       [↗][…]   │
│   ▾ Host                 │
│       ● API        [★][…]│
│   ▾ workspace (Container)│
│       ● Worker     [☆][…]│
└──────────────────────────┘
```

不得出现水平滚动。长名称截断但通过 title/accessible name 保留完整身份。

## 不应出现的状态

本视图没有 Setup、Rebind、Assign、Repair、Preview、Migration Report、Update UI
Bridge 或连接配置表单。Project 行不重复展示 tag；tag 只在顶部筛选器中出现。
