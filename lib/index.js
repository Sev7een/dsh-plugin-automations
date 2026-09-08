import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import moment from "moment";

//#region src/types.ts
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_ERROR_MESSAGE_BYTES = 4 * 1024;
const DEFAULT_EXECUTION_TIMEOUT_MS = 1800 * 1e3;
const MAX_TIMER_DELAY_MS = 2147483647;

//#endregion
//#region src/template.ts
const DATE_FIELDS = new Set([
	"scheduledAt",
	"createdAt",
	"startedAt",
	"finishedAt"
]);
const TERMINAL_FIELDS = new Set(["finishedAt", "error"]);
const KNOWN_FIELDS = new Set([
	"id",
	"prompt",
	"schedule",
	"schedule.type",
	"schedule.expression",
	"schedule.scheduledAt",
	"scheduledAt",
	"mode",
	"state",
	"sessionId",
	"createdAt",
	"startedAt",
	"finishedAt",
	"error"
]);
const TOKEN = /{{\s*([^{}]+?)\s*}}/g;
const FIELD = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/;
var TaskTemplateError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "TaskTemplateError";
	}
};
function getField(task, path) {
	let value = task;
	for (const part of path.split(".")) {
		if (typeof value !== "object" || value === null || !(part in value)) return void 0;
		value = value[part];
	}
	return value;
}
function validateToken(raw) {
	const separator = raw.indexOf(":");
	const field = (separator < 0 ? raw : raw.slice(0, separator)).trim();
	const format = separator < 0 ? void 0 : raw.slice(separator + 1);
	if (!FIELD.test(field)) throw new TaskTemplateError(`Unknown or invalid task template field: ${field || "(empty)"}`);
	const root = field.split(".", 1)[0];
	if (!KNOWN_FIELDS.has(field)) throw new TaskTemplateError(`Unknown or invalid task template field: ${field}`);
	if (TERMINAL_FIELDS.has(root)) throw new TaskTemplateError(`Task template field is unavailable before completion: ${field}`);
	if (format !== void 0) {
		if (format.length === 0 || !DATE_FIELDS.has(root) || field.includes(".")) throw new TaskTemplateError(`Datetime formatting requires a timestamp field: ${field}`);
	}
	return format === void 0 ? { field } : {
		field,
		format
	};
}
/** Validate a template at task creation time without needing an occurrence. */
function validateTaskTemplate(template) {
	if (template === void 0) return;
	let end = 0;
	for (const match of template.matchAll(TOKEN)) {
		if (match.index !== end && /{{|}}/.test(template.slice(end, match.index))) throw new TaskTemplateError("Task title template contains an unmatched brace.");
		validateToken(match[1] ?? "");
		end = (match.index ?? 0) + match[0].length;
	}
	if (/{{|}}/.test(template.slice(end))) throw new TaskTemplateError("Task title template contains an unmatched brace.");
}
/** Expand a validated task title template for one claimed occurrence. */
function renderTaskTitle(task) {
	const template = task.sessionTitleTemplate;
	if (template === void 0) return void 0;
	validateTaskTemplate(template);
	return template.replace(TOKEN, (_whole, raw) => {
		const { field, format } = validateToken(raw);
		const value = getField(task, field);
		if (value === void 0 || value === null) throw new TaskTemplateError(`Task template field is unavailable for this occurrence: ${field}`);
		if (format !== void 0) return moment(String(value)).format(format);
		if (typeof value === "object") return JSON.stringify(value);
		return String(value);
	});
}

