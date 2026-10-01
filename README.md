# ChatGPT Conversation Exporter

> **Disclaimer:** This is an experimental tool provided as-is, with no guarantees of correctness, reliability, or fitness for any purpose. It accesses ChatGPT's unofficial backend API, which may change or break at any time. By using this tool, you accept all responsibility for how you use it. I make no representations about the legality of exporting your own data in your jurisdiction, whether this use complies with OpenAI's Terms of Service, or any other legal or compliance matters. **Use at your own risk.**

Export the ChatGPT data exposed through the supported backend routes for personal and Teams/Business accounts. **Resumable** — if your token expires mid-export, run again with a fresh token and the same output directory.

This checkout includes local, unreleased fixes and optional Library/Dot exporters.
Run `node ./export-chatgpt.js` from this repository to use these changes;
an independently installed or fetched package may not contain them.

This is not a guaranteed backup of every account data type. Missing permissions,
deleted/expired assets, unsupported internal task APIs, or backend changes can
leave gaps. Review failed counts and the coverage notes below.

Supports:

- **Regular conversations** — your main ChatGPT history
- **Archived conversations** — include the archived regular-chat bucket with `--include-archived`
- **Project conversations** — your own conversations inside ChatGPT Projects; shared/unknown-owner conversations are excluded
- **File downloads** — DALL-E images, canvas documents, user uploads, attachments
- **Deep research** — captures async research task results
- **Enhanced Markdown** — browsing results, reasoning/thinking, tool usage
- **Optional Library export** — owned folders, files, and the file versions returned by the Library API
- **Optional Dot export** — owned Dot room messages, attachments, and linked-task metadata (not internal task bodies)

## Requirements

- Node.js 18+ (uses native `fetch`)

## Quick Start

> **Important:** If you have multiple ChatGPT accounts, make sure you're only logged into the one you want to export. Being logged into more than one account at the same time can cause ChatGPT to return data from the wrong account.

### 1. Get Your Bearer Token

1. Open https://chatgpt.com in your browser and make sure you're logged in
2. Open DevTools (F12) → **Network** tab
3. Refresh the page or click on a conversation
4. Filter requests: `backend-api/conversations`
5. Click on a matching request, find the **Authorization** header under Request Headers, and copy the token (just the `eyJ...` part after `Bearer`)

> **Warning:** Bearer tokens can expire quickly — you may want to get a fresh one each time you run the export.

### 2. Using the Exporter

**Setup:**

```bash
npm install
```

**Run:**

```bash
node ./export-chatgpt.js
```

The default run exports active regular chats, projects, and their files. To add
archived regular chats, Library, and Dot rooms:

```bash
node ./export-chatgpt.js --include-archived --include-library --include-dots
```

| Scope | Default | Control |
| --- | --- | --- |
| Active regular chats | Included | Skipped by any `--*-only` mode |
| Archived regular chats | Excluded | `--include-archived` |
| Owned project conversations and project files | Included | `--no-projects` / `--projects-only` |
| Owned Library folders/files/versions | Excluded | `--include-library` / `--library-only` |
| Owned Dot DM messages and attachments | Excluded | `--include-dots` / `--dots-only` |

Use `--include-*` to add scopes. The three only modes are mutually exclusive.

### 3. Find Your Exports

By default, conversations are saved to `./exports/{user_id}`:

```
exports/{user_id}
├── json/                          # Regular conversation JSON
│   └── {date}_{title}_{id}.json
├── markdown/                      # Regular conversation Markdown
│   └── {date}_{title}_{id}.md
├── files/                         # Files from regular conversations
│   └── {file_id}.{ext}
├── projects/                      # Project-scoped exports
│   ├── {ProjectName}/
│   │   ├── json/
│   │   ├── markdown/
│   │   └── files/
│   └── project-index.json
├── library/                       # Optional ChatGPT Library export
│   ├── library-index.json
│   └── files/
│       └── {Folder}__{id}/{File}__{id}/
│           ├── versions.json
│           └── v000_{filename}
├── conversation-index.json
├── dots/                          # Optional --include-dots/--dots-only
│   ├── dot-index.json
│   └── {DotName}__{id-hash}/
│       ├── profile.json
│       ├── room.json
│       ├── threads.json            # Linked tasks, including hidden links; metadata only
│       ├── messages.json
│       ├── messages.md
│       ├── downloads.json          # Inventory derived from message attachments
│       └── files/
└── .export-progress.json          # Resumption state
```

