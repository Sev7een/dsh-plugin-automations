window.__ModuleLoader__.load({ id: "dsh-plugin-automations", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/index.ts
var client_exports = {};
__export(client_exports, {
  API_PATH: () => API_PATH,
  EXECUTION_MODE_LABELS: () => EXECUTION_MODE_LABELS,
  MAX_PROMPT_BYTES: () => MAX_PROMPT_BYTES,
  POLL_INTERVAL_MS: () => POLL_INTERVAL_MS,
  SCHEDULE_LABELS: () => SCHEDULE_LABELS,
  TASK_STATE_LABELS: () => TASK_STATE_LABELS,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var React = __toESM(require("react"), 1);
var API_PATH = "/dsh-scheduled-tasks/api/v1/tasks";
var POLL_INTERVAL_MS = 5e3;
var MAX_PROMPT_BYTES = 64 * 1024;
var TASK_STATE_LABELS = {
  pending: "\u7B49\u5F85\u4E2D",
  waiting_idle: "\u7B49\u5F85\u7A7A\u95F2\u65F6\u6BB5",
  running: "\u6267\u884C\u4E2D",
  completed: "\u5DF2\u5B8C\u6210",
  failed: "\u5931\u8D25"
};
var EXECUTION_MODE_LABELS = {
  on_time: "\u51C6\u70B9\u6267\u884C",
  when_idle: "\u7A7A\u95F2\u6267\u884C\uFF08\u8C37\u65F6\u6BB5\uFF09"
};
var SCHEDULE_LABELS = {
  once: "\u4EC5\u4E00\u6B21",
  cron: "Cron"
};
var CSS = `
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
`;
function byteLength(value) {
  return new TextEncoder().encode(value).length;
}
function summary(value) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}\u2026` : compact;
}
function localTime(value) {
  try {
    return new Intl.DateTimeFormat(void 0, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}
function TaskRow({ task }) {
  let badge = "dsta-badge";
  if (task.state === "completed") badge += " dsta-badge-completed";
  if (task.state === "failed") badge += " dsta-badge-failed";
  const schedule = SCHEDULE_LABELS[task.schedule.type] ?? task.schedule.type;
  const scheduleValue = task.schedule.type === "cron" ? task.schedule.expression : localTime(task.scheduledAt);
  return React.createElement(
    "div",
    { className: "dsta-task" },
    React.createElement(
      "div",
      { className: "dsta-task-top" },
      React.createElement("div", { className: "dsta-summary", title: task.prompt }, summary(task.prompt)),
      React.createElement("span", { className: badge }, TASK_STATE_LABELS[task.state] ?? task.state)
    ),
    React.createElement(
      "div",
      { className: "dsta-meta" },
      React.createElement("span", null, `\u8BA1\u5212\uFF1A${scheduleValue}`),
      React.createElement("span", null, `\u65B9\u5F0F\uFF1A${EXECUTION_MODE_LABELS[task.mode] ?? task.mode}`),
      React.createElement("span", null, `\u8BA1\u5212\u7C7B\u578B\uFF1A${schedule}`),
      task.startedAt && React.createElement("span", null, `\u5F00\u59CB\uFF1A${localTime(task.startedAt)}`),
      task.finishedAt && React.createElement("span", null, `\u5B8C\u6210\uFF1A${localTime(task.finishedAt)}`)
    ),
    task.sessionTitleTemplate && React.createElement("div", { className: "dsta-hint" }, `\u6807\u9898\u6A21\u677F\uFF1A${task.sessionTitleTemplate}`),
    task.error && React.createElement(
      "div",
      { className: "dsta-failure" },
      `${task.error.code}\uFF1A${task.error.message}`
    )
  );
}
function Panel() {
  const [prompt, setPrompt] = React.useState("");
  const [scheduledAt, setScheduledAt] = React.useState("");
  const [scheduleType, setScheduleType] = React.useState("once");
  const [cronExpression, setCronExpression] = React.useState("0 0 8 * * *");
  const [sessionTitleTemplate, setSessionTitleTemplate] = React.useState("");
  const [mode, setMode] = React.useState("on_time");
  const [tasks, setTasks] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState();
  const load = React.useCallback(() => {
    return fetch(API_PATH, { cache: "no-store" }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }).then((body) => {
      setTasks(Array.isArray(body.tasks) ? body.tasks : []);
    }).catch((caught) => {
      setError(String(caught instanceof Error && caught.message || caught));
    });
  }, []);
  React.useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [load]);
  function submit(event) {
    event.preventDefault();
    const saved = prompt.trim();
    if (!saved) {
      setError("\u8BF7\u8F93\u5165\u4EFB\u52A1\u5185\u5BB9\u3002");
      return;
    }
    if (byteLength(saved) > MAX_PROMPT_BYTES) {
      setError("\u4EFB\u52A1\u5185\u5BB9\u4E0D\u80FD\u8D85\u8FC7 64 KiB\u3002");
      return;
    }
    if (scheduleType === "once") {
      if (!scheduledAt) {
        setError("\u8BF7\u9009\u62E9\u6267\u884C\u65F6\u95F4\u3002");
        return;
      }
      const instant = new Date(scheduledAt);
      if (!Number.isFinite(instant.getTime()) || instant.getTime() <= Date.now()) {
        setError("\u6267\u884C\u65F6\u95F4\u5FC5\u987B\u665A\u4E8E\u5F53\u524D\u65F6\u95F4\u3002");
        return;
      }
    } else if (cronExpression.trim().split(/\s+/).length !== 6) {
      setError("Cron \u8868\u8FBE\u5F0F\u5FC5\u987B\u5305\u542B 6 \u4E2A\u5B57\u6BB5\uFF1A\u79D2 \u5206 \u65F6 \u65E5 \u6708 \u5468\u3002");
      return;
    }
    setBusy(true);
    setError(void 0);
    fetch(API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-DSH-Scheduled-Tasks": "1" },
      body: JSON.stringify({
        prompt: saved,
        schedule: scheduleType === "once" ? { type: "once", scheduledAt: new Date(scheduledAt).toISOString() } : { type: "cron", expression: cronExpression.trim() },
        mode,
        ...sessionTitleTemplate.trim() === "" ? {} : { sessionTitleTemplate: sessionTitleTemplate.trim() }
      })
    }).then((response) => {
      return response.json().catch(() => ({})).then((body) => {
        if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
        return body;
      });
    }).then(() => {
      setPrompt("");
      setScheduledAt("");
      setScheduleType("once");
      setCronExpression("0 0 8 * * *");
      setSessionTitleTemplate("");
      setMode("on_time");
      return load();
    }).catch((caught) => {
      setError(String(caught instanceof Error && caught.message || caught));
    }).then(() => {
      setBusy(false);
    });
  }
  return React.createElement(
    "div",
    { className: "dsta-root" },
    React.createElement("h3", { className: "dsta-title" }, "\u5B9A\u65F6\u4EFB\u52A1"),
    error && React.createElement("div", { className: "dsta-error" }, error),
    React.createElement(
      "form",
      { className: "dsta-card dsta-form", onSubmit: submit },
      React.createElement(
        "label",
        { className: "dsta-label" },
        "\u4EFB\u52A1\u5185\u5BB9",
        React.createElement("textarea", {
          className: "dsta-textarea",
          value: prompt,
          required: true,
          placeholder: "\u8F93\u5165\u9700\u8981 DSH Agent \u6267\u884C\u7684\u4EFB\u52A1",
          onChange: (event) => {
            setPrompt(event.target.value);
          }
        })
      ),
      React.createElement(
        "div",
        { className: "dsta-label" },
        "\u8BA1\u5212\u7C7B\u578B",
        React.createElement(
          "div",
          { className: "dsta-modes" },
          React.createElement(
            "label",
            { className: "dsta-mode" },
            React.createElement("input", { type: "radio", name: "dsta-schedule", checked: scheduleType === "once", onChange: () => {
              setScheduleType("once");
            } }),
            "\u4EC5\u4E00\u6B21"
          ),
          React.createElement(
            "label",
            { className: "dsta-mode" },
            React.createElement("input", { type: "radio", name: "dsta-schedule", checked: scheduleType === "cron", onChange: () => {
              setScheduleType("cron");
            } }),
            "Cron"
          )
        )
      ),
      scheduleType === "once" ? React.createElement(
        "label",
        { className: "dsta-label" },
        "\u6267\u884C\u65F6\u95F4",
        React.createElement("input", {
          className: "dsta-input",
          type: "datetime-local",
          value: scheduledAt,
          required: true,
          onChange: (event) => {
            setScheduledAt(event.target.value);
          }
        })
      ) : React.createElement(
        "label",
        { className: "dsta-label" },
        "Cron \u8868\u8FBE\u5F0F\uFF08\u672C\u673A\u65F6\u533A\uFF0C\u516D\u5B57\u6BB5\uFF09",
        React.createElement("input", {
          className: "dsta-input",
          value: cronExpression,
          required: true,
          placeholder: "\u79D2 \u5206 \u65F6 \u65E5 \u6708 \u5468\uFF0C\u4F8B\u5982 0 0 8 * * *",
          onChange: (event) => {
            setCronExpression(event.target.value);
          }
        }),
        React.createElement("span", { className: "dsta-hint" }, "\u652F\u6301\u6807\u51C6 Cron\uFF1A\u79D2\u3001\u5206\u3001\u65F6\u3001\u65E5\u3001\u6708\u3001\u5468\uFF1B\u4F7F\u7528\u672C\u673A\u65F6\u533A\u3002")
      ),
      React.createElement(
        "label",
        { className: "dsta-label" },
        "Session \u6807\u9898\u6A21\u677F\uFF08\u53EF\u9009\uFF09",
        React.createElement("input", {
          className: "dsta-input",
          value: sessionTitleTemplate,
          placeholder: "Daily Feed \xB7 {{scheduledAt:YYYY-MM-DD}}",
          onChange: (event) => {
            setSessionTitleTemplate(event.target.value);
          }
        }),
        React.createElement("span", { className: "dsta-hint" }, "\u4F7F\u7528 {{field}} \u6216 {{datetimeField:FORMAT}}\uFF1B\u652F\u6301\u5D4C\u5957\u5B57\u6BB5\uFF0C\u4F8B\u5982 {{schedule.expression}}\u3002")
      ),
      React.createElement(
        "div",
        { className: "dsta-label" },
        "\u6267\u884C\u65B9\u5F0F",
        React.createElement(
          "div",
          { className: "dsta-modes" },
          React.createElement(
            "label",
            { className: "dsta-mode" },
            React.createElement("input", {
              type: "radio",
              name: "dsta-mode",
              checked: mode === "on_time",
              onChange: () => {
                setMode("on_time");
              }
            }),
            "\u51C6\u70B9\u6267\u884C"
          ),
          React.createElement(
            "label",
            { className: "dsta-mode" },
            React.createElement("input", {
              type: "radio",
              name: "dsta-mode",
              checked: mode === "when_idle",
              onChange: () => {
                setMode("when_idle");
              }
            }),
            "\u7A7A\u95F2\u6267\u884C\uFF08\u8C37\u65F6\u6BB5\uFF09"
          )
        ),
        mode === "when_idle" && React.createElement(
          "span",
          { className: "dsta-hint" },
          "\u7A7A\u95F2\u6267\u884C\uFF1A\u4EC5\u5728\u8C37\u65F6\u6BB5\u6267\u884C\uFF08\u5317\u4EAC\u65F6\u95F4 09:00-12:00\u300114:00-18:00 \u9AD8\u5CF0\u4E4B\u5916\uFF09\u3002"
        )
      ),
      React.createElement(
        "div",
        { className: "dsta-actions" },
        React.createElement(
          "span",
          { className: "dsta-hint" },
          scheduleType === "cron" ? "Cron \u4EFB\u52A1\u4F1A\u5728\u6BCF\u4E2A\u5339\u914D\u65F6\u95F4\u6267\u884C\u3002" : "\u4EFB\u52A1\u53EA\u6267\u884C\u4E00\u6B21\u3002"
        ),
        React.createElement(
          "button",
          { className: "dsta-btn", type: "submit", disabled: busy },
          busy ? "\u63D0\u4EA4\u4E2D\u2026" : "\u63D0\u4EA4\u4EFB\u52A1"
        )
      )
    ),
    React.createElement(
      "div",
      { className: "dsta-head" },
      React.createElement("h3", { className: "dsta-title" }, "\u4EFB\u52A1\u5217\u8868"),
      React.createElement("span", { className: "dsta-hint" }, "\u6BCF 5 \u79D2\u5237\u65B0")
    ),
    tasks.length === 0 ? React.createElement("div", { className: "dsta-empty" }, "\u6682\u65E0\u5B9A\u65F6\u4EFB\u52A1\u3002") : React.createElement(
      "div",
      { className: "dsta-list" },
      tasks.map((task) => React.createElement(TaskRow, { key: task.id, task }))
    )
  );
}
var inject = ["slots"];
function apply(ctx) {
  const style = document.createElement("style");
  style.dataset.plugin = "dsh-plugin-automations";
  style.textContent = CSS;
  document.head.append(style);
  ctx.effect(() => () => {
    if (style.parentNode) style.parentNode.removeChild(style);
  });
  const slots = ctx.get("slots");
  if (slots === void 0) return;
  slots.inject("settings.section", () => slots.register(
    { name: "settings.section", id: "scheduled-tasks", order: 30, label: "\u5B9A\u65F6\u4EFB\u52A1" },
    () => React.createElement(Panel)
  ));
}
return module.exports; } });
