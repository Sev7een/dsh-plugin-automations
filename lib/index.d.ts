import { z } from "zod";
import { Context } from "@deepseek-ai/cordis";
import { IncomingMessage, ServerResponse } from "node:http";
import { UserMessage } from "@deepseek-ai/dsh-llm";

//#region src/types.d.ts
type ExecutionMode = 'on_time' | 'when_idle';
/** 重复方式：仅执行一次，或每天在同一本地时刻重复执行。 */
type RepeatMode = 'once' | 'daily';
type TaskState = 'pending' | 'waiting_idle' | 'running' | 'completed' | 'failed';
interface TaskError {
  code: string;
  message: string;
}
interface ScheduledTask {
  id: string;
  prompt: string;
  scheduledAt: string;
  timeZone: string;
  mode: ExecutionMode;
  /**
   * 重复方式。存储中可选以保证旧记录（v0.1.0 无此字段）可继续加载；
   * 缺失等价于 'once'。新建任务与 API 响应中始终为显式值。
   */
  repeat?: RepeatMode;
  state: TaskState;
  sessionId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: TaskError;
}
interface CreateTaskInput {
  prompt: string;
  scheduledAt: string;
  timeZone: string;
  mode: ExecutionMode;
  repeat: RepeatMode;
}
interface TaskTable {
  get(id: string): ScheduledTask | undefined;
  entries(): IterableIterator<[string, ScheduledTask]>;
  put(id: string, task: ScheduledTask): Promise<void>;
  update(id: string, update: (current: ScheduledTask) => ScheduledTask): Promise<ScheduledTask>;
}
interface AgentView {
  id: string;
  status: 'idle' | 'running';
}
interface AgentRegistryView {
  roots(): AgentView[];
}
interface TimerPort {
  timeout(callback: () => void, delayMs: number): () => void;
}
declare const MAX_PROMPT_BYTES: number;
declare const MAX_ERROR_MESSAGE_BYTES: number;
declare const DEFAULT_EXECUTION_TIMEOUT_MS: number;
declare const MAX_TIMER_DELAY_MS = 2147483647;
//#endregion
//#region src/domain.d.ts
declare const scheduledTaskSchema: z.ZodObject<{
  id: z.ZodString;
  prompt: z.ZodString;
  scheduledAt: z.ZodString;
  timeZone: z.ZodString;
  mode: z.ZodUnion<readonly [z.ZodLiteral<"on_time">, z.ZodLiteral<"when_idle">]>;
  repeat: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"once">, z.ZodLiteral<"daily">]>>;
  state: z.ZodUnion<readonly [z.ZodLiteral<"pending">, z.ZodLiteral<"waiting_idle">, z.ZodLiteral<"running">, z.ZodLiteral<"completed">, z.ZodLiteral<"failed">]>;
  sessionId: z.ZodOptional<z.ZodString>;
  createdAt: z.ZodString;
  startedAt: z.ZodOptional<z.ZodString>;
  finishedAt: z.ZodOptional<z.ZodString>;
  error: z.ZodOptional<z.ZodType<TaskError, unknown, z.core.$ZodTypeInternals<TaskError, unknown>>>;
}, z.core.$strict>;
declare const scheduledTasksDomainSpec: {
  readonly name: "scheduled_tasks";
  readonly version: 1;
  readonly tables: {
    readonly tasks: {
      readonly valueSchema: z.ZodType<ScheduledTask>;
    };
  };
};
declare class RequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status?: number);
}
declare function isValidTimeZone(timeZone: string): boolean;
declare function parseCreateTaskInput(raw: unknown, now?: number): CreateTaskInput;
declare function createScheduledTask(input: CreateTaskInput, now?: number): ScheduledTask;
declare function listTasks(table: TaskTable): ScheduledTask[];
declare function recoverInterruptedTasks(table: TaskTable, now?: number): Promise<number>;
/**
 * 把 RFC 3339 instant 按 `timeZone` 的本地钟面时间平移 `days` 天，
 * 返回平移后的 UTC instant。用于每天重复任务：保持同一本地时刻，
 * 并且跨夏令时切换时仍落在正确的本地钟面时刻。
 */
