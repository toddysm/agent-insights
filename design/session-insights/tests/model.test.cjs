/** Verify synthetic read-only counting and source-bound analysis; no real captures or model calls. */
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../model.js");

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
    state.tasks.reduce((sum, task) => sum + M.metrics(state, task.id).artifacts, 0),
    7,
  );
  assert.equal(state.signals[0].tags.length, 2);
  assert.equal(M.metrics(state, "t1").steering, 2);
  assert.deepEqual(M.artifactTasks(state, state.artifacts[1]), ["t1", "t2"]);
});

test("parallel or duplicate intervals do not inflate elapsed activity", () => {
  assert.equal(M.unionMinutes([{ start: 0, end: 60 }, { start: 0, end: 60 }]), 60);
});

test("activity lanes reconcile known states and unknown gaps without adding overlapping execution", () => {
  const state = M.createState();
  const summary = M.activitySummary(state);
  const lanes = Object.fromEntries(summary.lanes.map((lane) => [lane.id, lane]));
  assert.equal(lanes.model.minutes + lanes.work.minutes, 20);
  assert.equal(summary.executionMinutes, 18);
  assert.equal(summary.outsideExecutionMinutes, 24);
  assert.equal(summary.executionMinutes + lanes.waiting.minutes + lanes.quiet.minutes + lanes.unknown.minutes, summary.observedMinutes);
  assert.deepEqual(lanes.unknown.spans, [{ start: 16, end: 22 }, { start: 32, end: 36 }, { start: 38, end: 42 }]);
  assert.equal(lanes.waiting.basis, "Recorded");
  assert.equal(lanes.quiet.basis, "Inferred");
  state.intervals.push({ ...state.intervals[0] });
  assert.equal(M.activitySummary(state).executionMinutes, 18);
  assert.equal(M.activitySummary(state).lanes[0].minutes, lanes.model.minutes);
});

test("missing lifecycle coverage never becomes measured waiting or idle time", () => {
  for (const mode of ["partial", "transcript"]) {
    const summary = M.activitySummary(M.createState(mode));
    for (const lane of summary.lanes.filter((item) => ["waiting", "quiet"].includes(item.id))) {
      assert.equal(lane.minutes, null);
      assert.equal(lane.spans, null);
    }
    assert.equal(summary.lanes.find((item) => item.id === "unknown").minutes, mode === "partial" ? 24 : 42);
    assert.equal(summary.executionMinutes, mode === "partial" ? 18 : null);
  }
});

test("activity contributors resolve to the same source interaction, task and tool duration", () => {
  const state = M.createState();
  for (const span of state.intervals) {
    const records = span.kind === "model" ? state.requests : state.tools;
    const source = records.find((item) => item.id === span.sourceId);
    assert.ok(source, `Missing activity contributor ${span.sourceId}`);
    assert.equal(span.turn, source.turn, `Interaction mismatch for ${span.sourceId}`);
    assert.equal(span.taskId, source.taskId, `Task mismatch for ${span.sourceId}`);
    assert.deepEqual(source.timing, { startMinute: span.start, endMinute: span.end });
    if (span.kind === "work") assert.equal((span.end - span.start) * 60000, source.durationMs);
  }
  assert.equal(state.requests.find((item) => item.id === "m2").timing, null);
  assert.equal(state.tools.find((item) => item.id === "c27").timing, null);
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

test("refresh discards interpretations without changing recorded evidence or starting analysis", () => {
  const state = M.createState();
  const evidence = structuredClone([state.tasks, state.signals, state.artifacts, state.tools, state.requests]);
  M.refreshSource(state);
  assert.equal(state.readId, 2);
  assert.equal(state.run, null);
  assert.equal(state.analyzed, false);
  assert.equal(M.metrics(state).steering, null);
  assert.equal(M.metrics(state).completed, null);
  assert.deepEqual(M.metrics(state).tasks, []);
  assert.equal(M.metrics(state).input, 12400);
  assert.deepEqual([state.tasks, state.signals, state.artifacts, state.tools, state.requests], evidence);
});

test("missing and changed sources cannot produce success-shaped metrics or analysis", () => {
  for (const result of ["unavailable", "changed"]) {
    const state = M.createState();
    M.refreshSource(state, result);
    assert.throws(() => M.metrics(state), /unavailable/);
    assert.throws(() => M.beginAnalysis(state, true), /message content/);
    assert.equal(state.analyzed, false);
    M.refreshSource(state);
    assert.equal(M.metrics(state).input, 12400);
    assert.equal(state.analyzed, false);
  }
});

test("analysis requires acknowledgment and usable content; duplicate starts are rejected atomically", () => {
  const state = M.createState("analysis-off");
  assert.throws(() => M.beginAnalysis(state, false), /Acknowledge/);
  assert.throws(() => M.beginAnalysis(M.createState("partial"), true), /message content/);
  assert.throws(() => M.beginAnalysis(M.createState("empty"), true), /message content/);
  const id = M.beginAnalysis(state, true);
  const before = structuredClone(state);
  assert.throws(() => M.beginAnalysis(state, true), /running analysis/);
  assert.deepEqual(state, before);
  assert.equal(M.metrics(state).toolCalls, 27);
  M.finishAnalysis(state, id, "complete");
  assert.equal(M.metrics(state).steering, 4);
  assert.equal(M.metrics(state).input, 12400);
});

test("failed, cancelled, and superseded results cannot be accepted by a later run/read", () => {
  for (const status of ["failed", "cancelled", "superseded"]) {
    const state = M.createState("analysis-off");
    const id = M.beginAnalysis(state, true);
    if (status === "superseded") M.refreshSource(state);
    else M.finishAnalysis(state, id, status);
    const before = structuredClone(state);
    assert.throws(() => M.finishAnalysis(state, id, "complete"), /no longer current/);
    assert.deepEqual(state, before);
    assert.equal(state.analyzed, false);
    const retry = M.beginAnalysis(state, true);
    assert.throws(() => M.finishAnalysis(state, id, "complete"), /no longer current/);
    M.finishAnalysis(state, retry, "complete");
    assert.equal(state.analyzed, true);
    assert.equal(state.run.readId, state.readId);
  }
});

test("invalid inputs fail without mutating the fixture and reset restores independent evidence", () => {
  const state = M.createState();
  const before = structuredClone(state);
  assert.throws(() => M.createState("unknown"), RangeError);
  assert.throws(() => M.taskById(state, "missing"), RangeError);
  assert.throws(() => M.refreshSource(state, "guess"), RangeError);
  assert.throws(() => M.finishAnalysis(state, 1, "guess"), RangeError);
  assert.throws(() => M.finishAnalysis(state, undefined, "complete"), /no longer current/);
  assert.deepEqual(state, before);
  M.refreshSource(state);
  const fresh = M.createState();
  assert.equal(fresh.readId, 1);
  assert.equal(fresh.analyzed, true);
  assert.equal(fresh.run, null);
  assert.equal(M.instructionsForTask(fresh, "t1")[0].turn, 1);
  assert.equal(fresh.sessionInstruction.id, "session-opening");
});
