# Prepare VS Code Copilot evidence

Use this guide to prepare and check evidence from **Copilot Agent Host sessions
in the Visual Studio Code (VS Code) editor**. Start with retained native history;
additional telemetry is optional. You do not need to switch to the Local harness,
weaken sandbox permissions or replace organization-managed settings.

**Status, checked 2026-11-16:** the source/setup qualification in
[#30](https://github.com/toddysm/agent-insights/issues/30) is complete. Native
conversation and execution backends are implemented, but **not available for
production reads with the currently pinned helper**. Optional Agent Host
per-call telemetry remains unqualified in
[#34](https://github.com/toddysm/agent-insights/issues/34).
This guide separates preparing evidence from a working end-to-end analyzer.
See [application availability](#application-availability) before selecting sources.

## Quick start: Copilot Agent Host

1. Record your VS Code version/build from **Help: About**, active profile,
   operating system (OS), Copilot extension version and, where reported, runtime
   version. Note which machine runs the agent: your desktop, a remote host,
   container or managed environment. Do not publish private paths or identifiers.
2. Confirm that the session target is **Copilot Agent Host**. Ask/Agent mode
   describes interaction behavior, not the execution harness. A session in the
   editor, or one running on your own machine, is not necessarily Local.
   The separate Copilot command-line interface (CLI) used to execute analysis is
   not the producer of these editor sessions.
3. Prefer an existing harmless test session. Agent Host already retains
   [native history and identity metadata](#what-evidence-is-available);
   that baseline does not require OpenTelemetry (OTel).
4. For prospective Agent Debug Logs, open the Command Palette with
   Cmd+Shift+P on macOS or Ctrl+Shift+P on Windows/Linux. Run
   **Preferences: Open User Settings (JSON)** and merge
   `"chat.agentHost.agentDebugLog.enabled": true` into the existing top-level
   object. Do not replace unrelated settings.
5. Coordinate interruption of other work, then **fully quit and restart VS Code**,
   including other windows using the shared host, before starting a new Agent
   Host test session. Reload-only activation of this host-side logging key has
   not been verified by this guide; use a full restart rather than assuming
   **Developer: Reload Window** applied it. Logging is not retroactive.
   New prompts can invoke remote models and incur usage; obtain the necessary
   permission before generating a test.
6. Run **Developer: Open Agent Debug Logs**, select that session, and use the
   [verification checklist](#verify-capture-end-to-end). Missing controls or
   fields are compatibility/coverage findings, not proof of no activity.
7. Only if you need additional prospective traces, review privacy, effective
   policy and the [optional Agent Host exporter](#optional-agent-host-export).
   Do not enable the extension's exporter as a substitute.

## What evidence is available?

Capture files and databases belong to the harness. The analyzer reads explicitly
selected sources **in place** and holds read/analysis results transiently in
memory. It has no mirrored session database, persistent normalized corpus,
saved analysis history, manual corrections, synchronization or archive fallback.
Harness-generated exports are optional source representations, not an import
requirement. Reading a source does not invoke analysis or a model.

| Source | Useful evidence | What it does not establish |
| --- | --- | --- |
| Agent Host catalog/session index | Current host owner/chat, native backing and storage mappings; archive/tombstone state | A complete conversation, prompt or model-call ledger |
| Native Copilot event history | Retained instructions/responses, turn/tool lifecycle events and original event identities | Exact typed text, every model request, complete input/output usage |
| Host session overlay database | Turn/event bridges and retained usage observations for a verified chat | An additive per-call ledger; a display response alone is not model input |
| Saved/exported conversation | Available message content for tasks, steering and prompt assessment | Guaranteed timing, tool details, token fields or native identity; export formats differ |
| Agent Debug Logs (Preview) | Runtime-dependent requests, tools, timestamps, tokens and child relationships; manual export | Guaranteed persistence, complete content or identical controls across builds |
| OTel traces | Recorded model/tool/agent spans, timing and reported usage; content when actually emitted and captured | Retroactive recovery, exact human typing/idle time or universally complete child spans |

For Agent Host, the qualified producer-owned locations are:

| Logical source | Producer-root placeholder |
| --- | --- |
| Authoritative catalog | `<appSettingsHome>/globalStorage/agent-host.db` |
| Native history | `<CopilotHome>/session-state/<sdkConversationId>/events.jsonl` |
| Host overlay | `<userData>/agentSessionData/<storage-key>/session.db` |

These are **not literal paths or instructions to scan your home directory**.
Profiles, installations and remote hosts can have different roots.
`CopilotHome` follows the producer's `COPILOT_HOME` override or default `.copilot`
home. Shared Copilot history can contain other clients: a directory name or
matching text does not prove Agent Host ownership. The catalog must establish the
exact host/chat/native mapping; do not guess the overlay storage key.
See the [qualified identity and accounting contract](evidence-contracts.md#agent-host-native-evidence-handoff).

Session/task elapsed time needs recorded timestamps and explicit task boundaries.
Tools need recorded invocations/results; artifact claims are grounded in those
recorded arguments/results, **not independent live filesystem, Git or GitHub
verification**. Semantic tasks, steering and prompt assessment need actual
instruction/response content. Metadata-only historical sources can still support
limited timing or counts, but not content-based conclusions.

**Missing is not zero; partial totals are not complete totals.** Do not add a
parent's usage to already included child usage, whole-turn to direct-turn totals,
or shutdown snapshots to turn totals. A native assistant turn is not a model call.
The historical Agent Host test retained turn usage but no per-call usage.
None of these settings measures exact human typing time or true human idle time.
Enabling capture later cannot reconstruct missing content, tokens, tools or
child spans from an earlier session.

## Privacy and settings scope

Full-content capture can include source code, prompts, system instructions,
paths, tool definitions/results and credentials. It does **not** promise automatic
secret redaction. Keep raw captures out of source control, public issues,
published fixtures and shared/synced directories. Use synthetic examples in
reports; do not upload private evidence merely to test capture.

Before enabling content, identify the effective exporter, destination, exporting
machine, access controls and retention policy. Local-file selection and export
over OpenTelemetry Protocol (OTLP) to a network collector are different routes.
A private file does not make normal Copilot inference on-device.
Keep identity capture off; personal identity is not required.

### User, profile, workspace and inherited configuration

- **Preferences: Open User Settings (JSON)** edits defaults for the current
  profile. Check the active profile in each window; profile settings can differ.
- **Preferences: Open Workspace Settings (JSON)** exposes corresponding
  workspace overrides. The pinned extension exporter declarations use the
  default **window** scope, not a workspace-only restriction. Recheck scope in
  your installed version; this is not a claim that every host setting has that scope.
- In a multi-root window, a window-scoped exporter is not independent per-folder
  configuration. User-level output is a fixed destination, not an automatic
  per-workspace directory template.
- Search Settings for `@id:github.copilot.chat.otel.outfile` (extension) or
  `@id:chat.agentHost.otel.outfile` (host). Inspect modified values and their scope.
  To inherit User Settings, **remove the workspace key**, or reset it at the
  Workspace scope. An empty-string override is not the same as removing it.
- Remote windows can have Remote Settings and a different execution host.
  A destination path refers to the machine doing the exporting, not necessarily
  the machine displaying the editor. Verify that machine's effective settings,
  permissions and private home directory.
- For the inspected extension exporter, `COPILOT_OTEL_FILE_EXPORTER_PATH`
  overrides the editor's `github.copilot.chat.otel.outfile`. Inherited
  `COPILOT_OTEL_*` and `OTEL_*` variables can also affect enablement, content,
  protocol and endpoint. A terminal opened later is not proof of the environment
  inherited by an already-running editor/host.
- Managed values can override personal settings. Managed Agent Host file routing
  has its own precedence: in the pinned host configuration translation,
  inherited parent-process environment overrides personal settings, while
  resolved enterprise-managed values override that inherited environment.
  Do not apply the extension's precedence rules universally.
  Use **Developer: Policy Diagnostics** when available and consult
  your administrator. Never remove policy or weaken permissions to obtain logs.
- General editor telemetry preferences interact differently across versions:
  the older pinned extension resolver disables OTel when
  `telemetry.telemetryLevel` is `off`, while newer host diagnostic OTel has an
  independent configuration path. Record the effective behavior; do not silently
  change privacy preferences to make a test pass.

Reload the affected extension window after exporter changes. For **personal
Agent Host exporter changes, fully quit and restart VS Code**, including other
windows using the shared host; Reload Window alone can leave it running with
its old environment. Coordinate interruption of other work first.

### Agent Debug Logs settings

These experimental settings and the panel/export controls are version-dependent
and documented as Preview:

| Runtime | Setting | Value for prospective logs |
| --- | --- | --- |
| Copilot Agent Host | `chat.agentHost.agentDebugLog.enabled` | `true`; use the full application restart described in the quick start |
| Extension-managed Local | `github.copilot.chat.agentDebugLog.fileLogging.enabled` | `true`; reload the window before testing |

If you actually use both runtimes, merge both keys into User Settings:

```json
{
  "github.copilot.chat.agentDebugLog.fileLogging.enabled": true,
  "chat.agentHost.agentDebugLog.enabled": true
}
```

They are separate capture pipelines, not interchangeable aliases. You do not
need Local access for the primary Agent Host path.

## Choose a private capture path

For optional file export, use a per-user directory outside every repository,
shared by that user's projects. Different OS users should have different private
locations. `~/.agent-insights/capture/agent-host-otel.jsonl` is **documentation
shorthand**, not necessarily a valid literal setting.

### macOS and Linux

Run this manually on the **exporting machine**, not automatically through the
analyzer:

```bash
mkdir -p -m 700 "$HOME/.agent-insights/capture"
printf '%s\n' "$HOME/.agent-insights/capture/agent-host-otel.jsonl"
```

The shell expands `$HOME`; paste the printed **absolute path** into
`chat.agentHost.otel.outfile` in User Settings. For the supplemental extension
pipeline, use a separate `copilot-otel.jsonl` file and
`github.copilot.chat.otel.outfile` instead.
The pinned extension file exporter passes its path to the filesystem without
expanding `~`, `$HOME` or `${userHome}`. VS Code variable substitution does not
apply to arbitrary settings. Using absolute paths also avoids differences in
host/exporter path expansion.

`mkdir -m 700` restricts a **newly created** capture directory; it does not repair
an existing one or prove that its ancestors are private. Inspect it first:

```bash
ls -ld "$HOME/.agent-insights" "$HOME/.agent-insights/capture"
```

Confirm these are your own directories, not symlinks or shared/managed storage.
If the existing capture directory is yours and should be private, restrict
**that directory only**:

```bash
chmod 700 "$HOME/.agent-insights/capture"
```

Inspect access-control lists with your OS tools as well. Directory permissions
do not repair existing files' permissions or remove inherited ACL entries.
After verifying ownership and policy, an existing personal regular capture file
can be restricted with `chmod 600 /absolute/private/capture/agent-host-otel.jsonl`.
Do not run recursive permission changes or modify harness database permissions.
The setup recipe does not precreate an empty file as supposed capture evidence.

### Windows paths (not a qualified Windows capture test)

In PowerShell, construct the absolute path and a JSON-escaped setting value:

```powershell
$capture = Join-Path $HOME '.agent-insights\capture'
$outfile = Join-Path $capture 'agent-host-otel.jsonl'
$outfile | ConvertTo-Json -Compress
```

Create the directory only in your private user storage and inspect **Properties >
Security > Advanced** for ownership, inheritance and effective access. Ask an
administrator if access is shared or policy-controlled; there is no blanket ACL
reset command here. The path expression does not grant privacy.
Paste the printed JSON string as the setting value. For example, the synthetic
Windows path `C:\Users\EXAMPLE\.agent-insights\capture\agent-host-otel.jsonl` becomes:

```json
{
  "chat.agentHost.otel.outfile": "C:\\Users\\EXAMPLE\\.agent-insights\\capture\\agent-host-otel.jsonl"
}
```

Replace the example with your own resolved path. For the supplemental extension
pipeline, use `github.copilot.chat.otel.outfile` with a separate
`copilot-otel.jsonl` filename instead. JSON backslashes
must be escaped; neither `%USERPROFILE%` nor `$HOME` is a portable literal value
for an exporter setting. Windows path construction/escaping is distinct from
Windows exporter, ACL or end-to-end qualification; see the
[verification record](#verification-record-and-limitations).

## Optional Agent Host export

Native history is the baseline. This optional, prospective configuration is
**source-inspected, not a qualified continuous-capture recipe**. Confirm that
your build exposes these settings and that personal export is allowed.
Use **Preferences: Open User Settings (JSON)** and merge this example only after
replacing the placeholder with your own absolute private destination:

```json
{
  "chat.agentHost.otel.enabled": true,
  "chat.agentHost.otel.exporterType": "file",
  "chat.agentHost.otel.outfile": "/absolute/private/capture/agent-host-otel.jsonl",
  "chat.agentHost.otel.captureContent": false,
  "chat.agentHost.otel.dbSpanExporter.enabled": false
}
```

`enabled`, `exporterType` and `outfile` select the intended personal file route.
Content is off deliberately until effective routing/privacy are verified;
`dbSpanExporter.enabled` is an optional alternative/additional diagnostic mode,
not required for native history. After informed approval, set
`chat.agentHost.otel.captureContent` to `true` if available content is needed.
**Fully quit/restart VS Code**, then start a new Agent Host test and verify actual
nonempty records from that session. An accepted key or an enabled exporter is
not proof that the SDK initialized, exported, or emitted all model/tool content.

The host can persist traces in a harness-owned database at
`<userData>/agent-host/otel/agent-host-traces.db` in supporting versions.
Its database mode and native pass-through routing differ; enabling the database
does not guarantee that all native traces reach it. Managed native destinations
can bypass that route. In supporting builds, the separate host command is
**Chat: Export Agent Host Traces Database...**
(`workbench.action.chat.agentHost.otel.exportAgentTracesDB`). Select a private
destination. Do not send host JSONL/database data to the extension parser or
assume that **Chat: Export Agent Traces DB** exports this host store.

### Organization-managed destinations

Current official documentation describes managed `telemetry.filePath` for
Copilot Agent Host starting with VS Code 1.143. This belongs to
**administrator-delivered Copilot managed settings**, not editor settings JSON.
Do not create/replace device-wide policy files from this guide.

The documented managed route enables file export without a personal opt-in;
explicit managed `telemetry.enabled: false` disables it. Managed file routing
takes precedence over a collector. The highest-precedence managed telemetry
block wins rather than merging individual blocks. The exporting host resolves
`~/`; environment-variable references such as `$HOME` or `%USERPROFILE%` are
rejected for this managed field. This is **different from the extension's
unexpanded path setting**.

The managed route documents automatic host restart after resolved policy changes,
parent-directory creation, append-only span lines and logged write failures
without collector fallback. These are upstream behavior claims, not a fresh
successful capture in this project. Personal changes still require the full
restart above. Ask your administrator for the effective destination, exporting
machine, permitted access and retention; do not introduce a second destination
or disable policy. A settled managed update can differ from an inherited
environment or an older already-running host. The inspected automatic-restart
flow is for the local desktop host; remote/standalone policy delivery and restart
behavior require separate verification.

## Supplemental extension-managed Local export

Use this section **only for sessions actually produced by the Local/extension
pipeline**, including a compatible in-process Copilot integration. These keys
do not universally configure a separately managed Agent Host.

OTel and content capture are normally off by default. For the extension's
continuous JSON Lines (JSONL) exporter, the settings reference is:

| Setting | Use/status |
| --- | --- |
| `github.copilot.chat.otel.enabled` | Required `true` for the explicit OTel path |
| `github.copilot.chat.otel.exporterType` | Required `"file"` for this example, not OTLP network export |
| `github.copilot.chat.otel.outfile` | Required resolved absolute private filename; an effective nonempty file path also selects file export in the pinned resolver |
| `github.copilot.chat.otel.captureContent` | Opt-in `true` for available prompts/responses, system/tool definitions and tool inputs/results; metadata-only capture does not meet semantic-analysis needs |
| `github.copilot.chat.otel.captureIdentity` | Leave `false`; version-specific, not present in the older pinned extension snapshot |
| `github.copilot.chat.otel.maxAttributeSizeChars` | Optional/version-specific; current docs use `0` to disable this attribute truncation limit, not a guarantee of producer completeness |
| `github.copilot.chat.otel.dbSpanExporter.enabled` | Optional; normally `false`; enabling it also enables OTel in supporting builds |

The following **full-content opt-in** example is for a trusted, personally
authorized destination only. First check routing with `captureContent: false`;
then, if approved, merge these values into the existing settings object:

```json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "file",
  "github.copilot.chat.otel.outfile": "/absolute/private/capture/copilot-otel.jsonl",
  "github.copilot.chat.otel.captureContent": true,
  "github.copilot.chat.otel.captureIdentity": false,
  "github.copilot.chat.otel.maxAttributeSizeChars": 0,
  "github.copilot.chat.otel.dbSpanExporter.enabled": false
}
```

Replace the path, omit unsupported version-specific keys rather than assuming
support, and run **Developer: Reload Window** before a new test.
The extension's file exporter needs an existing writable parent directory.
Check actual prompt/response/tool fields for completeness and truncation.
`0` does not undo producer-side truncation, omitted messages or reader budgets.

For the in-process Copilot harness described in the official monitoring guide,
the debug panel can capture full content with OTel export disabled. With export
enabled, `captureContent` controls both that integration's panel and export.
Do not extrapolate this to all Agent Host sessions or assume OTel alone enables
content capture.

For optional extension SQLite persistence, enable
`github.copilot.chat.otel.dbSpanExporter.enabled` and reload, then use
**Chat: Export Agent Traces DB** when exposed. The resulting `.db` is a
harness-generated SQLite export, not an analyzer-created database or permission
to open it with an arbitrary writable SQLite client.

## Verify capture end to end

Carry out these steps **privately**, only for an authorized harmless test.
An existing no-tools exchange can verify retained messages but cannot qualify
tool capture. Generating new prompts or subagents invokes inference and may
incur remote usage; it is not part of simply reading this guide.

1. Record build/profile/runtime/OS/execution-host details and the effective
   settings, policy source and destination, without publishing private values.
   Enable only the applicable logging/export settings, then reload or fully
   restart as specified for that runtime.
2. Start a new session in the intended Copilot Agent Host target. For a
   deliberately authorized **tool-bearing** test, ask:
   "Run one permitted shell command that prints only `capture-check`, then reply
   `capture-check complete`. Do not read or modify project files."
   Approve only the intended harmless command under normal sandbox controls.
   If tools are not permitted, record tool coverage as **not tested**; do not
   weaken policy. A separate no-tools echo is sufficient only for message checks.
3. Open **Developer: Open Agent Debug Logs** and select that exact session.
   Check the submitted instruction, response, model request, tool invocation and
   result, timestamps, and recorded input/output token fields. Record each as
   present, missing, truncated or not tested. No token field means unavailable,
   not zero consumption.
4. Only if separately testing a subagent, verify explicit parent/child identity
   and which usage includes descendants. Missing children reduce coverage;
   never sum overlapping parent/child observations. Inspect content for truncation.
5. For continuous export, check that the expected private file exists, is
   **nonzero**, and grows after new completed activity/flush. On macOS/Linux,
   `wc -c < "$HOME/.agent-insights/capture/agent-host-otel.jsonl"` checks size
   without printing contents; repeat after activity. Inspect records privately
   to establish the intended session/runtime and expected message/tool content.
   A nonempty file of unrelated records is still a failed target-session test.
6. Repeat in a second project using the same profile/User Settings. Verify that
   the fixed private destination is used and that the two sessions remain
   distinguishable by recorded identities. With multiple windows, check both
   independently for effective overrides, complete records and write errors.
   The filename does not establish project identity or guarantee concurrent-writer
   integrity.
7. For compatible Agent Host sessions, use the debug panel's **Export** control
   for an OTLP JSON export when available. Choose a private destination and
   inspect the format. **Chat: Export Chat...**, when available, produces a
   separate conversation representation, not necessarily trace data.
   Optional trace-database export is a third route, only where the runtime
   exposes it.
8. Identify formats by their actual structure, not filename:

   | Representation | Distinction |
   | --- | --- |
   | Extension exporter JSONL | One serialized span/log/metric record per line; the installed `vscode-otel-jsonl` reader targets this representation |
   | Agent Debug/OTLP JSON | OTLP resource/scope envelopes, not extension span-object JSONL; adapter deferred |
   | Transcript/mutation JSONL | Conversation messages or mutation operations, not trace spans |
   | Native SDK events | Versioned event envelopes plus qualified host identity; not OTLP |
   | Agent Host trace JSONL | Can use host-completed-span or native pass-through fields; not assumed extension-compatible |
   | SQLite trace database | Tables/schema and runtime-specific retention, not a text export; not the host catalog or session overlay |

9. **Application validation is separate.** Once a compatible supported reader is
   actually available, open only the exact authorized sources, verify the
   session identity, read-generation/time bounds, original anchors and metric
   coverage, then refresh to reread. Do not copy sources into a store. Until
   the [current gates](#application-availability) are removed through qualified
   releases, capture success is not a successful native application read.

Synthetic successful outcome (illustrative, **not a test receipt**): the intended
session has the known instruction/reply, its permitted tool/result and timestamps;
the correct file grows with matching records; usage fields are reported with
their accounting scope. Content/child completeness still needs checking.

Synthetic incomplete outcome: the host debug session has the expected reply,
but the personal export is zero bytes and per-call token fields are absent.
Report **messages captured; export unverified; per-call usage unavailable**,
not "zero tokens" or "setup complete."

## Application availability

The current native-helper pin is `native-helper-v0.1.0`. Explicit preparation
from the application checkout uses Node.js 24+ and npm:

```bash
npm ci --include=dev --ignore-scripts
npm run prepare:native
```

This prepares independently pinned published bytes; it needs no Rust/C compiler
and changes no VS Code settings or source data. It is separate from capture.
The [native preparation/recovery contract](../native/sqlite-guard/ARTIFACTS.md#versioned-release-preparation)
and [runtime availability guidance](local-runtime.md#agent-host-execution-availability)
are the current shipped references while the broader
[usage guide #21](https://github.com/toddysm/agent-insights/issues/21) remains open.
Use the application checkout containing the installer, not the older native
source tag as though it were a complete application distribution.

Published-byte preparation was qualified on macOS arm64/x64, GNU/Linux x64 and
Windows x64; this is **helper qualification, not capture support on those OSes**.
Older OS releases, other architectures and non-GNU Linux are not inferred.
Missing, incompatible, unsupported or tampered preparation reports
`NATIVE_GUARD_UNAVAILABLE`, not malformed capture data.

That release lacks predicates required by the implemented Agent Host readers.
The conversation reader is gated out of the production registry; the execution
reader reports unavailable and rejects reads with `READER_UNAVAILABLE` before
opening sources. Preparing a developer candidate does not enable production.
Do not disable guards, create database sidecars, change journal modes or copy
databases as a workaround. Existing shared-memory coordination can change
sidecar bytes; no atomic multi-source snapshot or total sidecar immutability is
promised. Compatible helper publication/registration and integrated
[producer verification #20](https://github.com/toddysm/agent-insights/issues/20)
remain separate gates.

The installed extension-file reader has its own
[explicit selection and coverage flow](local-runtime.md#read-an-existing-execution-capture).
Do not feed Agent Host captures to it to bypass unavailable native readers.
Its explicit parent-chat field establishes an association, not the call's own
session identity. Missing linkage cannot be reconstructed from timing, paths
or trace ID alone. See [direct versus associated reporting](local-runtime.md#read-the-session-report);
final integrated capture/usage acceptance remains tracked in
[#1](https://github.com/toddysm/agent-insights/issues/1) and
[#21](https://github.com/toddysm/agent-insights/issues/21).
No setup wizard, automatic source discovery, archive or automatic settings
configuration is shipped by this documentation.

## Troubleshooting

| Symptom | Check | Recovery / limitation |
| --- | --- | --- |
| No file | Actual exporting machine, absolute path, parent existence/ownership, write errors, effective route | Create only the intended private directory if permitted; correct personal settings and restart appropriately; consult admin for managed paths |
| File exists but is zero bytes | Intended runtime, completed new activity, flush/restart, host initialization/export errors | Treat as **unverified export**, not success; distinguish this from a missing file |
| Nonempty file, wrong session/runtime | Recorded identities, profile/window, destination and managed/inherited overrides | Select the correct source; do not infer identity from filenames or switch to Local as a workaround |
| No session in debug panel | Logging enabled before activity, correct profile/runtime, Local reload, build support | Start a new authorized test after proper restart; historical capture cannot be backfilled |
| Unknown setting / unsupported schema | Exact build, runtime, setting declarations and format | Record unsupported explicitly; use compatible documented controls, not renamed files or another format's parser |
| Missing Export control | Preview/build/runtime compatibility, correct selected session/panel | Investigate supported controls/manual export routes; absence of the button does not prove absence of native evidence |
| Prompts, results or tools missing | Effective content opt-in, actual event fields, truncation and harness coverage | Distinguish metadata-only from content capture; enabling OTel alone is insufficient; retry only with permission |
| Tokens or subagent spans missing | Reported fields, exact linkage and accounting scope | Mark unavailable/partial; do not invent zeros, reconstruct calls from turns or double-count descendants |
| Settings appear ignored | Workspace/Remote overrides, active profile, inherited environment, effective policy | Reset only the conflicting personal scope if permitted; inherited user value requires removing the override, not `""`; never bypass policy |
| Reload notice says endpoint will change to `http://localhost:4318/` | Active exporter and destination after reload | In the inspected 1.144.0 extension build, endpoint-change notification is independent of exporter type. Correct file export needs no collector there; the notice alone does not prove network export |
| Records truncated/incomplete | Attribute limit, producer omissions, partial final line, retention/rotation and reader budgets | Record the affected fields/interval; wait for writer completion and reread if appropriate. Disabling a limit cannot restore earlier missing data |
| Long-running/resumed session is partial | Read-time bounds, retained start/end, changed/rotated sources and duplicate segments | Preserve missing intervals/ambiguous linkage; a completed scan covers its admitted interval, not necessarily the whole session |
| Analyzer rejects a source over 64 MiB | Selected reader and authorized source/relative filename | For a supported `vscode-otel-jsonl` extension export, follow **Go to Scan JSONL source**, explicitly scan, select a **Scanned session**, then **Open session report**. See [large-capture recovery](local-runtime.md#scan-large-jsonl-captures-in-place). Do not truncate/copy the capture, change capture settings or use this path for SQLite/other formats |
| Capture works but analyzer is unavailable | Native-helper/readers' production gates and supported format | Keep capture and application validation separate; `NATIVE_GUARD_UNAVAILABLE`/`READER_UNAVAILABLE` is not a capture repair instruction |

## Retention, stopping capture and cleanup

Inspect file size/disk usage privately and follow the harness/organization's
retention and rotation controls. A continuous append file is not a bounded
archive. Do not assume the native history, debug log, trace file and trace database
share a retention policy. Long-running/resumed sessions can outlive retained
records; no later analyzer can recover data the harness removed.

To stop a **personal** setup, restore only values you changed for this workflow:

- Disable/reset the applicable Agent Debug Logs key(s).
- Disable/reset the applicable OTel `enabled`, `captureContent` and optional
  `dbSpanExporter.enabled` values. Review effective inherited configuration:
  a remaining database option, environment-configured exporter or managed route
  can keep capture active even if a personal `enabled` value is false.
- Remove your personal file destination if appropriate, then reload the
  extension window or fully restart the host application as required.
  Confirm no further export from a new authorized test; do not assume resetting
  a path stops another configured collector.
- Ask the administrator to change managed destinations. Removing a managed
  file destination can expose a previously configured collector/personal route;
  it does not necessarily disable export.

Stopping capture **does not delete existing files**. After stopping writers and
confirming ownership, policy and any needed evidence, manage only your original
capture files with normal OS tools. Do not delete active harness databases,
sidecars or an entire session-state directory to clean up an optional export.
The analyzer does not rotate, delete, archive or synchronize sources. If the
harness removes/rotates evidence, later reads can report it unavailable; refresh
rereads the originals rather than synchronizing a duplicate database.

## Verification record and limitations

Documentation/source checks were performed on **2026-11-16**. Keep the following
evidence categories separate:

| Evidence | Version/runtime/platform and result | Limit |
| --- | --- | --- |
| Historical Agent Host source qualification and selected native test, 2026-11-03 | VS Code **1.145.0**, Copilot Chat **0.73.0**, host SDK package **1.0.27-unstable.41379698026.g3219c66**; emitted runtime **1.0.103-unstable.r41379698026.g3219c66**, events format **1**, catalog **22**, overlay **18**. Nonempty native messages and exact host/turn-usage linkage observed | The published handoff does not establish an OS/architecture qualification matrix. No tools, complete per-call usage or optional exporter were verified; this guide does not rerun private-source inspection |
| Historical extension exporter inspection | VS Code **1.144.0**, pinned file-export shape; older extension configuration snapshot linked below | Static producer evidence, not all-build compatibility. A reported fresh capture was partial and its runtime/build was not confirmed |
| Current upstream monitoring/debug/settings documentation | Accessed 2026-11-16; describes Preview controls, managed routing and additional version-specific extension settings | Documentation claims, not a successful installed-runtime capture. Older pinned source lacks some newer controls |
| Path recipe/JSON/Markdown checks for this guide | macOS local validation; shell recipe and two temporary project working directories checked without touching real capture storage; PowerShell path serialization checked separately | Not a two-project VS Code capture test, Windows ACL test or Linux/Windows exporter qualification |
| Native-helper published-byte preparation | Four targets qualified in the linked release record | Does not qualify Agent Host production readers, telemetry routing or end-to-end analysis |

**Still requiring a separately authorized runtime test:** actual tool-bearing
capture, effective personal/managed Agent Host continuous routing, full-content
and child-span coverage, a shared private destination across two real projects,
and integrated application reads after the helper gate is resolved.
An accepted setting, syntactically valid example, file existence, synthetic
fixture or passed application CI job does not satisfy those checks.
Capture-guide work [#1](https://github.com/toddysm/agent-insights/issues/1) must
retain these acceptance limitations until verified; this guide does not claim
the feature is complete.

## References

- [Official Agent Debug Logs and export guidance](https://code.visualstudio.com/docs/agents/agent-troubleshooting/chat-debug-view)
- [Official OTel monitoring, content settings and managed destinations](https://code.visualstudio.com/docs/agents/guides/monitoring-agents)
- [User and workspace settings](https://code.visualstudio.com/docs/configure/settings)
- [Variables reference](https://code.visualstudio.com/docs/reference/variables-reference)
- [Enterprise policy precedence and diagnostics](https://code.visualstudio.com/docs/enterprise/manage-ai-settings)
- [Pinned Agent Host architecture and configuration](https://github.com/microsoft/vscode/blob/3c0ec3a089398503a462029e7cc2a5749df5169a/src/vs/platform/agentHost/OTEL.md)
- [Pinned host exporter resolution](https://github.com/microsoft/vscode/blob/3c0ec3a089398503a462029e7cc2a5749df5169a/src/vs/platform/agentHost/node/otel/agentHostOTelService.ts)
- [Older pinned extension settings declarations](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/package.json)
- [Older pinned extension environment resolution](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/platform/otel/common/otelConfig.ts)
- [Pinned extension file serialization and path handling](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/platform/otel/node/fileExporters.ts)
- [Pinned 1.144.0 endpoint notice behavior](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/extensions/copilot/src/extension/otel/vscode-node/otelContrib.ts)
- [Agent Host source/setup qualification and historical receipt](https://github.com/toddysm/agent-insights/issues/30)
- [Published native-helper preparation qualification](https://github.com/toddysm/agent-insights/issues/39)