Regular/project conversation files use `{date}_{title}_{13-character-id}.{ext}`.
Raw conversation JSON retains the returned message tree, including sibling
branches; Markdown renders the selected `current_node` branch. Library files
have a folder per file with version-prefixed names; Dot attachments have a
filename plus a file-ID hash inside that Dot's directory.

## Resumable Exports

The script tracks progress automatically:

- `exports/{user_id}/.export-progress.json` stores which conversations have been downloaded and where indexing left off
- If your token expires mid-export, the script saves progress and exits gracefully
- Just run again with a fresh Bearer token — already-downloaded conversations are skipped
- The conversation index is also built incrementally, resuming from the last page fetched
- Archived regular-chat indexing has its own offset/completion state
- Library resumes an interrupted recursive index; Dots checkpoint message pages and refresh their history on each run
- Ordinary/project chats already marked downloaded require `--update` to fetch changed bodies again

## Options

```
--bearer <token>        Bearer/access token (or set CHATGPT_BEARER_TOKEN env var; prompted if omitted)
--token <token>         Session token (alternative auth, personal accounts only; or set CHATGPT_SESSION_TOKEN)
--session-cookie <value> Browser Cookie header for Library downloads (or set CHATGPT_SESSION_COOKIE)
--account-id <id>       ChatGPT Teams account ID (auto-detected from token when possible)
-o, --output <dir>      Output directory (default: ./exports)
--format <format>       Export format: json | markdown | both (default: both)
--throttle <seconds>    Minimum time between API requests in seconds (default: 60)
--no-adaptive-throttle  Disable adaptive request pacing
--min-throttle <seconds> Adaptive pacing floor (default: 5)
--max-throttle <seconds> Adaptive pacing ceiling (default: 300)
--include-archived      Also index archived regular conversations
--update                Re-download conversations; also force Library/Dot file downloads
--no-projects           Skip project conversations (projects are exported by default)
--projects-only         Export only project conversations (skip regular)
--include-library       Also export owned Library folders, files, and all file versions
--library-only          Export only the owned Library (skip conversations and projects)
--include-dots          Also export owned Dot chats, attachments, and linked-task metadata
--dots-only             Export only Dots; combine with --include-library for Library-only results too
--no-files              Skip ALL file downloads
--no-images             Skip downloading images
--no-canvas             Skip downloading canvas documents
--no-attachments        Skip downloading other file attachments
--no-user-dir           Do not nest exports inside a user ID subdirectory
--max <n>               Only download the next N conversations this session (also -N, e.g. -7)
--conv <ids>            Only download specific conversation ID(s), comma-separated
--proj <ids>            Only download specific project ID(s), comma-separated
--verify                Compare recorded regular/project downloads with JSON files on disk; no network export
--refetch-missing       Reopen recorded regular/project conversations missing their JSON on disk
--retry-failed-files    Retry file IDs previously recorded as permanently failed
-n, --non-interactive   Run without any interactive prompts (requires --bearer or --token)
--no-summary            Suppress the export summary at the end
--no-donate             Suppress the donation message/prompt
--verbose               Show detailed request/response info
-v, --version           Show package version (local checkpoints do not bump it)
--help                  Show help message
```

`--conv`, `--proj`, and `--max` apply to ordinary/project conversation exports,
not Library or Dot enumeration. `--max` is enforced separately in each
regular/project export loop, not as an account-wide file limit.
`--verify`/`--refetch-missing` inspect saved conversation JSON, not Library or
Dot completeness; avoid treating a Markdown-only export as a JSON verification.

### Token via Environment Variables

To avoid having to paste your token each time:

```bash
export CHATGPT_BEARER_TOKEN="eyJ..."
node ./export-chatgpt.js
```

