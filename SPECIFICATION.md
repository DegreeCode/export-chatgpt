# ChatGPT Conversation Exporter — Engineering Specification

## 1. Overview

A Node.js CLI tool that exports supported ChatGPT conversation, project, file,
Library and Dot data through observed private backend routes. Supports personal
and Teams/Business accounts, resumable exports, and JSON/Markdown output. This
document describes the locally patched checkout as of 2026-10-01, not necessarily
an independently installed package. It does not promise a complete account-data backup.

### Goals

- Export active regular chats, optionally archived regular chats, and owned project conversations
- Download conversation **files** (DALL-E images, user uploads, PDFs)
- Capture **deep research** task results embedded in conversations
- Provide **resumable** exports that survive token expiration
- Produce both raw JSON and human-readable Markdown output
- Optionally export owned Library folder trees and returned file versions
- Optionally export owned Dot room messages/files and linked-task metadata

### Non-Goals

- Real-time sync or watching for new conversations
- Modifying or deleting conversations via the API
- Exporting custom GPT definitions/configurations as a separate scope
- Exporting unverified Dot internal task bodies, private notes/memory, external messaging channels, or an independent download-list API
- Recovering deleted files or bypassing access permissions

---

## 2. Requirements

| Requirement | Detail |
|-------------|--------|
| Runtime | Node.js >= 18.0.0 (native `fetch`) |
| Dependencies | `commander ^12.0.0` (CLI arg parsing) |
| Platform | Cross-platform (Windows, macOS, Linux) |
| Auth | Bearer token or session token |

---

## 3. Authentication

### 3.1 Bearer Token (Primary)

- Header: `Authorization: Bearer {token}`
- Source: DevTools Network tab → `backend-api/conversations` request
- Format: JWT starting with `eyJ...`
- Tokens expire quickly; user must refresh between sessions

### 3.2 Session Token (Fallback)

- Cookie: `__Secure-next-auth.session-token={token}`
- Exchanged for Bearer token via `GET /api/auth/session`
- Only works for personal accounts

### 3.3 Teams Account ID

- Header: `chatgpt-account-id: {account_id}`
- Required for Teams workspaces, optional for personal accounts
- Format: UUID (e.g., `cc47585e-b2fe-4e7d-ac6a-ced32852f07b`)

### 3.4 Token Sources (Priority Order)

1. CLI flag: `--bearer` or `--token`
2. Environment variable: `CHATGPT_BEARER_TOKEN` or `CHATGPT_SESSION_TOKEN`
3. Interactive prompt (if neither provided)

---

## 4. CLI Interface

### 4.1 Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--bearer <token>` | string | — | Bearer/access token (or `CHATGPT_BEARER_TOKEN` env var) |
| `--token <token>` | string | — | Session token (alt auth, or `CHATGPT_SESSION_TOKEN` env var) |
| `--session-cookie <cookie>` | string | — | Browser Cookie value for Library web downloads, or `CHATGPT_SESSION_COOKIE` |
| `--account-id <id>` | string | — | Teams account ID (auto-detected from JWT when not provided) |
| `-o, --output <dir>` | string | `./exports` | Output directory |
| `--format <fmt>` | string | `both` | `json`, `markdown`, or `both` |
| `--throttle <seconds>` | number | `60` | Minimum interval between API requests |
| `--no-adaptive-throttle` | boolean flag | — | Disable adaptive request pacing |
| `--min-throttle <seconds>` | number | `5` | Adaptive pacing floor |
| `--max-throttle <seconds>` | number | `300` | Adaptive pacing ceiling |
| `--include-archived` | boolean flag | `false` | Also index archived regular-chat bucket |
| `--update` | boolean flag | `false` | Re-download conversations and Library/Dot files; permanent file failures still need explicit retry |
| `--no-projects` | boolean flag | — | Skip project conversations (projects are exported by default) |
| `--projects-only` | boolean flag | `false` | Export only project conversations (skip regular) |
| `--include-library` | boolean flag | `false` | Also export owned Library folders, files, and all versions |
| `--library-only` | boolean flag | `false` | Export only the owned Library; skip conversations and projects |
| `--include-dots` | boolean flag | `false` | Add owned Dot chats/files and linked-task metadata |
| `--dots-only` | boolean flag | `false` | Skip ordinary chats/projects; allow `--include-library` alongside Dots |
| `--no-files` | boolean flag | — | Skip ALL file downloads (overrides granular flags below) |
| `--no-images` | boolean flag | — | Skip downloading DALL-E images |
| `--no-canvas` | boolean flag | — | Skip downloading canvas documents |
| `--no-attachments` | boolean flag | — | Skip downloading other file attachments |
| `--no-user-dir` | boolean flag | — | Do not nest output under the JWT-derived user ID |
| `--max <n>` / `-N` | positive integer | — | Limit downloads separately in each regular/project conversation loop |
| `--conv <ids>` | comma-separated IDs | — | Filter regular/project conversation downloads, not Dot/Library enumeration |
| `--proj <ids>` | comma-separated IDs | — | Filter project exports |
| `--verify` | boolean flag | `false` | Dry-run progress vs conversation JSON on disk, after auth preparation |
| `--refetch-missing` | boolean flag | `false` | Clear regular/project completion IDs lacking saved JSON before export |
| `--retry-failed-files` | boolean flag | `false` | Explicitly reopen recorded permanent file failures |
| `-n, --non-interactive` | boolean flag | `false` | Require a supplied auth token; suppress prompts |
| `--no-summary` | boolean flag | — | Suppress final summary |
| `--no-donate` | boolean flag | — | Suppress donation prompt |
| `--verbose` | boolean flag | `false` | Show detailed request/response info |
| `-v, --version` | flag | — | Show package version; local checkpoints do not bump it |
| `--help` | flag | — | Show help message |

