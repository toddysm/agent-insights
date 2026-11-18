/** Render the read-only synthetic walkthrough; source refresh and analysis are explicit in-memory simulations only. */
/* global InsightsModel */
(() => {
  const M = InsightsModel;
  const main = document.getElementById("main");
  const dialog = document.getElementById("detail");
  const announcement = document.getElementById("announcement");
  let state = M.createState();
  let lastBase = "";
  let lastOpener = null;
  let dirty = true;
  const scrollPositions = new Map();
  const filters = { search: "", purpose: "All", artifactTask: "All", tool: "All" };
  let noticeTimer;
  const scenarioDescriptions = {
    report: "Start with outcomes. Every metric leads to its evidence.",
    empty:
      "Open selected synthetic harness evidence. No real file access is used.",
    steering:
      "Follow a count to a message, inspect context and inferred classification rationale.",
    artifacts:
      "Separate unique outputs from repeated operations and temporary helpers.",
    usage:
      "Inspect model-call usage and the difference between elapsed and cumulative activity.",
    prompts:
      "Review a prompt in its original context and inspect a suggested rewrite.",
    partial:
      "Notice what stays useful when content and some token usage are missing.",
    "analysis-off":
      "Recorded metrics remain available before model-based interpretation.",
    unsupported:
      "An unsupported example must produce an explicit error, not empty success.",
    "source-changed":
      "A changed source invalidates the report. Retry explicitly; no archive fills the gap.",
    "source-unavailable":
      "Removed harness evidence is unavailable. No application replica is retained.",
  };

  /** Escape dynamic evidence as text/attributes, never executable captured markup. */
  function h(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  }

  /** Format only recorded numbers; null means unavailable rather than a numeric zero. */
  function number(value) {
    return value === null
      ? "Unavailable"
      : new Intl.NumberFormat("en-US").format(value);
  }

  /** Produce a text-bearing status badge; color never carries the status by itself. */
  function badge(text, tone = "") {
    return `<span class="badge ${h(tone)}">${h(text)}</span>`;
  }

  /** Parse browser-local deep links without loading content from any URL. */
  function route() {
    const hash = location.hash.slice(1);
    const separator = hash.indexOf("?");
    return {
      base: (separator < 0 ? hash : hash.slice(0, separator)) || "report",
      params: new URLSearchParams(
        separator < 0 ? "" : hash.slice(separator + 1),
      ),
    };
  }

  /** Change a local route; preserve the report DOM and scroll position for drawer-only changes. */
  function navigate(hash) {
    if (location.hash === `#${hash}`) render();
    else location.hash = hash;
  }

  /** Open a deep-linkable evidence drawer and remember the originating control for keyboard return. */
  function openPanel(panel, taskId = "", extras = {}) {
    if (!dialog.contains(document.activeElement))
      lastOpener = document.activeElement;
    const params = new URLSearchParams({ panel, read: String(state.readId), ...extras });
    if (taskId) params.set("task", taskId);
    navigate(`${route().base}?${params}`);
  }

  /** Close the drawer without changing the report's selected page or filters. */
  function closePanel() {
    navigate(route().base);
  }

  /** Announce simulated actions and recoverable errors; no notification claims real work was performed. */
  function announce(message, error = false) {
    clearTimeout(noticeTimer);
    announcement.textContent = message;
    announcement.classList.toggle("error", error);
    noticeTimer = setTimeout(() => {
      announcement.textContent = "";
    }, 6500);
  }

  /** Build a consistent heading with explicit local scope and optional actions. */
  function heading(title, eyebrow, description, actions = "") {
    return `<div class="breadcrumb"><a href="#sessions">Sessions</a> / <a href="#report">Reporting improvements</a></div>
      <div class="page-heading"><div><p class="eyebrow">${h(eyebrow)}</p><h1 tabindex="-1">${h(title)}</h1><p class="meta">${h(description)}</p></div><div class="actions">${actions}</div></div>`;
  }

  /** A metric is a real button that opens its definition and exact synthetic contributors. */
  function metric(label, value, note, key, taskId = "", small = false) {
    const formatted =
      typeof value === "number" || value === null
        ? number(value)
        : String(value);
    const scope = taskId ? M.taskById(state, taskId).title : "whole session";
    return `<button class="metric" id="metric-${h(key)}-${h(taskId || "session")}" data-action="metric" data-metric="${h(key)}" data-task="${h(taskId)}" aria-label="Inspect ${h(label)}: ${h(formatted)}. ${h(note)}. Scope: ${h(scope)}.">
      <span class="metric-arrow" aria-hidden="true">+</span><span class="metric-label">${h(label)}</span>
      <span class="metric-value ${small || value === null ? "word" : ""}">${h(formatted)}</span>
      <span class="metric-note">${h(note)}</span></button>`;
  }

  /** Table counts use the same drill-down behavior and counting contract as report cards. */
  function countLink(value, key, taskId) {
    const label = key === "tokens" ? "input tokens" : key;
    return `<button class="count-button" id="row-${h(key)}-${h(taskId)}" data-action="metric" data-metric="${h(key)}" data-task="${h(taskId)}" aria-label="Inspect ${h(label)} for ${h(M.taskById(state, taskId).title)}: ${h(number(value))}.">${h(number(value))}</button>`;
  }

  /** Render each immutable human instruction separately, retaining its original source ID and turn. */
  function instructionBlocks(records) {
    return records
      .map(
        (source) =>
          `<section class="source-instruction" data-source="${h(source.id)}"><p class="eyebrow">Human / U${String(source.turn).padStart(2, "0")} / original source</p><blockquote class="quote">${h(source.text)}</blockquote><p class="small muted">Source: ${h(source.id)}. This anchor does not change with task grouping.</p></section>`,
      )
      .join("");
  }

  /** Describe coverage and explicit run state without fabricating missing metrics. */
  function coverageNotice() {
    let markup = "";
    if (!state.content)
      markup += `<div class="callout"><strong>Partial capture.</strong> Message content is missing, and 3 of 12 model calls lack usage. Timing and tool counts remain available. <button class="text-button" data-action="metric" data-metric="coverage">Inspect coverage</button></div>`;
    if (!state.telemetry)
      markup += `<div class="callout"><strong>Transcript only.</strong> Tool activity, token totals, and artifact operations were not captured. Completion claims are not tool-verified.</div>`;
    markup += `<div class="callout info">Read-only view / source: selected synthetic sample-reports harness evidence / source read ${state.readId}: ${h(readTime())}. Report and interpretations describe this read only. <button class="text-button" data-action="metric" data-metric="coverage">Inspect source coverage</button></div>`;
    if (state.run)
      markup += `<div class="callout" role="status">Analysis: ${h(state.run.status)} / run ${state.run.id}, source read ${state.run.readId}. ${state.run.status === "running" ? '<button class="text-button" data-action="analysis">Inspect or cancel running simulation</button>' : state.run.status === "failed" ? 'No interpretations were produced. Retry is an explicit action and may incur additional usage in the product.' : state.run.status === "superseded" ? 'Older results are discarded, not mixed into this read.' : 'Actual model calls made by this prototype: 0.'}</div>`;
    return markup;
  }

  /** Display deterministic synthetic UTC read times, not a claim about a real capture clock. */
  function readTime() {
    return new Date(Date.UTC(2026, 9, 29, 9, 42 + state.readId))
      .toISOString()
      .replace("T", " ")
      .replace(".000Z", " UTC (synthetic)");
  }

  /** Show failed-read recovery, optionally beneath an existing page heading; never resurrect cached evidence. */
  function sourceUnavailable(withHeading = true) {
    const title = state.sourceState === "changed" ? "Source changed during a read" : "Source unavailable";
    const scope = `Selected synthetic source / read ${state.readId} / ${readTime()}`;
    return (withHeading
      ? heading(title, "NO REPORT FOR THIS READ", scope)
      : `<h2>${h(title)}</h2><p class="meta">${h(scope)}</p>`) +
      `<div class="callout error" role="alert">${state.sourceState === "changed" ? "This view could not establish the needed source coverage." : "The harness removed, rotated, or no longer exposes this evidence."} No successful totals or older interpretations are shown.</div><p>There is no application archive, saved analysis history, or source replica to fall back to.</p><div class="actions"><button class="button" data-action="refresh">Retry synthetic read</button><button class="secondary" data-action="import">Choose another example</button></div><p class="small muted">Retry illustrates a harness source becoming available again; it does not restore an application copy.</p>`;
  }

  /** Offer a useful path forward when synthetic content or analysis is unavailable. */
  function unavailable(title, explanation, action = "analysis") {
    const label =
      action === "analysis"
        ? "Review analysis setup"
        : action === "import"
          ? "Open a synthetic example"
          : "Open capture help";
    return `<section class="empty"><div class="empty-symbol" aria-hidden="true">...</div><h2>${h(title)}</h2><p class="muted">${h(explanation)}</p>
      <div class="actions"><button class="button" data-action="${h(action)}">${label}</button><a class="secondary" href="#report">Back to recorded metrics</a></div></section>`;
  }

  /** Show selected synthetic harness sources without reading files or scanning the computer. */
  function sessionsPage() {
    const intro = heading(
      "Your sessions",
      "THE STARTING POINT",
      "Choose a conversation. Understand the work behind it.",
      `<button class="button" data-action="import">Open demo source</button><button class="secondary" data-action="discover">Find demo sessions</button>${state.imported && state.sourceState === "ready" ? '<button class="secondary" data-action="refresh">Refresh selected source</button>' : ""}`,
    );
    if (!state.imported)
      return (
        intro +
        `<section class="empty"><div class="empty-symbol" aria-hidden="true">01</div><h2>A report starts with evidence.</h2><p class="muted">No supported harness source is selected. Choose existing evidence; capture setup cannot recover historical content.</p><div class="actions"><button class="button" data-action="import">Open a synthetic example</button><button class="secondary" data-action="capture-help">Capture prerequisites</button></div><p class="small muted">This prototype does not open a file picker, scan directories, or read real conversations.</p></section>`
      );
    if (state.sourceState !== "ready") return intro + sourceUnavailable(false);
    return (
      intro +
      `<div class="filter-bar"><label>Search sessions<input id="session-search" type="search" value="${h(filters.search)}" placeholder="Session or project"></label></div>
      <div class="table-wrap"><table><thead><tr><th>Session</th><th>Project</th><th>Source</th><th>Evidence</th><th></th></tr></thead><tbody>
      <tr data-search="reporting improvements sample-reports"><td><a class="task-link" href="#report">Reporting improvements</a><small>Observed 09:00-09:42 UTC / synthetic</small></td><td>sample-reports</td><td>VS Code Copilot</td><td>${badge(state.content && state.telemetry ? "Content + traces" : state.content ? "Transcript only" : "Partial capture", state.mode === "complete" ? "" : "warning")}</td><td><a href="#report" aria-label="Open Reporting improvements">Open</a></td></tr>
      <tr data-search="investigate test failures sample-tools"><td><button class="text-button" data-action="transcript-demo">Investigate test failures</button><small>Alternate evidence-coverage demonstration</small></td><td>sample-tools</td><td>VS Code Copilot</td><td>${badge("Transcript only", "warning")}</td><td><button class="text-button" data-action="transcript-demo" aria-label="Open transcript-only demonstration">Open</button></td></tr>
      </tbody></table></div><p id="search-empty" class="callout" hidden>No matching demo sessions.</p>
      <p class="table-note">The second row loads a transcript-only variation of the same synthetic evidence, not a second real capture.</p>
      <div class="two-column"><section class="panel"><p class="eyebrow">YOU CHOOSE THE SCOPE</p><h3>Opening is not permission to analyze.</h3><p class="small muted">Recorded metrics and source inspection are separate from model interpretation. Source selection and refresh never transmit content. Copilot is the approved first remote analysis executor; acknowledgment is required before a product model run.</p></section><section class="panel"><p class="eyebrow">HARNESS-OWNED EVIDENCE</p><h3>Read in place, not into another store.</h3><p class="small muted">No application-owned session database, source replica or saved report history. Capture retention remains the harness's responsibility.</p><button class="text-button" data-action="capture-help">See capture help</button></section></div>`
    );
  }

  /** Render the primary outcome-first report while keeping unknown and unanalysed counts explicit. */
  function reportPage() {
    const totals = M.metrics(state);
    const tasks = totals.tasks;
    const outcomeTitle = !tasks.length
      ? "No active task interpretations.<br>The recorded session remains available."
      : totals.completed === tasks.length
        ? "All active outcomes are complete.<br>Inspect the evidence behind them."
        : `${totals.completed} outcomes completed.<br>The rest deserves a closer look.`;
    return (
      heading(
        "Reporting improvements",
        "SESSION INSIGHTS",
        "sample-reports / VS Code Copilot Chat / observed 09:00-09:42 UTC (synthetic)",
        `<a class="secondary" href="#tools">Tools &amp; commands</a><button class="secondary" data-action="refresh">Refresh source</button><button class="button" data-action="analysis">Analysis setup</button>`,
      ) +
      `<div class="badge-row">${badge(state.content && state.telemetry ? "Captured content + execution" : "Limited evidence", state.mode === "complete" ? "" : "warning")}${badge(state.analyzed ? "Task interpretations: inferred" : "Interpretations: not analyzed", "neutral")}${badge("Synthetic example", "neutral")}</div>` +
      coverageNotice() +
      `<section class="hero"><div class="hero-story"><p class="eyebrow">WHAT MOVED FORWARD</p><h2>${state.analyzed ? outcomeTitle : "Your recorded activity is ready.<br>Interpretation is a separate step."}</h2><p class="muted">${state.analyzed ? `${number(totals.steering)} messages classified as steering; ${tasks.length} inferred tasks. Inspect the work behind each number before drawing a conclusion.` : "Time and tool evidence can be useful without assigning a task or rating a prompt. Nothing here contacts a model."}</p><button class="text-button" data-action="metric" data-metric="tasks">${state.analyzed ? `Inspect ${tasks.length} inferred tasks` : "Understand task availability"} <span aria-hidden="true">+</span></button></div>
      <div class="hero-aside"><p class="eyebrow">OUTCOMES, NOT A GRADE</p><div class="hero-number">${state.analyzed ? totals.completed : "--"} <span>/ ${state.analyzed ? tasks.length : "--"} tasks</span></div><p class="small muted">Completion evidence is shown per task. An agent's claim is not the same as a verified result.</p><button class="text-button" data-action="metric" data-metric="completed">Inspect completion evidence</button></div></section>
      <div class="metrics">
      ${metric("Human steering", totals.steering, state.analyzed ? "Distinct messages / inferred categories" : "Not analyzed", "steering")}
      ${metric("Unique artifacts", totals.artifacts, totals.deliverables === null ? "Purpose assessment unavailable" : `${totals.deliverables} deliverables / ${totals.helpers} temporary helpers`, "artifacts")}
      ${metric("Tools & commands", totals.toolCalls, totals.distinctTools === null ? "Execution records unavailable" : `${totals.distinctTools} distinct tools / inspect full inputs`, "tools")}
      ${metric("Model tokens", totals.input === null ? null : `${(totals.input / 1000).toFixed(1)}k / ${(totals.output / 1000).toFixed(1)}k`, "Input / output / recorded usage", "tokens")}
      </div>
      <div class="section-heading"><h2>The task story</h2><span class="small muted">Read-only / inspect evidence and uncertainty</span></div>
      ${state.analyzed ? taskTable(tasks) : `<div class="panel"><h3>Tasks have not been analyzed.</h3><p class="small muted">${state.content ? "Enable the simulated analysis to explore task interpretations. Recorded metrics above remain available." : "Message content is missing, so this example cannot support task or steering analysis."}</p><button class="text-button" data-action="${state.content ? "analysis" : "capture-help"}">${state.content ? "Review analysis setup" : "Inspect capture prerequisites"}</button></div>`}
      <section class="panel activity-panel"><div class="section-heading"><div><p class="eyebrow">42 MINUTES OBSERVED / SYNTHETIC</p><h3>Where did the time go?</h3></div><button class="text-button" data-action="metric" data-metric="time">Inspect time</button></div>
      ${timeline()}<p class="small muted">${state.telemetry ? `${totals.activeMinutes}m recorded agent activity / ${totals.cumulativeMinutes}m cumulative spans. 24m outside recorded execution, not 24m of human inactivity. Lanes can overlap; do not add their durations.` : "Execution and lifecycle timing unavailable. Conversation duration is not agent runtime."} <button class="text-button" data-action="metric" data-metric="typing">Human typing: unavailable</button></p></section>
      <section class="panel"><p class="eyebrow">A BETTER NEXT INSTRUCTION</p><h3>What would you ask differently?</h3><p class="small muted">Review the initial prompt and each task prompt in context. Ratings are model judgments; suggestions are grounded in visible evidence.</p><a class="button" href="#prompts">Explore prompt coaching</a><p class="small muted">No overall productivity score. No invented time saved.</p></section>`
    );
  }

  /** Keep task associations distinct from session-unique totals in the primary navigation table. */
  function taskTable(tasks) {
    return `<div class="table-wrap"><table><thead><tr><th>Requested outcome</th><th>Status &amp; basis</th><th>Steering</th><th>Artifacts</th><th>In / out tokens</th></tr></thead><tbody>${tasks
      .map((task) => {
        const values = M.metrics(state, task.id);
        return `<tr><td><a class="task-link" href="#task/${h(task.id)}">${h(task.title)}</a><small>Turns U${task.range[0]}-U${task.range[1]} / inferred grouping</small></td><td>${badge(task.status, task.status === "Completed" ? "" : "warning")}<small>${h(task.evidence)}</small></td><td>${countLink(values.steering, "steering", task.id)}</td><td>${countLink(values.artifacts, "artifacts", task.id)}</td><td>${countLink(values.input, "tokens", task.id)}<small>${number(values.output)} output</small></td></tr>`;
      })
      .join(
        "",
      )}</tbody></table></div><p class="table-note">A shared artifact can appear under more than one task, but counts once for the session. Task grouping is inferred; capture coverage is not interpretation confidence.</p>`;
  }

  /** Draw evidence-labeled, overlapping session lanes; every recorded segment opens its supporting records. */
  function timeline() {
    const summary = M.activitySummary(state);
    return `<div class="activity-lanes">${summary.lanes.map((lane) => {
      let end = 0;
      const segments = (lane.spans || []).map((span) => {
        const gap = '<span aria-hidden="true"></span>'.repeat(span.start - end);
        end = span.end;
        return gap + `<button class="span-${span.end - span.start}" data-action="activity" data-id="${h(lane.id)}" aria-label="${h(lane.label)}: minutes ${span.start}-${span.end}; ${h(lane.basis)}. Inspect evidence."></button>`;
      }).join("");
      return `<section class="activity-lane lane-${h(lane.id)}"><div class="activity-label"><button class="text-button" data-action="activity" data-id="${h(lane.id)}">${h(lane.label)}</button><span>${lane.minutes === null ? "Unavailable" : `${lane.minutes}m`} / ${h(lane.basis)}</span></div><div class="timeline" role="group" aria-label="${h(lane.label)} timeline">${segments}</div></section>`;
    }).join("")}</div><div class="timeline-labels"><span>09:00</span><span>09:21</span><span>09:42 UTC</span></div>`;
  }

  /** Explain a selected lane with source boundaries; quiet is inferred and unknown time never becomes measured idle. */
  function activityPanel(id) {
    const lane = M.activitySummary(state).lanes.find((item) => item.id === id);
    if (!lane) throw new RangeError("That activity lane does not exist.");
    return panelShell(lane.label, `${lane.basis} / ${lane.minutes === null ? "TIMING UNAVAILABLE" : `${lane.minutes}m`} / SYNTHETIC`,
      `<p>${h(lane.explanation)}</p>${lane.spans === null ? '<div class="callout">Required timing/state records were not captured. This is unavailable, not zero.</div>' :
        lane.spans.map((span) => `<section class="context-block"><h3>Minutes ${span.start}-${span.end} from session start</h3>${span.sourceId ? `<p>Recorded start/end boundaries for ${h(span.sourceId.toUpperCase())}.</p><button class="text-button" data-action="${lane.id === "model" ? "request" : "tool"}" data-id="${h(span.sourceId)}">Inspect ${h(span.sourceId.toUpperCase())}</button>` : span.evidence ? `<ul>${span.evidence.map((record) => `<li><strong>${h(record.id)}</strong>: ${h(record.text)}</li>`).join("")}</ul>` : '<p>No sufficient execution or lifecycle records cover this interval. No human activity is inferred.</p>'}</section>`).join("")}
        <button class="text-button" data-action="metric" data-metric="time">Back to time overview</button>`);
  }

  /** Share the session/task invocation ledger without reconstructing missing arguments or treating programs as extra tool calls. */
  function toolsTable(taskId = "", toolName = "All") {
    const tools = state.tools.filter((item) => (!taskId || item.taskId === taskId) && (toolName === "All" || item.name === toolName));
    return `<p class="small muted">${tools.length} recorded invocations in this view. A shell invocation can contain several commands; it still counts once.</p><div class="table-wrap"><table><thead><tr><th>Invocation / tool</th><th>Duration</th><th>Outcome</th><th>Input</th></tr></thead><tbody>${tools.map((item) => `<tr><td><button class="text-button" data-action="tool" data-id="${h(item.id)}">${h(item.id.toUpperCase())} / ${h(item.name)}</button><small>${h(M.taskLabel(state, item.taskId))} / U${item.turn}</small></td><td>${number(item.durationMs)} ms</td><td>${h(item.status)}</td><td>${h(item.inputStatus)}<br><button class="text-button" data-action="tool" data-id="${h(item.id)}" aria-label="Inspect full input for ${h(item.id.toUpperCase())}">Inspect full input</button></td></tr>`).join("")}</tbody></table></div>`;
  }

  /** Make all recorded tools and full captured inputs discoverable at session scope, independent of analysis. */
  function toolsPage() {
    const intro = heading("Tools & commands", "RECORDED EXECUTION", "Reporting improvements / inspect captured inputs, results and source references.");
    if (!state.telemetry)
      return intro + '<div class="callout">No execution records were captured. Tool names, commands and arguments cannot be reconstructed from transcript text.</div>';
    const names = [...new Set(state.tools.map((item) => item.name))].toSorted();
    return intro + coverageNotice() +
      `<p>${state.tools.length} invocations / ${names.length} distinct tools. Display only: no command or tool input on this page is executed.</p><div class="badge-row">${names.map((name) => badge(`${name}: ${state.tools.filter((tool) => tool.name === name).length}`, "neutral")).join("")}</div><div class="filter-bar"><div class="filter-control"><label for="tool-filter">Tool</label><select id="tool-filter">${["All", ...names].map((name) => `<option ${filters.tool === name ? "selected" : ""}>${h(name)}</option>`).join("")}</select></div></div>${toolsTable("", filters.tool)}`;
  }

  /** Show a task's original request and outcome basis before any inferred explanation. */
  function taskPage(id) {
    const task = M.taskById(state, id);
    if (!state.analyzed)
      return unavailable(
        "Task interpretation is unavailable.",
        "This scenario has no task analysis.",
        state.content ? "analysis" : "capture-help",
      );
    const values = M.metrics(state, id);
    return (
      heading(
        task.title,
        "TASK DETAIL",
        `Turns U${task.range[0]}-U${task.range[1]} / inferred task segment`,
        `<a class="secondary" href="#report">Back to report</a>`,
      ) +
      `<div class="badge-row">${badge(task.status, task.status === "Completed" ? "" : "warning")}${badge(task.evidence, "neutral")}${badge("Inferred boundaries", "neutral")}</div>` +
      coverageNotice() +
      `<div class="panel"><p class="eyebrow">REQUESTED OUTCOME / SOURCE INSTRUCTIONS</p>${instructionBlocks(M.instructionsForTask(state, id))}<button class="text-button" data-action="origin" data-task="${h(id)}">Inspect originating instruction and interpretation</button></div>
      <div class="metrics">${metric("Human steering", values.steering, "Distinct messages, not tags", "steering", id)}${metric("Artifacts", values.artifacts, "Unique within this task", "artifacts", id)}${metric("Tool calls", values.toolCalls, "Recorded invocations", "tools", id)}${metric("Input tokens", values.input, `${number(values.output)} output tokens`, "tokens", id)}</div>
      <div class="two-column"><section class="panel"><p class="eyebrow">OUTCOME BASIS</p><h2>Why this status?</h2><p class="small muted">${task.status === "Completed" ? "Inspect the captured evidence or original acceptance message. This scoped assessment is not a correctness guarantee." : "An artifact or an agent's statement does not prove that the requested outcome is complete."}</p><ul class="evidence-list"><li>Recorded artifacts<button class="text-button" data-action="metric" data-metric="artifacts" data-task="${h(id)}">Inspect</button></li><li>Recorded tool results<button class="text-button" data-action="metric" data-metric="tools" data-task="${h(id)}">Inspect</button></li><li>Outcome assessment<button class="text-button" data-action="outcome" data-task="${h(id)}">Inspect outcome evidence</button></li></ul></section><section class="panel"><p class="eyebrow">KEEP THE CONTEXT</p><h2>Learn from the instruction.</h2><p class="small muted">The task inherits earlier context. Review the prompt with that context, not as an isolated sentence.</p><a class="button" href="#prompts/${h(id)}">Review task prompt</a></section></div>`
    );
  }

  /** Filter artifact identities without losing the source-operation basis for their task associations. */
  function artifactsPage() {
    const intro = heading(
      "What the work produced",
      "ARTIFACT INVENTORY",
      "Unique outputs, recorded operations, and inferred read-only purpose labels.",
      `<a class="secondary" href="#report">Back to report</a>`,
    );
    if (!state.content || !state.telemetry)
      return (
        intro +
        unavailable(
          "Artifact operations were not captured.",
          "Without recorded tool arguments/results, references alone do not prove creation.",
          "capture-help",
        )
      );
    const artifacts = state.artifacts.filter(
      (item) =>
        !state.analyzed ||
        ((filters.purpose === "All" || item.purpose === filters.purpose) &&
          (filters.artifactTask === "All" ||
            M.artifactTasks(state, item).includes(filters.artifactTask))),
    );
    return (
      intro +
      coverageNotice() +
      `<div class="badge-row">${badge(`${state.artifacts.length} unique artifacts`)}${badge(state.analyzed ? "Purpose labels: model-inferred" : "Purpose: not analyzed", "neutral")}${badge("Files: 6 / pull requests: 0 / issues: 0", "neutral")}</div>
      <div class="filter-bar"><div class="filter-control"><label for="purpose-filter">Purpose</label><select id="purpose-filter" ${!state.analyzed ? "disabled" : ""}>${["All", "Deliverable", "Temporary helper", "Supporting artifact", "Unknown"].map((value) => `<option ${(state.analyzed ? filters.purpose : "All") === value ? "selected" : ""}>${h(value)}</option>`).join("")}</select></div><div class="filter-control"><label for="artifact-task-filter">Task</label><select id="artifact-task-filter" ${!state.analyzed ? "disabled" : ""}><option value="All">${state.analyzed ? "All tasks" : "Attribution not analyzed"}</option>${(state.analyzed ? state.tasks : []).map((task) => `<option value="${h(task.id)}" ${filters.artifactTask === task.id ? "selected" : ""}>${h(task.title)}</option>`).join("")}</select></div></div>
      ${!state.analyzed ? '<p class="small muted">All recorded identities are shown while purpose and task interpretation are unavailable. Previous filters return only after successful analysis.</p>' : ""}
      <div class="table-wrap"><table><thead><tr><th>Artifact / observed action</th><th>Purpose</th><th>Associated tasks</th><th>Evidence</th></tr></thead><tbody>${
        artifacts
          .map(
            (artifact) =>
              `<tr><td><code>${h(artifact.path)}</code><small>${h(artifact.operations.map(([, action]) => action).join(", "))}</small></td><td>${state.analyzed ? badge(artifact.purpose, artifact.purpose === "Temporary helper" ? "warning" : "neutral") : "Not analyzed"}<small>${state.analyzed ? "Model-inferred" : "No model assessment"}</small></td><td>${
                M.artifactTasks(state, artifact)
                  .map((id) => h(M.taskLabel(state, id)))
                  .join("<br>") || "Unallocated"
              }</td><td><button class="text-button" data-action="artifact" data-id="${h(artifact.id)}" aria-label="Inspect ${h(artifact.path)}">Inspect</button></td></tr>`,
          )
          .join("") ||
        `<tr><td colspan="4">No artifacts match these filters.</td></tr>`
      }</tbody></table></div>
      <p class="table-note">${artifacts.length} shown. The test file is associated with two original tasks but counts once in the session. Deleted helpers remain visible.</p>
      <div class="callout info">The complete example contains six files and no recorded pull requests or issues. A mention alone is not confirmed creation. No live filesystem, Git or GitHub state is used as evidence; deleted helpers remain inspectable only while the harness retains their lifecycle records.</div>`
    );
  }

  /** Present hypothetical prompt feedback with explicit context, source anchors, and no live model invocation. */
  function promptsPage(id = "") {
    if (!state.content)
      return (
        heading(
          "Prompt coaching",
          "LEARN FOR NEXT TIME",
          "Ratings need the actual instructions and context.",
        ) +
        unavailable(
          "Message content was not captured.",
          "Tool and timing analysis remain useful, but a prompt rating would be fabricated.",
          "capture-help",
        )
      );
    if (!state.analyzed)
      return (
        heading(
          "Prompt coaching",
          "ANALYSIS NOT ENABLED",
          "Recorded evidence is still available.",
        ) +
        unavailable(
          "Prompts have not been assessed.",
          "Review the simulated analysis setup first.",
        )
      );
    const task = id ? M.taskById(state, id) : null;
    const sourceInstructions = task
      ? M.instructionsForTask(state, id)
      : [state.sessionInstruction];
    const prompt = sourceInstructions.map((source) => source.text).join("\n\n");
    const isCsv = id === "t1";
    const rewrite = isCsv
      ? "Add CSV export for the currently filtered table rows, preserving their order. Include headers, use the existing CSV utility, and verify escaping in tests."
      : task
        ? `${prompt} Use the existing project conventions, explain any ambiguity before changing behavior, and show evidence that the requested outcome is complete.`
        : "Help me improve reporting in this app. We will work through one requested outcome at a time. Confirm each task's scope, preserve existing behavior, and show what was verified and what remains incomplete.";
    return (
      heading(
        "A better next instruction",
        "PROMPT COACHING",
        "Evidence-led suggestions, not a grade for the person.",
        `<a class="secondary" href="#report">Back to report</a>`,
      ) +
      `<nav class="tabs" aria-label="Prompt selection"><a href="#prompts" ${!id ? 'aria-current="page"' : ""}>Initial session prompt</a>${state.tasks
        .map(
          (item) =>
            `<a href="#prompts/${h(item.id)}" ${id === item.id ? 'aria-current="page"' : ""}>${h(item.title)}</a>`,
        )
        .join("")}</nav>` +
      coverageNotice() +
      `<div class="prompt-grid"><section class="panel"><p class="eyebrow">ORIGINAL INSTRUCTION EVIDENCE</p><h2>${task ? h(task.title) : "Initial session prompt"}</h2>${instructionBlocks(sourceInstructions)}
      <details><summary>What context was available?</summary><p>The synthetic session concerns an existing reporting table. Earlier accepted instructions remain relevant; a short reference to an agreed design can be sufficient.</p><p>Assessment uses submission-time context. Later clarifications can inform a rewrite but do not establish that the original prompt caused an error.</p></details>
      <p class="eyebrow">ILLUSTRATIVE ASSESSMENT</p><div class="rating">3 / 5 <span>clarity</span> &nbsp; 4 / 5 <span>usefulness</span></div>${badge("Model judgment / illustrative", "warning")}
      <p class="small muted">Example evaluator / draft rubric 1. No model has actually evaluated this page. These are canned ratings, not computed scores. Assessments are transient for source read ${state.readId}.</p></section>
      <section class="panel"><p class="eyebrow">KEEP WHAT WORKED</p><h3>A recognizable outcome.</h3><p class="small muted">The request identifies a capability and connects it to the ongoing work.</p><p class="eyebrow">MAKE THE BOUNDARIES CLEARER</p><h3>${isCsv ? "Which rows should be exported?" : "What would count as complete?"}</h3><p class="small muted">${isCsv ? "All rows versus filtered rows is a meaningful ambiguity. Inspect the later clarification without assuming the prompt caused the agent's decision." : "Make the expected output and verification explicit when they are not already established in the conversation."}</p>
      <div class="actions">${task ? `<button class="text-button" data-action="origin" data-task="${h(id)}">Original instruction</button>` : `<button class="text-button" data-action="session-origin">Original session instruction</button>`}${isCsv ? `<button class="text-button" data-action="signal" data-id="u08">Later clarification / U08</button>` : ""}</div>
      <label for="rewrite">Suggested rewrite / synthetic example</label><textarea id="rewrite" readonly>${h(rewrite)}</textarea><div class="actions"><button class="button" data-action="copy-rewrite">Copy suggested rewrite</button></div>
      <p class="small muted">${isCsv ? "Learned context: filtered rows (U08) and existing utility (U14). Suggested assumptions: preserve row order, include headers and verify escaping in tests; these are not recorded requirements." : "Review the suggested constraints before reusing them; they are recommendations, not new requirements."} Copying does not execute the prompt or change source evidence.</p></section></div>`
    );
  }

  /** Apply only DOM row filtering so typing does not replace the input or steal its focus. */
  function filterSessions() {
    const rows = [...main.querySelectorAll("[data-search]")];
    rows.forEach((row) => {
      row.hidden = !row.dataset.search.includes(filters.search.toLowerCase());
    });
    const empty = document.getElementById("search-empty");
    if (empty) empty.hidden = rows.some((row) => !row.hidden);
  }

  /** Compose a drawer with an accessible title, a close control, and explicit session/task scope. */
  function panelShell(title, subtitle, content) {
    return `<header class="dialog-header"><div><p class="eyebrow">${h(subtitle)}</p><h2 id="detail-title" tabindex="-1">${h(title)}</h2></div><button class="close-button" data-action="close" aria-label="Close detail">&times;</button></header><div class="dialog-content">${content}</div>`;
  }

  /** List distinct steering messages; two category tags on one message remain one contributor. */
  function steeringPanel(taskId) {
    if (!state.analyzed)
      return panelShell(
        "Steering is not analyzed",
        "EVIDENCE LIMIT",
        `<p>Semantic classifications are unavailable in this scenario. This is not a zero count.</p><button class="button" data-action="${state.content ? "analysis" : "capture-help"}">${state.content ? "Review analysis setup" : "Open capture help"}</button>`,
      );
    const messages = state.signals.filter(
      (item) =>
        (!taskId || item.taskId === taskId) &&
        M.steeringCategories.includes(item.category),
    );
    return panelShell(
      `${messages.length} steering messages`,
      taskId ? M.taskLabel(state, taskId) : "WHOLE SESSION",
      `<p class="small muted">One row per distinct human message. Corrections, routine approvals, and new requirements are not interchangeable.</p>
      ${messages.map((signal) => `<button class="signal-card" data-action="signal" data-id="${h(signal.id)}"><span class="badge-row">${badge(signal.id.toUpperCase(), "neutral")}${signal.tags.map((tag) => badge(tag, "warning")).join("")}</span><strong>${h(signal.text)}</strong><small>${h(M.taskLabel(state, signal.taskId))} / model-inferred category</small></button>`).join("") || `<div class="callout info">No messages currently have a corrective-steering classification in this scope.</div>`}
      <details><summary>Other human involvement</summary>${
        state.signals
          .filter(
            (item) =>
              (!taskId || item.taskId === taskId) &&
              !M.steeringCategories.includes(item.category),
          )
          .map(
            (signal) =>
              `<button class="signal-card" data-action="signal" data-id="${h(signal.id)}"><strong>${h(signal.text)}</strong><small>${h(signal.category)} / not counted as corrective steering</small></button>`,
          )
          .join("") || "<p>No other involvement records in this scope.</p>"
      }</details>`,
    );
  }

  /** Show exact fictional before/human/after context and a read-only classification rationale. */
  function interactionPanel(id) {
    if (!state.content)
      return panelShell(
        "Interaction content unavailable",
        "CAPTURE COVERAGE",
        `<p>The example did not capture message text. No original instruction can be reconstructed from timing alone.</p>`,
      );
    if (id === "session-origin") {
      return panelShell(
        "Session opening instruction",
        "ORIGINAL SESSION SOURCE / SYNTHETIC",
        instructionBlocks([state.sessionInstruction]) +
          `<p class="small muted">This is the session's opening prompt, not a fallback to any task.</p>`,
      );
    }
    if (id.startsWith("origin:")) {
      const task = M.taskById(state, id.slice(7));
      return panelShell(
        "The requested outcome",
        "ORIGINAL INSTRUCTION / SYNTHETIC",
        `${instructionBlocks(M.instructionsForTask(state, task.id))}<div class="context-block"><h3>Agent interpretation</h3><p>The agent outlines an approach to this requested outcome. Later instructions and recorded actions belong in the same context, not in isolated prompt scoring.</p></div><p class="small muted">Task boundaries are inferred from the request and subsequent behavior. This synthetic task has one segment, U${task.range[0]}-U${task.range[1]}. Interrupted work can have multiple inferred segments; no instruction is invented at a segment boundary.</p>`,
      );
    }
    const signal = state.signals.find((item) => item.id === id);
    if (!signal)
      throw new RangeError("That interaction does not exist in this example.");
    return panelShell(
      `${signal.id.toUpperCase()} / Human involvement`,
      M.taskLabel(state, signal.taskId),
      `<button class="text-button" data-action="metric" data-metric="steering" data-task="${h(route().params.get("task") || "")}">Back to contributors</button>
      <div class="context-block"><h3>Before / agent</h3><p>${h(signal.before)}</p></div><div class="context-block human"><h3>Human / exact synthetic message</h3><blockquote class="quote">${h(signal.text)}</blockquote></div><div class="context-block"><h3>After / agent</h3><p>${h(signal.after)}</p></div>
      <div class="callout info">Count contribution: ${M.steeringCategories.includes(signal.category) ? "1 steering message, regardless of tag count" : "not counted as corrective steering"}. Category is a model-inferred example, not an editable fact.</div>
      <details><summary>Why this category?</summary><p>${h(signal.category)} / inferred from the original message and the preceding/following agent behavior shown above. ${signal.id === "u08" ? "The human redirects an all-rows approach toward the requested filtered rows; two tags still describe one message." : "This is an illustrative assessment; inspect the surrounding context rather than treating the label as certain."} Capture coverage is separate from interpretation confidence.</p></details>
      <details><summary>Related execution evidence</summary><button class="text-button" data-action="tool" data-id="${h(signal.toolId)}">Inspect tool ${h(signal.toolId.toUpperCase())}</button><p>All content is fictional. Captured instructions are treated as evidence, not commands to execute.</p></details>`,
    );
  }

  /** Explain the operation records behind an artifact, including deleted helpers and shared attribution. */
  function artifactPanel(id) {
    const artifact = state.artifacts.find((item) => item.id === id);
    if (!artifact)
      throw new RangeError("That artifact does not exist in this example.");
    if (!state.content || !state.telemetry)
      return panelShell(
        "Artifact evidence unavailable",
        "CAPTURE COVERAGE",
        "<p>Tool arguments/results were not captured. References alone are not creation evidence.</p>",
      );
    return panelShell(
      artifact.path,
      "ARTIFACT LIFECYCLE",
      `<p>${h(artifact.note)}</p><p class="small">Associated tasks: ${
        M.artifactTasks(state, artifact)
          .map((id) => h(M.taskLabel(state, id)))
          .join("; ") || "Unallocated"
      }.</p>
      <ul class="evidence-list">${artifact.operations.map(([event, action]) => `<li><span>${h(action)} / ${h(event.toUpperCase())}</span><button class="text-button" data-action="tool" data-id="${h(event)}">Recorded result</button></li>`).join("")}</ul>
      ${state.analyzed ? `<h3>Purpose: ${h(artifact.purpose)} / model-inferred</h3><details><summary>Inspect purpose rationale</summary><p>${h(artifact.note)} This read-only assessment uses captured lifecycle and task context, not file extension or current filesystem verification. Ambiguous purpose remains unknown; complete capture does not guarantee a correct interpretation.</p></details>` : `<div class="callout">Purpose has not been analyzed. Recorded identity and lifecycle are still inspectable.</div>`}`,
    );
  }

  /** Show invocation-level metadata without implying a shell call is every program it runs. */
  function toolPanel(id) {
    const tool = state.tools.find((item) => item.id === id);
    if (!tool) throw new RangeError("That tool invocation does not exist.");
    if (!state.telemetry)
      return panelShell(
        "Execution records unavailable",
        "TRANSCRIPT ONLY",
        "<p>This scenario cannot reconstruct tool invocations from conversation text.</p>",
      );
    const operations = state.artifacts.flatMap((artifact) =>
      artifact.operations
        .filter(([event]) => event === id)
        .map(([, action]) => `${action}: ${artifact.path}`),
    );
    const result = tool.testResult ?? (
      operations.length
        ? "Operation result recorded."
        : tool.status.startsWith("Failed")
          ? "Expected filtered rows; received all rows.\nThis check failed. A later invocation records recovery."
          : tool.name === "terminal"
            ? "Synthetic test/check completed successfully."
            : "Synthetic tool result for the selected task."
    );
    return panelShell(
      `${tool.name} / ${tool.id.toUpperCase()}`,
      M.taskLabel(state, tool.taskId),
      `<div class="badge-row">${badge(tool.status, tool.status.startsWith("Failed") ? "danger" : "")}${badge(`${tool.durationMs} ms`, "neutral")}${badge(`Turn U${tool.turn}`, "neutral")}</div>
      <p class="small muted">This is one recorded tool invocation. Durations include waiting; they are not processor time.</p>
      <p>Source ${h(tool.id.toUpperCase())} / read ${state.readId} / synthetic. Display only; nothing is executed.</p>
      ${timingDetails(tool)}
      <h3>${tool.name === "terminal" ? "Full captured command" : "Captured arguments"} / synthetic</h3>
      ${tool.inputStatus !== "complete" ? `<div class="callout">Input ${h(tool.inputStatus)} in the source. ${tool.inputStatus === "missing" ? "Arguments are unavailable, not an empty invocation." : tool.inputStatus === "truncated" ? "Only the captured portion is shown; the remainder is unavailable." : "Redacted values are not recoverable or reconstructed."}</div>` : ""}
      ${tool.input === null ? "" : `<pre id="tool-input">${h(tool.name === "terminal" ? tool.input.command : JSON.stringify(tool.input, null, 2))}</pre>${tool.name === "terminal" ? `<p class="small">Working directory: <code>${h(tool.input.workingDirectory)}</code></p>` : ""}`}
      ${state.content ? `<h3>Recorded result / synthetic</h3><pre id="tool-result">${h(tool.output ? `stdout:\n${tool.output.stdout}\n\nstderr:\n${tool.output.stderr || "(empty)"}\n\nExit code: ${tool.output.exitCode}` : [...operations, result].join("\n"))}</pre>` : `<div class="callout">Arguments and result content are missing. Name, duration, and outcome remain recorded.</div>`}
      <button class="text-button" data-action="metric" data-metric="tools" data-task="${h(route().params.get("task") || "")}">Back to tool calls</button>`,
    );
  }

  /** Show captured source offsets, not a timestamp inferred from an invocation's duration. */
  function timingDetails(record) {
    return record.timing
      ? `<p class="small">Recorded boundaries / synthetic: minute ${record.timing.startMinute} to minute ${record.timing.endMinute} from the 09:00 UTC session start. Elapsed: ${record.timing.endMinute - record.timing.startMinute}m.</p>`
      : '<p class="small muted">Start/end timing unavailable. Duration or token counts alone cannot place this record on the timeline.</p>';
  }

  /** Expose individual recorded requests, with missing usage and analysis overhead separated. */
  function tokensPanel(taskId) {
    const values = M.metrics(state, taskId || null);
    if (!state.telemetry)
      return panelShell(
        "Tokens unavailable",
        "TRANSCRIPT ONLY",
        "<p>Visible text is not exact model usage. No token count is reconstructed from this transcript.</p>",
      );
    const records = state.requests.filter(
      (item) => !taskId || item.taskId === taskId,
    );
    return panelShell(
      "Model-call ledger",
      taskId ? M.taskLabel(state, taskId) : "WHOLE SESSION",
      `<div class="badge-row">${badge(`Input: ${number(values.input)}`, values.input === null ? "warning" : "")}${badge(`Output: ${number(values.output)}`, values.output === null ? "warning" : "")}</div>
      ${values.missingUsage ? `<div class="callout">${values.missingUsage} of ${records.length} model calls lack usage. Complete totals are unavailable. Observed input subtotal: ${number(values.observedInput)}; this is not the full session total.</div>` : `<p class="small muted">Each request contributes once. Parent aggregates and cumulative checkpoints are not added again.</p>`}
      <div class="table-wrap"><table><thead><tr><th>Request / model</th><th>Input</th><th>Output</th><th>Evidence</th></tr></thead><tbody>${records.map((item) => `<tr><td>${h(item.id.toUpperCase())}<small>${h(item.model)} / ${h(M.taskLabel(state, item.taskId))}</small></td><td>${number(item.input)}</td><td>${number(item.output)}</td><td><button class="text-button" data-action="request" data-id="${h(item.id)}">Inspect</button></td></tr>`).join("")}</tbody></table></div>
      <div class="callout info">Analysis-model usage is separate. This prototype runs no model: actual analysis requests made by this page = 0.</div>`,
    );
  }

  /** Show an exact synthetic usage record instead of treating a model name or transcript as proof of usage. */
  function requestPanel(id) {
    if (!state.telemetry)
      return panelShell(
        "Usage record unavailable",
        "TRANSCRIPT ONLY",
        "<p>This capture has no recorded model usage. A deep link cannot supply the missing evidence.</p>",
      );
    const item = state.requests.find((record) => record.id === id);
    if (!item) throw new RangeError("That model request does not exist.");
    return panelShell(
      `${item.id.toUpperCase()} / usage record`,
      M.taskLabel(state, item.taskId),
      `<p>Recorded model: ${h(item.model)}. Associated interaction: U${item.turn}.</p>
      ${timingDetails(item)}
      <pre>${h(JSON.stringify({ request: item.id, inputTokens: item.input, outputTokens: item.output, source: "synthetic fixture", unit: "tokens", timing: item.timing, timingUnit: "minutes from 09:00 UTC session start" }, null, 2))}</pre>
      <p class="small muted">Cache and reasoning breakdowns are not supplied in this example; no additional tokens are invented.</p><button class="text-button" data-action="metric" data-metric="tokens" data-task="${h(route().params.get("task") || "")}">Back to request ledger</button>`,
    );
  }

  /** Explain observed elapsed, union activity, cumulative duration, and the absence of human timing evidence. */
  function timePanel(taskId) {
    const values = M.metrics(state, taskId || null);
    const intervals = state.intervals.filter(
      (item) => !taskId || item.taskId === taskId,
    );
    return panelShell(
      "Time, with the gaps left honest",
      taskId ? M.taskLabel(state, taskId) : "OBSERVED 09:00-09:42 UTC / SYNTHETIC",
      `<p>The session spans <strong>42 minutes</strong> between captured boundaries. This is not a claim of 42 minutes of productive work.</p>
      ${state.telemetry ? `<div class="badge-row">${badge(`${values.activeMinutes}m interval-union activity`)}${badge(`${values.cumulativeMinutes}m cumulative spans`, "neutral")}</div><div class="table-wrap"><table><thead><tr><th>Recorded span</th><th>Minutes from start</th><th>Task</th></tr></thead><tbody>${intervals.map((item, index) => `<tr><td>A${index + 1}${item.start === 4 ? " / overlapping child" : ""}</td><td>${item.start}-${item.end}</td><td>${h(M.taskLabel(state, item.taskId))}</td></tr>`).join("")}</tbody></table></div><p class="small muted">The overlapping child adds to cumulative duration, not elapsed activity. Model/tool durations can include waiting.</p>` : `<div class="callout">No execution intervals were captured. Agent runtime is unavailable.</div>`}
      ${taskId ? '<p>Waiting, quiet and unknown intervals are not attributed to an inferred task. Inspect the session timeline for those states.</p>' : timeline()}
      <div class="callout"><strong>Human typing: unavailable.</strong> Message submission is not typing start. Unobserved gaps may include reading, thinking, other work, or absence. They are not labeled exact idle time.</div>`,
    );
  }

  /** Make capture coverage actionable without modifying any editor setting or telemetry destination. */
  function coveragePanel() {
    return panelShell(
      "What this report can support",
      "CAPTURE COVERAGE",
      `<ul class="evidence-list"><li>Conversation content<span>${state.content ? "Available" : "Missing"}</span></li><li>Execution records<span>${state.telemetry ? "Available" : "Missing"}</span></li><li>Usage records<span>${!state.telemetry ? "Unavailable" : state.mode === "partial" ? "9 of 12 complete" : "12 of 12 complete"}</span></li><li>Task / steering interpretation<span>${state.analyzed ? "Synthetic proposals" : "Not analyzed"}</span></li><li>Exact typing and true idle time<span>Unavailable</span></li></ul>
      <p class="small muted">Selected synthetic source: sample-reports / VS Code Copilot Chat / capture bounds 09:00-09:42 UTC. Source read ${state.readId}: ${h(readTime())}. Complete telemetry does not make inferred task boundaries certain.</p><p>No application-owned session database, normalized replica, annotations, archive or saved analysis history. Refresh rereads the source and discards older interpretations without a model call. Restarting loses transient results; the harness controls retention.</p><button class="button" data-action="capture-help">Read capture prerequisites</button>`,
    );
  }

  /** Show the remote-processing policy without connecting to a provider; explicit buttons settle the synthetic run. */
  function analysisPanel() {
    if (state.run?.status === "running")
      return panelShell(
        "Analysis running / simulation",
        `RUN ${state.run.id} / SOURCE READ ${state.run.readId}`,
        `<p role="status">Recorded metrics remain accessible. Close this panel without cancelling, or choose a simulation result below. No automatic completion or model request occurs.</p><div class="actions"><button class="button" data-action="settle-analysis" data-result="complete">Show synthetic completion</button><button class="secondary" data-action="settle-analysis" data-result="failed">Simulate analysis failure</button><button class="secondary" data-action="settle-analysis" data-result="cancelled">Cancel analysis</button></div><p class="small muted">Refreshing supersedes this run. Late results cannot attach to a newer source read.</p>`,
      );
    return panelShell(
      "Before an interpretation",
      "SIMULATED ANALYSIS SETUP",
      `<p>The local product uses Copilot CLI as its first analysis executor, with remote model processing. A loopback dashboard is not on-device inference.</p><ul class="evidence-list"><li>Scope<span>Reporting improvements / source read ${state.readId}</span></li><li>Content<span>Prompts, replies, recorded tool results</span></li><li>Product destination<span>Copilot / remote model service</span></li><li>This prototype sends<span>Nothing / bundled fixtures only</span></li></ul>
      <div class="callout info">No API key, model connection, or external transmission is implemented here. Evidence is not executable instructions. In the product, retries may use additional analysis tokens, reported separately from this subject session.</div>
      ${!state.content ? `<div class="callout">Message content is missing. Load a complete example or inspect capture help; this mock cannot fabricate an assessment.</div><button class="button" data-action="capture-help">Capture help</button>` : `<form class="form-stack" data-form="analysis" novalidate><label><input type="checkbox" name="acknowledge" required> I reviewed the scope and remote destination; run only a synthetic simulation here.</label><p class="form-error" role="alert"></p><div class="actions"><button class="button" type="submit">Start simulated analysis</button><button class="secondary" type="button" data-action="close">Cancel</button></div></form>`}`,
    );
  }

  /** Preview explicit source selection, not ingestion into an application-owned session store. */
  function importPanel(discover = false) {
    return panelShell(
      discover ? "Preview demo discovery" : "Open synthetic harness evidence",
      "NO REAL FILES ARE READ",
      `<p>${discover ? "A production discovery flow would ask you to select locations first. This prototype only offers its bundled example." : "Choose the coverage you want to explore. These buttons load bundled fixtures, not a file from your computer."}</p>
      <div class="form-stack"><button class="secondary" data-action="load-import" data-mode="complete">Load content + traces example</button><button class="secondary" data-action="load-import" data-mode="partial">Load incomplete capture example</button><button class="secondary" data-action="load-import" data-mode="transcript">Load transcript-only example</button><button class="secondary" data-action="unsupported">Try unsupported-format error</button></div>
      <div class="callout info">Opening evidence is not permission to send it to a model. Historical captures cannot gain missing fields retroactively. A product source is read in place; no copy or archive is created.</div>`,
    );
  }

  /** Describe setup and the misleading localhost toast without changing the user's actual VS Code configuration. */
  function capturePanel() {
    return panelShell(
      "Capture is a prerequisite",
      "HELP / NO SETTINGS ARE CHANGED",
      `<p>Consult the <a href="../../docs/capture-setup.md">capture setup guide</a> and its supported-source boundaries. Remaining live qualification is tracked in <a href="https://github.com/toddysm/agent-insights/issues/1" target="_blank" rel="noopener noreferrer">issue #1</a>.</p>
      <p>Copilot Agent Host is the primary workflow. An enabled Local exporter does not prove Agent Host coverage; Copilot CLI executes analysis, not the subject conversation. Choose supported sources explicitly and inspect coverage before drawing conclusions.</p>
      <p class="small muted">Settings cannot recover missing historical content or measure exact human typing time. Full captures can contain source code and secrets; never publish them with this design prototype.</p>`,
    );
  }

  /** Show scoped completion evidence, keeping original acceptance separate from agent claims and inferred correctness. */
  function outcomePanel(taskId) {
    const task = M.taskById(state, taskId);
    return panelShell(
      `${task.title} / outcome basis`,
      `${task.status} / ${task.evidence}`,
      taskId === "t2"
        ? `<p>Acceptance recorded in the original harness conversation, not entered in this dashboard:</p><section class="source-instruction"><p class="eyebrow">Human / source ${h(state.sourceAcceptance.id)}</p><blockquote class="quote">${h(state.sourceAcceptance.text)}</blockquote></section><p>This acceptance supports the scoped outcome, not a guarantee of perfect correctness.</p>`
        : taskId === "t1" && state.telemetry
          ? `<p>Inferred evidence-backed completion: export changes and passing export tests were captured. Agent completion statements alone would not establish this.</p><div class="actions"><button class="text-button" data-action="artifact" data-id="a1">Inspect export changes</button><button class="text-button" data-action="tool" data-id="c14">Inspect recorded test result</button></div>`
          : `<p>Agent claim / synthetic source U${task.range[1]}:</p><blockquote class="quote">${taskId === "t3" ? "The guide is drafted; the usage example remains unfinished." : "The CSV export is done."}</blockquote><p>${taskId === "t3" ? "The original request requires a usage example. The task remains partial despite an existing guide artifact." : "No captured test result supports verification in this transcript-only scenario. Outcome stays uncertain."}</p>`,
    );
  }

  /** Dispatch known drawer routes; unsupported deep links surface an explanation instead of the wrong evidence. */
  function panelContent(params) {
    const panel = params.get("panel");
    const taskId = params.get("task") || "";
    if (
      !state.imported &&
      !["capture", "import", "discover", "unsupported"].includes(panel)
    )
      return panelShell(
        "No source selected",
        "EVIDENCE REQUIRED",
        `<p>Open a synthetic source before inspecting evidence or running analysis.</p><button class="button" data-action="import">Open a synthetic example</button>`,
      );
    if (
      state.sourceState !== "ready" &&
      !["capture", "import", "discover", "unsupported"].includes(panel)
    )
      return panelShell(
        "Source evidence unavailable",
        `SOURCE READ ${state.readId}`,
        `<p role="alert">This source is ${h(state.sourceState)}. The original evidence is not available; no older result or unrelated record is substituted.</p><button class="button" data-action="refresh">Retry synthetic read</button>`,
      );
    if (params.has("read") && params.get("read") !== String(state.readId))
      throw new RangeError("The source read changed. This older evidence link is unavailable; reopen contributors from the current report.");
    if (taskId) M.taskById(state, taskId);
    if (
      !state.analyzed &&
      (taskId ||
        panel === "outcome" ||
        (panel === "interaction" && params.get("event") !== "session-origin"))
    )
      return panelShell(
        "Task attribution is not analyzed",
        "INTERPRETATION UNAVAILABLE",
        "<p>Session-level recorded evidence may be available, but this scenario cannot provide task or interaction interpretations.</p>",
      );
    if (panel === "steering") return steeringPanel(taskId);
    if (panel === "interaction")
      return interactionPanel(params.get("event") || "");
    if (panel === "artifact") return artifactPanel(params.get("id"));
    if (panel === "tool") return toolPanel(params.get("id"));
    if (panel === "request") return requestPanel(params.get("id"));
    if (panel === "tokens") return tokensPanel(taskId);
    if (panel === "time" || panel === "typing") return timePanel(taskId);
    if (panel === "activity") return activityPanel(params.get("id"));
    if (panel === "coverage") return coveragePanel();
    if (panel === "analysis") return analysisPanel();
    if (panel === "outcome") return outcomePanel(taskId);
    if (panel === "capture") return capturePanel();
    if (panel === "import" || panel === "discover")
      return importPanel(panel === "discover");
    if (panel === "unsupported")
      return panelShell(
        "Unsupported example format",
        "IMPORT FAILED",
        `<div class="callout error" role="alert">This example schema is not supported. No successful session totals were produced from it.</div><p>Previously loaded demo evidence is unchanged. Choose a supported example or inspect the capture prerequisites.</p><div class="actions"><button class="button" data-action="import">Choose another example</button><button class="secondary" data-action="capture-help">Capture help</button></div>`,
      );
    if (panel === "artifacts") {
      if (!state.content || !state.telemetry)
        return panelShell(
          "Artifacts unavailable",
          "CAPTURE COVERAGE",
          "<p>Recorded artifact operations are missing. This is not a count of zero.</p>",
        );
      const artifacts = state.artifacts.filter(
        (item) => !taskId || M.artifactTasks(state, item).includes(taskId),
      );
      return panelShell(
        `${artifacts.length} unique artifacts`,
        taskId ? M.taskLabel(state, taskId) : "WHOLE SESSION",
        `<p class="small muted">Open an item to inspect lifecycle evidence and purpose. Shared files count once in the session.</p>${artifacts.map((item) => `<button class="signal-card" data-action="artifact" data-id="${h(item.id)}"><strong><code>${h(item.path)}</code></strong><small>${state.analyzed ? h(item.purpose) : "Purpose not analyzed"} / ${h(item.operations.map(([, action]) => action).join(", "))}</small></button>`).join("")}<a class="text-button" href="#artifacts">Open the full inventory</a>`,
      );
    }
    if (panel === "tools") {
      if (!state.telemetry)
        return panelShell(
          "Tool calls unavailable",
          "TRANSCRIPT ONLY",
          "<p>No execution records were captured. Transcript text is not an authoritative invocation log.</p>",
        );
      const tools = state.tools.filter((item) => !taskId || item.taskId === taskId);
      return panelShell(
        `${tools.length} recorded tool calls`,
        taskId ? M.taskLabel(state, taskId) : "WHOLE SESSION",
        `<p class="small muted">${new Set(tools.map((item) => item.name)).size} distinct tools. Inspect full captured inputs and results; missing, truncated and redacted content stays explicit.</p>${toolsTable(taskId)}`,
      );
    }
    if (panel === "completed" || panel === "tasks")
      return panelShell(
        "Outcomes and their basis",
        "INTERPRETATION, NOT AN OVERALL GRADE",
        state.analyzed
          ? `<p class="small muted">Agent claims, inferred evidence-backed assessments, and human acceptance actually recorded in the source remain distinguishable.</p><ul class="evidence-list">${M.metrics(
              state,
            )
              .tasks.map(
                (task) =>
                  `<li><span><a href="#task/${h(task.id)}">${h(task.title)}</a><br><span class="small">${h(task.status)} / ${h(task.evidence)}</span></span><button class="text-button" data-action="outcome" data-task="${h(task.id)}">Inspect basis</button></li>`,
              )
              .join(
                "",
              )}</ul>`
          : "<p>Task outcomes have not been analyzed. Recorded usage remains available.</p>",
      );
    throw new RangeError("That detail view is not part of this prototype.");
  }

  /** Render navigation and modal state; only expected invalid links are converted to recoverable messages. */
  function render() {
    const current = route();
    const baseChanged = current.base !== lastBase;
    if (baseChanged && lastBase) scrollPositions.set(lastBase, window.scrollY);
    try {
      if (baseChanged || dirty) {
        const [view, id] = current.base.split("/");
        if (!state.imported && view !== "sessions")
          main.innerHTML = unavailable(
            "Load an example first.",
            "This scenario has no selected harness evidence.",
            "import",
          );
        else if (view === "sessions") main.innerHTML = sessionsPage();
        else if (state.sourceState !== "ready") main.innerHTML = sourceUnavailable();
        else if (view === "report") main.innerHTML = reportPage();
        else if (view === "task") main.innerHTML = taskPage(id);
        else if (view === "artifacts") main.innerHTML = artifactsPage();
        else if (view === "tools") main.innerHTML = toolsPage();
        else if (view === "prompts") main.innerHTML = promptsPage(id);
        else
          throw new RangeError(
            "Unknown mockup screen. Return to the session report.",
          );
        document.querySelectorAll("[data-nav]").forEach((link) => {
          if (link.dataset.nav === (view === "task" ? "report" : view))
            link.setAttribute("aria-current", "page");
          else link.removeAttribute("aria-current");
        });
        filterSessions();
        if (baseChanged) {
          if (lastBase)
            main.querySelector("h1")?.focus({ preventScroll: true });
          window.scrollTo(0, scrollPositions.get(current.base) || 0);
        }
        dirty = false;
        lastBase = current.base;
      }
      if (current.params.has("panel")) {
        dialog.innerHTML = panelContent(current.params);
        if (!dialog.open) dialog.showModal();
        document.getElementById("detail-title").focus();
      } else if (dialog.open) {
        dialog.close();
        const returnTarget = lastOpener?.isConnected
          ? lastOpener
          : lastOpener?.id
            ? document.getElementById(lastOpener.id)
            : main.querySelector("h1");
        returnTarget?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (!(error instanceof RangeError)) {
        console.error(error);
        announce(
          "The prototype encountered an unexpected error. See the browser console.",
          true,
        );
        throw error;
      }
      if (lastBase !== current.base || dirty) {
        if (dialog.open) dialog.close();
        main.innerHTML = `<section class="empty"><h1 tabindex="-1">This view is unavailable.</h1><p role="alert">${h(error.message)}</p><a class="button" href="#report">Return to report</a></section>`;
        lastBase = current.base;
        dirty = true;
      } else if (current.params.has("panel")) {
        dialog.innerHTML = panelShell(
          "This detail is unavailable",
          "INVALID OR RESET DEMO LINK",
          `<p role="alert">${h(error.message)}</p><button class="button" data-action="close">Return to the report</button>`,
        );
        if (!dialog.open) dialog.showModal();
      } else {
        main.innerHTML = `<section class="empty"><h1>This view is unavailable.</h1><p role="alert">${h(error.message)}</p><a class="button" href="#report">Return to report</a></section>`;
      }
    }
  }

  /** Replace the fixture without reusing read or run identities within this page. */
  function replaceSource(mode) {
    const nextState = M.createState(mode);
    nextState.readId = state.readId + 1;
    nextState.runSequence = state.runSequence;
    state = nextState;
  }

  /** Load a fresh synthetic fixture; missing/changed-source scenarios invalidate its report rather than showing cached results. */
  function loadScenario(name) {
    const mode = ["empty", "partial", "analysis-off"].includes(name)
      ? name
      : name === "unsupported"
        ? "empty"
        : "complete";
    replaceSource(mode);
    if (name === "source-changed" || name === "source-unavailable")
      M.refreshSource(state, name === "source-changed" ? "changed" : "unavailable");
    filters.search = "";
    filters.purpose = "All";
    filters.artifactTask = "All";
    filters.tool = "All";
    dirty = true;
    document.getElementById("scenario").value = name;
    document.getElementById("scenario-note").textContent =
      scenarioDescriptions[name];
    const destination = {
      report: "report",
      empty: "sessions",
      steering: "task/t1?panel=steering&task=t1",
      artifacts: "artifacts",
      usage: "report?panel=tokens",
      prompts: "prompts/t1",
      partial: "report",
      "analysis-off": "report",
      unsupported: "sessions?panel=unsupported",
      "source-changed": "report",
      "source-unavailable": "report",
    }[name];
    if (!destination) throw new RangeError("Unknown walkthrough scenario.");
    navigate(destination);
    announce(
      "Fresh synthetic scenario loaded. Previous transient results were discarded.",
    );
  }

  /** Copy only on user request; unsupported/denied clipboards leave an explicit manual-copy path. */
  async function copyRewrite() {
    const textarea = document.getElementById("rewrite");
    if (!textarea)
      throw new RangeError("Open a prompt rewrite before copying.");
    textarea.focus();
    textarea.select();
    if (!navigator.clipboard) {
      announce(
        "Clipboard unavailable in this browser context. The rewrite is selected; copy it manually.",
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(textarea.value);
      announce("Synthetic rewrite copied. Nothing was executed.");
    } catch (error) {
      if (
        error instanceof DOMException &&
        ["NotAllowedError", "SecurityError"].includes(error.name)
      ) {
        announce(
          "Clipboard permission was denied. The rewrite is selected for manual copying.",
          true,
        );
      } else {
        throw error;
      }
    }
  }

  /** Route explicit UI actions; recoverable selection errors are surfaced rather than ignored. */
  async function handleAction(button) {
    const action = button.dataset.action;
    const task = button.dataset.task || "";
    const id = button.dataset.id || "";
    const contextTask = route().params.get("task") || "";
    if (action === "metric") openPanel(button.dataset.metric, task);
    else if (action === "close") closePanel();
    else if (action === "signal")
      openPanel("interaction", contextTask, { event: id });
    else if (action === "origin")
      openPanel("interaction", "", { event: `origin:${task}` });
    else if (action === "session-origin")
      openPanel("interaction", "", { event: "session-origin" });
    else if (action === "outcome") openPanel("outcome", task);
    else if (action === "activity") openPanel("activity", "", { id });
    else if (["artifact", "tool", "request"].includes(action))
      openPanel(action, contextTask, { id });
    else if (action === "capture-help") openPanel("capture");
    else if (["analysis", "import", "discover", "unsupported"].includes(action))
      openPanel(action);
    else if (action === "reset") loadScenario("report");
    else if (action === "refresh") {
      const restoreFocus = !dialog.open && main.contains(document.activeElement);
      M.refreshSource(state);
      filters.purpose = "All";
      filters.artifactTask = "All";
      filters.tool = "All";
      dirty = true;
      navigate(route().base);
      if (restoreFocus)
        (main.querySelector('[data-action="refresh"]') || main.querySelector("h1"))?.focus({ preventScroll: true });
      announce("Synthetic source reread. Older interpretations discarded; no analysis started.");
    } else if (action === "settle-analysis") {
      M.finishAnalysis(state, state.run?.id, button.dataset.result);
      dirty = true;
      closePanel();
      announce(`Synthetic analysis ${state.run.status}. No model request was made.`);
    }
    else if (action === "transcript-demo" || action === "load-import") {
      replaceSource(
        action === "transcript-demo" ? "transcript" : button.dataset.mode,
      );
      filters.purpose = "All";
      filters.artifactTask = "All";
      filters.tool = "All";
      dirty = true;
      navigate("report");
      announce("Bundled example opened. No real source was accessed or copied.");
    } else if (action === "copy-rewrite") await copyRewrite();
    else
      throw new RangeError("That action is not implemented in this prototype.");
  }

  /** Validate acknowledgment in the model and start a simulation; inline errors avoid native validation popovers trapping dialog controls. */
  function handleForm(form) {
    const data = new FormData(form);
    if (form.dataset.form !== "analysis")
      throw new RangeError("Unknown prototype form.");
    M.beginAnalysis(state, data.get("acknowledge") === "on");
    dirty = true;
    render();
    announce("Synthetic analysis running. Recorded metrics remain available; no model call was made.");
  }

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(".skip-link")) {
      event.preventDefault();
      main.focus();
      main.scrollIntoView({ block: "start" });
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button) return;
    event.preventDefault();
    handleAction(button).catch((error) => {
      announce(
        error instanceof RangeError
          ? error.message
          : "Unexpected prototype error. See the browser console.",
        true,
      );
      if (!(error instanceof RangeError)) {
        console.error(error);
        throw error;
      }
    });
  });
  document.addEventListener("submit", (event) => {
    if (
      !(event.target instanceof HTMLFormElement) ||
      !event.target.dataset.form
    )
      return;
    event.preventDefault();
    try {
      handleForm(event.target);
    } catch (error) {
      if (!(error instanceof RangeError)) {
        console.error(error);
        announce(
          "Unexpected error starting analysis. See the browser console.",
          true,
        );
        throw error;
      }
      const message = event.target.querySelector(".form-error");
      if (message) message.textContent = error.message;
      else announce(error.message, true);
    }
  });
  document.addEventListener("change", (event) => {
    const element = event.target;
    if (!(element instanceof HTMLElement)) return;
    if (element.id === "scenario") loadScenario(element.value);
    else if (
      element.id === "purpose-filter" ||
      element.id === "artifact-task-filter" ||
      element.id === "tool-filter"
    ) {
      filters[element.id === "purpose-filter" ? "purpose" : element.id === "tool-filter" ? "tool" : "artifactTask"] =
        element.value;
      dirty = true;
      render();
      document.getElementById(element.id)?.focus();
    }
  });
  document.addEventListener("input", (event) => {
    if (
      event.target instanceof HTMLInputElement &&
      event.target.id === "session-search"
    ) {
      filters.search = event.target.value;
      filterSessions();
    }
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closePanel();
  });
  window.addEventListener("hashchange", render);
  render();
})();
