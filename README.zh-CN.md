[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-plugin-automations

> 为 DeepSeek Harness Web Profile 提供定时任务：支持准点执行、只在 DeepSeek 谷时段执行的“空闲执行”，以及每天重复执行。

## 功能特性

- 设置页“定时任务”表单与任务列表，每 5 秒轮询一次。
- 两种执行方式：**准点执行**和**空闲执行（谷时段）**。
- 两种重复方式：**仅一次**和**每天执行**。
- `when_idle` 仅在北京时间高峰 `09:00-12:00`、`14:00-18:00` 之外执行；高峰期内自动顺延至下一个谷时段。
- 每天执行保持相同的本地墙钟时间，正确处理跨月和夏令时变化。
- 使用 `ctx.storageDomain` 持久化任务状态。
- 单一串行 Scheduler pump，先持久化 `running` 再启动 Runner。
- 每次执行使用独立 Session，并继承默认 Agent preset、模型和 Host workspace root。
- 固定 30 分钟执行超时，并在启动时明确恢复 `host_interrupted` 任务。
- 严格校验 JSON、请求大小、同源 Origin 和自定义 mutation header。
- 自动化消息标记为 `{ kind: 'plugin', plugin: 'dsh-plugin-automations' }`，不伪装成直接人类输入。

完整行为契约见 [SDD.zh-CN.md](SDD.zh-CN.md)。

## 安装

### `dsh plugin add`（推荐）

将插件安装到 Web profile，安装后重启 DSH。

#### 从 GitHub 安装

```bash
dsh plugin --profile web add github:Sev7een/dsh-plugin-automations
```

#### 从 npm 安装

软件包发布到 npm 后使用：

```bash
dsh plugin --profile web add dsh-plugin-automations
```

如果通过 `npx` 运行 DSH，请使用：

```bash
npx @deepseek-ai/dsh plugin --profile web add github:Sev7een/dsh-plugin-automations
```

检查组合配置并重新启动 Web 应用：

```bash
dsh --profile web --dump-config
dsh web
```

启动后进入 **设置 → 定时任务**。

### 从本地源码安装（开发）

```bash
git clone https://github.com/Sev7een/dsh-plugin-automations.git
dsh plugin --profile web add ./dsh-plugin-automations
```

### 卸载

```bash
dsh plugin --profile web remove dsh-plugin-automations
```

## 使用说明

### 执行方式

| 模式 | 行为 |
| --- | --- |
| `on_time` 准点执行 | 到期后创建独立 DSH Session 并立即执行。 |
| `when_idle` 空闲执行 | 仅在北京时间谷时段执行；高峰期到期的任务等待到下一个谷时段。 |

### 重复方式

| 重复方式 | 行为 |
| --- | --- |
| `once` 仅一次 | 进入终态后不再执行。 |
| `daily` 每天执行 | 下一自然日相同的本地墙钟时间再次执行。 |

## HTTP API

- `POST /dsh-scheduled-tasks/api/v1/tasks`
  - `Content-Type: application/json`
  - `X-DSH-Scheduled-Tasks: 1`
  - Body：`{ prompt, scheduledAt, timeZone, mode, repeat }`
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

MVP 不提供编辑、删除、暂停、取消、重试或分页接口。

## 开发

```bash
npm install --legacy-peer-deps
npm run check
npm test
npm run build
npm pack --dry-run
```

当前本地开发需要 `--legacy-peer-deps`，因为公开的 `@deepseek-ai/dsh-storage-domain` 仍携带旧版 peer range，而当前 DSH Web bundle 使用更新版本。

## 许可

MIT
