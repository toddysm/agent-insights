/** Verify the prototype's counting rules and correction semantics with synthetic evidence only. */
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../model.js");

/** Snapshot recorded session totals to detect accidental evidence loss during interpretation edits. */
function recordedTotals(state) {
  const { input, output, toolCalls, artifacts, activeMinutes } =
    M.metrics(state);
  return { input, output, toolCalls, artifacts, activeMinutes };
}

test("the complete synthetic report reconciles with the experience design", () => {
  const state = M.createState();
  const result = M.metrics(state);
  assert.equal(result.tasks.length, 3);
  assert.equal(result.completed, 2);
  assert.equal(result.steering, 4);
  assert.equal(result.artifacts, 6);
  assert.equal(result.deliverables, 4);
  assert.equal(result.helpers, 2);
  assert.equal(result.toolCalls, 27);
  assert.equal(result.distinctTools, 8);
  assert.equal(result.input, 12400);
  assert.equal(result.output, 1800);
  assert.equal(result.activeMinutes, 18);
  assert.equal(result.cumulativeMinutes, 20);
  assert.equal(
    state.tasks.reduce(
      (sum, task) => sum + M.metrics(state, task.id).artifacts,
      0,
    ),
    7,
  );
});

test("parallel or duplicate intervals do not inflate elapsed activity", () => {
  const intervals = [
    { start: 0, end: 60 },
    { start: 0, end: 60 },
  ];
  assert.equal(M.unionMinutes(intervals), 60);
  assert.equal(
    intervals.reduce((sum, item) => sum + item.end - item.start, 0),
    120,
  );
});

test("partial and transcript-only captures do not use zero for unavailable values", () => {
  const partial = M.metrics(M.createState("partial"));
  assert.equal(partial.input, null);
  assert.equal(partial.output, null);
  assert.equal(partial.missingUsage, 3);
  assert.equal(partial.toolCalls, 27);
  assert.equal(partial.steering, null);
  assert.equal(partial.artifacts, null);
  const transcript = M.metrics(M.createState("transcript"));
  assert.equal(transcript.toolCalls, null);
  assert.equal(transcript.activeMinutes, null);
  assert.equal(transcript.input, null);
});

test("two tags on one message count once and a category correction recalculates totals", () => {
  const state = M.createState();
  assert.equal(state.signals[0].tags.length, 2);
  assert.equal(M.metrics(state, "t1").steering, 2);
  M.classifySignal(state, "u08", "New requirement");
  assert.equal(M.metrics(state).steering, 3);
  assert.equal(M.metrics(state, "t1").steering, 1);
  assert.equal(state.signals[0].confirmed, true);
  assert.equal(state.analysisStale, true);
});

test("artifact purpose is reviewable without changing identity counts", () => {
  const state = M.createState();
  M.classifyArtifact(state, "a3", "Unknown");
  assert.equal(M.metrics(state).helpers, 1);
  assert.equal(M.metrics(state).artifacts, 6);
  assert.deepEqual(M.artifactTasks(state, state.artifacts[1]), ["t1", "t2"]);
});

test("merging reconciles shared artifacts and preserves recorded session usage", () => {
  const state = M.createState();
  const before = recordedTotals(state);
  const id = M.mergeTasks(state, ["t1", "t2"], "Reporting behavior");
  assert.equal(M.metrics(state).tasks.length, 2);
  assert.equal(M.metrics(state).completed, 1);
  assert.equal(M.metrics(state, id).artifacts, 4);
  assert.equal(M.metrics(state, id).toolCalls, 23);
  assert.equal(M.metrics(state, id).input, 11000);
  assert.equal(M.metrics(state).steering, 4);
  assert.deepEqual(recordedTotals(state), before);
});

test("splitting partitions evidence by turn and requires outcome review", () => {
  const state = M.createState();
  const before = recordedTotals(state);
  const id = M.splitTask(state, "t1", 9, "Follow-up export work");
  assert.equal(state.tasks.length, 4);
  assert.equal(M.taskById(state, id).status, "Uncertain");
  assert.equal(M.taskById(state, "t1").status, "Uncertain");
  assert.equal(M.metrics(state, id).input + M.metrics(state, "t1").input, 7000);
  assert.equal(M.metrics(state, id).steering, 1);
  assert.equal(M.metrics(state, "t1").steering, 1);
  assert.deepEqual(recordedTotals(state), before);
});

test("segment edits leave displaced records unallocated without losing them", () => {
  const state = M.createState();
  const before = recordedTotals(state);
  M.adjustRange(state, "t1", 4, 12);
  assert.ok(state.tools.some((tool) => tool.taskId === null));
  assert.equal(M.taskById(state, "t1").status, "Uncertain");
  assert.equal(M.taskLabel(state, null), "Unallocated");
  assert.deepEqual(recordedTotals(state), before);
});