### 4.2 Flag Interactions

- **Projects:** Exported by default. Use `--no-projects` to skip, or `--projects-only` to export only projects.
- `--projects-only` implies project export and skips the regular conversation export.
- **Library:** Not exported by default. `--include-library` adds it to the normal export; `--library-only` enables it and skips both conversation modes.
- **Dots:** Not exported by default. `--include-dots` adds it; `--dots-only` skips ordinary/project conversation exports and legacy file backfill. Mutually exclusive only modes are rejected before authentication. Add optional scopes with `--include-library`/`--include-dots`.
- **Files:** All file types downloaded by default. `--no-files` overrides all granular flags (`--no-images`, `--no-canvas`, `--no-attachments`).
- `--throttle` accepts a non-negative number of seconds; invalid values fall back to 60 seconds with a warning. Adaptive pacing adjusts it after 429s/success streaks unless disabled.
- `--account-id` is auto-detected from the JWT payload when not provided explicitly.
- JWT user identity is resolved even with `--no-user-dir`; project and Dot ownership filtering must not depend on output nesting.
- `--verify` checks regular/project JSON availability, not file content, Library or Dot completeness. It short-circuits the export; supplied bearer auth avoids a session-token exchange.

### 4.3 Interactive Prompts

The authentication prompt asks for a **bearer token** if neither authentication
flag nor corresponding environment variable is supplied. Scope/update/file
selection uses CLI flags, not prompts. A successful interactive TTY run may
also show a donation prompt; `--no-donate` or `--non-interactive` disables it.

---

## 5. API Endpoints

### 5.1 Regular Conversations

#### List Conversations

```
GET /backend-api/conversations?offset={offset}&limit=28&order=updated&is_archived={false|true}
```

- Pagination: numeric `offset`, 28 per page
- Stop condition: 3 consecutive pages with no new conversations, or page returns fewer than 28
- Always index the active bucket; add the archived bucket only with `--include-archived`. Each has separate offset/completion state.

#### Fetch Conversation

```
GET /backend-api/conversation/{conversation_id}
```

- Returns full conversation data with message mapping tree

#### Exchange Session Token

```
GET /api/auth/session
Cookie: __Secure-next-auth.session-token={token}
```

- Returns `{ accessToken: "..." }`

### 5.2 Projects

#### List All Projects

```
GET /backend-api/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0
```

- Pagination: cursor-based (opaque string), `null` = last page
- Returns: project metadata, attached files, workspace info
- Project IDs: format `g-p-{32_hex_chars}`

**Response shape:**
```
{
  items: [{
    gizmo: {
      gizmo: { id, display: { name, description }, instructions, workspace_id, created_at, updated_at, num_interactions },
      files: [{ id, file_id, name, type, size }],
      conversations: { items: [], cursor }
    }
  }],
  cursor: string | null
}
```