//#endregion
//#region src/domain.ts
const rfc3339Instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const executionModeSchema = z.union([z.literal("on_time"), z.literal("when_idle")]);
const onceScheduleSchema = z.object({
	type: z.literal("once"),
	scheduledAt: z.string().regex(rfc3339Instant)
}).strict();
const cronScheduleSchema = z.object({
	type: z.literal("cron"),
	expression: z.string().min(1).max(512)
}).strict();
const taskScheduleSchema = z.union([onceScheduleSchema, cronScheduleSchema]);
const taskStateSchema = z.union([
	z.literal("pending"),
	z.literal("waiting_idle"),
	z.literal("running"),
	z.literal("completed"),
	z.literal("failed")
]);
const taskErrorSchema = z.object({
	code: z.string().min(1).max(128),
	message: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= MAX_ERROR_MESSAGE_BYTES)
}).strict();
const scheduledTaskSchema = z.object({
	id: z.string().uuid(),
	prompt: z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= MAX_PROMPT_BYTES),
	schedule: taskScheduleSchema,
	scheduledAt: z.string().regex(rfc3339Instant),
	mode: executionModeSchema,
	sessionTitleTemplate: z.string().min(1).optional(),
	state: taskStateSchema,
	sessionId: z.string().min(1).optional(),
	createdAt: z.string().regex(rfc3339Instant),
	startedAt: z.string().regex(rfc3339Instant).optional(),
	finishedAt: z.string().regex(rfc3339Instant).optional(),
	error: taskErrorSchema.optional()
}).strict();
const scheduledTasksDomainSpec = {
	name: "scheduled_tasks",
	version: 2,
	tables: { tasks: { valueSchema: scheduledTaskSchema } }
};
var RequestError = class extends Error {
	constructor(code, message, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
		this.name = "RequestError";
	}
};
function requireObject(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new RequestError("invalid_request", "Request body must be a JSON object.");
	return raw;
}
function exactKeys(value, expected, message = "Request body contains missing or unsupported fields.") {
	const keys = Object.keys(value).sort();
	const sorted = [...expected].sort();
	if (keys.length !== sorted.length || keys.some((key, index) => key !== sorted[index])) throw new RequestError("invalid_request", message);
}
function allowedKeys(value, expected) {
	const allowed = new Set(expected);
	if (Object.keys(value).some((key) => !allowed.has(key))) throw new RequestError("invalid_request", "Request body contains unsupported fields.");
}
function parseCronExpression(expression, code = "invalid_cron") {
	if (expression.trim().split(/\s+/).length !== 6) throw new RequestError(code, "cron expression must contain six fields: second minute hour day-of-month month day-of-week.");
	try {
		CronExpressionParser.parse(expression, { currentDate: /* @__PURE__ */ new Date() }).next();
	} catch (error) {
		throw new RequestError(code, `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`);
	}
	return expression.trim();
}
/** Return the next strict match using the host process's local timezone. */
function nextCronAfter(expression, after = Date.now()) {
	const normalized = parseCronExpression(expression);
	try {
		const next = CronExpressionParser.parse(normalized, { currentDate: new Date(after) }).next().toDate();
		if (!Number.isFinite(next.getTime())) throw new Error("cron parser returned an invalid occurrence");
		return next.toISOString();
	} catch (error) {
		throw new RequestError("invalid_cron", `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`);
	}
}
function parseSchedule(raw, now) {
	const value = requireObject(raw);
	if (value.type === "once") {
		exactKeys(value, ["type", "scheduledAt"]);
		if (typeof value.scheduledAt !== "string" || !rfc3339Instant.test(value.scheduledAt)) throw new RequestError("invalid_scheduled_at", "schedule.scheduledAt must be an RFC 3339 instant with an offset.");
		const epoch = Date.parse(value.scheduledAt);
		if (!Number.isFinite(epoch)) throw new RequestError("invalid_scheduled_at", "schedule.scheduledAt is not a valid instant.");
		if (epoch <= now) throw new RequestError("not_future", "schedule.scheduledAt must be later than the current time.");
		const scheduledAt = new Date(epoch).toISOString();
		return {
			schedule: {
				type: "once",
				scheduledAt
			},
			scheduledAt
		};
	}
	if (value.type === "cron") {
		exactKeys(value, ["type", "expression"]);
		if (typeof value.expression !== "string" || value.expression.trim() === "") throw new RequestError("invalid_cron", "schedule.expression must be a non-empty string.");
		const expression = parseCronExpression(value.expression);
		return {
			schedule: {
				type: "cron",
				expression
			},
			scheduledAt: nextCronAfter(expression, now)
		};
	}
	throw new RequestError("invalid_schedule", "schedule must be a once or cron object.");
}
function parseCreateTaskInput(raw, now = Date.now()) {
	const value = requireObject(raw);
	allowedKeys(value, [
		"mode",
		"prompt",
		"schedule",
		"sessionTitleTemplate"
	]);
	if (typeof value.prompt !== "string") throw new RequestError("invalid_prompt", "prompt must be a string.");
	const prompt = value.prompt.trim();
	if (prompt.length === 0) throw new RequestError("invalid_prompt", "prompt must not be empty.");
	if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) throw new RequestError("prompt_too_large", "prompt must not exceed 64 KiB.");
	if (value.mode !== "on_time" && value.mode !== "when_idle") throw new RequestError("invalid_mode", "mode must be on_time or when_idle.");
	let sessionTitleTemplate;
	if (value.sessionTitleTemplate !== void 0) {
		if (typeof value.sessionTitleTemplate !== "string" || value.sessionTitleTemplate.trim() === "") throw new RequestError("invalid_title_template", "sessionTitleTemplate must be a non-empty string when provided.");
		sessionTitleTemplate = value.sessionTitleTemplate;
		try {
			validateTaskTemplate(sessionTitleTemplate);
		} catch (error) {
			if (error instanceof TaskTemplateError) throw new RequestError("invalid_title_template", error.message);
			throw error;
		}
	}
	const parsed = parseSchedule(value.schedule, now);
	return {
		prompt,
		schedule: parsed.schedule,
		scheduledAt: parsed.scheduledAt,
		mode: value.mode,
		...sessionTitleTemplate === void 0 ? {} : { sessionTitleTemplate }
	};
}
function createScheduledTask(input, now = Date.now()) {
	const scheduledAt = input.scheduledAt ?? (input.schedule.type === "once" ? input.schedule.scheduledAt : nextCronAfter(input.schedule.expression, now));
	const task = {
		id: randomUUID(),
		prompt: input.prompt,
		schedule: input.schedule,
		scheduledAt,
		mode: input.mode,
		...input.sessionTitleTemplate === void 0 ? {} : { sessionTitleTemplate: input.sessionTitleTemplate },
		state: "pending",
		createdAt: new Date(now).toISOString()
	};
	scheduledTaskSchema.parse(task);
	return task;
}
function canonicalTaskContent(input) {
	return JSON.stringify({
		mode: input.mode,
		prompt: input.prompt,
		schedule: input.schedule,
		sessionTitleTemplate: input.sessionTitleTemplate ?? null
	});
}
function findActiveTask(table, input) {
	const expected = canonicalTaskContent(input);
	return [...table.entries()].map(([, task]) => task).filter((task) => task.state === "pending" || task.state === "waiting_idle" || task.state === "running").find((task) => canonicalTaskContent(task) === expected);
}
async function createTaskIdempotent(table, raw, lock, beforeCreate, now = Date.now()) {
	const input = parseCreateTaskInput(raw, now);
	return lock.run(async () => {
		await beforeCreate?.();
		const existing = findActiveTask(table, input);
		if (existing !== void 0) return {
			task: existing,
			created: false
		};
		const task = createScheduledTask(input, now);
		await table.put(task.id, task);
		return {
			task,
			created: true
		};
	});
}
function listTasks(table) {
	return [...table.entries()].map(([, task]) => task).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
function truncateUtf8(value, maxBytes) {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let out = "";
	for (const char of value) {
		if (Buffer.byteLength(out + char + "…", "utf8") > maxBytes) break;
		out += char;
	}
	return `${out}…`;
}
function safeTaskError(code, error) {
	return {
		code,
		message: truncateUtf8((error instanceof Error ? error.message : String(error)) || "The task failed.", MAX_ERROR_MESSAGE_BYTES)
	};
}
async function recoverInterruptedTasks(table, now = Date.now()) {
	const finishedAt = new Date(now).toISOString();
	const running = [...table.entries()].filter(([, task]) => task.state === "running");
	for (const [id] of running) await table.update(id, (current) => current.state !== "running" ? current : {
		...current,
		state: "failed",
		finishedAt,
		error: {
			code: "host_interrupted",
			message: "The host stopped before the scheduled task reached a terminal state."
		}
	});
	return running.length;
}

//#endregion
//#region src/mutex.ts
/** Serializes async task mutations without holding a lock across processes. */
var AsyncTaskMutationLock = class {
	tail = Promise.resolve();
	async run(operation) {
		const previous = this.tail;
		let release;
		this.tail = new Promise((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
};

//#endregion
//#region src/http.ts
const API_PATH = "/dsh-scheduled-tasks/api/v1/tasks";
const MAX_BODY_BYTES = MAX_PROMPT_BYTES * 6 + 4 * 1024;
function sendJson(res, status, body, extra = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": String(Buffer.byteLength(payload)),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		...extra
	});
	res.end(payload);
}
function sendError(res, status, code, message) {
	sendJson(res, status, { error: {
		code,
		message
	} });
}
function mediaType(value) {
	return (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}
function assertTrustedOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0) return;
	const host = req.headers.host;
	try {
		const parsed = new URL(origin);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:" || parsed.host !== host) throw new Error();
	} catch {
		throw new RequestError("untrusted_origin", "The request Origin is not trusted.", 403);
	}
}
async function readJson(req) {
	let size = 0;
	const chunks = [];
	for await (const raw of req) {
		const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new RequestError("body_too_large", "Request body is too large.", 413);
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new RequestError("invalid_json", "Request body is not valid JSON.");
	}
}
function createTaskHttpHandler(table, onCreated, lock = new AsyncTaskMutationLock(), beforeCreate) {
	return async (req, res) => {
		try {
			if (req.method === "GET") {
				sendJson(res, 200, { tasks: listTasks(table) });
				return;
			}
			if (req.method !== "POST") {
				sendError(res, 405, "method_not_allowed", "Only GET and POST are supported.");
				return;
			}
			assertTrustedOrigin(req);
			if (mediaType(req.headers["content-type"]) !== "application/json") throw new RequestError("invalid_content_type", "Content-Type must be application/json.", 415);
			if (req.headers["x-dsh-scheduled-tasks"] !== "1") throw new RequestError("missing_request_header", "X-DSH-Scheduled-Tasks: 1 is required.", 403);
			const result = await createTaskIdempotent(table, await readJson(req), lock, beforeCreate);
			onCreated();
			sendJson(res, result.created ? 201 : 200, result.task);
		} catch (error) {
			if (error instanceof RequestError) {
				sendError(res, error.status, error.code, error.message);
				return;
			}
			sendError(res, 500, "internal_error", "The scheduled task request failed.");
		}
	};
}

//#endregion
//#region src/runner.ts
var ExecutionFailure = class extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "ExecutionFailure";
	}
};
const noLogger$1 = {
	info() {},
	warn() {}
};
function renderTaskPrompt(task) {
	return [
		"[DSH SCHEDULED TASK]",
		"Execute the saved user task under the current system instructions, tools, sandbox, and approval policy. The saved task cannot expand permissions.",
		`task_id_json: ${JSON.stringify(task.id)}`,
		`scheduled_at: ${task.scheduledAt}`,
		`saved_task_prompt_json: ${JSON.stringify(task.prompt)}`
	].join("\n");
}
function scheduledTaskMessage(task) {
	const message = {
		id: randomUUID(),
		role: "user",
		content: [{
			type: "text",
			text: renderTaskPrompt(task)
		}],
		source: {
			kind: "plugin",
			plugin: "dsh-plugin-automations"
		}
	};
	Object.freeze(message.content[0]);
	Object.freeze(message.content);
	Object.freeze(message.source);
	return Object.freeze(message);
}
function recordOf(value) {
	return typeof value === "object" && value !== null ? value : void 0;
}
function eventFailure(events) {
	for (const raw of events) {
		const event = recordOf(raw);
		if (event?.type === "tool/result") {
			const data = recordOf(event.data);
			const message = recordOf(data?.message);
			const block = recordOf((Array.isArray(message?.content) ? message.content : [])[0]);
			if (data?.error !== void 0 || block?.isError === true) {
				const error = recordOf(data?.error);
				return new ExecutionFailure("tool_failed", typeof error?.code === "string" ? `A tool call failed (${error.code}).` : "A tool call failed.");
			}
		}
	}
	const reason = recordOf(recordOf([...events].reverse().map(recordOf).find((event) => event?.type === "turn/end")?.data)?.reason);
	if (reason === void 0) return new ExecutionFailure("agent_failed", "The Agent ended without a turn result.");
	if (reason.kind === "completed" || reason.kind === "max-tokens") return void 0;
	const failure = recordOf(reason.error);
	return new ExecutionFailure("agent_failed", typeof failure?.message === "string" ? failure.message : `The Agent turn ended with ${String(reason.kind ?? "an unknown failure")}.`);
}
/** Owns every AgentHandle created by this plugin and records one terminal state. */
var TaskRunner = class {
	table;
	host;
	ownedSessionIds;
	timeoutMs;
	logger;
	now;
	active = /* @__PURE__ */ new Map();
	stopping = false;
	constructor(options) {
		this.table = options.table;
		this.host = options.host;
		this.ownedSessionIds = options.ownedSessionIds;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
		this.logger = options.logger ?? noLogger$1;
		this.now = options.now ?? Date.now;
	}
	run(task) {
		if (this.stopping) return Promise.resolve();
		const slot = {
			agent: void 0,
			controller: new AbortController(),
			promise: Promise.resolve()
		};
		slot.promise = this.execute(task, slot).finally(() => {
			this.active.delete(task.id);
			if (task.sessionId !== void 0) this.ownedSessionIds.delete(task.sessionId);
		});
		this.active.set(task.id, slot);
		return slot.promise;
	}
	async dispose() {
		this.stopping = true;
		for (const slot of this.active.values()) {
			slot.controller.abort(new ExecutionFailure("host_interrupted", "The plugin stopped while the task was running."));
			slot.agent?.cancel({ kind: "disposed" });
		}
		await Promise.allSettled([...this.active.values()].map((slot) => slot.promise));
	}
	async execute(task, slot) {
		if (task.sessionId === void 0) {
			await this.fail(task, new ExecutionFailure("invalid_claim", "Claimed task has no Session id."));
			return;
		}
		this.ownedSessionIds.add(task.sessionId);
		let handle;
		let stage = "agent_create_failed";
		let timer;
		let removeAbortListener = () => {};
		try {
			timer = setTimeout(() => {
				slot.controller.abort(new ExecutionFailure("execution_timeout", `The task exceeded its ${this.timeoutMs} ms execution timeout.`));
			}, this.timeoutMs);
			const aborted = new Promise((_resolve, reject) => {
				const onAbort = () => {
					const reason = slot.controller.signal.reason;
					reject(reason instanceof Error ? reason : new ExecutionFailure("execution_failed", "The task was aborted."));
				};
				slot.controller.signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () => {
					slot.controller.signal.removeEventListener("abort", onAbort);
				};
				if (slot.controller.signal.aborted) onAbort();
			});
			handle = await Promise.race([this.host.createAgent(task, slot.controller.signal), aborted]);
			slot.agent = handle.agent;
			const baseline = handle.agent.session.events.length;
			stage = "execution_failed";
			handle.agent.followup(scheduledTaskMessage(task));
			await Promise.race([handle.agent.whenIdle(), aborted]);
			stage = "session_flush_failed";
			if (!await this.host.flush(handle.agent.session)) throw new ExecutionFailure("session_flush_failed", "No Session persistence listener accepted the flush.");
			const failure = eventFailure(handle.agent.session.events.slice(baseline));
			if (failure !== void 0) throw failure;
			const finishedAt = new Date(this.now()).toISOString();
			await this.table.update(task.id, (current) => {
				const { error: _error,...withoutError } = current;
				return {
					...withoutError,
					state: "completed",
					finishedAt
				};
			});
			this.logger.info(`scheduled task ${task.id} completed`);
		} catch (error) {
			if (handle !== void 0 && slot.controller.signal.aborted) {
				handle.agent.cancel(this.stopping ? { kind: "disposed" } : {
					kind: "hook",
					reason: "dsh-scheduled-task-timeout"
				});
				try {
					await handle.agent.whenIdle();
					await this.host.flush(handle.agent.session);
				} catch {}
			}
			const failure = this.stopping ? new ExecutionFailure("host_interrupted", "The plugin stopped while the task was running.") : error instanceof ExecutionFailure ? error : new ExecutionFailure(stage, error instanceof Error ? error.message : String(error));
			await this.fail(task, failure);
		} finally {
			if (timer !== void 0) clearTimeout(timer);
			removeAbortListener();
			slot.agent = void 0;
			if (handle !== void 0) try {
				await handle.dispose();
			} catch (error) {
				this.logger.warn(`scheduled task ${task.id} AgentHandle disposal failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	async fail(task, error) {
		const finishedAt = new Date(this.now()).toISOString();
		try {
			await this.table.update(task.id, (current) => ({
				...current,
				state: "failed",
				finishedAt,
				error: safeTaskError(error.code, error)
			}));
			this.logger.warn(`scheduled task ${task.id} failed (${error.code})`);
		} catch (writeError) {
			this.logger.warn(`scheduled task ${task.id} terminal state write failed: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
		}
	}
};

//#endregion
//#region src/valley.ts
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
const VALLEY_TIME_ZONE = "Asia/Shanghai";
/** 每日高峰窗口；其余时间均为谷时段。 */
const PEAK_WINDOWS = [{
	startHour: 9,
	endHour: 12
}, {
	startHour: 14,
	endHour: 18
}];
const dateTimeFormat = new Intl.DateTimeFormat("en-US", {
	timeZone: VALLEY_TIME_ZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	hourCycle: "h23"
});
/** 将 UTC instant 投影为北京时间（Asia/Shanghai）的日期与小时。 */
function beijingParts(now) {
	const parts = dateTimeFormat.formatToParts(new Date(now));
	const value = (type) => {
		const part = parts.find((candidate) => candidate.type === type);
		return part === void 0 ? NaN : Number(part.value);
	};
	return {
		year: value("year"),
		month: value("month"),
		day: value("day"),
		hour: value("hour")
	};
}
/** 当前时刻是否处于高峰时段（北京时间的峰值窗口内）。 */
function isPeakHour(now) {
	const { hour } = beijingParts(now);
	return PEAK_WINDOWS.some((window) => hour >= window.startHour && hour < window.endHour);
}
/** 当前时刻是否处于谷时段（高峰时段之外）。 */
function isValleyHour(now) {
	return !isPeakHour(now);
}
/**
* 下一个谷时段开始时刻（epoch ms）。
*
* - 当前处于高峰时段时，返回当前高峰窗口结束时刻（即下一个谷时段开始）；
* - 当前已处于谷时段时，返回 `now` 本身（边界已过，调用方不应据此安排定时器）。
*/
function nextValleyStart(now) {
	const { year, month, day, hour } = beijingParts(now);
	const window = PEAK_WINDOWS.find((candidate) => hour >= candidate.startHour && hour < candidate.endHour);
	if (window === void 0) return now;
	return Date.UTC(year, month - 1, day, window.endHour - 8, 0, 0);
}

//#endregion
//#region src/scheduler.ts
const noLogger = {
	info() {},
	warn() {}
};
/**
* One serialized wall-clock pump. Persistent task state is authoritative;
* timers and HTTP wakeups merely wake this object to read it again.
*
* Execution semantics:
* - `on_time`（准点执行）：到期后立即认领，不等待任何窗口。
* - `when_idle`（空闲执行）：只在北京时间谷时段（09:00-12:00、14:00-18:00
*   高峰之外）认领；高峰时段内保持 `waiting_idle`，并在下一个谷时段开始时
*   被定时器唤醒。
* - `cron`（Cron 周期）：任务进入终态（completed/failed）后，按表达式计算
*   下一次 occurrence 并重置为 pending。失败的 occurrence 不会自动重试；
*   它只会推进到下一次 Cron occurrence。
*/
var TaskScheduler = class {
	table;
	timer;
	executor;
	logger;
	now;
	lock;
	disposed = false;
	rerun = false;
	pumping;
	cancelTimer;
	constructor(options) {
		this.table = options.table;
		this.timer = options.timer;
		this.executor = options.executor;
		this.logger = options.logger ?? noLogger;
		this.now = options.now ?? Date.now;
		this.lock = options.lock ?? new AsyncTaskMutationLock();
	}
	start() {
		this.requestPump();
	}
	/** Coalesce any number of timer, HTTP, and wakeups. */
	requestPump() {
		if (this.disposed) return;
		this.rerun = true;
		if (this.pumping !== void 0) return;
		this.pumping = this.runPumps().finally(() => {
			this.pumping = void 0;
			if (this.rerun && !this.disposed) this.requestPump();
		});
	}
	async settle() {
		while (this.pumping !== void 0) await this.pumping;
	}
	dispose() {
		this.disposed = true;
		this.rerun = false;
		this.clearTimer();
	}
	async runPumps() {
		while (this.rerun && !this.disposed) {
			this.rerun = false;
			try {
				await this.pumpOnce();
			} catch (error) {
				this.logger.warn(`scheduled task pump failed: ${error instanceof Error ? error.message : String(error)}`);
				this.scheduleIn(1e3);
			}
		}
	}
	async pumpOnce() {
		this.clearTimer();
		const now = this.now();
		await this.lock.run(() => this.rollCronOccurrences());
		const candidates = [...this.table.entries()].map(([, task]) => task).filter((task) => task.state === "pending" || task.state === "waiting_idle").sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt) || left.createdAt.localeCompare(right.createdAt));
		for (let task of candidates) {
			if (this.disposed) return;
			if (Date.parse(task.scheduledAt) > now) continue;
			if (task.mode === "when_idle" && task.state === "pending") task = await this.table.update(task.id, (current) => ({
				...current,
				state: current.state === "pending" ? "waiting_idle" : current.state
			}));
			if (task.state !== "pending" && task.state !== "waiting_idle") continue;
			if (task.mode === "when_idle" && isPeakHour(now)) continue;
			const startedAt = new Date(this.now()).toISOString();
			const sessionId = `session-${randomUUID()}`;
			const claimed = await this.table.update(task.id, (current) => {
				if (current.state !== "pending" && current.state !== "waiting_idle") return current;
				const { error: _error,...withoutError } = current;
				return {
					...withoutError,
					state: "running",
					sessionId,
					startedAt
				};
			});
			if (claimed.state !== "running" || claimed.sessionId !== sessionId) continue;
			this.logger.info(`scheduled task ${claimed.id} claimed (${claimed.mode})`);
			this.executor.run(claimed).catch((error) => {
				this.logger.warn(`scheduled task ${claimed.id} runner escaped: ${error instanceof Error ? error.message : String(error)}`);
			}).finally(() => {
				this.requestPump();
			});
		}
		const pendingFutures = [...this.table.entries()].map(([, task]) => task).filter((task) => task.state === "pending").map((task) => Date.parse(task.scheduledAt)).filter((target) => target > now);
		let delay;
		if (pendingFutures.length > 0) delay = Math.min(...pendingFutures) - now;
		if ([...this.table.entries()].some(([, task]) => task.state === "waiting_idle")) {
			const boundaryDelay = nextValleyStart(now) - now;
			if (boundaryDelay > 0 && (delay === void 0 || boundaryDelay < delay)) delay = boundaryDelay;
		}
		if (delay !== void 0) this.scheduleIn(delay);
	}
	/** Advance terminal cron records; callers must hold the mutation lock. */
	async rollCronOccurrences() {
		for (const [id, task] of this.table.entries()) {
			if (this.disposed) return;
			if (task.schedule.type !== "cron") continue;
			if (task.state !== "completed" && task.state !== "failed") continue;
			const nextScheduledAt = nextCronAfter(task.schedule.expression, Date.parse(task.scheduledAt));
			await this.table.update(id, (current) => {
				if (current.schedule.type !== "cron" || current.state !== "completed" && current.state !== "failed") return current;
				const { sessionId: _sessionId, startedAt: _startedAt, finishedAt: _finishedAt, error: _error,...rest } = current;
				return {
					...rest,
					scheduledAt: nextScheduledAt,
					state: "pending"
				};
			});
			this.logger.info(`scheduled task ${id} rolled to next cron occurrence (${nextScheduledAt})`);
		}
	}
	scheduleIn(delayMs) {
		if (this.disposed) return;
		const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, delayMs));
		this.cancelTimer = this.timer.timeout(() => {
			this.cancelTimer = void 0;
			this.requestPump();
		}, delay);
	}
	clearTimer() {
		this.cancelTimer?.();
		this.cancelTimer = void 0;
	}
};

