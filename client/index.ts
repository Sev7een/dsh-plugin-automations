/** Readable source for client/bundle.js (React is supplied by the DSH Web runtime). */
import * as React from 'react'

export const API_PATH = '/dsh-scheduled-tasks/api/v1/tasks'
export const POLL_INTERVAL_MS = 5_000
export const MAX_PROMPT_BYTES = 64 * 1024

export const TASK_STATE_LABELS: Record<string, string> = {
  pending: '等待中',
  waiting_idle: '等待空闲时段',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
}

export const EXECUTION_MODE_LABELS: Record<string, string> = {
  on_time: '准点执行',
  when_idle: '空闲执行（谷时段）',
}

export const SCHEDULE_LABELS: Record<string, string> = {
  once: '仅一次',
  cron: 'Cron',
}

interface ClientTask {
  id: string
  prompt: string
  schedule: { type: 'once' | 'cron'; scheduledAt?: string; expression?: string }
  scheduledAt: string
  mode: string
  sessionTitleTemplate?: string
  state: string
  startedAt?: string
  finishedAt?: string
  error?: { code: string; message: string }
}

const CSS = `
.dsta-root{display:flex;flex-direction:column;gap:18px;padding:6px 2px;font-family:inherit}
.dsta-title{font-size:16px;font-weight:650;margin:0}
.dsta-card{border:1px solid var(--ds-border,#444);border-radius:10px;padding:14px}
.dsta-form{display:flex;flex-direction:column;gap:12px}
.dsta-label{display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:600}
.dsta-input,.dsta-textarea{box-sizing:border-box;width:100%;border:1px solid var(--ds-border,#555);border-radius:7px;background:transparent;color:inherit;padding:8px;font:inherit}
.dsta-textarea{min-height:104px;resize:vertical}
.dsta-modes{display:flex;gap:18px;flex-wrap:wrap;font-size:13px}
.dsta-mode{display:flex;align-items:center;gap:6px;cursor:pointer}
.dsta-actions{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dsta-btn{border:0;border-radius:7px;background:var(--ds-accent,#4f8cff);color:#fff;padding:7px 15px;font-size:13px;font-weight:600;cursor:pointer}
.dsta-btn:disabled{opacity:.55;cursor:default}
.dsta-hint{font-size:11px;opacity:.62}
.dsta-error{border:1px solid rgba(239,68,68,.5);background:rgba(239,68,68,.08);border-radius:8px;padding:8px 11px;font-size:12px;color:#ef4444}
.dsta-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsta-list{display:flex;flex-direction:column;gap:9px}
.dsta-task{border:1px solid var(--ds-border,#444);border-radius:9px;padding:11px 12px;display:flex;flex-direction:column;gap:7px}
.dsta-task-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.dsta-summary{font-size:13px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
.dsta-badge{border-radius:999px;padding:2px 8px;font-size:10px;font-weight:650;background:rgba(79,140,255,.14);color:var(--ds-accent,#4f8cff)}
.dsta-badge-completed{background:rgba(34,197,94,.14);color:#22c55e}
.dsta-badge-failed{background:rgba(239,68,68,.14);color:#ef4444}
.dsta-meta{display:flex;gap:6px 14px;flex-wrap:wrap;font-size:11px;opacity:.66}
.dsta-failure{font-size:11px;color:#ef4444;overflow-wrap:anywhere}
.dsta-empty{font-size:12px;opacity:.6;padding:8px 0}
@media(max-width:600px){.dsta-actions,.dsta-task-top{align-items:stretch;flex-direction:column}.dsta-btn{width:100%}}
`

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function summary(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 180 ? `${compact.slice(0, 177)}…` : compact
}

function localTime(value: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(value))
  } catch {
    return new Date(value).toLocaleString()
  }
}