#### List Project Conversations

```
GET /backend-api/gizmos/{gizmo_id}/conversations?cursor={cursor}
```

- Start with `cursor=0`, paginate until `cursor` is `null`
- Returns same conversation metadata as regular list (id, title, timestamps, snippet)
- Keep only conversations whose `owner.user_id` matches the authenticated user, normalizing `__{workspace}` suffixes; shared/unknown owners are excluded.

#### Fetch Project Conversation

Same as regular: `GET /backend-api/conversation/{conversation_id}`

### 5.3 Files

#### Get Signed Download URL

```
GET /backend-api/files/download/{file_id}?conversation_id={conversation_id}&inline=false
```

- Returns `{ status, download_url, file_name, file_size_bytes }`
- `download_url` is a signed, time-limited URL

#### Download File Content

```
GET {download_url}
```

- Returns binary file content
- Do NOT cache signed URLs; fetch fresh for each download

### 5.4 ChatGPT Library (Optional)

These are private ChatGPT web endpoints and may change without notice.

```
GET /backend-api/files/library/nodes?hydrate_folder_thumbnails=true&include_onedrive=true&include_folder_counts=true&include_saved_entities=true[&cursor={cursor}][&parent_directory_id={directory_id}]
GET /backend-api/files/library/files/{library_file_id}/versions?limit=20[&cursor={cursor}]
GET /backend-api/files/download/{file_id}?inline=false
```

- Paginate the top-level node list and every discovered directory until each cursor is `null`.
- Export only nodes whose `access_kind` is `owned`.
- Paginate every file's version list and download each backing `file_id`.
- Signed download URLs are fetched just in time and are never persisted with their query string.

### 5.5 Deep Research (Optional)

The process stream below is observed/planned supplementary capture, not an
implemented CLI scope. Embedded final research results are exported through
the ordinary conversation data.

#### Stream Research Task Progress

```
GET /backend-api/tasks/{task_id}/stream?parent_conversation_id={id}&message_id={id}
```

- Server-Sent Events (SSE) format
- Row types: `summary`, `search`, `website_open`, `file_open`
- Ends with `final_message` object then `[DONE]`
- **Note:** The final research result is already embedded in the conversation data as a message with `is_async_task_result_message: true`. Streaming is optional for capturing the research process.

---

### 5.6 Dots (Optional, Observed Private API)

```
GET /backend-api/tbo?limit=25&include_room_preview=false[&cursor={cursor}]
GET /backend-api/tbo/{aeon_id}/threads?limit=100&include_hidden=true[&cursor={cursor}]
GET /backend-api/messaging/rooms/{room_id}
GET /backend-api/messaging/rooms/{room_id}/messages?limit=32[&before={prev_cursor}]
GET /backend-api/messaging/rooms/{room_id}/files/{CalpicoFile_id}
```

Profiles and linked-task lists use `{items, cursor}`. Messages use
`{items, prev_cursor, next_cursor}`; backwards pagination uses `prev_cursor`
as `before`, with oldest-message-ID fallback only when the field is absent.
The non-null message cursor mapping still needs a real multi-page capture.
File metadata includes a fresh `download_url`, name, MIME type and optional
`library_file_id`. Both human and Dot messages may have `role: user`; Markdown
authors are distinguished by `account_user_id`/member `aeon_id` instead.
`/tbo/primary` can return selection only or selection plus profile; export does
not depend on the optional profile or limit itself to the primary Dot.

These APIs are not official supported contracts. Linked task bodies and an
independent download-list API are unverified and not claimed as exported.
See `_docs/DOTS_EXPORT_RESEARCH.md` for evidence and follow-up capture needs.

## 6. Data Flow

### 6.1 Regular Conversation Export

```
1. Authenticate (bearer or session → bearer)
2. Load existing index + progress
3. Paginate /conversations, build index (save after each page)
4. For each un-downloaded conversation:
   a. GET /conversation/{id}
   b. Save JSON to exports/json/
   c. Convert to Markdown, save to exports/markdown/
   d. Unless disabled by file-type flags: extract & download file references
   e. Mark downloaded in progress
5. Print summary
```