Some Library-backed files use a `chatgpt.com/api/library/...` web route that
also requires your current browser session. Copy the complete `Cookie` request
header from that request in DevTools and provide it through the environment so
it does not appear in shell history:

```bash
export CHATGPT_SESSION_COOKIE="__Secure-authjs.session-token.0=...; __Secure-authjs.session-token.1=..."
```

The cookie is sent only to `chatgpt.com`, never to external signed download
hosts.

### Windows PowerShell (local checkout)

Run from the directory containing `export-chatgpt.js`. To prepare UTF-8 output
and use a freshly copied Authorization header value without putting the token
in your command history:

```powershell
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:CHATGPT_BEARER_TOKEN = ((Get-Clipboard) -replace '^\s*Bearer\s+', '').Trim()

# Dot chats/files plus owned Library, using the same destination on later runs
node .\export-chatgpt.js --dots-only --include-library --output '.\exports' --throttle 10 --verbose --no-donate

# Active + archived chats, projects, Library and Dots
node .\export-chatgpt.js --include-archived --include-library --include-dots --output '.\exports' --throttle 10 --verbose --no-donate
```

If a Library-backed web download specifically reports that a browser session
cookie is required, copy **only the Cookie request-header value** and set
`$env:CHATGPT_SESSION_COOKIE = (Get-Clipboard).Trim()` before rerunning. Do not
paste Korean DevTools labels or an entire response body into this variable.
A cookie does not guarantee that a 404/422 or expired/deleted file is recoverable.

Tokens/cookies are credentials. Do not paste them into issue reports, HARs,
patches, or shared logs. Environment variables remain in the current shell;
replace an expired value before retrying. If you want the bearer prompt instead,
remove stale token variables from that shell and omit the authentication flags.

### Interactive Mode

The authentication prompt asks for a bearer token if neither authentication
flag nor corresponding environment variable is supplied. There are no prompts
for export scopes. A successful interactive TTY run can also show a donation
prompt; `--no-donate` disables it, and `--non-interactive` disables prompts.

## Examples

```bash
# Default: active regular chats, projects, and available files
node ./export-chatgpt.js

# Skip project conversations
node ./export-chatgpt.js --no-projects

# Only project conversations, skip file downloads
node ./export-chatgpt.js --projects-only --no-files

# Export conversations, projects, and the complete owned Library
node ./export-chatgpt.js --include-library

# Export only the complete owned Library
node ./export-chatgpt.js --library-only

# Export only Dot chats/files plus the complete owned Library
node ./export-chatgpt.js --dots-only --include-library

# Add both optional exports to conversations and projects
node ./export-chatgpt.js --include-dots --include-library --include-archived

# Export only JSON format (default is both json and markdown)
node ./export-chatgpt.js --format json

# Export to custom directory
node ./export-chatgpt.js --output ./chatgpt-backup

# Slower requests to avoid rate limiting
node ./export-chatgpt.js --throttle 90

# Re-download all conversations (overwrite existing)
node ./export-chatgpt.js --update --include-archived

# Skip images but keep canvas and attachments
node ./export-chatgpt.js --no-images

# Resume after token expiry — just run again with a fresh token
node ./export-chatgpt.js

# Limit to 10 conversations this session
node ./export-chatgpt.js --max 10

# Explicitly retry permanently failed files; successful files remain skipped
node ./export-chatgpt.js --dots-only --include-library --retry-failed-files

# Non-interactive mode (for scripts/CI — requires --bearer or ENV variable as below)
CHATGPT_BEARER_TOKEN="eyJ..." node ./export-chatgpt.js --non-interactive
```

## Library Export

`--include-library` adds the owned Library to a normal run; `--library-only`
skips ordinary chats, projects, and their legacy file backfill. The exporter
uses the global nodes API, not the Recommended tab, follows owned folders
recursively, paginates each file's versions, and saves metadata plus available
version files under `library/files/`. Shared/unknown-access nodes are excluded.