function TaskRow({ task }: { task: ClientTask }) {
  let badge = 'dsta-badge'
  if (task.state === 'completed') badge += ' dsta-badge-completed'
  if (task.state === 'failed') badge += ' dsta-badge-failed'
  const schedule = SCHEDULE_LABELS[task.schedule.type] ?? task.schedule.type
  const scheduleValue = task.schedule.type === 'cron' ? task.schedule.expression : localTime(task.scheduledAt)
  return React.createElement('div', { className: 'dsta-task' },
    React.createElement('div', { className: 'dsta-task-top' },
      React.createElement('div', { className: 'dsta-summary', title: task.prompt }, summary(task.prompt)),
      React.createElement('span', { className: badge }, TASK_STATE_LABELS[task.state] ?? task.state),
    ),
    React.createElement('div', { className: 'dsta-meta' },
      React.createElement('span', null, `计划：${scheduleValue}`),
      React.createElement('span', null, `方式：${EXECUTION_MODE_LABELS[task.mode] ?? task.mode}`),
      React.createElement('span', null, `计划类型：${schedule}`),
      task.startedAt && React.createElement('span', null, `开始：${localTime(task.startedAt)}`),
      task.finishedAt && React.createElement('span', null, `完成：${localTime(task.finishedAt)}`),
    ),
    task.sessionTitleTemplate && React.createElement('div', { className: 'dsta-hint' }, `标题模板：${task.sessionTitleTemplate}`),
    task.error && React.createElement('div', { className: 'dsta-failure' },
      `${task.error.code}：${task.error.message}`),
  )
}

