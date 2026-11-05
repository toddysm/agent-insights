# Native database helper protocol v1

This is the private, short-lived process boundary delivered by
[#37](https://github.com/toddysm/agent-insights/issues/37). It is not a browser
endpoint, a query console, a producer runtime or an application database.
The [source guard](README.md) still owns all SQLite file operations.

The trusted application parent authorizes and pins the source, selects
application-owned declarations, and verifies the helper artifact **before**
launch. Captured content, browser controls and model responses must never
supply declarations, query identifiers or database paths. Structural validation
here does not prove that the parent authorized a path. A database filename found
inside a captured row is data, never another grant.

## Launch and handshake

Build from the repository root with the pinned toolchain/configuration:

```sh
cargo build --locked --manifest-path native/sqlite-guard/Cargo.toml --bin agent-insights-sqlite-helper
```

Launch the resulting executable directly, without a shell:

```text
agent-insights-sqlite-helper --parent-pid <actual-direct-parent-pid> --lifetime-ms 30000
```

The parent supplies its own process identifier, not one from a capture. Lifetime
must be 1..30000 milliseconds. Do not inherit provider credentials, debugger
options or loader customization. The helper creates threads but no child
processes, daemon, session replica or temporary source database.

The helper first sends `hello`, containing:

| Field                | Contract                                                                   |
| -------------------- | -------------------------------------------------------------------------- |
| `protocolVersion`    | Exactly `1`                                                                |
| `guardVersion`       | Crate version, currently `0.1.0`                                           |
| `sqliteSourceId`     | Complete pinned identifier from [the engine contract](src/lib.rs)          |
| `target`             | One of the four qualified target triples listed in [the README](README.md) |
| `qualificationHooks` | Must be `false` for a serving/released helper                              |
| `maxRequestBytes`    | `1048576`                                                                  |
| `maxReplyBytes`      | `25165824`                                                                 |

`--check` performs source-free engine/interface inspection, emits one framed
`hello`, and exits. A qualification build can describe itself through
`--check`, but refuses normal serving with exit code 65. Packaging must reject
such a binary. A handshake is a compatibility check, not an authenticity proof
or a replacement for artifact checksum verification.

## Frames and state

Every frame is a four-byte unsigned **big-endian** payload length, followed by
exactly that many UTF-8 bytes containing one JSON (JavaScript Object Notation)
object. There are no newline delimiters. A zero or oversized prefix is rejected
before allocating the payload. Unknown fields, malformed JSON, duplicate
binding names and out-of-order identifiers are rejected.

Request identifiers start at 1 and increase by exactly one. Use one outstanding
request at a time; the implementation has only one queued slot, and excess
pipelining is a protocol failure. For open, query and close, `started` precedes
the terminal reply with the same identifier. `cancel` terminates immediately
without promising an acknowledgement.
Validated requests arm their deadlines in the input thread before queueing.
The watchdog enforces the earliest active or queued deadline; finishing an
earlier response cannot erase a queued request's timer.

The state sequence is `hello -> open -> query* -> close -> exit(0)`. Reopening,
queries before open, and close before open fail. An error is terminal: no
continuation, empty-row substitution or alternate engine is used.

**Keep standard input open through the successful close acknowledgement and
process exit.** End-of-file terminates the read with `CHANNEL_LOST` (exit 69),
including at a frame boundary. It is distinct from an explicit `cancel` request,
which terminates with `CANCELLED` (exit 66).
Unexpected exit, a truncated reply, broken output or missing close acknowledgement
invalidates the entire read generation, even if earlier row replies arrived.
The parent must await actual exit before releasing its source lease or admitting
a replacement read; sending a kill signal is not proof of cleanup.
The parent should enforce its own spawn/handshake deadline and use operating-system
process termination on cancellation, especially if a partially written request
prevents an in-band cancel frame from being decoded. Native lifetime monitoring
starts once direct-parent supervision is established.

## Requests

The exact wire shapes and declaration bounds are implemented in
[wire.rs](src/helper/wire.rs) and [query.rs](src/helper/query.rs).

### Open

```json
{
  "kind": "open",
  "id": 1,
  "protocolVersion": 1,
  "path": "/parent-authorized/source.db",
  "timeoutMs": 5000,
  "definition": {
    "userVersions": [1],
    "tables": [
      { "name": "items", "columns": ["id", "value"], "primaryKey": ["id"] }
    ],
    "queries": [
      {
        "id": "by_id",
        "table": "items",
        "columns": ["id", "value"],
        "filters": [{ "column": "id", "parameter": "id" }]
      }
    ]
  }
}
```

Paths must be absolute and already authorized by the parent. Declarations are
the same restricted model used by the shared-access work:

- At most 32 nonnegative signed-32-bit user versions, 32 tables and 64 queries.
- Identifiers match `[A-Za-z_][A-Za-z0-9_]{0,63}`; table/query names are unique.
- Tables declare 1..64 unique columns and 1..16 primary-key columns, in order.
- Queries select declared columns and preserve every primary-key component.
- At most 16 equality filters use placeholders. An optional `jsonPath` contains
  1..16 identifier/index components, with indices 0..10000. Explicit null is
  not an omitted path.
- No query text, joins, attachments, extensions or source-derived identifiers.

Schema admission checks the actual user version, ordinary main-schema tables,
columns, absence of hidden/generated columns, and primary-key order. Views and
virtual tables are rejected. Admission is repeated inside each query's snapshot;
a different user version later in the same helper is a schema failure, even if
both versions occur in the declaration's supported list.

A successful open produces:

```json
{"kind":"started","id":1}
{"kind":"opened","id":1,"userVersion":1,"snapshotScope":"request"}
```

These are separate framed objects, not a newline-based stream.

### Query

```json
{
  "kind": "query",
  "id": 2,
  "queryId": "by_id",
  "bindings": { "id": { "type": "integer", "value": "1" } },
  "maxRows": 1,
  "maxBytes": 1024,
  "timeoutMs": 5000
}
```

Bindings must have exactly the declared parameter names; at most 16 unique
names are admitted. Values never replace query text or identifiers.

| Cell                  | Wire form                                                      |
| --------------------- | -------------------------------------------------------------- |
| Null                  | `{"type":"null"}`                                              |
| Signed 64-bit integer | `{"type":"integer","value":"9223372036854775807"}`             |
| Finite real           | `{"type":"real","value":1e-7}`                                 |
| Valid UTF-8 text      | `{"type":"text","value":"example"}`                            |
| Bytes                 | `{"type":"blob","value":"AP8="}` using canonical padded base64 |

Integers require canonical decimal strings; overflow and leading-zero variants
are rejected. Reals use round-trip parsing. Embedded null characters in text and
empty blobs remain distinct from null cells. Invalid UTF-8/nonfinite source values
fail rather than being replaced. Original keys support integer, real and text
components; null/blob keys are explicitly unsupported.

For a synthetic `items(1, 'example')` row, the following result has a verified
fingerprint and byte cost. Observation timestamps here are illustrative:

```json
{
  "kind": "rows",
  "id": 2,
  "rows": [
    {
      "values": {
        "id": { "type": "integer", "value": "1" },
        "value": { "type": "text", "value": "example" }
      },
      "table": "items",
      "key": [{ "column": "id", "type": "integer", "value": "1" }],
      "fingerprint": "c632c20f165603ff8f940b609789506e9a4bb1759c1fcf277de1cc6832467177"
    }
  ],
  "bytes": 206,
  "observation": {
    "startedAtMs": 1000,
    "finishedAtMs": 1001,
    "changed": false,
    "snapshotScope": "request"
  }
}
```

### Close and cancel

`{"kind":"close","id":3}` ends the source connection before sending
`{"kind":"closed","id":3,"observation":...}` and exiting successfully.
`{"kind":"cancel","id":3}` terminates actual process work with exit code 66.
The latter is not a successful close or a successful empty result.

## Snapshots, provenance and budgets

Write-ahead logging (WAL) mode retains the connection snapshot. Rollback mode
uses a bounded transaction around schema admission and each named projection,
then releases it **before replying**. It does not retain locks while waiting for
another request; separate rollback requests can observe different commits.
There is no global atomic multi-source snapshot. `changed` combines observed
metadata/data-version changes; it is not proof that no undetected content change
occurred. Parent-owned grant/identity verification is still required around
operations and final publication.

The fingerprint is SHA-256 over UTF-8 JSON of the selected columns **in declared
order**, with the previous reader's tagged values:

```text
[[column, ["integer", decimalString]],
 [column, ["number", finiteNumber]],
 [column, ["string", text]],
 [column, ["blob", base64]],
 [column, ["null", null]]]
```

Only the selected cells appear; this is a projection witness, not a hash of the
whole database or a normalized event. Finite-number formatting follows
ECMAScript, including exponent notation and negative zero, to match the
existing JavaScript key/fingerprint contract.

`bytes` is the sum, per row, of:

1. The UTF-8 byte length of that ordered tagged projection.
2. The UTF-8 byte length of JSON for `{table, key, fingerprint}`.

The helper streams counting/hashing so a large escaped projection does not need
an unbounded intermediate string. The actual framed reply has a separate cap.

| Bound                                                       | Maximum                             |
| ----------------------------------------------------------- | ----------------------------------- |
| Source main file plus companions                            | 64 MiB (existing guard limit)       |
| Incoming frame                                              | 1 MiB                               |
| Outgoing frame                                              | 24 MiB                              |
| Tagged binding values, including outer array/separators     | 8192 bytes                          |
| Query result rows, per request **and** per helper           | 10000                               |
| Encoded result cost, per request **and** per helper         | 8 MiB                               |
| Data queries per helper                                     | 256                                 |
| Generated query text                                        | 4096 bytes                          |
| Open/query/close operation                                  | 5000 ms, or a lower requested bound |
| Process lifetime, including idle/partial-frame/output waits | 30000 ms, or lower launch bound     |

The parent can only lower request budgets. One-over results fail without a
partial rows reply. Schema reads have their own bounded internal iteration.
These are protocol/source/result limits, not a general operating-system memory
sandbox. SQLite and serialization need bounded working memory in addition to
returned cell bytes.

## Supervision and failures

An independent input thread observes cancellation, malformed input and channel
loss while the main thread is in SQLite. An independent watchdog observes
monotonic deadlines and parent lifetime, including while output blocks. Unix
compares the verified direct parent; Windows retains a waitable parent handle
and checks creation ordering against PID reuse. Missing supervision fails
closed. Deadlines are checked again before/after replies; polling is 10 ms,
subject to operating-system scheduling.

Out-of-band termination performs no diagnostic I/O that could itself block.
The exit code is authoritative when no error frame can be sent. Ordinary failures
may send `{"kind":"error","id":2,"code":"LIMIT"}` and then exit nonzero.
Diagnostics contain fixed codes only, not paths, payloads, query text or native
exception messages.

| Exit | Meaning / error codes                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Source-free check, or confirmed normal close                                                                                                                  |
| 64   | `PROTOCOL`                                                                                                                                                    |
| 65   | `GUARD_UNAVAILABLE`, `ENGINE_MISMATCH`, `POLICY_VIOLATION`                                                                                                    |
| 66   | `CANCELLED`                                                                                                                                                   |
| 67   | `DEADLINE`                                                                                                                                                    |
| 68   | `PARENT_LOST`                                                                                                                                                 |
| 69   | `CHANNEL_LOST` / failed output                                                                                                                                |
| 70   | `ACCESS_DENIED`, `SOURCE_UNAVAILABLE`, `SOURCE_CHANGED`, `IO`, `BUSY`, `RECOVERY_REQUIRED`, `JOURNAL_PRESENT`, `SCHEMA`, `QUERY`, `BINDINGS`, `DATA`, `CLOCK` |
| 71   | `LIMIT`                                                                                                                                                       |
| 72   | `CLEANUP`                                                                                                                                                     |

Journal presence does not diagnose required recovery: idle TRUNCATE/PERSIST
sources retaining journals remain unadmitted, while an active DELETE writer can
be retried after it removes its own journal. No helper recovery or migration
is performed. Failed cleanup takes precedence over an otherwise usable result.
Aborting a failed request performs cleanup without requesting final observations,
so a secondary observation error cannot replace the original request failure.
Diagnostic writes are best-effort and cannot replace its selected exit code.

## Integration boundary and validation

[#33](https://github.com/toddysm/agent-insights/issues/33) must replace its private
Node interprocess transport, not its public normalized evidence contracts:

- Verify prepared artifacts from [#38](https://github.com/toddysm/agent-insights/issues/38)
  before launch; compare the complete handshake before granting source access.
- Serialize only its registered code-owned declarations and authorized source
  path. Keep file/sidecar leases and before/after identity checks.
- Bound and validate frames/replies, correlate identifiers, decode integer strings
  to `bigint` and blobs to bytes, and reject incompatible shapes/categories.
- Preserve aggregate multi-source budgets and original row references. This
  protocol's accounting/fingerprints match the existing declaration model.
- Await exit before releasing ownership; preserve the serialized cleanup barrier.
  Guard/integrity/cleanup/protocol failures must not become optional empty input.

The executable is not yet installed or wired into the local web application.
Publication remains separately gated in
[#39](https://github.com/toddysm/agent-insights/issues/39).

Rust and real subprocess tests cover exact/one-over frames, binding/result/row/query
budgets, keys/cells/fingerprints, rejected schemas and malformed input, active
writers, broken/blocked output, deadlines and cancellation during blocked native
work. Parent-loss qualification keeps the control-pipe writer open independently,
so end-of-file cannot substitute for proving parent supervision. Tests use only
owned synthetic sources and run on the native platform matrix.
