# Copilot analysis transport

The application includes the operational runner from
[#15](https://github.com/toddysm/agent-insights/issues/15): consent, an installed
Copilot connection, result validation, progress, cancellation and transient results.

**Real capture readers and interpretation definitions are separate work.**
The shipped definition registry is currently empty, so the interface says
"Analysis definitions are not installed yet." Configuring a source or detecting
Copilot does not by itself produce a session report. Task/outcome, steering,
artifact and prompt-coaching definitions belong to the subsequent work items.

## Install and select Copilot

Install GitHub Copilot CLI (command-line interface) separately. This application
does not install, update or silently substitute a harness. The qualified
combination is Copilot CLI **1.0.104**, Copilot SDK (software development kit)
**1.0.28**, and protocol version **3**. Other executable versions remain unavailable
until qualified, even if they are newer.

Follow the [local startup guide](local-runtime.md), then optionally specify:

```bash
npm start -- --source /path/to/capture.jsonl --harness copilot --model MODEL_ID
```

`--copilot-path /absolute/path/to/copilot` selects an explicit executable instead
of the native `copilot` executable on `PATH`. On Windows, use `copilot.exe`; shell
command shims are not executed through a shell. Restart after installing or
changing the executable, because installation status is cached for the launch.
Each analysis independently rechecks the runtime before sending evidence.

Leaving out `--model` lets Copilot choose its default. The application does not
invent a model identity when Copilot has not selected or reported one yet.
Reported effective model information appears separately with analysis usage.
An explicit model must be in the account's catalog; no alternative is silently
selected when it is unavailable.

Authentication uses the SDK's supported existing-user flow: the GitHub CLI login
or supported token environment. Existing GitHub CLI authentication was verified
without copying credential files. This isolated mode does not read credentials
out of another active Copilot conversation. A Copilot chat login alone may not
make SDK authentication available.

Managed-policy bootstrap also requires a **session-scoped** GitHub credential,
not merely client-level login. After acknowledgement, the application obtains
that credential in memory from the reported GitHub CLI account (`gh auth token`,
pinned to its reported host/user), or from the supported environment-token
precedence. It supplies the token only through the SDK protocol, never through
files, command-line arguments or logs. Unsupported authentication fails closed.
Locked managed model defaults are requested alongside managed permission policy.

Check `gh auth status` and make sure the selected account is the one you intend
to use. It may differ from another Copilot chat's account. If needed, authenticate
through `gh auth login` or the SDK's supported token flow outside this application.
Never put credentials in source files, capture files or launch arguments.

## Remote processing and acknowledgement

A local Copilot process is **not** on-device model inference. Analysis sends
selected messages and captured event information to Copilot's remote endpoint.
Content can include private code, paths or other sensitive material. Account
limits, billing and provider retention policies apply.

Once a reader and an analysis definition are available:

1. Read a configured source and select the session to analyze.
2. Select an installed analysis definition.
3. Review the disclosure and selected record count.
4. Check the acknowledgement, then select **Analyze**.

The acknowledgement resets when the source, session or analysis selection changes.
Source selection, source refresh and progress polling never initiate model
analysis. Only application-owned definitions can supply analysis instructions;
the browser cannot upload arbitrary prompts or register operations.

If the start response is lost, the interface locks another start while it
reconciles server status. It retries status reads, not the analysis request.
Reopening the full launch URL restores active-run progress and cancellation
without requiring the browser to retain its previous selection. Terminal errors,
usage and results remain scoped to the selected read, session and analysis.

## Isolation and retention

Each run uses a fresh, explicitly selected Copilot process over standard input
and output, not an existing chat or a bundled-runtime fallback.

- SDK empty mode, an empty tool allowlist and explicit exclusions disable tools.
- Permissions are denied; configuration discovery, skills, file hooks, custom
  instructions, host Git operations and the cross-session store are disabled.
- Managed organizational settings remain enabled. A failure is surfaced rather
  than bypassing enforced policy.
- Session files are served by a bounded, text-only **in-memory** filesystem.
  No application session database or SQLite provider is created.
- Session telemetry and client telemetry are disabled. Ambient tracing/debug
  configuration is not inherited; embedding caches are memory-only.
- The application never writes model requests, responses or analysis results to
  payload files, logs, browser storage, archives or saved jobs.

Copilot may create operational configuration, locks and program-cache metadata
in a private temporary directory. This is not a payload staging directory.
Qualification checks that synthetic prompt/response markers are absent from its
files while the session is alive and again after the runtime stops. The directory is removed after confirmed cleanup.
If stopping the process or removing its metadata fails, ownership is retained
and new analyses remain blocked, including after source refresh. Shutdown retries
the retained cleanup; repeated stop signals can retry a failed shutdown.

Application results and the selected read remain transient. Refresh or a new
read invalidates old results and cancels their analysis. Restarting the application
loses results; no archive or synchronization fallback exists. Provider-side
retention is governed separately by the provider's policies.

## Limits and failures

| Boundary                                       | Behavior                                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Serialized instructions plus selected evidence | At most 64 KiB; larger input is rejected before transmission                                                           |
| Model context                                  | Conservative UTF-8 byte admission with a 4,096-token overhead allowance and output reserve; this is not measured usage |
| Unresolved default / Auto routing              | Check all available concrete model budgets, excluding the non-model `auto` routing entry                               |
| Model output                                   | At most 128 KiB; invalid JSON, domain data or evidence references fail explicitly                                      |
| Virtual session-file content                   | At most 8 MiB and 512 entries; not a limit on the entire process's memory                                              |
| Run lifetime                                   | Two minutes; model response waiting is separately bounded                                                              |
| Concurrency                                    | One run including cleanup; additional starts are rejected, not queued                                                  |

Automatic context compaction is disabled. Evidence is not silently truncated to
fit. Select an explicit model with suitable context when the conservative default
budget is too small.

Results cite only events from the selected session/read and retain their original
source references. They are model judgments, not independent artifact verification.
Input-capture bounds are sent separately from parsing/normalization completion;
missing capture timing remains unavailable rather than becoming an observation timestamp.
Missing analysis input/output usage remains **Unavailable**, not zero. Analysis
usage never changes the subject session's captured usage.

**Cancel analysis** stops the owned transport and discards its result. Cancellation
cannot guarantee that a remote provider stops computation immediately or reverses
account usage. Refresh also discards the current read and analysis.

Unavailable executables, unqualified versions, authentication failures, unavailable
models, oversized context, invalid output and stale selections are explicit errors.
Raw SDK errors and payloads are not exposed in diagnostics.

## Developer validation and extension points

[Analysis contracts](../src/analysis/contracts.ts) separate provider transport from
application-owned interpretation definitions. [The runner](../src/analysis/runner.ts)
validates selection, acknowledgement, generation and result references.
Production does not register the [synthetic test definitions](../tests/fixtures/analysis.ts).

```bash
npm run check
npm test
npm run test:browser
COPILOT_QUALIFICATION_PATH=/absolute/path/to/copilot npm run test:copilot
```

The last command uses the **real selected Copilot executable** with a synthetic
loopback model. It needs no model credentials, performs no paid inference and
sends no private captures. It checks tool exclusion, unrelated instruction
exclusion, native cancellation and absence of synthetic payloads on disk.
These unauthenticated loopback cases explicitly exclude managed-policy bootstrap;
authenticated session creation with a session-scoped credential is qualified
separately, without sending a prompt or invoking a model. Hosted validation downloads
checksum-pinned 1.0.104 binaries solely into owned test directories on the
Linux, macOS and Windows runners; application startup does not download them.

The [authenticated qualification](../tests/copilot-auth-qualification.test.mjs)
also exercises prompt-bearing requests on the normal authenticated Copilot path.
It uses existing account metadata/policy authentication, but intercepts every
model request locally and returns synthetic responses. Nothing is forwarded to
a remote model, and payloads and credentials are audited while the session is
alive and after shutdown. This is separate from the unauthenticated hosted cases:

```bash
COPILOT_AUTH_QUALIFICATION=1 COPILOT_QUALIFICATION_PATH=/absolute/path/to/copilot npm run test:copilot-auth
```

One-shot Copilot requests use the supported non-WebSocket transport. Production
still sends acknowledged content to Copilot's remote service; only the opt-in
qualification substitutes local responses.

The SDK pins an older Zod release affected by
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
The dependency override uses the application's patched Zod version, with
compatibility covered by runtime qualification. Published SDK/JSON-RPC declarations
also conflict with the compiler's optional-property and iterator library checks.
`skipLibCheck` excludes declaration-file checking; strict application source
checking, including SDK calls, remains enabled. No third-party declaration-check
success is claimed.