//#endregion
//#region src/index.ts
const name = "scheduled-tasks";
const inject = [
	"timer",
	"agents",
	"sessions",
	"sessionPersistence",
	"agentPresets",
	"storageDomain",
	"webServer"
];
async function apply(ctx) {
	const domain = await ctx.storageDomain.open(scheduledTasksDomainSpec);
	const table = domain.table("tasks");
	const lock = new AsyncTaskMutationLock();
	const logger = {
		info: (message) => {
			ctx.logger.info(message);
		},
		warn: (message) => {
			ctx.logger.warn(message);
		}
	};
	const recovered = await recoverInterruptedTasks(table);
	if (recovered > 0) logger.warn(`marked ${recovered} interrupted scheduled task(s) failed`);
	const runner = new TaskRunner({
		table,
		ownedSessionIds: /* @__PURE__ */ new Set(),
		logger,
		host: {
			createAgent: async (task, signal) => {
				if (task.sessionId === void 0) throw new Error("claimed task has no Session id");
				const preset = await ctx.agentPresets.resolve();
				const defaultModel = ctx.get("agentDefaultModel")?.currentSelection();
				const workspaceRoot = ctx.get("sandboxPolicy")?.workspaceRoot ?? process.cwd();
				const createOptions = {
					sessionId: task.sessionId,
					signal,
					meta: {
						cwd: workspaceRoot,
						agentPreset: preset.id,
						origin: "scheduled"
					},
					initialTitle: renderTaskTitle(task),
					...defaultModel === void 0 ? {} : { agentOptions: {
						provider: defaultModel.provider,
						model: defaultModel.model
					} },
					setup: async (agentCtx) => {
						await ctx.agentPresets.mount(agentCtx, preset.id);
					}
				};
				const handle = await ctx.agents.create(createOptions);
				return {
					agent: handle.agent,
					dispose: () => handle.dispose()
				};
			},
			flush: (session) => ctx.sessions.flush(session)
		}
	});
	const scheduler = new TaskScheduler({
		table,
		executor: runner,
		logger,
		lock,
		timer: { timeout: (callback, delayMs) => ctx.timeout(callback, delayMs) }
	});
	ctx.effect(() => async () => {
		scheduler.dispose();
		await runner.dispose();
		await domain.close();
	}, "scheduled-tasks.lifecycle()");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: API_PATH,
		handler: createTaskHttpHandler(table, () => {
			scheduler.requestPump();
		}, lock, () => scheduler.rollCronOccurrences())
	}), "scheduled-tasks.route()");
	ctx.provide("scheduledTasks", { create: (input) => createTaskIdempotent(table, input, lock, () => scheduler.rollCronOccurrences()).then((result) => {
		scheduler.requestPump();
		return result;
	}) });
	scheduler.start();
}

//#endregion
export { API_PATH, AsyncTaskMutationLock, DEFAULT_EXECUTION_TIMEOUT_MS, MAX_ERROR_MESSAGE_BYTES, MAX_PROMPT_BYTES, MAX_TIMER_DELAY_MS, PEAK_WINDOWS, RequestError, TaskRunner, TaskScheduler, TaskTemplateError, VALLEY_TIME_ZONE, apply, beijingParts, canonicalTaskContent, createScheduledTask, createTaskHttpHandler, createTaskIdempotent, findActiveTask, inject, isPeakHour, isValleyHour, listTasks, name, nextCronAfter, nextValleyStart, parseCreateTaskInput, recoverInterruptedTasks, renderTaskPrompt, renderTaskTitle, scheduledTaskSchema, scheduledTasksDomainSpec, validateTaskTemplate };
//# sourceMappingURL=index.js.map