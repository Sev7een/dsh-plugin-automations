/* dsh-plugin-automations Web client (prebuilt DSH module-loader artifact). */
window.__ModuleLoader__.load({
  id: "dsh-plugin-automations",
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var React = require("react")
    var API = "/dsh-scheduled-tasks/api/v1/tasks"
    var MAX_PROMPT_BYTES = 64 * 1024
    var stateLabels = {
      pending: "等待中",
      waiting_idle: "等待空闲时段",
      running: "执行中",
      completed: "已完成",
      failed: "失败"
    }
    var modeLabels = { on_time: "准点执行", when_idle: "空闲执行（谷时段）" }
    var repeatLabels = { once: "仅一次", daily: "每天" }
    var CSS = [
      ".dsta-root{display:flex;flex-direction:column;gap:18px;padding:6px 2px;font-family:inherit}",
      ".dsta-title{font-size:16px;font-weight:650;margin:0}",
      ".dsta-card{border:1px solid var(--ds-border,#444);border-radius:10px;padding:14px}",
      ".dsta-form{display:flex;flex-direction:column;gap:12px}",
      ".dsta-label{display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:600}",
      ".dsta-input,.dsta-textarea{box-sizing:border-box;width:100%;border:1px solid var(--ds-border,#555);border-radius:7px;background:transparent;color:inherit;padding:8px;font:inherit}",
      ".dsta-textarea{min-height:104px;resize:vertical}",
      ".dsta-modes{display:flex;gap:18px;flex-wrap:wrap;font-size:13px}",
      ".dsta-mode{display:flex;align-items:center;gap:6px;cursor:pointer}",
      ".dsta-actions{display:flex;align-items:center;justify-content:space-between;gap:10px}",
      ".dsta-btn{border:0;border-radius:7px;background:var(--ds-accent,#4f8cff);color:#fff;padding:7px 15px;font-size:13px;font-weight:600;cursor:pointer}",
      ".dsta-btn:disabled{opacity:.55;cursor:default}",
      ".dsta-hint{font-size:11px;opacity:.62}",
      ".dsta-error{border:1px solid rgba(239,68,68,.5);background:rgba(239,68,68,.08);border-radius:8px;padding:8px 11px;font-size:12px;color:#ef4444}",
      ".dsta-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
      ".dsta-list{display:flex;flex-direction:column;gap:9px}",
      ".dsta-task{border:1px solid var(--ds-border,#444);border-radius:9px;padding:11px 12px;display:flex;flex-direction:column;gap:7px}",
      ".dsta-task-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}",
      ".dsta-summary{font-size:13px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}",
      ".dsta-badge{flex:none;border-radius:999px;padding:2px 8px;font-size:10px;font-weight:650;background:rgba(79,140,255,.14);color:var(--ds-accent,#4f8cff)}",
      ".dsta-badge-completed{background:rgba(34,197,94,.14);color:#22c55e}",
      ".dsta-badge-failed{background:rgba(239,68,68,.14);color:#ef4444}",
      ".dsta-meta{display:flex;gap:6px 14px;flex-wrap:wrap;font-size:11px;opacity:.66}",
      ".dsta-failure{font-size:11px;color:#ef4444;overflow-wrap:anywhere}",
      ".dsta-empty{font-size:12px;opacity:.6;padding:8px 0}",
      "@media(max-width:600px){.dsta-actions,.dsta-task-top{align-items:stretch;flex-direction:column}.dsta-btn{width:100%}}"
    ].join("\n")

    function byteLength(value) { return new TextEncoder().encode(value).length }
    function summary(value) {
      var compact = value.replace(/\s+/g, " ").trim()
      return compact.length > 180 ? compact.slice(0, 177) + "…" : compact
    }
    function localTime(value, zone) {
      try {
        return new Intl.DateTimeFormat(undefined, {
          timeZone: zone,
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit"
        }).format(new Date(value))
      } catch (_) {
        return new Date(value).toLocaleString()
      }
    }
    function TaskRow(props) {
      var task = props.task
      var badge = "dsta-badge"
      if (task.state === "completed") badge += " dsta-badge-completed"
      if (task.state === "failed") badge += " dsta-badge-failed"
      var repeat = repeatLabels[task.repeat || "once"] || "仅一次"
      return React.createElement("div", { className: "dsta-task" },
        React.createElement("div", { className: "dsta-task-top" },
          React.createElement("div", { className: "dsta-summary", title: task.prompt }, summary(task.prompt)),
          React.createElement("span", { className: badge }, stateLabels[task.state] || task.state)
        ),
        React.createElement("div", { className: "dsta-meta" },
          React.createElement("span", null, "计划：" + localTime(task.scheduledAt, task.timeZone)),
          React.createElement("span", null, "方式：" + (modeLabels[task.mode] || task.mode)),
          React.createElement("span", null, "重复：" + repeat),
          task.startedAt && React.createElement("span", null, "开始：" + localTime(task.startedAt, task.timeZone)),
          task.finishedAt && React.createElement("span", null, "完成：" + localTime(task.finishedAt, task.timeZone))
        ),
        task.error && React.createElement("div", { className: "dsta-failure" },
          task.error.code + "：" + task.error.message
        )
      )
    }

    function Panel() {
      var promptState = React.useState("")
      var prompt = promptState[0], setPrompt = promptState[1]
      var timeState = React.useState("")
      var scheduledAt = timeState[0], setScheduledAt = timeState[1]
      var modeState = React.useState("on_time")
      var mode = modeState[0], setMode = modeState[1]
      var dailyState = React.useState(false)
      var daily = dailyState[0], setDaily = dailyState[1]
      var taskState = React.useState([])
      var tasks = taskState[0], setTasks = taskState[1]
      var busyState = React.useState(false)
      var busy = busyState[0], setBusy = busyState[1]
      var errorState = React.useState(null)
      var error = errorState[0], setError = errorState[1]

      var load = React.useCallback(function () {
        return fetch(API, { cache: "no-store" }).then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status)
          return res.json()
        }).then(function (body) {
          setTasks(Array.isArray(body.tasks) ? body.tasks : [])
        }).catch(function (err) {
          setError(String((err && err.message) || err))
        })
      }, [])

      React.useEffect(function () {
        load()
        var id = setInterval(load, 5000)
        return function () { clearInterval(id) }
      }, [load])

      var submit = function (event) {
        event.preventDefault()
        var saved = prompt.trim()
        if (!saved) { setError("请输入任务内容。"); return }
        if (byteLength(saved) > MAX_PROMPT_BYTES) { setError("任务内容不能超过 64 KiB。"); return }
        if (!scheduledAt) { setError("请选择执行时间。"); return }
        var instant = new Date(scheduledAt)
        if (!isFinite(instant.getTime()) || instant.getTime() <= Date.now()) {
          setError("执行时间必须晚于当前时间。"); return
        }
        setBusy(true)
        setError(null)
        fetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-DSH-Scheduled-Tasks": "1" },
          body: JSON.stringify({
            prompt: saved,
            scheduledAt: instant.toISOString(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            mode: mode,
            repeat: daily ? "daily" : "once"
          })
        }).then(function (res) {
          return res.json().catch(function () { return {} }).then(function (body) {
            if (!res.ok) throw new Error(body.error && body.error.message ? body.error.message : "HTTP " + res.status)
            return body
          })
        }).then(function () {
          setPrompt("")
          setScheduledAt("")
          setMode("on_time")
          setDaily(false)
          return load()
        }).catch(function (err) {
          setError(String((err && err.message) || err))
        }).then(function () { setBusy(false) })
      }

      return React.createElement("div", { className: "dsta-root" },
        React.createElement("h3", { className: "dsta-title" }, "定时任务"),
        error && React.createElement("div", { className: "dsta-error" }, error),
        React.createElement("form", { className: "dsta-card dsta-form", onSubmit: submit },
          React.createElement("label", { className: "dsta-label" }, "任务内容",
            React.createElement("textarea", {
              className: "dsta-textarea", value: prompt, required: true,
              placeholder: "输入需要 DSH Agent 执行的任务",
              onChange: function (event) { setPrompt(event.target.value) }
            })
          ),
          React.createElement("label", { className: "dsta-label" }, "执行时间",
            React.createElement("input", {
              className: "dsta-input", type: "datetime-local", value: scheduledAt, required: true,
              onChange: function (event) { setScheduledAt(event.target.value) }
            })
          ),
          React.createElement("div", { className: "dsta-label" }, "执行方式",
            React.createElement("div", { className: "dsta-modes" },
              React.createElement("label", { className: "dsta-mode" },
                React.createElement("input", { type: "radio", name: "dsta-mode", checked: mode === "on_time", onChange: function () { setMode("on_time") } }),
                "准点执行"
              ),
              React.createElement("label", { className: "dsta-mode" },
                React.createElement("input", { type: "radio", name: "dsta-mode", checked: mode === "when_idle", onChange: function () { setMode("when_idle") } }),
                "空闲执行（谷时段）"
              )
            ),
            mode === "when_idle" && React.createElement("span", { className: "dsta-hint" },
              "空闲执行：仅在谷时段执行（北京时间 09:00-12:00、14:00-18:00 高峰之外）。")
          ),
          React.createElement("label", { className: "dsta-mode" },
            React.createElement("input", {
              type: "checkbox", checked: daily,
              onChange: function (event) { setDaily(event.target.checked) }
            }),
            "每天执行（每天同一时刻重复执行）"
          ),
          React.createElement("div", { className: "dsta-actions" },
            React.createElement("span", { className: "dsta-hint" },
              daily ? "每天在设定时刻重复执行。" : "任务只执行一次。"),
            React.createElement("button", { className: "dsta-btn", type: "submit", disabled: busy }, busy ? "提交中…" : "提交任务")
          )
        ),
        React.createElement("div", { className: "dsta-head" },
          React.createElement("h3", { className: "dsta-title" }, "任务列表"),
          React.createElement("span", { className: "dsta-hint" }, "每 5 秒刷新")
        ),
        tasks.length === 0
          ? React.createElement("div", { className: "dsta-empty" }, "暂无定时任务。")
          : React.createElement("div", { className: "dsta-list" }, tasks.map(function (task) {
              return React.createElement(TaskRow, { key: task.id, task: task })
            }))
      )
    }

    var inject = ["slots"]
    function apply(ctx) {
      var style = document.createElement("style")
      style.setAttribute("data-plugin", "dsh-plugin-automations")
      style.textContent = CSS
      document.head.append(style)
      ctx.effect(function () { return function () { if (style.parentNode) style.parentNode.removeChild(style) } })
      var slots = ctx.get("slots")
      if (slots === undefined) return
      slots.inject("settings.section", function () {
        return slots.register(
          { name: "settings.section", id: "scheduled-tasks", order: 30, label: "定时任务" },
          function () { return React.createElement(Panel) }
        )
      })
    }
    exports.inject = inject
    exports.apply = apply
    return module.exports
  }
})
