# dsh-plugin-automations

> **一句话介绍 / One-liner:** 为 DeepSeek Harness Web Profile 提供定时任务：支持准点执行、只在 DeepSeek 谷时段执行的“空闲执行”，以及每天重复执行。
> **A scheduled-task plugin for the DeepSeek Harness Web profile: run tasks on time, only during DeepSeek off-peak (valley) pricing hours, or repeat daily.**

---

## 功能特性 / Features

- 设置页「定时任务」表单与任务列表 / A settings-page form and task list;
- 执行方式：准点执行 / 空闲执行（谷时段）/ Execution modes: **on-time** / **when-idle (valley hours)**;
- 重复方式：仅一次 / 每天执行 / Repeat: **once** or **daily**;
- 空闲执行只在谷时段执行：北京时间高峰 `09:00-12:00`、`14:00-18:00` 之外，高峰期自动顺延至下一个谷时段开始 / *when-idle* runs only outside Beijing peak hours (`09:00-12:00`, `14:00-18:00`), deferring to the next valley-hour window;
- 每天执行自动滚动到下一自然日同一本地时刻（跨月、跨夏令时保持墙钟时间）/ *daily* tasks roll to the same local wall-clock time the next day (month and DST aware);
- Client 每 5 秒轮询 / 5-second client polling;
- 基于 `ctx.storageDomain` 的持久化任务状态 / durable task state via `ctx.storageDomain`;
- 单一串行 Scheduler pump，先持久化 `running` 再启动 Runner / one serialized scheduler pump that persists `running` before launching the runner;
- 独立 Session、默认 Agent preset、默认模型与 Host workspace root / isolated sessions with the default preset, model, and host workspace root;
- 固定 30 分钟执行超时 / fixed 30-minute execution timeout;
- 启动时把遗留 `running` 标记为 `host_interrupted`（每天任务顺延到次日）/ orphaned `running` tasks are marked `host_interrupted` on startup (daily tasks roll to the next day);
- 严格 JSON API、body/prompt 上限、同源 Origin 与自定义 mutation header / strict JSON API with body/prompt limits, same-origin checks, and a custom mutation header;
- 插件消息标记为 `{ kind: 'plugin', plugin: 'dsh-plugin-automations' }`，不伪装成人类输入 / plugin messages are branded as plugin-generated, never disguised as human input.

完整行为契约见 `SDD.zh-CN.md`（中文软件设计文档）。
Full behavioral contract: `SDD.zh-CN.md`.

---

## 快速安装 / Quick Start

在 DSH 已安装的 profile 上安装本插件（推荐以本地目录方式添加，便于迭代）：

Install the plugin into an existing DSH profile (a local directory add keeps it easy to iterate):

```bash
# 1. 安装插件 / install the plugin
dsh plugin --profile <profile> add ./dsh-automations

# 2. 查看组合后的配置（可选）/ inspect the composed config (optional)
dsh --profile <profile> --dump-config

# 3. 启动 DSH / boot DeepSeek Harness
dsh --profile <profile>
```

> 提示 / Tip: 若本地依赖安装失败，请使用 `npm install --legacy-peer-deps`（见下文「开发 / Development」）。

安装后，在 Web 设置页打开「定时任务」即可提交任务：选择**执行方式**（准点 / 空闲-谷时段）与**每天执行**复选框。

After install, open **Settings → 定时任务 (Scheduled Tasks)** in the Web UI, write a prompt, pick an **execution mode** (on-time / when-idle) and optionally check **每天执行 (run daily)**.

### 从 npm 包安装（可选）/ Install from a packed tarball (optional)

```bash
npm pack            # 生成 dsh-plugin-automations-<version>.tgz
dsh plugin --profile <profile> add ./dsh-plugin-automations-<version>.tgz
```

---

## 使用说明 / Usage

### 执行方式 / Execution modes

| 模式 / Mode | 行为 / Behavior |
| --- | --- |
| `on_time` 准点执行 | 到期后立即创建独立 DSH Session 执行，不等待任何窗口。Runs immediately when due. |
| `when_idle` 空闲执行（谷时段） | 只在谷时段执行：北京高峰 `09:00-12:00`、`14:00-18:00` 之外；高峰期内保持「等待空闲时段」，并在下一个谷时段开始时自动执行。Runs only outside Beijing peak hours; waits during peak and starts automatically at the next valley-hour window. |

### 重复方式 / Repeat

| 重复 / Repeat | 行为 / Behavior |
| --- | --- |
| `once` 仅一次 | 完成或失败后不再执行。Never runs again after completion or failure. |
| `daily` 每天执行 | 进入终态后自动滚动到下一自然日同一本地时刻并重置为 pending（跨月、跨夏令时保持墙钟时间）。Rolls to the same local time the next day and resets to `pending` (DST/month aware). |

---

## HTTP API

- `POST /dsh-scheduled-tasks/api/v1/tasks`
  - `Content-Type: application/json`
  - `X-DSH-Scheduled-Tasks: 1`
  - Body: `{ prompt, scheduledAt, timeZone, mode, repeat }`
- `GET /dsh-scheduled-tasks/api/v1/tasks`

```bash
curl -X POST http://127.0.0.1:3080/dsh-scheduled-tasks/api/v1/tasks \
  -H 'Content-Type: application/json' \
  -H 'X-DSH-Scheduled-Tasks: 1' \
  -d '{
    "prompt": "check project tests",
    "scheduledAt": "2026-08-15T01:00:00+08:00",
    "timeZone": "Asia/Shanghai",
    "mode": "when_idle",
    "repeat": "daily"
  }'
```

MVP 不提供编辑、删除、暂停、取消、重试或分页。
The MVP has no edit/delete/pause/cancel/retry/pagination endpoints.

---

## 开发 / Development

```bash
npm install --legacy-peer-deps
npm run check     # tsc --noEmit + node --check client/bundle.js
npm test          # vitest run
npm run build     # tsdown -> lib/
npm pack --dry-run
```

`--legacy-peer-deps` 仅用于当前 DSH 预发布包的本地开发：公开的 `@deepseek-ai/dsh-storage-domain` 仍携带旧版 peer range，而当前 DSH Web 组合使用同一 API 的新版本。

`--legacy-peer-deps` is only needed for local development against the current DSH pre-release packages: the published `@deepseek-ai/dsh-storage-domain` still carries an older peer range while the current DSH Web bundle uses a newer build of the same API.

---

## 存储命名说明 / Storage naming

SDD 将逻辑 domain 命名为 `scheduled-tasks`。当前 DSH `storageDomain` 的运行时约束是 `^[a-z][a-z0-9_]*$`，因此实际 unit 名使用 `scheduled_tasks`；HTTP 路径和产品命名保持 SDD 原样。

The SDD names the logical domain `scheduled-tasks`. Because the current DSH `storageDomain` restricts runtime unit names to `^[a-z][a-z0-9_]*$`, the actual unit is `scheduled_tasks`; the HTTP path and product naming keep the SDD spelling.

---

## 许可 / License

MIT
