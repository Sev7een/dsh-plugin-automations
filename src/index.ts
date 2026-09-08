/** Host-plane one-shot scheduled task plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { createTaskIdempotent, recoverInterruptedTasks, scheduledTasksDomainSpec } from './domain.js'
import { API_PATH, createTaskHttpHandler } from './http.js'
import { TaskRunner } from './runner.js'
import type { RunnerSession } from './runner.js'
import { TaskScheduler } from './scheduler.js'
import type { ScheduledTask, TaskTable } from './types.js'
import type { CreateTaskInput, TaskMutationLock } from './types.js'
import { AsyncTaskMutationLock } from './mutex.js'
import { renderTaskTitle } from './template.js'

export * from './types.js'
export {
  RequestError,
  createScheduledTask,
  canonicalTaskContent,
  createTaskIdempotent,
  findActiveTask,
  listTasks,
  nextCronAfter,
  parseCreateTaskInput,
  recoverInterruptedTasks,
  scheduledTasksDomainSpec,
  scheduledTaskSchema,
} from './domain.js'
export { API_PATH, createTaskHttpHandler } from './http.js'
export { TaskRunner, renderTaskPrompt } from './runner.js'
export { TaskScheduler } from './scheduler.js'
export { renderTaskTitle, validateTaskTemplate, TaskTemplateError } from './template.js'
export { AsyncTaskMutationLock } from './mutex.js'
export {
  PEAK_WINDOWS,
  VALLEY_TIME_ZONE,
  beijingParts,
  isPeakHour,
  isValleyHour,
  nextValleyStart,
} from './valley.js'

export const name = 'scheduled-tasks'
export const inject = [
  'timer',
  'agents',
  'sessions',
  'sessionPersistence',
  'agentPresets',
  'storageDomain',
  'webServer',
]

export interface ScheduledTasksService {
  create(input: CreateTaskInput): Promise<{ task: ScheduledTask; created: boolean }>
}

export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(scheduledTasksDomainSpec)
  const table = domain.table('tasks') as TaskTable
  const lock: TaskMutationLock = new AsyncTaskMutationLock()
  const logger = {
    info: (message: string) => { ctx.logger.info(message) },
    warn: (message: string) => { ctx.logger.warn(message) },
  }
  const recovered = await recoverInterruptedTasks(table)
  if (recovered > 0) logger.warn(`marked ${recovered} interrupted scheduled task(s) failed`)

  const ownedSessionIds = new Set<string>()
  const runner = new TaskRunner({
    table,
    ownedSessionIds,
    logger,
    host: {
      createAgent: async (task: ScheduledTask, signal: AbortSignal) => {
        if (task.sessionId === undefined) throw new Error('claimed task has no Session id')
        const preset = await ctx.agentPresets.resolve()
        const defaultModel = ctx.get('agentDefaultModel')?.currentSelection()
        const workspaceRoot = ctx.get('sandboxPolicy')?.workspaceRoot ?? process.cwd()
        const createOptions = {
          sessionId: task.sessionId as SessionId,
          signal,
          meta: { cwd: workspaceRoot, agentPreset: preset.id, origin: 'scheduled' },
          initialTitle: renderTaskTitle(task),
          ...defaultModel === undefined ? {} : {
            agentOptions: { provider: defaultModel.provider, model: defaultModel.model },
          },
          setup: async (agentCtx: Context) => {
            await ctx.agentPresets.mount(agentCtx, preset.id)
          },
        }
        // The optional property is supplied by the MindPalace DSH Agent-factory extension.
        const handle = await ctx.agents.create(createOptions as Parameters<typeof ctx.agents.create>[0])
        return { agent: handle.agent, dispose: () => handle.dispose() }
      },
      flush: (session: RunnerSession) => ctx.sessions.flush(session as Session),
    },
  })

  const scheduler = new TaskScheduler({
    table,
    executor: runner,
    logger,
    lock,
    timer: {
      timeout: (callback, delayMs) => ctx.timeout(callback, delayMs),
    },
  })

  // The plugin-owned resources are stopped before the durable domain closes.
  ctx.effect(() => async () => {
    scheduler.dispose()
    await runner.dispose()
    await domain.close()
  }, 'scheduled-tasks.lifecycle()')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH,
    handler: createTaskHttpHandler(
      table,
      () => { scheduler.requestPump() },
      lock,
      () => scheduler.rollCronOccurrences(),
    ),
  }), 'scheduled-tasks.route()')

  ctx.provide('scheduledTasks', {
    create: (input: CreateTaskInput) => createTaskIdempotent(
      table,
      input,
      lock,
      () => scheduler.rollCronOccurrences(),
    ).then(result => {
      scheduler.requestPump()
      return result
    }),
  } satisfies ScheduledTasksService)

  scheduler.start()
}