The Library index is refreshed on an ordinary completed run. Interrupted scans
use `.library-index.partial.json`. Existing version files are checked against
the API's size when present; otherwise the presence of a nonempty file is the
check. Matching conversation/project files may be copied rather than downloaded
again (`reused`). `--update` forces version file downloads; recorded failed IDs
require `--retry-failed-files`. A failed version-list lookup can fall back to
current node metadata and is recorded as `_versions_error`, so successful file
counts do not prove that every historical version was enumerated.

Library JSON indexes/manifests remain available with `--no-files` and with
any `--format`; file-type flags control the binaries, not the metadata.
`libraryDownloadComplete` means that the pass finished, not that it had zero
failures. Check `failed`, version `_export.status`, and `_versions_error`.

## Dot Export Coverage and Resumption

Dot export lives in a separate `lib/dots.js` module and a separate `dots/`
output tree. It uses the observed private `/tbo` and `/messaging/rooms` APIs,
which are experimental and may change. Only DM rooms whose creator matches
the authenticated user are exported; shared and unknown-owner rooms are
skipped. `--projects-only`, `--library-only`, and `--dots-only` cannot be combined;
use the `--include-*` flags to add optional scopes.

Each run refreshes the Dot message history, merging messages by ID to retain
previously saved messages and update edits/reactions. Interrupted message
pagination is checkpointed in `.messages.partial.json`; a fresh token resumes
the older pages and then refreshes the latest pages. Dot JSON checkpoints and
inventories are always kept, even with `--format markdown`. `--format json`
suppresses creation/update of the readable Dot Markdown.

Files are deduplicated within each Dot. Complete local files are skipped by
the recorded byte count; missing or truncated files are downloaded again.
`--update` forces file downloads. Each download requests a fresh URL from the
room file resolver, rather than reusing an expiring URL embedded in old
messages. Files are written to `.part` first. Signed URL fields are sanitized
in saved metadata, and bearer/cookie credentials are not sent to external
download hosts. File-type flags (`--no-files`, `--no-images`, etc.) still apply.
Recorded permanent file failures are retried only with `--retry-failed-files`.
Dot record/file errors produce an incomplete summary and a nonzero exit code.
If formats change, a previously generated Dot `messages.md` is not deleted by
`--format json`; read the refreshed JSON or regenerate Markdown before relying
on that old file.

`threads.json` preserves visible and hidden linked-task IDs, parent links,
and visibility metadata, **not their internal conversation/task bodies**.
`downloads.json` is an attachment inventory, not a verified export of an
independent product download-list endpoint. Widget payloads are preserved in
the raw messages JSON but are not executed or rendered as live widgets.
For outputs saved only in Library rather than attached to a Dot message, add
`--include-library`; this exports the owned Library separately, not an inferred
Dot-to-Library association. These limitations are recorded in the JSON
`coverage` fields and in [_docs/DOTS_EXPORT_RESEARCH.md](_docs/DOTS_EXPORT_RESEARCH.md).

## Markdown Output

Regular/project Markdown includes YAML frontmatter and handles the content
types below. Dot Markdown has its own room/author/timestamp layout rather than
the conversation frontmatter format.

| Content Type | Rendering |
|---|---|
| Text messages | Standard Markdown |
| Code results | Fenced code blocks |
| Images/files | `![image](files/{id}.ext)` links or `[Image: {id}]`; Work `sandbox:` file links are rewritten to downloaded files |
| Canvas documents | `![image](files/{id}.ext)` links |
| Browsing results | Blockquote with "Browsing Result" header |
| Thinking/reasoning (o1/o3) | Collapsible `<details>` block |
| Reasoning recap | Italic summary |
| Deep research results | "Assistant (Deep Research: title)" header |
| Tool messages | Blockquote with tool name |

Example frontmatter:
```yaml
---
title: "My conversation title"
id: abc123...
create_time: 2025-01-15T10:30:00.000Z
update_time: 2025-01-15T11:00:00.000Z
model: gpt-4o
project_id: g-abc123...
---
```

## Troubleshooting

### "Authentication failed" / token expired mid-export