### 6.2 Project Export

```
1. Paginate /gizmos/snorlax/sidebar, build project index
2. Save project-index.json
3. For each project:
   a. Paginate /gizmos/{id}/conversations
   b. For each un-downloaded conversation:
      i.   GET /conversation/{id}
      ii.  Save JSON to exports/projects/{ProjectName}/json/
      iii. Convert to Markdown, save to exports/projects/{ProjectName}/markdown/
      iv.  Unless disabled by file-type flags: extract & download files
      v.   Mark downloaded in progress
4. Print summary
```

### 6.3 File Download Flow

```
1. Scan conversation JSON for `asset_pointer`, `metadata.attachments`, and `metadata.content_references[type=file]`
2. Extract the resolver file ID and retain filename plus Library metadata when present
3. For each unique file ID (not already downloaded):
   a. GET /files/download/{file_id}?conversation_id={id}&inline=false
   b. Fetch the signed download_url
   c. Save binary to appropriate files/ directory
   d. Track file ID as downloaded
```

### 6.4 Library Export

```
1. Paginate /files/library/nodes for the global Library view
2. Recursively paginate the same endpoint for every owned directory
3. Save a resumable partial index after every page
4. For each owned file, paginate /versions until cursor is null
5. Download every version through /files/download/{file_id}?inline=false
6. Reuse an already-downloaded conversation/project file when its file_id matches
7. Save per-file versions.json and the final library-index.json
```

---

### 6.5 Dot Export

1. Paginate all Dot profiles, then fetch each full room.
2. Require matching current-user creator, DM type, room ID and Dot ID.
3. Save profile and room metadata; paginate linked tasks including hidden links.
4. Merge messages by ID, checkpoint each page, guard against repeated cursors.
5. After interruption, resume older history and refresh from the latest page.
6. Index file/image attachments; retain widget payloads in raw JSON.
7. Skip complete local files; fetch fresh room file metadata for each download.
8. Download to `.part`, check optional expected size, then rename into `files/`.
9. Refresh a CDN 401/403 URL once. Distinguish expired bearer from file-specific denial.
10. Save sanitized inventories, Markdown and progress. Mark record/file failures incomplete.

Dot JSON checkpoints are always saved regardless of `--format`; `json` disables
Markdown generation. Renaming a Dot preserves its original ID-keyed directory.
Dot message history refreshes on ordinary runs; `--update` additionally forces
file downloads. Permanent file failures require `--retry-failed-files`.
Library-only outputs require the separate `--include-library` scope.

## 7. Output Structure

### 7.1 Directory Layout

```
{outputDir}/
├── json/                                    # Regular conversation JSON
│   └── {date}_{title}_{shortId}.json
├── markdown/                                # Regular conversation Markdown
│   └── {date}_{title}_{shortId}.md
├── files/                                   # Files from regular conversations
│   └── {file_id}.{ext}
├── projects/                                # Project-scoped exports
│   ├── {ProjectName}/
│   │   ├── json/
│   │   │   └── {date}_{title}_{shortId}.json
│   │   ├── markdown/
│   │   │   └── {date}_{title}_{shortId}.md
│   │   ├── files/
│   │   │   └── {file_id}.{ext}
│   │   └── conversation-index.json          # Per-project conversation metadata
│   └── project-index.json
├── library/                                 # Present with --include-library/--library-only
│   ├── library-index.json                   # Owned nodes, versions, and local status
│   └── files/
│       └── {Folder}__{id}/                  # Recursive Library folder hierarchy
│           ├── .directory.json
│           └── {File}__{id}/
│               ├── versions.json
│               ├── v000_{filename}
│               └── v001_{filename}
├── conversation-index.json                  # Regular conversation metadata
├── dots/
│   ├── dot-index.json                       # Profiles, local status and coverage limitations
│   └── {DotName}__{id-hash}/
│       ├── profile.json
│       ├── room.json
│       ├── threads.json                     # Metadata only, bodies_exported: false
│       ├── messages.json                    # Raw room messages, nested widgets retained
│       ├── messages.md
│       ├── downloads.json                   # Message-attachment inventory and local status
│       └── files/{name}__{file-id-hash}.{ext}
└── .export-progress.json                    # Resumption state
```

### 7.2 File Naming