declare function addLocalDays(instantIso: string, timeZone: string, days: number): string;
//#endregion
//#region src/http.d.ts
declare const API_PATH = "/dsh-scheduled-tasks/api/v1/tasks";
declare function createTaskHttpHandler(table: TaskTable, onCreated: () => void): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
//#endregion
//#region src/runner.d.ts
interface RunnerSession {
  readonly events: readonly unknown[];
}
interface RunnerAgent {
  readonly session: RunnerSession;
  followup(message: UserMessage): void;
  whenIdle(): Promise<void>;
  cancel(cause: {
    kind: 'hook';
    reason: string;
  } | {
    kind: 'disposed';
  }): void;
}
interface RunnerAgentHandle {
  readonly agent: RunnerAgent;
  dispose(): Promise<void>;
}
interface TaskRunnerHost {
  createAgent(task: ScheduledTask, signal: AbortSignal): Promise<RunnerAgentHandle>;
  flush(session: RunnerSession): Promise<boolean>;
}
interface RunnerLogger {
  info(message: string): void;
  warn(message: string): void;
}
interface TaskRunnerOptions {
  table: TaskTable;
  host: TaskRunnerHost;
  ownedSessionIds: Set<string>;
  timeoutMs?: number;
  logger?: RunnerLogger;
  now?: () => number;
}
declare function renderTaskPrompt(task: Pick<ScheduledTask, 'id' | 'scheduledAt' | 'prompt'>): string;
/** Owns every AgentHandle created by this plugin and records one terminal state. */
declare class TaskRunner {
  private readonly table;
  private readonly host;
  private readonly ownedSessionIds;
  private readonly timeoutMs;
  private readonly logger;
  private readonly now;
  private readonly active;
  private stopping;
  constructor(options: TaskRunnerOptions);
  run(task: ScheduledTask): Promise<void>;
  dispose(): Promise<void>;
  private execute;
  private fail;
}
//#endregion
//#region src/scheduler.d.ts
interface ScheduledTaskExecutor {
  run(task: ScheduledTask): Promise<void>;
}
interface SchedulerLogger {
  info(message: string): void;
  warn(message: string): void;
}
interface SchedulerOptions {
  table: TaskTable;
  timer: TimerPort;
  executor: ScheduledTaskExecutor;
  logger?: SchedulerLogger;
  now?: () => number;
}
/**
 * One serialized wall-clock pump. Persistent task state is authoritative;
 * timers and HTTP wakeups merely wake this object to read it again.
 *
 * Execution semantics:
 * - `on_time`（准点执行）：到期后立即认领，不等待任何窗口。
 * - `when_idle`（空闲执行）：只在北京时间谷时段（09:00-12:00、14:00-18:00
 *   高峰之外）认领；高峰时段内保持 `waiting_idle`，并在下一个谷时段开始时
 *   被定时器唤醒。
 * - `repeat: 'daily'`（每天执行）：任务进入终态（completed/failed）后，
 *   自动把 scheduledAt 平移到下一自然日的同一本地时刻并重置为 pending。
 */
declare class TaskScheduler {
  private readonly table;
  private readonly timer;
  private readonly executor;
  private readonly logger;
  private readonly now;
  private disposed;
  private rerun;
  private pumping;
  private cancelTimer;
  constructor(options: SchedulerOptions);
  start(): void;
  /** Coalesce any number of timer, HTTP, and wakeups. */
  requestPump(): void;
  settle(): Promise<void>;
  dispose(): void;
  private runPumps;
  private pumpOnce;
  /**
   * 每天重复任务进入终态后，把 scheduledAt 平移到下一自然日的同一本地时刻，
   * 清空本次执行痕迹并重置为 pending，等待下一次到期。
   */
  private rollDailyOccurrences;
  private scheduleIn;
  private clearTimer;
}
//#endregion
//#region src/valley.d.ts
/**
 * DeepSeek 峰谷算力价格时段（valley-hour window）。
 *
 * `when_idle`（空闲执行）语义 = 只在谷时段执行命令：
 * - 每日高峰时段为北京时间 09:00 - 12:00 与 14:00 - 18:00；
 * - 其余时间为谷时段（空闲时段）。
 *
 * 北京时间为 Asia/Shanghai（UTC+8，无夏令时）。窗口以小时为粒度，
 * 边界约定为 [startHour, endHour)（如 12:00 属于谷时段）。
 */
declare const VALLEY_TIME_ZONE = "Asia/Shanghai";
interface HourWindow {
  /** 窗口起始小时（北京时间，含）。 */
  readonly startHour: number;
  /** 窗口结束小时（北京时间，不含）。 */
  readonly endHour: number;
}
/** 每日高峰窗口；其余时间均为谷时段。 */
declare const PEAK_WINDOWS: readonly HourWindow[];
interface BeijingParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}
/** 将 UTC instant 投影为北京时间（Asia/Shanghai）的日期与小时。 */
declare function beijingParts(now: number): BeijingParts;
/** 当前时刻是否处于高峰时段（北京时间的峰值窗口内）。 */
declare function isPeakHour(now: number): boolean;
/** 当前时刻是否处于谷时段（高峰时段之外）。 */
declare function isValleyHour(now: number): boolean;
/**
 * 下一个谷时段开始时刻（epoch ms）。
 *
 * - 当前处于高峰时段时，返回当前高峰窗口结束时刻（即下一个谷时段开始）；
 * - 当前已处于谷时段时，返回 `now` 本身（边界已过，调用方不应据此安排定时器）。
 */
declare function nextValleyStart(now: number): number;
//#endregion
//#region src/index.d.ts
declare const name = "scheduled-tasks";
declare const inject: string[];
declare function apply(ctx: Context): Promise<void>;
//#endregion
export { API_PATH, AgentRegistryView, AgentView, CreateTaskInput, DEFAULT_EXECUTION_TIMEOUT_MS, ExecutionMode, MAX_ERROR_MESSAGE_BYTES, MAX_PROMPT_BYTES, MAX_TIMER_DELAY_MS, PEAK_WINDOWS, RepeatMode, RequestError, ScheduledTask, TaskError, TaskRunner, TaskScheduler, TaskState, TaskTable, TimerPort, VALLEY_TIME_ZONE, addLocalDays, apply, beijingParts, createScheduledTask, createTaskHttpHandler, inject, isPeakHour, isValidTimeZone, isValleyHour, listTasks, name, nextValleyStart, parseCreateTaskInput, recoverInterruptedTasks, renderTaskPrompt, scheduledTaskSchema, scheduledTasksDomainSpec };
//# sourceMappingURL=index.d.ts.map