- Bearer tokens expire quickly — get a fresh one from DevTools
- Make sure you copied the **entire** token (starts with `eyJ`)
- For Teams accounts, make sure to include `--account-id` (or let the tool auto-detect it)
- Progress is saved automatically, so just re-run with a new token

### "No conversations found"
This likely means one of:

- **Teams account without `--account-id`**: You need to pass your account ID for Teams workspaces
- You're logged into a different workspace than expected
- The account genuinely has no conversations

### Rate limiting

The 60-second default is a request interval, not one conversation per minute;
a conversation can require several requests. Adaptive pacing increases the
interval after 429s and reduces it after a sustained success streak. For a
429, the retry delay uses `Retry-After` when present, otherwise 60/120/300 seconds
with later attempts capped at 300 seconds. You can also increase the throttle:

```bash
node ./export-chatgpt.js --throttle 90
```

### File failures or an incomplete export

An authentication interruption saves progress and exits with code 1. Dot
record/file failures also print `Export Incomplete` and exit with code 1;
normal/Library failures may instead be reported as counts or metadata even
when the overall banner says complete. Always inspect those results.

A fresh resolver URL can repair a stale signed URL, but cannot restore a
deleted file or grant missing access. 404s are not repeatedly retried by the
API helper. Ordinary file backfill may run even when conversations are skipped;
permanent failure records stay skipped until `--retry-failed-files` is supplied.

### Dot tasks or files missing from the export

Dot task links are metadata only. Internal/background task bodies, the Dot's
private notes/memory, messages in external Slack/Teams channels, and a separate
product download-list endpoint are not exported by `lib/dots.js`. For files
saved only in Library, add `--include-library`. See the
[Dot research and follow-up checklist](_docs/DOTS_EXPORT_RESEARCH.md).

## How It Works

1. Uses your Bearer token directly for API authentication (or exchanges a session token for one)
2. Incrementally fetches the conversation list via `/backend-api/conversations` (28 per page), saving progress after each page
3. Downloads each conversation's full content via `/backend-api/conversation/{id}`, tracking completed downloads
4. Fetches the project list via `/backend-api/gizmos/snorlax/sidebar`, then indexes and downloads each project's conversations (use `--no-projects` to skip)
5. Scans conversation data for file references (`asset_pointer`, attachments, and Pro/Work `content_references`) and downloads via the available file resolver routes (use `--no-files` to skip)
6. Saves to JSON and/or Markdown files
7. On auth failure, saves all progress and exits — re-running skips already-completed work
8. With `--include-dots`, separately indexes owned Dot rooms, messages, task links and attachments
9. With `--include-library`, recursively exports owned Library folders and returned file versions

Markdown follows the branch selected by the conversation's `current_node`, so edited or regenerated Pro responses are not replaced by an abandoned first-child branch.

## Documentation and Local Checkpoints

- [Engineering specification](SPECIFICATION.md): implemented flags, API observations, schemas, and error handling.
- [TODO / verification checklist](TODO.md): completed local features and outstanding capture/manual checks.
- [Changelog](_docs/CHANGELOG.md): upstream release history and unreleased local changes.
- [Dot research](_docs/DOTS_EXPORT_RESEARCH.md): captured evidence, unsupported scopes, and future API needs.
- [Projects/files research](_docs/PROJECTS_FILES_RESEARCH.md): earlier API observations and current behavior notes.

Local patch order is 1 → 2 → 3 → 4 → 5: pre-Library fixes, 404 recovery,
Pro/Work fixes, full Library export, then Dot support and documentation.
The 5th patch is incremental on the 4th-patch working state. Existing patched
checkouts already contain these changes; do not apply the same patch twice.
The separate `legacy` patch is not part of this sequence.

The last full automated run passed 356 tests in 20 suites. Dot tests use mocked
responses and local files; a live-account Dot download, non-null message cursor
capture, and hidden task-body API verification remain outstanding. The official
[Tasks and memory documentation](https://learn.chatgpt.com/docs/dots/tasks-and-memory)
describes individual tasks as separate conversations; exporting room messages
must not be described as exporting those task conversations too.

## License

MIT
