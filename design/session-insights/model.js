/** Synthetic evidence and in-memory interpretation edits; never reads captures or contacts a provider. */
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
      evidence: "User-confirmed",
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
  const categories = [
    ...steeringCategories,
    "Requested clarification",
    "New requirement",
    "Routine approval",
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
      revision: 0,
      analysisStale: false,
      nextTask: 1,
      tasks: structuredClone(taskSeeds).map((task) => ({
        ...task,
        excluded: false,
        corrected: false,
      })),
      signals: structuredClone(signalSeeds).map((signal) => ({
        ...signal,
        confirmed: false,
      })),
      artifacts: structuredClone(artifactSeeds).map((artifact) => ({
        ...artifact,
        confirmed: false,
      })),
      intervals: structuredClone(intervals),
      tools: toolNames.flatMap((names, group) =>
        names.map((name, index) => ({
          id: `c${++toolIndex}`,
          name,
          taskId: `t${group + 1}`,
          turn: toolTurns[group][index],
          durationMs: name === "terminal" ? 1400 + index * 80 : 40 + index * 17,
          status: toolIndex === 6 ? "Failed, recovered later" : "Succeeded",
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

  /** Resolve a known task, including excluded tasks; invalid deep links are errors, not a different task. */
  function taskById(state, id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task)
      throw new RangeError(
        "That task is not present in this demo. It may have been reset or merged.",
      );
    return task;
  }

  /** Label missing, unallocated, or excluded attribution without inventing an active task interpretation. */
  function taskLabel(state, id) {
    if (!id) return "Unallocated";
    const task = taskById(state, id);
    if (!state.analyzed) return "Not analyzed";
    return task.excluded ? `Unallocated / ${task.title} excluded` : task.title;
  }

  /** Calculate unique task associations from the artifact's recorded operations after interpretation edits. */
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
      tasks: state.tasks.filter((item) => !item.excluded),
      completed: state.tasks.filter(
        (item) => !item.excluded && item.status === "Completed",
      ).length,
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

  /** Mark interpretation edits as requiring a new assessment, without running a model or changing source usage. */
  function changed(state) {
    state.revision += 1;
    state.analysisStale = true;
  }

  /** Reject empty task names instead of silently saving an unusable interpretation. */
  function validatedTitle(title) {
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 120)
      throw new RangeError("Use a task title between 1 and 120 characters.");
    return trimmed;
  }

  /** Save a user-supplied task label in this page's memory. */
  function renameTask(state, id, title) {
    const value = validatedTitle(title);
    const task = taskById(state, id);
    task.title = value;
    task.corrected = true;
    changed(state);
  }

  /** Reassign all evidence collections together so task edits cannot leave contradictory resource counts. */
  function reassign(state, predicate, destination) {
    [state.tools, state.requests, state.signals, state.intervals].forEach(
      (collection) => {
        collection.forEach((record) => {
          if (predicate(record)) record.taskId = destination;
        });
      },
    );
  }

  /** Validate and sort adjacent active ranges before either previewing or mutating a single-range merge. */
  function mergeSelection(state, ids) {
    const selected = [...new Set(ids)]
      .map((id) => taskById(state, id))
      .sort((a, b) => a.range[0] - b.range[0]);
    if (selected.length < 2 || selected.some((task) => task.excluded))
      throw new RangeError("Select at least two active tasks to merge.");
    if (
      selected.some(
        (task, index) =>
          index > 0 && selected[index - 1].range[1] + 1 !== task.range[0],
      )
    )
      throw new RangeError(
        "This single-range mockup can merge only adjacent task ranges. Select contiguous tasks without gaps.",
      );
    return selected;
  }

  /** Merge adjacent active tasks; keep every source record and derive completion from their outcomes. */
  function mergeTasks(state, ids, title) {
    const selected = mergeSelection(state, ids);
    const value = validatedTitle(title);
    const id = `merged-${state.nextTask++}`;
    const merged = {
      id,
      title: value,
      status: selected.every((task) => task.status === "Completed")
        ? "Completed"
        : "Partial",
      evidence: "Derived from merged outcomes",
      prompt: selected.map((task) => task.prompt).join("\n\n"),
      range: [
        Math.min(...selected.map((task) => task.range[0])),
        Math.max(...selected.map((task) => task.range[1])),
      ],
      corrected: true,
      excluded: false,
    };
    reassign(state, (record) => ids.includes(record.taskId), id);
    state.tasks = [
      ...state.tasks.filter((task) => !ids.includes(task.id)),
      merged,
    ].sort((a, b) => a.range[0] - b.range[0]);
    changed(state);
    return id;
  }

  /** Split one active task at a user-selected turn; preserve usage and mark the new outcome as uncertain. */
  function splitTask(state, id, turn, title) {
    const task = taskById(state, id);
    const value = validatedTitle(title);
    if (
      !Number.isInteger(turn) ||
      turn <= task.range[0] ||
      turn > task.range[1] ||
      task.excluded
    )
      throw new RangeError(
        "Choose a split turn inside the selected active task.",
      );
    const nextId = `split-${state.nextTask++}`;
    const next = {
      ...task,
      id: nextId,
      title: value,
      range: [turn, task.range[1]],
      status: "Uncertain",
      evidence: "Needs outcome review",
      corrected: true,
    };
    reassign(
      state,
      (record) => record.taskId === id && record.turn >= turn,
      nextId,
    );
    task.range = [task.range[0], turn - 1];
    task.corrected = true;
    task.status = "Uncertain";
    task.evidence = "Needs outcome review";
    state.tasks.push(next);
    state.tasks.sort((a, b) => a.range[0] - b.range[0]);
    changed(state);
    return nextId;
  }

  /** Adjust a non-overlapping active range; reject conflicts atomically and leave displaced records unallocated. */
  function adjustRange(state, id, start, end) {
    const task = taskById(state, id);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end > 28 ||
      start > end
    )
      throw new RangeError("Use an inclusive turn range between 1 and 28.");
    if (task.excluded)
      throw new RangeError("Restore this task before changing its segment.");
    const overlap = state.tasks.find(
      (other) =>
        other.id !== id && start <= other.range[1] && end >= other.range[0],
    );
    if (overlap)
      throw new RangeError(
        `This range overlaps "${overlap.title}". Keep task ranges separate, including excluded tasks.`,
      );
    reassign(
      state,
      (record) =>
        record.taskId === id && (record.turn < start || record.turn > end),
      null,
    );
    reassign(state, (record) => record.turn >= start && record.turn <= end, id);
    task.range = [start, end];
    task.corrected = true;
    task.status = "Uncertain";
    task.evidence = "Needs outcome review";
    changed(state);
  }

  /** Exclude or restore an interpretation without deleting its original events or session totals. */
  function excludeTask(state, id, excluded) {
    taskById(state, id).excluded = excluded;
    changed(state);
  }

  /** Save a human correction to one interaction's category; tags do not multiply the counted message. */
  function classifySignal(state, id, category) {
    const signal = state.signals.find((item) => item.id === id);
    if (!signal || !categories.includes(category))
      throw new RangeError(
        "Select a known interaction and involvement category.",
      );
    signal.category = category;
    signal.tags = [category];
    signal.confirmed = true;
    changed(state);
  }

  /** Update an artifact's reviewable purpose; unknown remains a valid, explicit classification. */
  function classifyArtifact(state, id, purpose) {
    const artifact = state.artifacts.find((item) => item.id === id);
    if (
      !artifact ||
      ![
        "Deliverable",
        "Temporary helper",
        "Supporting artifact",
        "Unknown",
      ].includes(purpose)
    )
      throw new RangeError("Select a known artifact and purpose.");
    artifact.purpose = purpose;
    artifact.confirmed = true;
    changed(state);
  }

  /** Record an explicit user outcome correction without presenting it as tool-verified evidence. */
  function setOutcome(state, id, status) {
    if (
      !["Completed", "Partial", "Blocked", "Abandoned", "Uncertain"].includes(
        status,
      )
    )
      throw new RangeError("Choose a supported outcome.");
    const task = taskById(state, id);
    task.status = status;
    task.evidence = "User-confirmed";
    task.corrected = true;
    changed(state);
  }

  return {
    createState,
    taskById,
    taskLabel,
    artifactTasks,
    unionMinutes,
    metrics,
    renameTask,
    mergeSelection,
    mergeTasks,
    splitTask,
    adjustRange,
    excludeTask,
    classifySignal,
    classifyArtifact,
    setOutcome,
    categories,
    steeringCategories,
  };
})();

if (typeof module !== "undefined" && module.exports)
  module.exports = InsightsModel;
