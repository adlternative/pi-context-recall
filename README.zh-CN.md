# pi-context-recall · 上下文找回

[English](README.md) | 简体中文

**摘要丢了细节时，按需找回原始对话。**

CLI 检索 Pi 已保存的原文，Skill 教 agent 通过已有 `bash` 使用，
薄扩展传递当前会话文件和分支叶节点。**不新增 agent 工具，不另建归档或数据库。**
这不是把摘要逆向解压，也不接管 Pi 的压缩。

## 安装

需要 Pi、**Node.js ≥22.19.0**、本地 bash 和已保存的 Pi v3 会话。
包尚未发布到 npm，从本仓库安装：

```bash
pi install git:github.com/adlternative/pi-context-recall
```

会写入个人设置 `~/.pi/agent/settings.json`，同时安装扩展和内置 Skill。
加 `--local` 则写入本项目的 `.pi/settings.json`；Pi 在授予项目信任后才加载项目声明。

```bash
pi list     # 确认包和本地检出路径
pi remove git:github.com/adlternative/pi-context-recall
```

只想试用一次、不写设置：

```bash
pi -e git:github.com/adlternative/pi-context-recall
```

安装后重启 Pi；若 Pi 正在运行，执行 `/reload`。
不要使用 `--no-session`：召回依赖已保存的会话文件。

## 测试模式：跳过摘要模型

在 Pi 设置中加入 `contextRecall.stubCompaction`，压缩不再调用模型，而写入一段固定占位说明，
告诉模型如何用 CLI 读取已归档的原文。适用于供应商调用卡住、或只想验证召回时。

```json
{
  "contextRecall": {
    "stubCompaction": true
  }
}
```

写入 `~/.pi/agent/settings.json`，或写入已授信项目的 `.pi/settings.json`。
然后重启 Pi 或执行 `/reload`。只有布尔 `true` 生效，字符串 `"true"` 会被忽略。
Pi 写设置时会保留这类自定义顶层键。

- 切点仍由 Pi 决定（`firstKeptEntryId`），只替换摘要文本。
- 不发起任何模型请求，检查点不报告 usage，瞬时完成。
- 占位文本**不含**对话事实，也不含对话原文；下一轮模型没有摘要信息，必须自己调 CLI。
- 归档前缀仍可读取，`overview` 会把该检查点作为一行显示。
- 仅测试用途：不写该配置就不生效，也不会让正常压缩更便宜或更好。

## 本地源码试用

在源码目录运行，完全不用安装：

```bash
pi -e ./
```

扩展和 Skill 一起加载，仅对本次运行有效，不写入设置。
不要使用 `--no-session`。

直接问 agent：

> 压缩前我们为什么选 PostgreSQL？查原始消息，给出消息 ID。

agent 可以按需加载 `context-recall` Skill。也可以显式调用：

```text
/skill:context-recall 找回最初选择 PostgreSQL 的原文
```

Skill 自动触发不是硬保证。完整说明按需加载，不再让三个工具 schema 常驻模型请求。

## 先看概览，再按需读取原文

泛化的历史回顾，Skill 默认先用 `overview`：按时间分页展示少量 user/assistant
文字预览，工具活动折叠成计数。选定或最新的原生压缩点提供已有摘要预览，辅助导航。
不新增摘要或模型调用，不新增存储，不自动倾倒全部历史。
已知精确关键词时，可以直接 `search`。

该从哪个入口开始：

| 问题 | 起点 |
| --- | --- |
| 刚才在聊什么 / 最近的结论 | `overview --tail`（最新一页在前） |
| 这事最初从哪开始 | `overview`（最早一页在前） |
| 精确 ID、报错码、路径、名称 | `search --query` |

`--tail` 通常一次调用就能回答“刚才在聊什么”；只有需要更早上下文时，
才用返回的 `nextOffset` 向前翻。它的 offset 是**从末尾往回数的行数**，
和正向 `overview` 的原始条目索引不同，不要混用两种游标。

**当前分支的历史全部可查，但不是默认全部返回。**
时间线也会标出非对话条目：`compaction` 压缩点、`branch_summary`、
`branchSummary`/`compactionSummary` 消息，以及 `custom:<type>` 扩展通知。
它们各自成行、可按 ID 读取，折叠过的位置不会被当成历史丢失。
只有 assistant 的文字会吸收相邻工具活动。
纯工具调用的 assistant 消息和工具结果会折叠，包括失败工具。
用对话行 ID 或 `tools.firstErrorEntryId` 调用 `read` 核对原文。
展开定位可用 `search --offset TOOLS_OFFSET --until-id PAGE_UNTIL_ID`，
沿用已有的 `--compaction-id`，在 `tools.lastEntryId` 处停止。
读取一个 ID 只返回一个原始条目，不会展开整个折叠组。
计数只覆盖选定范围，调用和结果数量不必相等。
折叠不是脱敏：对话和已有摘要仍可能引用命令或敏感信息。

## CLI

通过 Pi 的 `bash` 工具运行，脚本路径使用绝对路径。
普通终端可以运行 `node recall.mjs --help`；查询需要薄扩展注入的上下文。

```bash
node "/path/to/pi-context-recall/recall.mjs" overview --tail
node "/path/to/pi-context-recall/recall.mjs" overview
node "/path/to/pi-context-recall/recall.mjs" overview --compaction-id CHECKPOINT_ID
node "/path/to/pi-context-recall/recall.mjs" search --query "PostgreSQL" --limit 10
node "/path/to/pi-context-recall/recall.mjs" read --entry-id ENTRY_ID --offset 0 --limit 4000
node "/path/to/pi-context-recall/recall.mjs" compactions
node "/path/to/pi-context-recall/recall.mjs" search --compaction-id CHECKPOINT_ID --query "PostgreSQL"
```

