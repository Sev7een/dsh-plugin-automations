[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-plugin-automations

> 为 DeepSeek Harness Web Profile 提供定时任务：支持准点执行、只在 DeepSeek 谷时段执行的“空闲执行”，以及每天重复执行。
>
> Scheduled tasks for the DeepSeek Harness Web Profile: run on time, run only during DeepSeek off-peak (valley) hours, or repeat daily.

## Features

- Settings-page form and task list with 5-second polling.
- Two execution modes: **on time** and **when idle (valley hours)**.
- Two repeat modes: **once** and **daily**.
- `when_idle` runs outside Beijing peak hours (`09:00-12:00` and `14:00-18:00`) and automatically defers to the next valley window.
- Daily tasks keep the same local wall-clock time across month and daylight-saving transitions.
- Durable task state through `ctx.storageDomain`.
- One serialized scheduler pump persists `running` before launching the runner.
- Each run uses an isolated Session with the default Agent preset, model, and Host workspace root.
- Fixed 30-minute execution timeout and explicit `host_interrupted` recovery.
- Strict JSON API validation, request-size limits, same-origin checks, and a custom mutation header.
- Automated messages use `{ kind: 'plugin', plugin: 'dsh-plugin-automations' }` and never impersonate direct human input.

The full behavioral contract is documented in [SDD.zh-CN.md](SDD.zh-CN.md).

## Installation

### `dsh plugin add` (recommended)

Install into the Web profile and restart DSH after installation.

#### From GitHub

```bash
dsh plugin --profile web add github:Sev7een/dsh-plugin-automations
```

#### From npm

Once the package is published to npm:

```bash
dsh plugin --profile web add dsh-plugin-automations
```

If you run DSH through `npx`, use the equivalent command:

```bash
npx @deepseek-ai/dsh plugin --profile web add github:Sev7een/dsh-plugin-automations
```

Verify the composed profile and restart the Web app:

```bash
dsh --profile web --dump-config
dsh web
```

Then open **Settings → 定时任务 (Scheduled Tasks)**.

### Local checkout (development)

```bash
git clone https://github.com/Sev7een/dsh-plugin-automations.git
dsh plugin --profile web add ./dsh-plugin-automations
```

### Remove

```bash
dsh plugin --profile web remove dsh-plugin-automations
```

## Usage

### Execution modes

| Mode | Behavior |
| --- | --- |
| `on_time` | Creates an isolated DSH Session and starts as soon as the task is due. |
| `when_idle` | Runs only outside Beijing peak hours; a task due during peak hours waits for the next valley window. |

### Repeat modes

| Repeat | Behavior |
| --- | --- |
| `once` | Reaches a terminal state and does not run again. |
| `daily` | Rolls to the same local wall-clock time on the next calendar day. |

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

The MVP has no edit, delete, pause, cancel, retry, or pagination endpoints.

## Development

```bash
npm install --legacy-peer-deps
npm run check
npm test
npm run build
npm pack --dry-run
```

`--legacy-peer-deps` is currently needed for local development because the published `@deepseek-ai/dsh-storage-domain` package still carries an older peer range than the current DSH Web bundle.

## License

MIT