function Panel() {
  const [prompt, setPrompt] = React.useState('')
  const [scheduledAt, setScheduledAt] = React.useState('')
  const [scheduleType, setScheduleType] = React.useState<'once' | 'cron'>('once')
  const [cronExpression, setCronExpression] = React.useState('0 0 8 * * *')
  const [sessionTitleTemplate, setSessionTitleTemplate] = React.useState('')
  const [mode, setMode] = React.useState<'on_time' | 'when_idle'>('on_time')
  const [tasks, setTasks] = React.useState<ClientTask[]>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()

  const load = React.useCallback(() => {
    return fetch(API_PATH, { cache: 'no-store' }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json() as Promise<{ tasks?: ClientTask[] }>
    }).then((body) => {
      setTasks(Array.isArray(body.tasks) ? body.tasks : [])
    }).catch((caught: unknown) => {
      setError(String((caught instanceof Error && caught.message) || caught))
    })
  }, [])

  React.useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [load])

  function submit(event: React.FormEvent): void {
    event.preventDefault()
    const saved = prompt.trim()
    if (!saved) { setError('请输入任务内容。'); return }
    if (byteLength(saved) > MAX_PROMPT_BYTES) { setError('任务内容不能超过 64 KiB。'); return }
    if (scheduleType === 'once') {
      if (!scheduledAt) { setError('请选择执行时间。'); return }
      const instant = new Date(scheduledAt)
      if (!Number.isFinite(instant.getTime()) || instant.getTime() <= Date.now()) {
        setError('执行时间必须晚于当前时间。'); return
      }
    } else if (cronExpression.trim().split(/\s+/).length !== 6) {
      setError('Cron 表达式必须包含 6 个字段：秒 分 时 日 月 周。'); return
    }
    setBusy(true)
    setError(undefined)
    fetch(API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DSH-Scheduled-Tasks': '1' },
      body: JSON.stringify({
        prompt: saved,
        schedule: scheduleType === 'once'
          ? { type: 'once', scheduledAt: new Date(scheduledAt).toISOString() }
          : { type: 'cron', expression: cronExpression.trim() },
        mode,
        ...(sessionTitleTemplate.trim() === '' ? {} : { sessionTitleTemplate: sessionTitleTemplate.trim() }),
      }),
    }).then((response) => {
      return response.json().catch(() => ({})).then((body: { error?: { message?: string } }) => {
        if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`)
        return body
      })
    }).then(() => {
      setPrompt('')
      setScheduledAt('')
      setScheduleType('once')
      setCronExpression('0 0 8 * * *')
      setSessionTitleTemplate('')
      setMode('on_time')
      return load()
    }).catch((caught: unknown) => {
      setError(String((caught instanceof Error && caught.message) || caught))
    }).then(() => { setBusy(false) })
  }

  return React.createElement('div', { className: 'dsta-root' },
    React.createElement('h3', { className: 'dsta-title' }, '定时任务'),
    error && React.createElement('div', { className: 'dsta-error' }, error),
    React.createElement('form', { className: 'dsta-card dsta-form', onSubmit: submit },
      React.createElement('label', { className: 'dsta-label' }, '任务内容',
        React.createElement('textarea', {
          className: 'dsta-textarea', value: prompt, required: true,
          placeholder: '输入需要 DSH Agent 执行的任务',
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => { setPrompt(event.target.value) },
        })),
      React.createElement('div', { className: 'dsta-label' }, '计划类型',
        React.createElement('div', { className: 'dsta-modes' },
          React.createElement('label', { className: 'dsta-mode' },
            React.createElement('input', { type: 'radio', name: 'dsta-schedule', checked: scheduleType === 'once', onChange: () => { setScheduleType('once') } }), '仅一次'),
          React.createElement('label', { className: 'dsta-mode' },
            React.createElement('input', { type: 'radio', name: 'dsta-schedule', checked: scheduleType === 'cron', onChange: () => { setScheduleType('cron') } }), 'Cron'),
        )),
      scheduleType === 'once'
        ? React.createElement('label', { className: 'dsta-label' }, '执行时间',
        React.createElement('input', {
          className: 'dsta-input', type: 'datetime-local', value: scheduledAt, required: true,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setScheduledAt(event.target.value) },
        }))
        : React.createElement('label', { className: 'dsta-label' }, 'Cron 表达式（本机时区，六字段）',
          React.createElement('input', {
            className: 'dsta-input', value: cronExpression, required: true,
            placeholder: '秒 分 时 日 月 周，例如 0 0 8 * * *',
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setCronExpression(event.target.value) },
          }),
          React.createElement('span', { className: 'dsta-hint' }, '支持标准 Cron：秒、分、时、日、月、周；使用本机时区。')),
      React.createElement('label', { className: 'dsta-label' }, 'Session 标题模板（可选）',
        React.createElement('input', {
          className: 'dsta-input', value: sessionTitleTemplate,
          placeholder: 'Daily Feed · {{scheduledAt:YYYY-MM-DD}}',
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setSessionTitleTemplate(event.target.value) },
        }),
        React.createElement('span', { className: 'dsta-hint' }, '使用 {{field}} 或 {{datetimeField:FORMAT}}；支持嵌套字段，例如 {{schedule.expression}}。')),
      React.createElement('div', { className: 'dsta-label' }, '执行方式',
        React.createElement('div', { className: 'dsta-modes' },
          React.createElement('label', { className: 'dsta-mode' },
            React.createElement('input', {
              type: 'radio', name: 'dsta-mode', checked: mode === 'on_time',
              onChange: () => { setMode('on_time') },
            }), '准点执行'),
          React.createElement('label', { className: 'dsta-mode' },
            React.createElement('input', {
              type: 'radio', name: 'dsta-mode', checked: mode === 'when_idle',
              onChange: () => { setMode('when_idle') },
            }), '空闲执行（谷时段）'),
        ),
        mode === 'when_idle' && React.createElement('span', { className: 'dsta-hint' },
          '空闲执行：仅在谷时段执行（北京时间 09:00-12:00、14:00-18:00 高峰之外）。')),
      React.createElement('div', { className: 'dsta-actions' },
        React.createElement('span', { className: 'dsta-hint' },
          scheduleType === 'cron' ? 'Cron 任务会在每个匹配时间执行。' : '任务只执行一次。'),
        React.createElement('button', { className: 'dsta-btn', type: 'submit', disabled: busy },
          busy ? '提交中…' : '提交任务')),
    ),
    React.createElement('div', { className: 'dsta-head' },
      React.createElement('h3', { className: 'dsta-title' }, '任务列表'),
      React.createElement('span', { className: 'dsta-hint' }, '每 5 秒刷新')),
    tasks.length === 0
      ? React.createElement('div', { className: 'dsta-empty' }, '暂无定时任务。')
      : React.createElement('div', { className: 'dsta-list' },
          tasks.map(task => React.createElement(TaskRow, { key: task.id, task }))),
  )
}

export const inject = ['slots']

export function apply(ctx: any): void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-plugin-automations'
  style.textContent = CSS
  document.head.append(style)
  ctx.effect(() => () => {
    if (style.parentNode) style.parentNode.removeChild(style)
  })
  const slots = ctx.get('slots')
  if (slots === undefined) return
  slots.inject('settings.section', () => slots.register(
    { name: 'settings.section', id: 'scheduled-tasks', order: 30, label: '定时任务' },
    () => React.createElement(Panel),
  ))
}
