# Run the local interface

The current runtime implements
[#9](https://github.com/toddysm/agent-insights/issues/9): source configuration,
availability checks, a controlled read boundary and an in-memory reader registry.
It does not yet include real capture readers, report views or a model adapter.
The interface states those limitations explicitly. The
[historical prototype](../design/session-insights/README.md) is separate and
continues to use fictional data.

## Install and start

Use Node.js 24 and npm. From the repository root:

```bash
npm ci --include=dev --ignore-scripts
npm start -- --source /path/to/private/captures
```

Install dependencies once per checkout, and again when the lockfile changes.
The development dependencies are needed to compile this source distribution.
`npm start` runs `npm run build` automatically before launching; it does not
install packages or start an older build when compilation fails.

Git does not contain the generated `.build` directory. Pulling or cloning the
repository alone therefore does not prepare it to run. On older revisions that
lack automatic startup building, run `npm run build` before `npm start`.
If you deliberately disable npm lifecycle scripts for startup, build explicitly
first. The `--ignore-scripts` flag in the installation command above applies
only to installation; it does not disable later startup hooks.

`--source` can name a file or directory; repeat it for additional locations, up
to 32. Relative paths resolve against the startup directory. Shell-expanded home
paths work; the application does not expand a quoted literal `~`.
No locations are discovered or scanned automatically. Starting without sources
is valid and displays "No sources configured."

The server binds only to `127.0.0.1`. Its default port is chosen by the operating
system, avoiding collisions with other local services. Use `--port NUMBER` to
request a specific port; `--port 0` restores automatic selection.

Open the full launch URL printed by the server. Its fragment contains a
per-process access credential:

```text
http://127.0.0.1:<port>/#access=<generated-value>
```

Treat that URL like a password; do not share or commit it. The browser removes
the credential from the visible URL and retains it only in memory. A page reload
therefore requires reopening the original launch URL. The "Refresh sources"
button does not reload the page or lose access. Restarting the process changes
the credential. Stop the runtime with Ctrl+C.

## Source selection and limits

Configured locations are checked for availability and shown only after
authentication. A missing or unreadable startup location remains unavailable;
correct it and restart to grant access. Existing authorized locations can be
rechecked with "Refresh sources."

For a directory grant, a reader request must name a relative file inside it.
A file grant cannot read neighboring files. Traversal, cross-drive paths, links
escaping the canonical grant, and retargeted configured links are rejected.
Only regular files are read, using read-only descriptors. A single read is
limited to 64 MiB; oversized captures produce an explicit error, not silent
truncation. There are no filesystem watchers.

No production reader is registered yet, so "Read source" is disabled in this
build. Internal adapters use the existing
[reader contract](evidence-contracts.md); tests use synthetic adapters, not real
capture support. Future readers receive a bounded byte stream and cancellation
signal, not permission to select arbitrary paths.

Read views remain in process memory. Refresh, cancellation and process shutdown
discard the current view. An older operation cannot publish a result after a
newer read or refresh. Source-change metadata is a best-effort observation, not
a claim of an atomic filesystem snapshot. This is not a security sandbox against
a hostile process already running with the same operating-system account.

The view's read-completion timestamp includes adapter parsing and normalization.
Authenticated status retains the separate input-capture bounds in `readTiming`,
so processing latency is not mistaken for newer source observation. Source-change
checks apply to that input-capture interval, not to later adapter computation.
The read deadline also uses a monotonic elapsed-time check before publication:
synchronous parsing cannot publish an overdue result merely because it delayed
the timeout callback. Cancellation cannot preempt JavaScript that is currently
blocking the event loop, but its eventual result is rejected.

## Copilot configuration and remote processing

The approved first backend is installed Copilot. These startup options record
the requested preferences but do not launch or authenticate Copilot yet:

```bash
npm start -- --source /path/to/capture.jsonl --harness copilot --model MODEL_ID
```

Use `--copilot-path PATH` to record an explicit executable preference. If no model
is requested, the interface displays the harness default as not connected;
it does not invent an effective model. Other harness names are rejected rather
than silently substituted.

**A local harness does not mean local model inference.** Once the analysis
adapter is implemented and qualified, selected conversation messages and relevant
tool results may be sent to Copilot's remote service. They can contain source
code, private paths or other sensitive material. Provider/account retention,
data-handling and usage limits still apply.

The interface displays this notice now. The future analysis action must require
an explicit acknowledgement before transmission; source selection and refresh
must never send capture content to a model. No model connection occurs in this
runtime release.

The application must not persist source payloads or results in a database,
browser storage, history, logs or archives. The Copilot adapter must additionally
prove that its own transcript/debug/telemetry/cache behavior meets that policy,
with tools and unrelated customizations disabled. If the installed version or
enforced policy cannot provide those controls, analysis remains unavailable.
Credentials stay with supported harness authentication; the application must
not copy auth files or silently fall back to another provider.

Provider/cloud decisions are recorded in
[#7](https://github.com/toddysm/agent-insights/issues/7), with integration tracked
in [#15](https://github.com/toddysm/agent-insights/issues/15). The initial
completion/rubric defaults are approved; implementing and qualifying the actual
adapter is still outstanding.

## Errors and validation

- **Missing dependencies or generated CLI:** run
  `npm ci --include=dev --ignore-scripts`, then `npm start`. For an older revision,
  run `npm run build` between those commands.
- **Access required:** reopen the full launch URL; do not put the credential in
  a query parameter or browser storage.
- **Unavailable location:** check the configured path and permissions, then
  restart if it was unavailable at startup or its target/type changed.
- **No reader installed:** the capture format is not implemented in this build;
  no example data or zero-valued report replaces it.
- **Read cancelled / timed out:** retry through the interface. A stale result is
  never attached to a newer read.
- **Unexpected failure:** the server reports a diagnostic code, not raw request
  bodies, source text, credentials or exception stacks.

Developer checks:

```bash
npm run check
npm test
npx playwright install chromium
npm run test:browser
```

The application workflow runs Node.js 24 type/unit/integration checks on Ubuntu,
Windows and macOS, plus the real runtime walkthrough in Chromium on Ubuntu.
These checks do not certify every capture format, model, browser or platform
configuration. Capture setup remains the separate guide in
[#1](https://github.com/toddysm/agent-insights/issues/1).
