/** Render the synthetic walkthrough using local assets, hash navigation, and in-memory edits only. */
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
  let selectedTasks = new Set();
  const filters = { search: "", purpose: "All", artifactTask: "All" };
  let noticeTimer;
  const scenarioDescriptions = {
    report: "Start with outcomes. Every metric leads to its evidence.",
    empty:
      "Import a synthetic example. No file picker or real session access is used.",
    steering:
      "Follow a count to a message, inspect its context, then correct its classification.",
    artifacts:
      "Separate unique outputs from repeated operations and temporary helpers.",
    usage:
      "Inspect model-call usage and the difference between elapsed and cumulative activity.",
    prompts:
      "Review a prompt in its original context and inspect a suggested rewrite.",
    review:
      "Try a rename, merge, split, or boundary adjustment. Source totals are preserved.",
    partial:
      "Notice what stays useful when content and some token usage are missing.",
    "analysis-off":
      "Recorded metrics remain available before model-based interpretation.",
    unsupported:
      "An unsupported example must produce an explicit error, not empty success.",
  };

  /** Escape every dynamic text/attribute value, including names entered in correction forms. */
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
    const params = new URLSearchParams({ panel, ...extras });
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
    return `<button class="metric" id="metric-${h(key)}-${h(taskId || "session")}" data-action="metric" data-metric="${h(key)}" data-task="${h(taskId)}" aria-label="Inspect ${h(label)}${taskId ? " for this task" : ""}">
      <span class="metric-arrow" aria-hidden="true">+</span><span class="metric-label">${h(label)}</span>
      <span class="metric-value ${small || value === null ? "word" : ""}">${h(value === null ? "Unavailable" : value)}</span>
      <span class="metric-note">${h(note)}</span></button>`;
  }

  /** Table counts use the same drill-down behavior and counting contract as report cards. */
  function countLink(value, key, taskId) {
    return `<button class="count-button" id="row-${h(key)}-${h(taskId)}" data-action="metric" data-metric="${h(key)}" data-task="${h(taskId)}" aria-label="Inspect ${h(key)} for ${h(M.taskById(state, taskId).title)}">${h(number(value))}</button>`;
  }

  /** Describe incomplete evidence and edited interpretations without overwriting available metrics. */
  function coverageNotice() {
    let markup = "";
    if (!state.content)
      markup += `<div class="callout"><strong>Partial capture.</strong> Message content is missing, and 3 of 12 model calls lack usage. Timing and tool counts remain available. <button class="text-button" data-action="metric" data-metric="coverage">Inspect coverage</button></div>`;
    if (!state.telemetry)
      markup += `<div class="callout"><strong>Transcript only.</strong> Tool activity, token totals, and artifact operations were not captured. Completion claims are not tool-verified.</div>`;
    if (state.analysisStale)
      markup += `<div class="callout info"><strong>Interpretations changed.</strong> Recorded totals are preserved; affected prompt assessments need refresh. No model call ran. <span class="badge neutral">Edit revision ${state.revision}</span></div>`;
    return markup;
  }

  /** Offer a useful path forward when synthetic content or analysis is unavailable. */
  function unavailable(title, explanation, action = "analysis") {
    const label =
      action === "analysis"
        ? "Review analysis setup"
        : action === "import"
          ? "Import a synthetic example"
          : "Open capture help";
    return `<section class="empty"><div class="empty-symbol" aria-hidden="true">...</div><h2>${h(title)}</h2><p class="muted">${h(explanation)}</p>
      <div class="actions"><button class="button" data-action="${h(action)}">${label}</button><a class="secondary" href="#report">Back to recorded metrics</a></div></section>`;
  }

  /** Show an opt-in synthetic import surface; it never reads files or scans the user's computer. */
  function sessionsPage() {
    const intro = heading(
      "Your sessions",
      "THE STARTING POINT",
      "Choose a conversation. Understand the work behind it.",
      `<button class="button" data-action="import">Import demo evidence</button><button class="secondary" data-action="discover">Find demo sessions</button>`,
    );
    if (!state.imported)
      return (
        intro +
        `<section class="empty"><div class="empty-symbol" aria-hidden="true">01</div><h2>A report starts with evidence.</h2><p class="muted">No sessions are imported in this scenario. Try the sample import, or inspect the capture prerequisites.</p><div class="actions"><button class="button" data-action="import">Import a synthetic example</button><button class="secondary" data-action="capture-help">Capture prerequisites</button></div><p class="small muted">This prototype does not open a file picker, scan directories, or read real conversations.</p></section>`
      );
    return (
      intro +
      `<div class="filter-bar"><label>Search sessions<input id="session-search" type="search" value="${h(filters.search)}" placeholder="Session or project"></label></div>
      <div class="table-wrap"><table><thead><tr><th>Session</th><th>Project</th><th>Source</th><th>Evidence</th><th></th></tr></thead><tbody>
      <tr data-search="reporting improvements sample-reports"><td><a class="task-link" href="#report">Reporting improvements</a><small>Observed 09:00-09:42 / synthetic local time</small></td><td>sample-reports</td><td>VS Code Copilot</td><td>${badge(state.content && state.telemetry ? "Content + traces" : state.content ? "Transcript only" : "Partial capture", state.mode === "complete" ? "" : "warning")}</td><td><a href="#report" aria-label="Open Reporting improvements">Open</a></td></tr>
      <tr data-search="investigate test failures sample-tools"><td><button class="text-button" data-action="transcript-demo">Investigate test failures</button><small>Alternate evidence-coverage demonstration</small></td><td>sample-tools</td><td>VS Code Copilot</td><td>${badge("Transcript only", "warning")}</td><td><button class="text-button" data-action="transcript-demo" aria-label="Open transcript-only demonstration">Open</button></td></tr>
      </tbody></table></div><p id="search-empty" class="callout" hidden>No matching demo sessions.</p>
      <p class="table-note">The second row loads a transcript-only variation of the same synthetic evidence, not a second real capture.</p>
      <div class="two-column"><section class="panel"><p class="eyebrow">YOU CHOOSE THE SCOPE</p><h3>Import is not permission to analyze.</h3><p class="small muted">Recorded metrics and source inspection are separate from model-based interpretation. The production consent flow is still a design decision.</p></section><section class="panel"><p class="eyebrow">A PRIVATE PER-USER LOCATION</p><h3>Across projects, not inside them.</h3><p class="small muted">Capture setup belongs in the user profile. The prototype only illustrates the resulting report.</p><button class="text-button" data-action="capture-help">See capture help</button></section></div>`
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
        "sample-reports / VS Code Copilot Chat / observed 09:00-09:42, local time",
        `<a class="secondary" href="#review">Review tasks</a><button class="button" data-action="analysis">Analysis setup</button>`,
      ) +
      `<div class="badge-row">${badge(state.content && state.telemetry ? "Captured content + execution" : "Limited evidence", state.mode === "complete" ? "" : "warning")}${badge(state.analyzed ? "Task interpretations: review suggested" : "Interpretations: not analyzed", "neutral")}${badge("Synthetic example", "neutral")}</div>` +
      coverageNotice() +
      `<section class="hero"><div class="hero-story"><p class="eyebrow">WHAT MOVED FORWARD</p><h2>${state.analyzed ? outcomeTitle : "Your recorded activity is ready.<br>Interpretation is a separate step."}</h2><p class="muted">${state.analyzed ? `${number(totals.steering)} messages classified as steering; ${tasks.length} active task interpretations. Inspect the work behind each number before drawing a conclusion.` : "Time and tool evidence can be useful without assigning a task or rating a prompt. Nothing here contacts a model."}</p><a class="text-button" href="${state.analyzed ? "#review" : "#report?panel=coverage"}">${state.analyzed ? "Review the task map" : "Understand this capture"} <span aria-hidden="true">+</span></a></div>
      <div class="hero-aside"><p class="eyebrow">OUTCOMES, NOT A GRADE</p><div class="hero-number">${state.analyzed ? totals.completed : "--"} <span>/ ${state.analyzed ? tasks.length : "--"} tasks</span></div><p class="small muted">Completion evidence is shown per task. An agent's claim is not the same as a verified result.</p><button class="text-button" data-action="metric" data-metric="completed">Inspect completion evidence</button></div></section>
      <div class="metrics">
      ${metric("Human steering", totals.steering, state.analyzed ? "Distinct messages / inferred categories" : "Not analyzed", "steering")}
      ${metric("Unique artifacts", totals.artifacts, totals.deliverables === null ? "Purpose assessment unavailable" : `${totals.deliverables} deliverables / ${totals.helpers} temporary helpers`, "artifacts")}
      ${metric("Tool activity", totals.toolCalls, totals.distinctTools === null ? "Execution records unavailable" : `${totals.distinctTools} distinct tools / recorded`, "tools")}
      ${metric("Model tokens", totals.input === null ? null : `${(totals.input / 1000).toFixed(1)}k / ${(totals.output / 1000).toFixed(1)}k`, "Input / output / recorded usage", "tokens")}
      </div>
      <div class="section-heading"><h2>The task story</h2><a class="text-button" href="#review">Correct an interpretation</a></div>
      ${state.analyzed ? taskTable(tasks) : `<div class="panel"><h3>Tasks have not been analyzed.</h3><p class="small muted">${state.content ? "Enable the simulated analysis to explore task interpretations. Recorded metrics above remain available." : "Message content is missing, so this example cannot support task or steering analysis."}</p><button class="text-button" data-action="${state.content ? "analysis" : "capture-help"}">${state.content ? "Review analysis setup" : "Inspect capture prerequisites"}</button></div>`}
      <div class="two-column"><section class="panel"><div class="section-heading"><div><p class="eyebrow">42 MINUTES OBSERVED</p><h3>Activity is not the whole story.</h3></div><button class="text-button" data-action="metric" data-metric="time">Inspect time</button></div>
      ${timeline()}<div class="legend"><span><i></i>${state.telemetry ? `${totals.activeMinutes}m recorded agent activity` : "Agent activity unavailable"}</span><span><i class="gap"></i>${state.telemetry ? "24m unobserved gaps" : "No execution trace"}</span></div>
      <p class="small muted">Gaps may include thinking, reviewing, or being away. <button class="text-button" data-action="metric" data-metric="typing">Human typing: unavailable</button></p></section>
      <section class="panel"><p class="eyebrow">A BETTER NEXT INSTRUCTION</p><h3>What would you ask differently?</h3><p class="small muted">Review the initial prompt and each task prompt in context. Ratings are model judgments; suggestions are grounded in visible evidence.</p><a class="button" href="#prompts">Explore prompt coaching</a><p class="small muted">No overall productivity score. No invented time saved.</p></section></div>`
    );
  }

  /** Keep task associations distinct from session-unique totals in the primary navigation table. */
  function taskTable(tasks) {
    return `<div class="table-wrap"><table><thead><tr><th>Requested outcome</th><th>Status &amp; basis</th><th>Steering</th><th>Artifacts</th><th>In / out tokens</th></tr></thead><tbody>${tasks
      .map((task) => {
        const values = M.metrics(state, task.id);
        return `<tr><td><a class="task-link" href="#task/${h(task.id)}">${h(task.title)}</a><small>Turns U${task.range[0]}-U${task.range[1]} / ${task.corrected ? "user-corrected grouping" : "inferred grouping"}</small></td><td>${badge(task.status, task.status === "Completed" ? "" : "warning")}<small>${h(task.evidence)}</small></td><td>${countLink(values.steering, "steering", task.id)}</td><td>${countLink(values.artifacts, "artifacts", task.id)}</td><td>${countLink(values.input, "tokens", task.id)}<small>${number(values.output)} output</small></td></tr>`;
      })
      .join(
        "",
      )}</tbody></table></div><p class="table-note">A shared artifact can appear under more than one task, but counts once for the session. Excluded task evidence remains in session totals.</p>`;
  }

  /** Draw the exact synthetic active/gap intervals; the time drawer provides the accessible record table. */
  function timeline() {
    if (!state.telemetry)
      return `<div class="callout">No execution intervals were captured. Elapsed conversation time is not agent runtime.</div>`;
    const spans = [
      [2, false],
      [6, true],
      [4, false],
      [4, true],
      [6, false],
      [4, true],
      [4, false],
      [2, true],
      [4, false],
      [2, true],
      [4, false],
    ];
    return `<div class="timeline" role="group" aria-label="Recorded agent activity and unobserved gaps">${spans.map(([minutes, active]) => `<button class="span-${minutes} ${active ? "active" : ""}" data-action="metric" data-metric="time" aria-label="${minutes} minutes ${active ? "recorded agent activity" : "unobserved gap"}"></button>`).join("")}</div><div class="timeline-labels"><span>09:00</span><span>09:21</span><span>09:42 local time</span></div>`;
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
        `Turns U${task.range[0]}-U${task.range[1]} / ${task.excluded ? "excluded interpretation" : "active interpretation"}`,
        `<a class="secondary" href="#report">Back to report</a><a class="button" href="#review">Review this task</a>`,
      ) +
      `<div class="badge-row">${badge(task.status, task.status === "Completed" ? "" : "warning")}${badge(task.evidence, "neutral")}${badge(task.corrected ? "User-corrected grouping" : "Inferred boundaries", "neutral")}</div>` +
      coverageNotice() +
      `<div class="panel"><p class="eyebrow">REQUESTED OUTCOME</p><blockquote class="quote">${h(task.prompt)}</blockquote><button class="text-button" data-action="origin" data-task="${h(id)}">Inspect originating instruction and interpretation</button></div>
      <div class="metrics">${metric("Human steering", values.steering, "Distinct messages, not tags", "steering", id)}${metric("Artifacts", values.artifacts, "Unique within this task", "artifacts", id)}${metric("Tool calls", values.toolCalls, "Recorded invocations", "tools", id)}${metric("Input tokens", values.input, `${number(values.output)} output tokens`, "tokens", id)}</div>
      <div class="two-column"><section class="panel"><p class="eyebrow">OUTCOME BASIS</p><h2>Why this status?</h2><p class="small muted">${task.status === "Completed" ? "Inspect the evidence or confirmation behind this outcome. The label is scoped to what is captured, not a guarantee of perfect correctness." : "An artifact or an agent's statement does not prove that the requested outcome is complete."}</p><ul class="evidence-list"><li>Recorded artifacts<button class="text-button" data-action="metric" data-metric="artifacts" data-task="${h(id)}">Inspect</button></li><li>Recorded tool results<button class="text-button" data-action="metric" data-metric="tools" data-task="${h(id)}">Inspect</button></li><li>Outcome interpretation<button class="text-button" data-action="edit-one" data-op="outcome" data-task="${h(id)}">Correct outcome</button></li></ul></section><section class="panel"><p class="eyebrow">KEEP THE CONTEXT</p><h2>Learn from the instruction.</h2><p class="small muted">The task inherits earlier context. Review the prompt with that context, not as an isolated sentence.</p><a class="button" href="#prompts/${h(id)}">Review task prompt</a></section></div>`
    );
  }

  /** Filter artifact identities without losing the source-operation basis for their task associations. */
  function artifactsPage() {
    const intro = heading(
      "What the work produced",
      "ARTIFACT INVENTORY",
      "Unique outputs, recorded operations, and reviewable purpose labels.",
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
        (filters.purpose === "All" || item.purpose === filters.purpose) &&
        (filters.artifactTask === "All" ||
          M.artifactTasks(state, item).includes(filters.artifactTask)),
    );
    return (
      intro +
      coverageNotice() +
      `<div class="badge-row">${badge(`${state.artifacts.length} unique artifacts`)}${badge(state.analyzed ? "Purpose labels: reviewable" : "Purpose: not analyzed", "neutral")}${badge("Files: 6 / pull requests: 0 / issues: 0", "neutral")}</div>
      <div class="filter-bar"><div class="filter-control"><label for="purpose-filter">Purpose</label><select id="purpose-filter" ${!state.analyzed ? "disabled" : ""}>${["All", "Deliverable", "Temporary helper", "Supporting artifact", "Unknown"].map((value) => `<option ${filters.purpose === value ? "selected" : ""}>${h(value)}</option>`).join("")}</select></div><div class="filter-control"><label for="artifact-task-filter">Task</label><select id="artifact-task-filter" ${!state.analyzed ? "disabled" : ""}><option value="All">${state.analyzed ? "All tasks" : "Attribution not analyzed"}</option>${(state.analyzed ? state.tasks : []).map((task) => `<option value="${h(task.id)}" ${filters.artifactTask === task.id ? "selected" : ""}>${h(task.title)}</option>`).join("")}</select></div></div>
      <div class="table-wrap"><table><thead><tr><th>Artifact / observed action</th><th>Purpose</th><th>Associated tasks</th><th>Evidence</th></tr></thead><tbody>${
        artifacts
          .map(
            (artifact) =>
              `<tr><td><code>${h(artifact.path)}</code><small>${h(artifact.operations.map(([, action]) => action).join(", "))}</small></td><td>${state.analyzed ? badge(artifact.purpose, artifact.purpose === "Temporary helper" ? "warning" : "neutral") : "Not analyzed"}<small>${state.analyzed ? (artifact.confirmed ? "User-confirmed" : "Model-inferred") : "No model assessment"}</small></td><td>${
                M.artifactTasks(state, artifact)
                  .map((id) => h(M.taskLabel(state, id)))
                  .join("<br>") || "Unallocated"
              }</td><td><button class="text-button" data-action="artifact" data-id="${h(artifact.id)}" aria-label="Inspect ${h(artifact.path)}">Inspect</button></td></tr>`,
          )
          .join("") ||
        `<tr><td colspan="4">No artifacts match these filters.</td></tr>`
      }</tbody></table></div>
      <p class="table-note">${artifacts.length} shown. The test file is associated with two original tasks but counts once in the session. Deleted helpers remain visible.</p>
      <div class="callout info">The complete example contains six files and no recorded pull requests or issues. The production design also supports those artifact types; this prototype does not create external items.</div>`
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
    const prompt = task
      ? task.prompt
      : "Help me improve reporting in this app.";
    const isCsv = id === "t1";
    const rewrite = isCsv
      ? "Add CSV export for the currently filtered table rows, preserving their order. Include headers, use the existing CSV utility, and verify escaping in tests."
      : task
        ? `${task.prompt} Use the existing project conventions, explain any ambiguity before changing behavior, and show evidence that the requested outcome is complete.`
        : "Help me improve reporting in this app. We will work through one requested outcome at a time. Confirm each task's scope, preserve existing behavior, and show what was verified and what remains incomplete.";
    return (
      heading(
        "A better next instruction",
        "PROMPT COACHING",
        "Evidence-led suggestions, not a grade for the person.",
        `<a class="secondary" href="#report">Back to report</a>`,
      ) +
      `<nav class="tabs" aria-label="Prompt selection"><a href="#prompts" ${!id ? 'aria-current="page"' : ""}>Initial session prompt</a>${state.tasks
        .filter((item) => !item.excluded)
        .map(
          (item) =>
            `<a href="#prompts/${h(item.id)}" ${id === item.id ? 'aria-current="page"' : ""}>${h(item.title)}</a>`,
        )
        .join("")}</nav>` +
      coverageNotice() +
      `<div class="prompt-grid"><section class="panel"><p class="eyebrow">THE INSTRUCTION AS SUBMITTED</p><h2>${task ? h(task.title) : "Initial session prompt"}</h2><blockquote class="quote">${h(prompt)}</blockquote>
      <details><summary>What context was available?</summary><p>The synthetic session concerns an existing reporting table. Earlier accepted instructions remain relevant; a short reference to an agreed design can be sufficient.</p><p>Assessment uses submission-time context. Later clarifications can inform a rewrite but do not establish that the original prompt caused an error.</p></details>
      <p class="eyebrow">ILLUSTRATIVE ASSESSMENT</p><div class="rating">3 / 5 <span>clarity</span> &nbsp; 4 / 5 <span>usefulness</span></div>${badge("Model judgment / illustrative", "warning")}
      <p class="small muted">Example evaluator / draft rubric 1. No model has actually evaluated this page. These are canned ratings, not computed scores for edited prompts.</p></section>
      <section class="panel"><p class="eyebrow">KEEP WHAT WORKED</p><h3>A recognizable outcome.</h3><p class="small muted">The request identifies a capability and connects it to the ongoing work.</p><p class="eyebrow">MAKE THE BOUNDARIES CLEARER</p><h3>${isCsv ? "Which rows should be exported?" : "What would count as complete?"}</h3><p class="small muted">${isCsv ? "All rows versus filtered rows is a meaningful ambiguity. Inspect the later clarification without assuming the prompt caused the agent's decision." : "Make the expected output and verification explicit when they are not already established in the conversation."}</p>
      <div class="actions"><button class="text-button" data-action="origin" data-task="${h(id || "t1")}">Original instruction</button>${isCsv ? `<button class="text-button" data-action="signal" data-id="u08">Later clarification / U08</button>` : ""}</div>
      <label for="rewrite">Suggested rewrite / synthetic example</label><textarea id="rewrite" readonly>${h(rewrite)}</textarea><div class="actions"><button class="button" data-action="copy-rewrite">Copy suggested rewrite</button></div>
      <p class="small muted">${isCsv ? "This rewrite includes the later filtered-row and utility clarifications." : "Review the suggested constraints before reusing them; they are recommendations, not new requirements."} Copying does not execute the prompt or change source evidence.</p></section></div>`
    );
  }

  /** Expose genuine in-memory correction controls while preserving original session-level usage. */
  function reviewPage() {
    const intro = heading(
      "Review the interpretation",
      "YOUR INTENT IS THE AUTHORITY",
      "Correct the map, not the original evidence.",
      `<a class="secondary" href="#report">Back to report</a>`,
    );
    if (!state.analyzed)
      return (
        intro +
        unavailable(
          "There are no task interpretations to review.",
          state.content
            ? "Load the simulated analysis to explore corrections."
            : "Task interpretation needs message content.",
          state.content ? "analysis" : "capture-help",
        )
      );
    return (
      intro +
      coverageNotice() +
      `<div class="callout info">Edits are kept only in this page. Session token/tool totals remain recorded; task associations and interpreted counts recalculate. No model call runs automatically.</div>
      <div class="table-wrap"><table><thead><tr><th><span class="sr-only">Select</span></th><th>Task / segments</th><th>Outcome</th><th>Review actions</th></tr></thead><tbody>${state.tasks.map((task) => `<tr><td><input type="checkbox" class="task-selection" value="${h(task.id)}" aria-label="Select ${h(task.title)}" ${selectedTasks.has(task.id) ? "checked" : ""} ${task.excluded ? "disabled" : ""}></td><td><strong>${h(task.title)}</strong><small>U${task.range[0]}-U${task.range[1]} / ${task.excluded ? "excluded; evidence retained" : task.corrected ? "user-corrected" : "inferred grouping"}</small></td><td>${badge(task.status, task.status === "Completed" ? "" : "warning")}<small>${h(task.evidence)}</small></td><td><div class="actions"><button class="text-button" data-action="edit-one" data-op="rename" data-task="${h(task.id)}">Rename</button><button class="text-button" data-action="edit-one" data-op="outcome" data-task="${h(task.id)}">Outcome</button><button class="text-button" data-action="${task.excluded ? "restore" : "edit-one"}" data-op="exclude" data-task="${h(task.id)}">${task.excluded ? "Restore" : "Exclude"}</button></div></td></tr>`).join("")}</tbody></table></div>
      <div class="actions section-heading"><div class="actions"><button class="secondary" data-action="edit-selected" data-op="merge">Merge selected</button><button class="secondary" data-action="edit-selected" data-op="split">Split selected</button><button class="secondary" data-action="edit-selected" data-op="range">Adjust segments</button></div><span class="small muted">Merge: select adjacent tasks. Split/segments: select one.</span></div>
      <section class="panel"><p class="eyebrow">BEFORE YOU SAVE</p><h3>See what changes.</h3><p class="small muted">Each edit opens a preview. Excluded or displaced evidence remains available in the session and is identified as unallocated. Changed boundaries require outcome review; affected prompt assessments become stale.</p></section>`
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
      ${messages.map((signal) => `<button class="signal-card" data-action="signal" data-id="${h(signal.id)}"><span class="badge-row">${badge(signal.id.toUpperCase(), "neutral")}${signal.tags.map((tag) => badge(tag, "warning")).join("")}</span><strong>${h(signal.text)}</strong><small>${h(M.taskLabel(state, signal.taskId))} / ${signal.confirmed ? "user-confirmed category" : "model-inferred category"}</small></button>`).join("") || `<div class="callout info">No messages currently have a corrective-steering classification in this scope.</div>`}
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

  /** Show exact fictional before/human/after context and a reviewable classification. */
  function interactionPanel(id) {
    if (!state.content)
      return panelShell(
        "Interaction content unavailable",
        "CAPTURE COVERAGE",
        `<p>The example did not capture message text. No original instruction can be reconstructed from timing alone.</p>`,
      );
    if (id.startsWith("origin:")) {
      const task = M.taskById(state, id.slice(7));
      return panelShell(
        "The requested outcome",
        "ORIGINAL INSTRUCTION / SYNTHETIC",
        `<div class="context-block human"><h3>Human / U${task.range[0]}</h3><p>${h(task.prompt)}</p></div><div class="context-block"><h3>Agent interpretation</h3><p>The agent outlines an approach to this requested outcome. Later instructions and recorded actions belong in the same context, not in isolated prompt scoring.</p></div><p class="small muted">Task boundaries ${task.corrected ? "were corrected by you" : "are inferred"}; a task can span more than one conversation segment in the product design.</p>`,
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
      <div class="callout info">Count contribution: ${M.steeringCategories.includes(signal.category) ? "1 steering message, regardless of tag count" : "not counted as corrective steering"}. ${signal.confirmed ? "Category confirmed by you." : "Category is a model-inferred example."}</div>
      <form class="form-stack" data-form="signal"><input type="hidden" name="id" value="${h(id)}"><label>Interpretation category<select name="category">${M.categories.map((category) => `<option ${category === signal.category ? "selected" : ""}>${h(category)}</option>`).join("")}</select></label><button class="button" type="submit">Save classification</button><p class="form-error" role="alert"></p></form>
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
      ${state.analyzed ? `<form class="form-stack" data-form="purpose"><input type="hidden" name="id" value="${h(id)}"><label>Artifact purpose<select name="purpose">${["Deliverable", "Temporary helper", "Supporting artifact", "Unknown"].map((value) => `<option ${artifact.purpose === value ? "selected" : ""}>${h(value)}</option>`).join("")}</select></label><p class="small muted">${artifact.confirmed ? "Current label is user-confirmed." : "Current label is model-inferred; file extension alone does not determine purpose."}</p><button class="button" type="submit">Save purpose</button><p class="form-error" role="alert"></p></form>` : `<div class="callout">Purpose has not been analyzed. Recorded identity and lifecycle are still inspectable.</div>`}`,
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
    return panelShell(
      `${tool.name} / ${tool.id.toUpperCase()}`,
      M.taskLabel(state, tool.taskId),
      `<div class="badge-row">${badge(tool.status, tool.status.startsWith("Failed") ? "danger" : "")}${badge(`${tool.durationMs} ms`, "neutral")}${badge(`Turn U${tool.turn}`, "neutral")}</div>
      <p class="small muted">This is one recorded tool invocation. Durations include waiting; they are not processor time.</p>
      ${state.content ? `<h3>Recorded result / synthetic</h3><pre>${h(operations.length ? operations.join("\n") + "\nOperation result recorded." : tool.status.startsWith("Failed") ? "Expected filtered rows; received all rows.\nThis check failed. A later invocation records recovery." : tool.name === "terminal" ? "Synthetic test/check completed successfully." : "Synthetic tool result for the selected task.")}</pre><details><summary>Arguments and source anchor</summary><p>Example reference: ${h(tool.id)} / turn U${tool.turn}. No command on this page is executed.</p><code>${h(tool.name)}(synthetic task context)</code></details>` : `<div class="callout">Arguments and result content are missing. Name, duration, and outcome remain recorded.</div>`}`,
    );
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
      <pre>${h(JSON.stringify({ request: item.id, inputTokens: item.input, outputTokens: item.output, source: "synthetic fixture", unit: "tokens" }, null, 2))}</pre>
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
      taskId ? M.taskLabel(state, taskId) : "OBSERVED 09:00-09:42 / LOCAL TIME",
      `<p>The session spans <strong>42 minutes</strong> between captured boundaries. This is not a claim of 42 minutes of productive work.</p>
      ${state.telemetry ? `<div class="badge-row">${badge(`${values.activeMinutes}m interval-union activity`)}${badge(`${values.cumulativeMinutes}m cumulative spans`, "neutral")}</div><div class="table-wrap"><table><thead><tr><th>Recorded span</th><th>Minutes from start</th><th>Task</th></tr></thead><tbody>${intervals.map((item, index) => `<tr><td>A${index + 1}${item.start === 4 ? " / overlapping child" : ""}</td><td>${item.start}-${item.end}</td><td>${h(M.taskLabel(state, item.taskId))}</td></tr>`).join("")}</tbody></table></div><p class="small muted">The overlapping child adds to cumulative duration, not elapsed activity. Model/tool durations can include waiting.</p>` : `<div class="callout">No execution intervals were captured. Agent runtime is unavailable.</div>`}
      <div class="callout"><strong>Human typing: unavailable.</strong> Message submission is not typing start. Unobserved gaps may include reading, thinking, other work, or absence. They are not labeled exact idle time.</div>`,
    );
  }

  /** Make capture coverage actionable without modifying any editor setting or telemetry destination. */
  function coveragePanel() {
    return panelShell(
      "What this report can support",
      "CAPTURE COVERAGE",
      `<ul class="evidence-list"><li>Conversation content<span>${state.content ? "Available" : "Missing"}</span></li><li>Execution records<span>${state.telemetry ? "Available" : "Missing"}</span></li><li>Usage records<span>${!state.telemetry ? "Unavailable" : state.mode === "partial" ? "9 of 12 complete" : "12 of 12 complete"}</span></li><li>Task / steering interpretation<span>${state.analyzed ? "Synthetic proposals" : "Not analyzed"}</span></li><li>Exact typing and true idle time<span>Unavailable</span></li></ul>
      <p class="small muted">Coverage belongs to the source, runtime, and selected scope. Complete recorded telemetry does not make inferred task boundaries certain.</p><button class="button" data-action="capture-help">Read capture prerequisites</button>`,
    );
  }

  /** Preview a simulated analysis separately from capture, with an explicit no-network boundary. */
  function analysisPanel() {
    return panelShell(
      "Before an interpretation",
      "SIMULATED ANALYSIS SETUP",
      `<p>The product should show what is selected and where it would be analyzed before any model request.</p><ul class="evidence-list"><li>Scope<span>Reporting improvements</span></li><li>Content<span>Prompts, replies, recorded tool results</span></li><li>Destination<span>This browser / synthetic fixtures</span></li><li>Data transmitted<span>None</span></li></ul>
      <div class="callout info">This is not a provider configuration screen. No API key, model connection, or external transmission is implemented. The production privacy/provider decision remains open.</div>
      ${!state.content ? `<div class="callout">Message content is missing. Load a complete example or inspect capture help; this mock cannot fabricate an assessment.</div><button class="button" data-action="capture-help">Capture help</button>` : `<form class="form-stack" data-form="analysis"><label><input type="checkbox" name="acknowledge" required> Show canned example interpretations; do not make a model call.</label><div class="actions"><button class="button" type="submit">Show simulated analysis</button><button class="secondary" type="button" data-action="close">Cancel</button></div></form>`}`,
    );
  }

  /** Synthetic import preview deliberately avoids a file picker or a misleading claim of real ingestion. */
  function importPanel(discover = false) {
    return panelShell(
      discover ? "Preview demo discovery" : "Import a synthetic export",
      "NO REAL FILES ARE READ",
      `<p>${discover ? "A production discovery flow would ask you to select locations first. This prototype only offers its bundled example." : "Choose the coverage you want to explore. These buttons load bundled fixtures, not a file from your computer."}</p>
      <div class="form-stack"><button class="secondary" data-action="load-import" data-mode="complete">Load content + traces example</button><button class="secondary" data-action="load-import" data-mode="partial">Load incomplete capture example</button><button class="secondary" data-action="load-import" data-mode="transcript">Load transcript-only example</button><button class="secondary" data-action="unsupported">Try unsupported-format error</button></div>
      <div class="callout info">Importing evidence is not permission to send it to a model. Historical captures cannot gain missing fields retroactively.</div>`,
    );
  }

  /** Describe setup and the misleading localhost toast without changing the user's actual VS Code configuration. */
  function capturePanel() {
    return panelShell(
      "Capture is a prerequisite",
      "HELP / NO SETTINGS ARE CHANGED",
      `<p>The complete setup guide is tracked in <a href="https://github.com/toddysm/agent-insights/issues/1" target="_blank" rel="noopener noreferrer">issue #1</a>.</p>
      <ul><li>Enable the debug-log setting for the actual Local or Agent Host runtime.</li><li>Reload as required and verify a new test session.</li><li>For the extension file exporter, use a resolved private per-user path outside repositories.</li><li>Inspect the effective destination before enabling full-content capture.</li></ul>
      <details><summary>Why does the reload notice mention localhost:4318?</summary><p>The endpoint-change notice can appear even with file export selected. Verify the active exporter and output file; the notification alone does not prove network export or require a collector.</p></details>
      <p class="small muted">Settings cannot recover missing historical content or measure exact human typing time. Full captures can contain source code and secrets; never publish them with this design prototype.</p>`,
    );
  }

  /** Preview interpretation changes with source totals explicitly preserved; forms delegate validation to the model. */
  function editPanel(params) {
    const operation = params.get("op");
    const ids = (params.get("ids") || params.get("task") || "")
      .split(",")
      .filter(Boolean);
    const task = ids.length ? M.taskById(state, ids[0]) : null;
    if (!task) throw new RangeError("Select a task before editing.");
    if (operation === "merge") M.mergeSelection(state, ids);
    const title = {
      rename: "Rename the requested outcome",
      merge: "Merge task interpretations",
      split: "Split at an interaction",
      range: "Adjust the task's segment",
      exclude: "Exclude an interpretation",
      outcome: "Correct the outcome",
    }[operation];
    if (!title) throw new RangeError("Unknown interpretation edit.");
    let fields = `<input type="hidden" name="operation" value="${h(operation)}"><input type="hidden" name="ids" value="${h(ids.join(","))}">`;
    if (["rename", "merge", "split"].includes(operation))
      fields += `<label>Task title<input name="title" maxlength="120" required value="${h(operation === "merge" ? ids.map((id) => M.taskById(state, id).title).join(" + ") : operation === "split" ? `Continue ${task.title}` : task.title)}"></label>`;
    if (operation === "split")
      fields += `<label>New task starts at turn<input name="turn" type="number" min="${task.range[0] + 1}" max="${task.range[1]}" value="${Math.ceil((task.range[0] + task.range[1]) / 2)}" required></label><p class="small muted">Records at or after this turn move to the new task. Both outcomes become uncertain until reviewed.</p>`;
    if (operation === "range")
      fields += `<label>First turn<input type="number" name="start" min="1" max="28" value="${task.range[0]}" required></label><label>Last turn, inclusive<input type="number" name="end" min="1" max="28" value="${task.range[1]}" required></label><p class="small muted">The range must not overlap any other task, including excluded tasks. Records outside the new range become unallocated; no source record is deleted.</p>`;
    if (operation === "outcome")
      fields += `<label for="task-outcome">Outcome</label><select id="task-outcome" name="status">${["Completed", "Partial", "Blocked", "Abandoned", "Uncertain"].map((value) => `<option ${value === task.status ? "selected" : ""}>${value}</option>`).join("")}</select><p class="small muted">This will be labeled user-confirmed, not tool-verified.</p>`;
    if (operation === "exclude")
      fields += `<p>Exclude <strong>${h(task.title)}</strong> from the active task map? Its recorded evidence remains in session totals and is labeled unallocated. You can restore it later.</p>`;
    const activeCount = M.metrics(state).tasks.length;
    const nextCount =
      operation === "merge"
        ? activeCount - ids.length + 1
        : operation === "split"
          ? activeCount + 1
          : operation === "exclude"
            ? activeCount - 1
            : activeCount;
    return panelShell(
      title,
      "REVIEW BEFORE SAVING",
      `<form class="form-stack" data-form="task">${fields}<div class="callout info"><strong>Change preview</strong><br>Active tasks: ${activeCount} to ${nextCount}.<br>Session tool/token totals: unchanged.<br>Affected prompt assessments: need refresh; no model call runs.</div><p class="form-error" role="alert"></p><div class="actions"><button class="button" type="submit">Save corrections</button><button class="secondary" type="button" data-action="close">Cancel</button></div></form>`,
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
        "No session imported",
        "EVIDENCE REQUIRED",
        `<p>Load a synthetic example before inspecting evidence or running the simulated analysis.</p><button class="button" data-action="import">Import a synthetic example</button>`,
      );
    if (taskId) M.taskById(state, taskId);
    if (!state.analyzed && (taskId || ["interaction", "edit"].includes(panel)))
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
    if (panel === "coverage") return coveragePanel();
    if (panel === "analysis") return analysisPanel();
    if (panel === "capture") return capturePanel();
    if (panel === "import" || panel === "discover")
      return importPanel(panel === "discover");
    if (panel === "edit") return editPanel(params);
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
      const tools = state.tools.filter(
        (item) => !taskId || item.taskId === taskId,
      );
      return panelShell(
        `${tools.length} recorded tool calls`,
        taskId ? M.taskLabel(state, taskId) : "WHOLE SESSION",
        `<p class="small muted">${new Set(tools.map((item) => item.name)).size} distinct tools. Open a row for its exact synthetic result.</p><div class="table-wrap"><table><thead><tr><th>Invocation</th><th>Duration</th><th>Outcome</th></tr></thead><tbody>${tools.map((item) => `<tr><td><button class="text-button" data-action="tool" data-id="${h(item.id)}">${h(item.id.toUpperCase())} / ${h(item.name)}</button><small>${h(M.taskLabel(state, item.taskId))}</small></td><td>${item.durationMs} ms</td><td>${h(item.status)}</td></tr>`).join("")}</tbody></table></div>`,
      );
    }
    if (panel === "completed" || panel === "tasks")
      return panelShell(
        "Outcomes and their basis",
        "INTERPRETATION, NOT AN OVERALL GRADE",
        state.analyzed
          ? `<p class="small muted">Completion claims, direct evidence, and user confirmations remain distinguishable.</p><ul class="evidence-list">${M.metrics(
              state,
            )
              .tasks.map(
                (task) =>
                  `<li><span><a href="#task/${h(task.id)}">${h(task.title)}</a><br><span class="small">${h(task.status)} / ${h(task.evidence)}</span></span></li>`,
              )
              .join(
                "",
              )}</ul><a class="text-button" href="#review">Review the task map</a>`
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
            "This scenario has no imported sessions.",
            "import",
          );
        else if (view === "sessions") main.innerHTML = sessionsPage();
        else if (view === "report") main.innerHTML = reportPage();
        else if (view === "task") main.innerHTML = taskPage(id);
        else if (view === "artifacts") main.innerHTML = artifactsPage();
        else if (view === "prompts") main.innerHTML = promptsPage(id);
        else if (view === "review") main.innerHTML = reviewPage();
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
      if (current.params.has("panel")) {
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

  /** Load a fresh walkthrough fixture, explicitly discarding only synthetic in-page edits. */
  function loadScenario(name) {
    const mode = ["empty", "partial", "analysis-off"].includes(name)
      ? name
      : name === "unsupported"
        ? "empty"
        : "complete";
    state = M.createState(mode);
    selectedTasks = new Set();
    filters.search = "";
    filters.purpose = "All";
    filters.artifactTask = "All";
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
      review: "review",
      partial: "report",
      "analysis-off": "report",
      unsupported: "sessions?panel=unsupported",
    }[name];
    if (!destination) throw new RangeError("Unknown walkthrough scenario.");
    navigate(destination);
    announce(
      "Fresh synthetic scenario loaded. Previous demo edits were reset.",
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
    else if (["artifact", "tool", "request"].includes(action))
      openPanel(action, contextTask, { id });
    else if (action === "capture-help") openPanel("capture");
    else if (["analysis", "import", "discover", "unsupported"].includes(action))
      openPanel(action);
    else if (action === "reset") loadScenario("report");
    else if (action === "transcript-demo" || action === "load-import") {
      state = M.createState(
        action === "transcript-demo" ? "transcript" : button.dataset.mode,
      );
      selectedTasks.clear();
      filters.purpose = "All";
      filters.artifactTask = "All";
      dirty = true;
      navigate("report");
      announce("Bundled example loaded. No real file was imported.");
    } else if (action === "edit-one")
      openPanel("edit", task, { op: button.dataset.op });
    else if (action === "edit-selected") {
      const ids = [...selectedTasks];
      if (
        (button.dataset.op === "merge" && ids.length < 2) ||
        (button.dataset.op !== "merge" && ids.length !== 1)
      )
        throw new RangeError(
          button.dataset.op === "merge"
            ? "Select at least two active tasks to merge."
            : "Select exactly one active task.",
        );
      if (button.dataset.op === "merge") M.mergeSelection(state, ids);
      openPanel("edit", "", { op: button.dataset.op, ids: ids.join(",") });
    } else if (action === "restore") {
      M.excludeTask(state, task, false);
      dirty = true;
      render();
      announce(
        "Task interpretation restored. Original evidence was never removed.",
      );
    } else if (action === "copy-rewrite") await copyRewrite();
    else
      throw new RangeError("That action is not implemented in this prototype.");
  }

  /** Save correction forms atomically through the model; unexpected failures remain visible in console and UI. */
  function handleForm(form) {
    const data = new FormData(form);
    if (form.dataset.form === "signal")
      M.classifySignal(
        state,
        String(data.get("id")),
        String(data.get("category")),
      );
    else if (form.dataset.form === "purpose")
      M.classifyArtifact(
        state,
        String(data.get("id")),
        String(data.get("purpose")),
      );
    else if (form.dataset.form === "analysis") {
      state.analyzed = true;
      state.analysisStale = false;
    } else if (form.dataset.form === "task") {
      const ids = String(data.get("ids")).split(",");
      const operation = data.get("operation");
      if (operation === "rename")
        M.renameTask(state, ids[0], String(data.get("title")));
      else if (operation === "merge")
        M.mergeTasks(state, ids, String(data.get("title")));
      else if (operation === "split")
        M.splitTask(
          state,
          ids[0],
          Number(data.get("turn")),
          String(data.get("title")),
        );
      else if (operation === "range")
        M.adjustRange(
          state,
          ids[0],
          Number(data.get("start")),
          Number(data.get("end")),
        );
      else if (operation === "exclude") M.excludeTask(state, ids[0], true);
      else if (operation === "outcome")
        M.setOutcome(state, ids[0], String(data.get("status")));
      else throw new RangeError("Unknown task correction.");
      selectedTasks.clear();
      if (
        filters.artifactTask !== "All" &&
        !state.tasks.some((task) => task.id === filters.artifactTask)
      )
        filters.artifactTask = "All";
    } else throw new RangeError("Unknown prototype form.");
    dirty = true;
    closePanel();
    announce(
      form.dataset.form === "analysis"
        ? "Canned interpretations shown. No model request was made."
        : "Synthetic interpretation saved. Recorded session usage is unchanged.",
    );
  }

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
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
          "Unexpected error while saving. See the browser console.",
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
    else if (element.classList.contains("task-selection")) {
      if (element.checked) selectedTasks.add(element.value);
      else selectedTasks.delete(element.value);
    } else if (
      element.id === "purpose-filter" ||
      element.id === "artifact-task-filter"
    ) {
      filters[element.id === "purpose-filter" ? "purpose" : "artifactTask"] =
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
