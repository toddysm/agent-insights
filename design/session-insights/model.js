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
    { taskId: "t1", turn: 6, start: 2, end: 8 },
    { taskId: "t1", turn: 12, start: 12, end: 16 },
    { taskId: "t2", turn: 17, start: 22, end: 26 },
    { taskId: "t2", turn: 20, start: 30, end: 32 },
    { taskId: "t3", turn: 26, start: 36, end: 38 },
    { taskId: "t1", turn: 6, start: 4, end: 6 },
  ];
  const steeringCategories = [
    "Correction",
    "Repeated requirement",
    "Rejected approach",
  ];

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
      tools: toolNames.flatMap((names, group) =>
        names.map((name, index) => ({
          id: `c${++toolIndex}`,
          name,
          taskId: `t${group + 1}`,
          turn: toolTurns[group][index],
          durationMs: name === "terminal" ? 1400 + index * 80 : 40 + index * 17,
          status: toolIndex === 6 ? "Failed, recovered later" : "Succeeded",
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
    metrics,
    refreshSource,
    beginAnalysis,
    finishAnalysis,
    steeringCategories,
  };
})();

if (typeof module !== "undefined" && module.exports)
  module.exports = InsightsModel;