- **Date prefix:** ISO date from `create_time` (e.g., `2025-07-23`)
- **Title:** Sanitized conversation title (max 100 chars)
- **Short ID:** First 13 characters of conversation UUID, avoiding the older 8-character collision issue
- **Pattern:** `{date}_{title}_{shortId}.{ext}`
- **Project folders:** Sanitized project name (illegal chars → `_`, spaces → `_`, max 50 chars)
- **Library files:** Recursive folder names and a directory per Library file; `v{version}_{filename}` binaries plus `versions.json`
- **Dot files:** A Dot name plus 16-character ID hash directory; attachment name plus 16-character file-ID hash. A Dot rename retains its prior validated directory.

### 7.3 Filename Sanitization

```javascript
function sanitizeFilename(name) {
  if (!name) return 'untitled';
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 100)
    .replace(/^\.+$/, 'untitled');
}
```

For project folder names, limit to 50 characters.

---

## 8. Export Formats

### 8.1 JSON

For regular/project exports, `--format json` or `both` saves the returned
conversation object with `JSON.stringify(data, null, 2)`, including:

- `id`, `title`, `create_time`, `update_time`
- `mapping` — message tree (nodes with parent/children relationships)
- `gizmo_id` — project association (null for regular conversations)
- `is_archived`, `conversation_template_id`
- Full message content, metadata, and author information

The returned `mapping` preserves all branches exposed by that response, even
though Markdown chooses one branch. This is not a promise to enumerate revision
history that an endpoint does not return. `--format markdown` does not save raw
regular/project conversation JSON. Library and Dot metadata/checkpoints are
always JSON and sanitize signed URL fields; they are not byte-for-byte raw API
responses. Dot nested widget data is retained without executing it.

### 8.2 Markdown

Regular/project human-readable format with YAML frontmatter:

```markdown
---
title: "Conversation Title"
id: {uuid}
create_time: {ISO timestamp}
update_time: {ISO timestamp}
model: {model name, if available}
project_id: {gizmo_id, if project conversation}
---

# Conversation Title

## User

[message content]

## Assistant

[message content]
```

#### Enhanced Content Type Rendering

| Content Type | Markdown Rendering |
|---|---|
| `text` | Plain text |
| `code` | Fenced code block |
| `multimodal_text` | Text parts inline; images as `![image](files/{id}.ext)` when file downloads are enabled, otherwise `[Image: {id}]` |
| `tether_browsing_display` | Blockquote: `> **Browsing Result:** ...` |
| `thoughts` | Collapsible `<details><summary>Thinking</summary>` block |
| `reasoning_recap` | Italic: `*Reasoning recap: ...*` |
| `model_editable_context` | Omitted from Markdown output |

#### Tool Message Rendering

| Tool Name | Markdown Rendering |
|---|---|
| `research_kickoff_tool.start_research_task` | `> **Deep Research:** {title}` |
| `research_kickoff_tool.clarify_with_text` | `> **Research Clarification:** {text}` |
| `file_search` | `> **Searched files:** {text}` |
| Other tools | `> **Tool ({name}):** {text}` |

#### Deep Research Result Messages

Messages with `metadata.is_async_task_result_message: true` are rendered with a special header:
`## Assistant (Deep Research: {task_title})`

---

## 9. Conversation Parsing

### 9.1 Message Tree Traversal

Conversations use a tree structure via the `mapping` field. Each node has:
- `id` — node identifier
- `message` — message content (may be null for root)
- `parent` — parent node ID (null for root)
- `children` — array of child node IDs

Traversal: when `current_node` identifies a valid leaf, walk its `parent` chain
to the root, guard against cycles, then reverse the collected messages. If the
active branch is unavailable, use the legacy root/first-child fallback. This
avoids rendering an abandoned early branch as the entire Pro conversation.
JSON retains the returned sibling branches; Markdown is not an all-branch view.

### 9.2 Content Types

| `content_type` | Description | Handling |
|----------------|-------------|----------|
| `text` | Standard text messages | Extract `parts[]` strings |
| `code` | Code execution results | Wrap in code block |
| `multimodal_text` | Messages with images/files | Extract text parts; reference files via `asset_pointer` |
| `tether_browsing_display` | Web browsing results | Extract browsing summary |
| `model_editable_context` | System context | Omitted from Markdown output |
| `thoughts` | Reasoning/thinking (o1/o3) | Include in Markdown under "Thinking" section |
| `reasoning_recap` | Summary of reasoning | Include as assistant recap |