test("exclude and restore change the interpretation, not the original session totals", () => {
  const state = M.createState();
  const before = recordedTotals(state);
  M.excludeTask(state, "t2", true);
  assert.equal(M.metrics(state).tasks.length, 2);
  assert.match(M.taskLabel(state, "t2"), /Unallocated/);
  assert.deepEqual(recordedTotals(state), before);
  M.excludeTask(state, "t2", false);
  assert.equal(M.metrics(state).tasks.length, 3);
});

test("overlapping range edits preserve every affected task and its outcome", () => {
  const state = M.createState();
  const before = structuredClone(state);
  assert.throws(() => M.adjustRange(state, "t1", 1, 20), /overlaps/);
  assert.deepEqual(state, before);
  M.excludeTask(state, "t2", true);
  const excluded = structuredClone(state);
  assert.throws(() => M.adjustRange(state, "t1", 1, 20), /overlaps/);
  assert.deepEqual(state, excluded);
  assert.throws(() => M.adjustRange(state, "t2", 16, 20), /Restore/);
});

test("single-range merges reject nonadjacent tasks and gaps without mutation", () => {
  const state = M.createState();
  const before = structuredClone(state);
  assert.throws(
    () => M.mergeTasks(state, ["t1", "t3"], "Disjoint work"),
    /adjacent task ranges/,
  );
  assert.deepEqual(state, before);
  M.adjustRange(state, "t1", 1, 12);
  const gap = structuredClone(state);
  assert.throws(
    () => M.mergeTasks(state, ["t1", "t2"], "Work with a gap"),
    /adjacent task ranges/,
  );
  assert.deepEqual(state, gap);
  const merged = M.mergeTasks(state, ["t3", "t2"], "Adjacent tasks");
  assert.deepEqual(M.taskById(state, merged).range, [15, 28]);
});

test("outcome and title corrections are explicitly user-authored", () => {
  const state = M.createState();
  M.renameTask(state, "t3", "Finish the usage guide");
  M.setOutcome(state, "t3", "Blocked");
  assert.equal(M.taskById(state, "t3").title, "Finish the usage guide");
  assert.equal(M.taskById(state, "t3").evidence, "User-confirmed");
  assert.equal(M.taskById(state, "t3").status, "Blocked");
});

test("source instruction anchors survive splits, ranges, and merges", () => {
  const state = M.createState();
  const source = M.instructionsForTask(state, "t1")[0];
  assert.equal(source.turn, 1);
  assert.equal(Object.isFrozen(source), true);
  const split = M.splitTask(state, "t1", 9, "Later CSV work");
  assert.equal(M.taskById(state, split).range[0], 9);
  assert.equal(M.instructionsForTask(state, split)[0].turn, 1);
  const restored = M.mergeTasks(state, ["t1", split], "CSV work");
  assert.deepEqual(M.instructionsForTask(state, restored), [source]);
  const merged = M.mergeTasks(state, [restored, "t2"], "Reporting work");
  assert.deepEqual(
    M.instructionsForTask(state, merged).map((item) => item.turn),
    [1, 15],
  );
  assert.equal(
    state.sessionInstruction.text,
    "Help me improve reporting in this app.",
  );
  assert.equal(state.sessionInstruction.id, "session-opening");
});

test("invalid inputs fail explicitly and do not mutate a valid fixture", () => {
  const state = M.createState();
  const before = structuredClone(state);
  assert.throws(() => M.createState("unknown"), RangeError);
  assert.throws(() => M.taskById(state, "missing"), RangeError);
  assert.throws(() => M.renameTask(state, "t1", " "), RangeError);
  assert.throws(
    () => M.mergeTasks(state, ["t1", "t1"], "Duplicate"),
    RangeError,
  );
  assert.throws(
    () => M.splitTask(state, "t1", 99, "Outside range"),
    RangeError,
  );
  assert.throws(() => M.adjustRange(state, "t1", 20, 2), RangeError);
  assert.throws(() => M.classifySignal(state, "u08", "Guess"), RangeError);
  assert.throws(() => M.classifyArtifact(state, "a1", "Guess"), RangeError);
  assert.deepEqual(state, before);
});

test("reset produces independent fixture state and keeps analysis overhead separate", () => {
  const first = M.createState();
  M.renameTask(first, "t1", "Changed");
  const fresh = M.createState("analysis-off");
  assert.equal(fresh.tasks[0].title, "Add CSV export");
  assert.equal(M.metrics(fresh).steering, null);
  assert.equal(M.metrics(fresh).input, 12400);
  assert.equal(fresh.analyzed, false);
  assert.equal(M.taskLabel(fresh, "t1"), "Not analyzed");
});
