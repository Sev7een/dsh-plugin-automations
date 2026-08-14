import { randomUUID } from "node:crypto";
import { z } from "zod";

//#region src/types.ts
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_ERROR_MESSAGE_BYTES = 4 * 1024;
const DEFAULT_EXECUTION_TIMEOUT_MS = 1800 * 1e3;
const MAX_TIMER_DELAY_MS = 2147483647;

//#endregion
//#region src/domain.ts
const rfc3339Instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const executionModeSchema = z.union([z.literal("on_time"), z.literal("when_idle")]);
const repeatModeSchema = z.union([z.literal("once"), z.literal("daily")]);
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
	scheduledAt: z.string().regex(rfc3339Instant),
	timeZone: z.string().min(1).max(255),
	mode: executionModeSchema,
	repeat: repeatModeSchema.optional(),
	state: taskStateSchema,
	sessionId: z.string().min(1).optional(),
	createdAt: z.string().regex(rfc3339Instant),
	startedAt: z.string().regex(rfc3339Instant).optional(),
	finishedAt: z.string().regex(rfc3339Instant).optional(),
	error: taskErrorSchema.optional()
}).strict();
const scheduledTasksDomainSpec = {
	name: "scheduled_tasks",
	version: 1,
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
function validateExactKeys(value) {
	const expected = [
		"mode",
		"prompt",
		"repeat",
		"scheduledAt",
		"timeZone"
	];
	const keys = Object.keys(value).sort();
	if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new RequestError("invalid_request", "Request body contains missing or unsupported fields.");
}
function isValidTimeZone(timeZone) {
	if (timeZone !== "UTC" && !timeZone.includes("/")) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
		return true;
	} catch {
		return false;
	}
}
function parseCreateTaskInput(raw, now = Date.now()) {
	const value = requireObject(raw);
	validateExactKeys(value);
	if (typeof value.prompt !== "string") throw new RequestError("invalid_prompt", "prompt must be a string.");
	const prompt = value.prompt.trim();
	if (prompt.length === 0) throw new RequestError("invalid_prompt", "prompt must not be empty.");
	if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) throw new RequestError("prompt_too_large", "prompt must not exceed 64 KiB.");
	if (typeof value.scheduledAt !== "string" || !rfc3339Instant.test(value.scheduledAt)) throw new RequestError("invalid_scheduled_at", "scheduledAt must be an RFC 3339 instant with an offset.");
	const epoch = Date.parse(value.scheduledAt);
	if (!Number.isFinite(epoch)) throw new RequestError("invalid_scheduled_at", "scheduledAt is not a valid instant.");
	if (epoch <= now) throw new RequestError("not_future", "scheduledAt must be later than the current time.");
	if (typeof value.timeZone !== "string" || !isValidTimeZone(value.timeZone)) throw new RequestError("invalid_time_zone", "timeZone must be UTC or a valid IANA Area/Location name.");
	if (value.mode !== "on_time" && value.mode !== "when_idle") throw new RequestError("invalid_mode", "mode must be on_time or when_idle.");
	if (value.repeat !== "once" && value.repeat !== "daily") throw new RequestError("invalid_repeat", "repeat must be once or daily.");
	return {
		prompt,
		scheduledAt: new Date(epoch).toISOString(),
		timeZone: value.timeZone,
		mode: value.mode,
		repeat: value.repeat
	};
}
function createScheduledTask(input, now = Date.now()) {
	const task = {
		id: randomUUID(),
		...input,
		scheduledAt: new Date(Date.parse(input.scheduledAt)).toISOString(),
		state: "pending",
		createdAt: new Date(now).toISOString()
	};
	scheduledTaskSchema.parse(task);
	return task;
}
function listTasks(table) {
	return [...table.entries()].map(([, task]) => ({
		...task,
		repeat: task.repeat ?? "once"
	})).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
function localParts(ms, timeZone) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23"
	}).formatToParts(new Date(ms));
	const value = (type) => {
		const part = parts.find((candidate) => candidate.type === type);
		return part === void 0 ? NaN : Number(part.value);
	};
	return {
		year: value("year"),
		month: value("month"),
		day: value("day"),
		hour: value("hour"),
		minute: value("minute"),
		second: value("second")
	};
}
/**
* 把 RFC 3339 instant 按 `timeZone` 的本地钟面时间平移 `days` 天，
* 返回平移后的 UTC instant。用于每天重复任务：保持同一本地时刻，
* 并且跨夏令时切换时仍落在正确的本地钟面时刻。
*/
function addLocalDays(instantIso, timeZone, days) {
	const original = Date.parse(instantIso);
	const parts = localParts(original, timeZone);
	const localAsUtc = (ms) => {
		const p = localParts(ms, timeZone);
		return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
	};
	const target = Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second);
	let guess = target + (original - localAsUtc(original));
	guess += target - localAsUtc(guess);
	guess += target - localAsUtc(guess);
	return new Date(guess).toISOString();
}

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
function createTaskHttpHandler(table, onCreated) {
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
			const task = createScheduledTask(parseCreateTaskInput(await readJson(req)));
			await table.put(task.id, task);
			onCreated();
			sendJson(res, 201, task);
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
* - `repeat: 'daily'`（每天执行）：任务进入终态（completed/failed）后，
*   自动把 scheduledAt 平移到下一自然日的同一本地时刻并重置为 pending。
*/
var TaskScheduler = class {
	table;
	timer;
	executor;
	logger;
	now;
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
		await this.rollDailyOccurrences();
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
	/**
	* 每天重复任务进入终态后，把 scheduledAt 平移到下一自然日的同一本地时刻，
	* 清空本次执行痕迹并重置为 pending，等待下一次到期。
	*/
	async rollDailyOccurrences() {
		for (const [id, task] of this.table.entries()) {
			if (this.disposed) return;
			if (task.repeat !== "daily") continue;
			if (task.state !== "completed" && task.state !== "failed") continue;
			const nextScheduledAt = addLocalDays(task.scheduledAt, task.timeZone, 1);
			await this.table.update(id, (current) => {
				if (current.repeat !== "daily" || current.state !== "completed" && current.state !== "failed") return current;
				const { sessionId: _sessionId, startedAt: _startedAt, finishedAt: _finishedAt, error: _error,...rest } = current;
				return {
					...rest,
					scheduledAt: nextScheduledAt,
					state: "pending"
				};
			});
			this.logger.info(`scheduled task ${id} rolled to next daily occurrence (${nextScheduledAt})`);
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
				const handle = await ctx.agents.create({
					sessionId: task.sessionId,
					signal,
					meta: {
						cwd: workspaceRoot,
						agentPreset: preset.id
					},
					...defaultModel === void 0 ? {} : { agentOptions: {
						provider: defaultModel.provider,
						model: defaultModel.model
					} },
					setup: async (agentCtx) => {
						await ctx.agentPresets.mount(agentCtx, preset.id);
					}
				});
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
		})
	}), "scheduled-tasks.route()");
	scheduler.start();
}

//#endregion
export { API_PATH, DEFAULT_EXECUTION_TIMEOUT_MS, MAX_ERROR_MESSAGE_BYTES, MAX_PROMPT_BYTES, MAX_TIMER_DELAY_MS, PEAK_WINDOWS, RequestError, TaskRunner, TaskScheduler, VALLEY_TIME_ZONE, addLocalDays, apply, beijingParts, createScheduledTask, createTaskHttpHandler, inject, isPeakHour, isValidTimeZone, isValleyHour, listTasks, name, nextValleyStart, parseCreateTaskInput, recoverInterruptedTasks, renderTaskPrompt, scheduledTaskSchema, scheduledTasksDomainSpec };
//# sourceMappingURL=index.js.map