### 9.3 Message Roles

| `author.role` | Description |
|---------------|-------------|
| `user` | User messages |
| `assistant` | AI responses |
| `system` | System prompts/context |
| `tool` | Tool invocations and results |

### 9.4 Tool Messages

Tool messages have `author.role: "tool"` and `author.name` values including:
- `file_search` — File/document search
- `research_kickoff_tool.start_research_task` — Deep research initiation
- `research_kickoff_tool.clarify_with_text` — Research clarification
- Various code interpreter and browsing tool names

### 9.5 Special Metadata Flags

| Flag | Description |
|------|-------------|
| `is_visually_hidden_from_conversation` | System messages not shown in UI |
| `is_async_task_result_message` | Deep research final result |
| `async_task_id` | Links message to an async research task |
| `async_task_title` | Human-readable research task title |

---

## 10. File Handling

### 10.1 Identifying Files in Conversations

Scan all returned mapping nodes for multimodal `asset_pointer` values,
`metadata.attachments`, canvas references, and Pro/Work
`metadata.content_references[type=file]`. The latter can carry a durable file ID
and filename while visible text contains only an ephemeral `sandbox:` link.
File extraction is not limited to the selected Markdown branch. One example:

```json
{
  "content_type": "image_asset_pointer",
  "asset_pointer": "sediment://file_00000000842871f5b6a1bab8e3499232",
  "size_bytes": 305531,
  "width": 1024,
  "height": 1024,
  "metadata": { "dalle": {...}, "generation": {...} }
}
```

### 10.2 File ID Extraction

```javascript
const fileId = assetPointer.replace('sediment://', '');
// "sediment://file_abc123" → "file_abc123"
```

### 10.3 Download Process

1. Get signed URL: `GET /files/download/{fileId}?conversation_id={convId}&inline=false`
2. Fetch binary content from `download_url`
3. Determine file extension from `file_name` in response or content-type
4. Save to disk

Additional resolver candidates handle alternate backend/file-service and
Library-backed references. Composite PDF-page preview pointers are normalized
to their source file rather than requested as literal `#` URL fragments.
Work `sandbox:` links with matching `content_references` are rewritten in
Markdown to local file references. This does not prove a referenced binary
download succeeded; consult failure counts and file inventories.

### 10.4 File Types

- DALL-E generated images (PNG, optional transparency)
- User-uploaded images (PNG, JPG, GIF, WebP)
- User-uploaded documents (PDF, etc.)
- Code interpreter outputs

### 10.5 Deduplication

The same file may be referenced in multiple conversations. Track downloaded file IDs to avoid re-downloading. Use the file ID as the unique key.

### 10.6 Project-Level Files

Projects also have files attached at the project level (visible in the sidebar response under `gizmo.files[]`). These are metadata-only in the listing — they use the same download endpoint with the `file_id` field.

---

## 11. Deep Research

### 11.1 Identification

Deep research tasks are identified by metadata on messages within the conversation:

**Initiation message:**
- `author.name`: `"research_kickoff_tool.start_research_task"`
- `metadata.async_task_id`: `"deepresch_{32_hex_chars}"`
- `metadata.async_task_type`: `"research"`
- `metadata.async_task_title`: human-readable title

**Result message:**
- `metadata.is_async_task_result_message`: `true`
- `metadata.async_task_id`: links to the initiation message
- `content.parts[]`: contains the full research output as text

### 11.2 Export Behavior

The research result is already embedded in the conversation as a regular message. No special handling is needed for basic export — the result will appear in both JSON and Markdown output.

### 11.3 Optional: Research Process Capture

The SSE stream at `/backend-api/tasks/{task_id}/stream` provides the research process steps:

| Row Type | Description | Key Fields |
|----------|-------------|------------|
| `summary` | Thinking/progress | `summary`, `title` |
| `search` | Web search performed | `query`, `urls` |
| `website_open` | Website being read | `url`, `row_text` |
| `file_open` | File being analyzed | `file_name`, `file_ext` |

