/** Synthetic read-only evidence and explicit in-memory source/analysis lifecycles; no capture access or provider calls. */
const InsightsModel = (() => {
  const taskSeeds = [
    {
      id: "t1",
      title: "Add CSV export",
      status: "Completed",
      evidence: "Evidence-backed",
      prompt: "Add CSV export for this table.",
      range: [1, 14],
    },
    {
      id: "t2",
      title: "Fix date filtering",
      status: "Completed",
      evidence: "Source acceptance",
      prompt: "Next, fix date filtering so the end date is included.",
      range: [15, 22],
    },
    {
      id: "t3",
      title: "Document the workflow",
      status: "Partial",
      evidence: "Agent-claimed",
      prompt: "Document the export workflow, including a usage example.",
      range: [23, 28],
    },
  ];
  const toolNames = [
    [
      "read_file",
      "search_files",
      "list_directory",
      "read_file",
      "apply_patch",
      "terminal",
      "read_file",
      "apply_patch",
      "terminal",
      "run_subagent",
      "read_file",
      "search_files",
      "ask_user",
      "terminal",
    ],
    [
      "read_file",
      "search_files",
      "apply_patch",
      "terminal",
      "read_file",
      "apply_patch",
      "terminal",
      "search_files",
      "read_file",
    ],
    ["read_file", "web_fetch", "apply_patch", "terminal"],
  ];
  const toolTurns = [
    [2, 3, 3, 4, 6, 7, 8, 9, 10, 10, 11, 12, 13, 14],
    [16, 16, 17, 18, 19, 20, 20, 21, 22],
    [24, 25, 26, 27],
  ];
  const toolInputs = [
    { path: "src/table.ts", startLine: 1, endLine: 160 },
    { path: "src", pattern: "export.*csv|filteredRows", regex: true },
    { path: "src/utils" },
    { path: "src/utils/csv.ts", startLine: 1, endLine: 120 },
    { patch: "*** Begin Patch\n*** Add File: src/export.ts\n+import { toCsv } from './utils/csv';\n+export const exportRows = (rows) => toCsv(rows);\n*** End Patch" },
    { command: "npm test -- --run tests/export.test.ts", workingDirectory: "/workspace/sample-reports", stdout: "Export tests: 1 failed, 7 passed.", stderr: "Expected filtered rows; received all rows.", exitCode: 1 },
    { path: "src/table.ts", startLine: 80, endLine: 140 },
    { patch: "*** Begin Patch\n*** Update File: src/export.ts\n@@\n-export const exportRows = (rows) => toCsv(rows);\n+export const exportRows = (table) => toCsv(table.filteredRows);\n*** Add File: tests/export.test.ts\n+import { test, expect } from 'vitest';\n+import { exportRows } from '../src/export';\n+test('exports filtered rows', () => {\n+  expect(exportRows({ filteredRows: [['visible']] })).toContain('visible');\n+});\n*** End Patch" },
    { command: "mkdir -p temp\nprintf '%s\\n' 'print(\"name,value\")' 'print(\"sample,1\")' > temp/make-fixtures.py\npython3 temp/make-fixtures.py\nnpm test -- --run tests/export.test.ts", workingDirectory: "/workspace/sample-reports", stdout: "name,value\nsample,1\nExport tests: 8 passed, 0 failed.", stderr: "", exitCode: 0 },
    { prompt: "Check filtered-row handling and CSV escaping. Inspect src/export.ts and tests/export.test.ts. Remaining instructions were not captured." },
    { path: "tests/export.test.ts", startLine: 1, endLine: 120 },
    { path: "src/utils", pattern: "toCsv", regex: false },
    { question: "Can I use the existing CSV utility and remove the temporary fixture helper?", choices: ["Use existing utility", "Explain the alternative"] },
    { command: "npm test -- --run tests/export.test.ts && rm temp/make-fixtures.py", workingDirectory: "/workspace/sample-reports", stdout: "CSV export filtered-row and escaping tests: 8 passed, 0 failed (synthetic).\nDeleted: temp/make-fixtures.py", stderr: "", exitCode: 0 },
    { path: "src/date-filter.ts", startLine: 1, endLine: 100 },
    { path: "src", pattern: "endDate", regex: false },
    { patch: "*** Begin Patch\n*** Update File: src/date-filter.ts\n@@\n-return date < end;\n+return date <= end;\n*** End Patch" },
    { command: "npm test -- --run tests/export.test.ts", workingDirectory: "/workspace/sample-reports", stdout: "Date-filter checks passed; end-date boundary case not yet covered.", stderr: "", exitCode: 0 },
    { path: "tests/export.test.ts", startLine: 1, endLine: 160 },
    { patch: "*** Begin Patch\n*** Update File: src/date-filter.ts\n@@\n-return date <= end;\n+return date >= start && date <= end;\n*** Update File: tests/export.test.ts\n@@\n import { test, expect } from 'vitest';\n+import { includesDate } from '../src/date-filter';\n+test('includes the end date', () => {\n+  expect(includesDate('2026-10-29', '2026-10-01', '2026-10-29')).toBe(true);\n+});\n*** End Patch" },
    { command: "npm test -- --run tests/export.test.ts", workingDirectory: "/workspace/sample-reports", stdout: "Date-filter boundary tests passed, including the selected end date.", stderr: "", exitCode: 0 },
    null,
    { path: "src/date-filter.ts", startLine: 1, endLine: 100 },
    { path: "docs/README.md", startLine: 1, endLine: 120 },
    { url: "https://example.invalid/csv-reference", headers: { Authorization: "[REDACTED BY HARNESS / SYNTHETIC]" } },
    { patch: "*** Begin Patch\n*** Add File: docs/export.md\n+# CSV export\n+Export uses the visible filtered rows and the existing CSV utility.\n+Usage example remains unfinished.\n*** End Patch" },
    { command: "mkdir -p temp\nprintf '%s\\n' 'Export <filtered> rows & preserve \"quotes\".' > temp/session-notes.md\ncat temp/session-notes.md\nrm temp/session-notes.md", workingDirectory: "/workspace/sample-reports", stdout: "Export <filtered> rows & preserve \"quotes\".\nCreated and deleted: temp/session-notes.md", stderr: "", exitCode: 0 },
  ];
  const usage = [
    [
      [1200, 150, 2],
      [1000, 160, 4],
      [1300, 200, 6],
      [1500, 180, 9],
      [1000, 160, 12],
      [1000, 150, 14],
    ],
    [
      [900, 140, 16],
      [1100, 160, 18],
      [1000, 150, 20],
      [1000, 150, 22],
    ],
    [
      [800, 110, 24],
      [600, 90, 27],
    ],
  ];
  const signalSeeds = [
    {
      id: "u08",
      taskId: "t1",
      turn: 8,
      category: "Correction",
      tags: ["Correction", "Repeated requirement"],
      text: "Export the filtered rows, not all rows.",
      before:
        "The agent describes exporting every row from the underlying dataset.",
      after: "The agent updates the export to use the table's filtered rows.",
      toolId: "c8",
    },
    {
      id: "u14",
      taskId: "t1",
      turn: 14,
      category: "Rejected approach",
      tags: ["Rejected approach"],
      text: "Use the existing CSV utility.",
      before: "The agent proposes a second CSV formatter.",
      after: "The agent reuses the existing utility and records passing tests.",
      toolId: "c14",
    },
    {
      id: "u19",
      taskId: "t2",
      turn: 19,
      category: "Correction",
      tags: ["Correction"],
      text: "The last day should be included in the results.",
      before: "The proposed comparison excludes the selected end date.",
      after: "The agent changes the comparison and adds a boundary case.",
      toolId: "c20",
    },
    {
      id: "u26",
      taskId: "t3",
      turn: 26,
      category: "Repeated requirement",
      tags: ["Repeated requirement"],
      text: "Please include the usage example I requested.",
      before: "The agent drafts the guide without the example.",
      after: "The agent notes that the usage example remains unfinished.",
      toolId: "c26",
    },
    {
      id: "u04",
      taskId: "t1",
      turn: 4,
      category: "Routine approval",
      tags: ["Routine approval"],
      text: "Yes, go ahead.",
      before: "The agent asks permission to proceed with the agreed approach.",
      after: "The agent proceeds.",
      toolId: "c5",
    },
  ];
  const artifactSeeds = [
    {
      id: "a1",
      path: "src/export.ts",
      purpose: "Deliverable",
      operations: [
        ["c5", "Created"],
        ["c8", "Modified"],
      ],
      note: "The export implementation; completion evidence includes a subsequent test result.",
    },
    {
      id: "a2",
      path: "tests/export.test.ts",
      purpose: "Deliverable",
      operations: [
        ["c8", "Created"],
        ["c20", "Modified"],
      ],
      note: "Shared by two tasks. It counts once in the session inventory.",
    },
    {
      id: "a3",
      path: "temp/make-fixtures.py",
      purpose: "Temporary helper",
      operations: [
        ["c9", "Created"],
        ["c14", "Deleted"],
      ],
      note: "Removed after creating test data; its recorded lifecycle remains visible.",
    },
    {
      id: "a4",
      path: "src/date-filter.ts",
      purpose: "Deliverable",
      operations: [
        ["c17", "Modified"],
        ["c20", "Modified"],
      ],
      note: "A changed file, not a newly created artifact.",
    },
    {
      id: "a5",
      path: "docs/export.md",
      purpose: "Deliverable",
      operations: [["c26", "Created"]],
      note: "An intended deliverable can exist while its task remains partial.",
    },
    {
      id: "a6",
      path: "temp/session-notes.md",
      purpose: "Temporary helper",
      operations: [
        ["c27", "Created"],
        ["c27", "Deleted"],
      ],
      note: "The recorded shell result describes creating and removing scratch notes.",
    },
  ];
  const intervals = [
    { taskId: "t1", turn: 2, start: 2, end: 8, kind: "model", sourceId: "m1" },
    { taskId: "t1", turn: 14, start: 12, end: 16, kind: "model", sourceId: "m6" },
    { taskId: "t2", turn: 18, start: 22, end: 26, kind: "model", sourceId: "m8" },
    { taskId: "t2", turn: 20, start: 30, end: 32, kind: "work", sourceId: "c21" },
    { taskId: "t3", turn: 26, start: 36, end: 38, kind: "work", sourceId: "c26" },
    { taskId: "t1", turn: 7, start: 4, end: 6, kind: "work", sourceId: "c6" },
  ];
  const stateIntervals = [
    { kind: "waiting", start: 8, end: 12, evidence: [
      { id: "H01", text: "Approval requested at 09:08: may I continue with the filtered-row approach?" },
      { id: "H02", text: "Human response at 09:12: continue with that approach." },
    ] },
    { kind: "quiet", start: 0, end: 2, evidence: [
      { id: "L01", text: "Session open at 09:00; no pending execution or input request." },
      { id: "L02", text: "Model execution starts at 09:02; complete lifecycle coverage between these records." },
    ] },
    { kind: "quiet", start: 26, end: 30, evidence: [
      { id: "L03", text: "Session open at 09:26; no pending execution or input request." },
      { id: "L04", text: "Tool execution starts at 09:30; complete lifecycle coverage between these records." },
    ] },
  ];
  const steeringCategories = [
    "Correction",
    "Repeated requirement",
    "Rejected approach",
  ];

  /** Attach the fixture's recorded minute offsets to its source record; other invocations have no captured boundaries. */
  function sourceTiming(id) {
    const span = intervals.find((item) => item.sourceId === id);
    return span ? { startMinute: span.start, endMinute: span.end } : null;
  }

  /** Return a fresh synthetic capture; modes deliberately remove evidence rather than replace missing values with zero. */
  function createState(mode = "complete") {
    if (
      !["complete", "partial", "transcript", "analysis-off", "empty"].includes(
        mode,
      )
    )
      throw new RangeError("Unknown demo capture mode.");
    let toolIndex = 0;
    let requestIndex = 0;
    const state = {
      mode,
      imported: mode !== "empty",
      content: mode !== "partial",
      telemetry: mode !== "transcript",
      analyzed: !["partial", "analysis-off", "empty"].includes(mode),
      readId: 1,
      sourceState: "ready",
      runSequence: 0,
      run: null,
      sourceAcceptance: Object.freeze({
        id: "C02",
        text: "Date filtering now includes the end date; that is what I needed.",
      }),
      sessionInstruction: Object.freeze({
        id: "session-opening",
        turn: 0,
        text: "Help me improve reporting in this app.",
      }),
      instructions: Object.freeze(
        taskSeeds.map((task) =>
          Object.freeze({
            id: `prompt-${task.id}`,
            turn: task.range[0],
            text: task.prompt,
          }),
        ),
      ),
      tasks: taskSeeds.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        evidence: task.evidence,
        range: [...task.range],
        instructionIds: Object.freeze([`prompt-${task.id}`]),
      })),
      signals: structuredClone(signalSeeds),
      artifacts: structuredClone(artifactSeeds),
      intervals: structuredClone(intervals),
      stateIntervals: ["partial", "transcript"].includes(mode) ? null : structuredClone(stateIntervals),
      observedMinutes: 42,
      tools: toolNames.flatMap((names, group) =>
        names.map((name, index) => ({
          id: `c${++toolIndex}`,
          name,
          taskId: `t${group + 1}`,
          turn: toolTurns[group][index],
          timing: mode === "transcript" ? null : sourceTiming(`c${toolIndex}`),
          durationMs: [6, 21, 26].includes(toolIndex) ? 120000 : name === "terminal" ? 1400 + index * 80 : 40 + index * 17,
          status: toolIndex === 6 ? "Failed, recovered later" : "Succeeded",
          input: mode === "partial" ? null : name === "terminal"
            ? { command: toolInputs[toolIndex - 1].command, workingDirectory: toolInputs[toolIndex - 1].workingDirectory }
            : structuredClone(toolInputs[toolIndex - 1]),
          output: mode === "partial" || name !== "terminal" ? null
            : { stdout: toolInputs[toolIndex - 1].stdout, stderr: toolInputs[toolIndex - 1].stderr, exitCode: toolInputs[toolIndex - 1].exitCode },
          inputStatus: mode === "partial" || toolIndex === 22 ? "missing" : toolIndex === 10 ? "truncated" : toolIndex === 25 ? "redacted" : "complete",
          testResult: toolIndex === 14
            ? "CSV export filtered-row and escaping tests: 8 passed, 0 failed (synthetic)."
            : null,
        })),
      ),
      requests: usage.flatMap((rows, group) =>
        rows.map(([input, output, turn]) => ({
          id: `m${++requestIndex}`,
          taskId: `t${group + 1}`,
          turn,
          input,
          output,
          model: requestIndex < 9 ? "Example model A" : "Example model B",
          timing: mode === "transcript" ? null : sourceTiming(`m${requestIndex}`),
        })),
      ),
    };
    if (mode === "partial")
      [3, 8, 11].forEach((index) => {
        state.requests[index].input = null;
        state.requests[index].output = null;
      });
    if (mode === "transcript") {
      state.tasks[0].status = "Uncertain";
      state.tasks[0].evidence = "Agent-claimed";
    }
    return state;
  }

  /** Resolve a known inferred task; invalid deep links never substitute a different record. */
  function taskById(state, id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task)
      throw new RangeError(
        "That task is not present in this source read.",
      );
    return task;
  }

  /** Resolve original source instructions independently of inferred task boundaries. */
  function instructionsForTask(state, id) {
    return taskById(state, id).instructionIds.map((sourceId) => {
      const source = state.instructions.find((item) => item.id === sourceId);
      if (!source)
        throw new RangeError("The original instruction record is unavailable.");
      return source;
    });
  }

  /** Label unallocated or unanalyzed attribution without inventing a task interpretation. */
  function taskLabel(state, id) {
    if (!id) return "Unallocated";
    const task = taskById(state, id);
    if (!state.analyzed) return "Not analyzed";
    return task.title;
  }

  /** Calculate unique task associations from the artifact's recorded operations. */
  function artifactTasks(state, artifact) {
    return [
      ...new Set(
        artifact.operations
          .map(([id]) => state.tools.find((tool) => tool.id === id)?.taskId)
          .filter(Boolean),
      ),
    ];
  }

  /** Measure the union of minute-based intervals; overlaps and nested spans count only once. */
  function unionMinutes(records) {
    const sorted = records.toSorted((a, b) => a.start - b.start);
    let end = -Infinity;
    let total = 0;
    for (const interval of sorted) {
      total += Math.max(0, interval.end - Math.max(end, interval.start));
      end = Math.max(end, interval.end);
    }
    return total;
  }

  /** Separate evidence-backed timeline lanes; missing state coverage stays unknown, and overlapping execution counts once overall. */
  function activitySummary(state) {
    const totals = metrics(state);
    const execution = state.telemetry ? state.intervals : [];
    const lifecycle = state.telemetry ? state.stateIntervals : null;
    const known = [...execution, ...(lifecycle || [])].toSorted((a, b) => a.start - b.start);
    const unknown = [];
    let end = 0;
    for (const interval of known) {
      if (interval.start > end) unknown.push({ start: end, end: interval.start });
      end = Math.max(end, interval.end);
    }
    if (end < state.observedMinutes) unknown.push({ start: end, end: state.observedMinutes });
    const definitions = [
      ["model", "Model processing / thinking", "Recorded", "Model-request boundaries include queueing, network and generation; they do not measure private reasoning.", state.telemetry ? execution.filter((item) => item.kind === "model") : null],
      ["work", "Executing work", "Recorded", "Recorded tool spans, including time a tool spends waiting. Background work can overlap model processing.", state.telemetry ? execution.filter((item) => item.kind === "work") : null],
      ["waiting", "Waiting for you", "Recorded", "An explicit input/approval request through its response or cancellation; silence between messages is insufficient.", lifecycle ? lifecycle.filter((item) => item.kind === "waiting") : null],
      ["quiet", "Session quiet / idle", "Inferred", "An open session with complete lifecycle coverage and no pending execution or input request. Not a measurement of human inactivity.", lifecycle ? lifecycle.filter((item) => item.kind === "quiet") : null],
      ["unknown", "Unknown / unobserved", "Unavailable", "These intervals lack enough evidence to classify. They may include unrecorded work, reading, thinking or absence.", unknown],
    ];
    return {
      observedMinutes: state.observedMinutes,
      executionMinutes: totals.activeMinutes,
      outsideExecutionMinutes: state.telemetry ? state.observedMinutes - totals.activeMinutes : null,
      lanes: definitions.map(([id, label, basis, explanation, spans]) => ({
        id, label, basis, explanation,
        spans: spans === null ? null : structuredClone(spans).toSorted((a, b) => a.start - b.start),
        minutes: spans === null ? null : unionMinutes(spans),
      })),
    };
  }

  /** Derive recorded metrics for the whole capture or an event-attributed task; null denotes unavailable coverage. */
  function metrics(state, taskId = null) {
    if (!state.imported || state.sourceState !== "ready")
      throw new RangeError("Source evidence is unavailable for this read.");
    if (taskId) taskById(state, taskId);
    const tools = state.tools.filter(
      (item) => !taskId || item.taskId === taskId,
    );
    const requests = state.requests.filter(
      (item) => !taskId || item.taskId === taskId,
    );
    const signals = state.signals.filter(
      (item) =>
        (!taskId || item.taskId === taskId) &&
        steeringCategories.includes(item.category),
    );
    const artifacts = state.artifacts.filter(
      (item) => !taskId || artifactTasks(state, item).includes(taskId),
    );
    const active = state.intervals.filter(
      (item) => !taskId || item.taskId === taskId,
    );
    const unavailableUsage =
      !state.telemetry ||
      requests.some((item) => item.input === null || item.output === null);
    return {
      tasks: state.analyzed ? state.tasks : [],
      completed: state.analyzed
        ? state.tasks.filter((item) => item.status === "Completed").length
        : null,
      steering: state.analyzed ? signals.length : null,
      artifacts: state.content && state.telemetry ? artifacts.length : null,
      deliverables:
        state.analyzed && state.telemetry
          ? artifacts.filter((item) => item.purpose === "Deliverable").length
          : null,
      helpers:
        state.analyzed && state.telemetry
          ? artifacts.filter((item) => item.purpose === "Temporary helper")
              .length
          : null,
      toolCalls: state.telemetry ? tools.length : null,
      distinctTools: state.telemetry
        ? new Set(tools.map((item) => item.name)).size
        : null,
      input: unavailableUsage
        ? null
        : requests.reduce((sum, item) => sum + item.input, 0),
      output: unavailableUsage
        ? null
        : requests.reduce((sum, item) => sum + item.output, 0),
      missingUsage: requests.filter(
        (item) => item.input === null || item.output === null,
      ).length,
      observedInput: state.telemetry
        ? requests.reduce((sum, item) => sum + (item.input ?? 0), 0)
        : null,
      activeMinutes: state.telemetry ? unionMinutes(active) : null,
      cumulativeMinutes: state.telemetry
        ? active.reduce((sum, item) => sum + item.end - item.start, 0)
        : null,
    };
  }

  /** Reread only the selected synthetic source; discard interpretations and supersede any old run, never analyze automatically. */
  function refreshSource(state, sourceState = "ready") {
    if (!["ready", "changed", "unavailable"].includes(sourceState))
      throw new RangeError("Unknown source-read result.");
    if (!state.imported)
      throw new RangeError("Select a source before refreshing.");
    state.readId += 1;
    state.sourceState = sourceState;
    state.analyzed = false;
    if (state.run) state.run.status = "superseded";
  }

  /** Start one acknowledged, content-bearing fixture run; reject missing evidence or overlapping runs without changing state. */
  function beginAnalysis(state, acknowledged) {
    if (acknowledged !== true)
      throw new RangeError("Acknowledge the selected scope and destination first.");
    if (!state.imported || state.sourceState !== "ready" || !state.content)
      throw new RangeError("Available message content is required for analysis.");
    if (state.run?.status === "running")
      throw new RangeError("Cancel or finish the running analysis first.");
    state.analyzed = false;
    state.run = {
      id: ++state.runSequence,
      readId: state.readId,
      status: "running",
    };
    return state.run.id;
  }

  /** Settle only a still-running run for this exact source read; reject late/cancelled results and never attach them to a newer view. */
  function finishAnalysis(state, runId, status) {
    if (!["complete", "failed", "cancelled"].includes(status))
      throw new RangeError("Unknown analysis result.");
    if (
      !state.run ||
      state.run.id !== runId ||
      state.run.status !== "running" ||
      state.run.readId !== state.readId ||
      state.sourceState !== "ready"
    )
      throw new RangeError("This result is no longer current; nothing was applied.");
    state.run.status = status;
    state.analyzed = status === "complete";
  }

  return {
    createState,
    taskById,
    instructionsForTask,
    taskLabel,
    artifactTasks,
    unionMinutes,
    activitySummary,
    metrics,
    refreshSource,
    beginAnalysis,
    finishAnalysis,
    steeringCategories,
  };
})();

if (typeof module !== "undefined" && module.exports)
  module.exports = InsightsModel;