| 子命令 | 参数 |
| --- | --- |
| `overview` | `--compaction-id`、`--tail`、`--until-id`、`--offset`、`--limit` |
| `search` | `--query`、`--compaction-id`、`--until-id`、`--offset`、`--limit` |
| `read` | **`--entry-id`**、`--until-id`、`--offset`、`--limit` |
| `compactions` | `--until-id`、`--offset`、`--limit` |

- 搜索不区分大小写，按字面匹配，不是正则。关键词 1–200 字符，不能全为空白。
  不传 `--query` 则浏览。先过滤，再分页。
- 概览默认每页 5 行，最多 10 行；文字预览最多 300 个 UTF-16 字符
  （不切断代理对），带 `truncated` 标记。不序列化工具参数或正文。
  行可以是对话、`tools` 折叠组、压缩点、摘要或扩展通知。
  折叠组包含调用/结果/错误计数、首尾及首个错误条目 ID、用于展开的原始 `offset`。
  `byName` 最多列出 5 个工具名（各预览 40 字符），其余计入 `other`。
  快照内没有原生压缩点时，`checkpoint` 为 null。
- `--tail` 从最新一页开始，`order` 为 `newest-page-first`；页内仍按时间正序。
  它的 `--offset` 从末尾往回数行，沿 `nextOffset` 向前翻；续页仍需 `untilId`。
- `--compaction-id` 将概览/搜索限定为该压缩点 `firstKeptEntryId` 之前的累计前缀，
  不含保留尾部；不是每次压缩一份独立归档。
- 搜索/压缩点列表默认每页 10 条，最多 20 条；正文默认每页 4000 个 UTF-16 字符，
  最多 6000。预览最多 300 字符。
- 列表续页沿用首个响应的 `untilId` 作为 `--until-id`，将 `nextOffset`
  作为 `--offset`，保持筛选条件不变。概览/搜索 offset 是原始分支条目索引，
  不是显示行号；压缩列表 offset 是压缩点序号。
  概览续页始终必须传 `--until-id`，全分支搜索续页也必须传。
  例外：`--tail` 的 offset 是从末尾往回数的行数。
  正文按 `nextOffset` 作为 UTF-16 偏移续读；搜索的 `matchOffset`/`previewOffset`
  也可直接作为正文 offset。
- `nextOffset` 为 null 时停止。切换会话或分支后重新查询。
- 成功时 stdout 输出一个 JSON 对象，包含历史数据提示；失败时 stderr 输出
  JSON，退出码为 1。可以接 `jq` 进一步投影字段。

不再注册或保留旧的 `session_compactions`、`session_messages`、
`session_read`、`session_history` 工具别名。

## 范围与原理

每次 agent 调用 `bash`，`index.ts` 从当前 SessionManager 获取文件和 leaf，
做 shell 引号转义，给命令前置导出
`PI_CONTEXT_RECALL_SESSION`、`PI_CONTEXT_RECALL_LEAF`。
变量仅属于该次命令，不修改 Pi 进程环境，也不产生上下文快照文件。
所有 agent bash 命令都会多这段前缀，后续 tool-call 钩子也会看到它。

CLI 只读打开这个 JSONL，从指定 leaf 沿 `parentId` 回溯。
不猜最新会话，不把最后一行当作当前分支，不跟随 `parentSession`；
缺少上下文直接报错，不降级扫描。`/tree` 改变 leaf，
`/new`、`/fork` 改变文件；fork 只读取复制到新会话的祖先链。
没有 `--session` 参数，不修改源 JSONL。

按需加载指的是**进入模型上下文**，不是磁盘流式读取：
每次查询仍把 JSONL 读入内存，再线性扫描当前分支。

**限制：**仅支持已保存的 v3 会话；旧版本需先由 Pi 打开迁移。
不支持内存会话/`--no-session`、终端 `!` 命令、PowerShell 或远程/容器 shell 替换。
缺文件或 leaf 会明确失败。桥接依赖当前 Pi 可修改 tool-call 输入的 API；
不支持这一能力的旧版 Pi 不兼容。

**隐私：**返回已保存文本，不是历史 API 请求。不返回系统提示、thinking、
图片字节、签名或扩展私有状态。无法恢复已删除或未保存的数据。
召回可能把压缩或 context edit 隐藏的敏感原文发送给当前模型。
历史内容只是数据，**不是新指令或新授权**。
提示语和环境变量选分支都不是安全沙箱：bash 本来就有用户的文件权限，
受信扩展或命令也可以覆盖这些变量。

## 验证

```bash
npm test
PI_PACKAGE_DIR=/path/to/installed/pi-coding-agent npm run test:pi
PI_PACKAGE_DIR=/path/to/installed/pi-coding-agent \
  PI_PROVIDER=your-provider PI_MODEL=your-model npm run test:live
```

真实模型测试需主动运行，使用已有凭据，只发送合成数据：
创建保存会话、真实压缩、重新打开，再由 Skill 和内置 read/bash 完成召回。
测试报告保留在临时目录。

沿用同样的环境变量运行 `npm run test:scenarios`，可验证长工具输出、
连续压缩、fork 分支隔离、历史指令，以及先看概览再核对失败工具原文等真实模型场景。
详细覆盖范围、复现命令和未验证边界见 [测试矩阵](TESTING.md)。