This supplementary process capture is not implemented. The exporter currently
retains embedded final research results; the SSE stream is a future TODO and
must not be described as part of a completed export.

---

## 12. Progress Tracking

### 12.1 Legacy Minimal Schema

```json
{
  "indexingComplete": false,
  "lastOffset": 0,
  "downloadedIds": []
}
```

### 12.2 Extended Schema (with Projects, Files, Library & Dots)

```json
{
  "indexingComplete": false,
  "lastOffset": 0,
  "downloadedIds": [],

  "archivedIndexingComplete": false,
  "lastArchivedOffset": 0,

  "projectsIndexingComplete": false,
  "projectsLastCursor": null,
  "projects": {
    "g-p-{hex}": {
      "name": "Project Name",
      "indexingComplete": false,
      "lastCursor": null,
      "downloadedIds": []
    }
  },

  "downloadedFileIds": [],
  "failedFileIds": {},

  "libraryIndexingComplete": false,
  "libraryDownloadComplete": false,
  "libraryLastCursor": null,
  "libraryDownloadedFileIds": [],
  "libraryFailedFileIds": {},
  "dots": {
    "room-id": {
      "before": null,
      "messagesComplete": false,
      "threadsMetadataComplete": false,
      "downloadComplete": false
    }
  },
  "dotsFailedFileIds": {}
}
```

Archived bucket fields are populated when that scope is indexed. Dot permanent
failure keys are `{room_id}~{file_id}`, so the same file ID in another room does
not inherit that room's failure. Dot state may also contain `lastExportedAt`.

### 12.3 Resumption Logic

1. If `indexingComplete: false` → resume regular conversation indexing from `lastOffset`
2. If `projectsIndexingComplete: false` → resume project listing from `projectsLastCursor`
3. For each project: if `indexingComplete: false` → resume from project's `lastCursor`
4. Skip conversations in `downloadedIds` (unless `--update`)
5. Skip files in `downloadedFileIds`
6. Resume an interrupted Library node scan from its partial index and cursor
7. Skip complete Library versions by local file size; retry recorded failures only with `--retry-failed-files`
8. On auth error → save all progress, exit with message to refresh token
9. Resume interrupted Dot messages from `.messages.partial.json`, then refresh latest/history pages
10. Reuse complete Dot files by recorded size; preserve permanent Dot failures until an explicit retry

Completion fields indicate that a pass finished; Library failures and
`_versions_error` still need inspection. `--verify` only compares recorded
conversation IDs with saved JSON, not complete content or every file.

---

## 13. Error Handling

### 13.1 Authentication Errors (401/403)

- Set `error.authError = true`
- Save all progress to disk
- Log clear message about token expiration
- Exit with code 1
- User re-runs with fresh token to resume

### 13.2 Rate Limiting (429)

- API helper permits up to 6 attempts by default.
- Use integer `Retry-After` seconds when supplied; otherwise wait 60, 120, 300 seconds and 300 seconds for later 429s.
- Adaptive pacing adds 2 seconds per 429, bounded by its configured ceiling. After 20 consecutive successful API responses, reduce by 1 second toward its floor.
- `--throttle` controls the baseline interval; `--no-adaptive-throttle` keeps adaptive adjustments off.

### 13.3 Network Errors

- Non-auth API failures use up to 6 attempts with 2-second waits; 404 is marked no-retry.
- Binary file downloads use up to 3 attempts per header variant with 2-second waits; 401/403 move to the next applicable header variant instead of retrying identical credentials.
- Bearer auth is allowed only for `chatgpt.com` and `.openai.com` hosts. Cookies are sent only to `chatgpt.com`; external signed CDN hosts receive neither. All download URLs must use HTTPS.
- Non-auth errors fail after exhausting retries

### 13.4 File System Errors

- Auto-create directories with `{ recursive: true }`
- Graceful handling of corrupted index files (start fresh)

### 13.5 Scoped Completeness

- Bearer expiry interrupts the run with saved progress and exit code 1.
- Dot record/file errors set `summary.incomplete`, print an incomplete banner, and return exit code 1.
- A signed Dot CDN URL rejected with 401/403 is refreshed once before marking a file-specific failure. Resolver auth errors verify token validity to distinguish expiry from file denial.
- Other scope failures can remain counts/manifests under an otherwise complete banner. In Library, review `failed`, `_export.status` and `_versions_error`, not only `libraryDownloadComplete`.
- No retry option grants access or reconstructs deleted assets. Saved permanent file errors require `--retry-failed-files`.

---

## 14. Project Metadata

### 14.1 project-index.json Schema

```json
[
  {
    "id": "g-p-{hex}",
    "name": "Project Name",
    "description": "",
    "instructions": "Project instructions text...",
    "workspace_id": "uuid",
    "created_at": "ISO timestamp",
    "updated_at": "ISO timestamp",
    "num_interactions": 26,
    "files": [
      {
        "id": "hex",
        "file_id": "file-{id}",
        "name": "Document.pdf",
        "type": "application/pdf",
        "size": 1404959
      }
    ],
    "conversation_count": 12
  }
]
```

---

## 15. Request Headers

Backend JSON requests include:

```
Accept: application/json
Content-Type: application/json
Authorization: Bearer {token}
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36
```

Teams accounts additionally include:
```
chatgpt-account-id: {account_id}
```

Binary downloads use the restricted host-specific credential behavior in
§13.3, not the backend headers for every host. Optional browser Cookie headers
are normalized and validated as printable ASCII before export. Non-ASCII
DevTools labels produce an early validation error rather than a Fetch ByteString
failure mid-download. Credentials must not be included in documentation,
shared HARs, logs or patches.

---

## 16. Constraints & Notes

1. **Modular architecture** — The tool is split into `export-chatgpt.js` (shim entry point) and focused modules in `lib/` (`config`, `cli`, `auth`, `storage`, `formatter`, `api`, `downloader`, `exporter`, `library`, `dots`). No build step required.
2. **Signed URLs are ephemeral** — File download URLs must be fetched fresh; never cache them
3. **Backward compatibility** — Default behavior (no new flags) is identical to current behavior
4. **Project IDs** — Always format `g-p-{32_hex_chars}`
5. **Async Task IDs** — Format `deepresch_{32_hex_chars}`
6. **Timestamps** — API values can be epoch seconds or ISO strings; the formatter accepts both for date prefixes
7. **Conversation data is identical** — Project conversations use the same data structure as regular ones
8. **The `chatgpt-account-id` header** is required for Teams, optional for personal
9. **Hidden messages** — Messages with `is_visually_hidden_from_conversation: true` are included in JSON export but omitted from Markdown output
10. **Dot coverage** — Linked-task metadata is not internal task conversation content. Saved coverage fields state this limitation; independent download lists and Library-only outputs are distinct scopes.
11. **Validation status** — Last full local run: 356 tests / 20 suites passed. Dot responses are mocked; real non-null message pagination and live-account downloads remain to be validated. Documentation updates do not imply a new npm release.

---

### Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| v0.1.0 | 2025-03-04 | user | Initial specification |
| v0.1.1 | 2026-03-04 | audit-docs | Synced with implementation: updated interactive prompt defaults (y/N), added per-project conversation-index.json to output structure, documented enhanced Markdown rendering (content types, tool messages, deep research headers, project_id frontmatter), clarified model_editable_context is always omitted from Markdown, added file download retry behavior, made hidden-message handling definitive |
| v0.1.2 | 2026-03-31 | audit-docs | Corrected CLI flags (§4.1–4.3): replaced planned `--include-projects`/`--download-files` with actual implemented flags (`--no-projects`, `--projects-only`, `--no-files`, `--no-images`, `--no-canvas`, `--no-attachments`, `--verbose`, boolean `--update`); replaced 7 interactive prompts with single bearer token prompt (§4.3); corrected dependencies from "zero" to `commander ^12.0.0` (§2); corrected file download auth header behavior (§13.3); updated architecture description to modular `lib/` layout (§16). |
| v0.2.0 | 2026-03-31 | user | Software release: projects, files, and deep research export fully implemented; modular `lib/` architecture; Commander.js CLI; enhanced Markdown rendering. Spec reflects shipped state. |
| local checkpoint | 2026-10-01 | local update | Synced implemented CLI including archive/adaptive/verify/retry flags; documented ownership filtering, 13-character conversation IDs, active-branch Pro rendering, Work files, recursive Library versions, separate Dot module, progress/error scopes and unverified Dot task bodies. Package version unchanged. |
