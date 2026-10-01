# TODO — Export Features and Verification

Status of the locally patched ChatGPT Conversation Exporter as of 2026-10-01.
Checked items refer to implemented code, not guaranteed completeness for every
live account. The local `package.json` version remains v0.2.0; see
[_docs/CHANGELOG.md](_docs/CHANGELOG.md) for unreleased checkpoint changes.

---

## Phase 1: CLI & Configuration

- [x] Enable projects by default; implement `--no-projects` and `--projects-only` in Commander
- [x] Enable file downloads by default; implement `--no-files`, `--no-images`, `--no-canvas`, `--no-attachments`
- [x] Keep bearer-token prompting only for authentication; scopes use CLI flags, donation prompt can be disabled
- [x] Update Commander help with implemented options and examples
- [x] Add `projects/` and `files/` paths to `initPaths()` and `PATHS` object
- [x] Ensure `--projects-only` skips regular conversation export
- [x] Add archived regular-chat indexing, adaptive throttle and explicit file-error retry flags

---

## Phase 2: Project Listing & Indexing

- [x] Implement `fetchProjectList(accessToken, progress)` function
  - Paginate `GET /backend-api/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0`
  - Use cursor-based pagination (not offset)
  - Save progress after each page (`projectsLastCursor`)
  - Mark `projectsIndexingComplete` when cursor is null
- [x] Save `project-index.json` to `exports/projects/`
  - Schema: array of `{ id, name, description, instructions, workspace_id, created_at, updated_at, num_interactions, files[], conversation_count }`
- [x] Extend `.export-progress.json` with project tracking fields
  - `projectsIndexingComplete`, `projectsLastCursor`, `projects: {}`

---

## Phase 3: Project Conversation Export

- [x] Implement `fetchProjectConversations(accessToken, project, progress)` function
  - Paginate `GET /backend-api/gizmos/{gizmo_id}/conversations?cursor={cursor}`
  - Start with `cursor=0`, paginate until null
  - Track per-project: `indexingComplete`, `lastCursor`, `downloadedIds`
- [x] Create project directory structure: `exports/projects/{SanitizedProjectName}/json/` and `markdown/`
- [x] Implement `exportProjectConversations(accessToken, project, progress)` function
  - Reuse existing `fetchConversation()` for full conversation data
  - Reuse existing `conversationToMarkdown()` for Markdown conversion
  - Reuse existing file-naming logic (`{date}_{title}_{shortId}`)
  - Save to project-specific subdirectories
  - Track downloads per-project in progress file
- [x] Add project folder name sanitization (max 50 chars)
- [x] Exclude shared/unknown-owner conversations using JWT identity and normalized workspace user IDs
- [x] Use 13-character conversation ID filename prefixes to avoid older collision-based silent skips

---

## Phase 4: File Downloads

- [x] Implement `extractFileReferences(conversationData)` function
  - Traverse message mapping tree
  - Find messages with `content_type: "multimodal_text"`
  - Extract `asset_pointer` values from `image_asset_pointer` parts
  - Return array of `{ fileId, conversationId, metadata }` objects
- [x] Implement `getFileDownloadUrl(accessToken, fileId, conversationId)` function
  - `GET /backend-api/files/download/{file_id}?conversation_id={id}&inline=false`
  - Return `{ download_url, file_name, file_size_bytes }`
- [x] Implement `downloadFile(downloadUrl, outputPath, accessToken)` function
  - Fetch binary content from signed URL
  - Save to disk
  - Determine file extension from response `file_name` or content-type
- [x] Implement file download orchestration in export flow
  - After downloading conversation JSON, scan for file references
  - For regular conversations: save to `exports/files/{file_id}.{ext}`
  - For project conversations: save to `exports/projects/{name}/files/{file_id}.{ext}`
  - Track downloaded file IDs in `progress.downloadedFileIds[]` for deduplication
- [x] Handle project-level files (attached to project, not conversation)
  - Extract from `gizmo.files[]` in sidebar response
  - Download using same mechanism with `file_id` field
- [x] Extract attachments and Pro/Work `content_references`, not only image pointers
- [x] Resolve alternate/file-service/Library download routes and normalize composite PDF page previews to their source file
- [x] Restrict credentials by download host; validate browser Cookie values before Fetch
- [x] Reopen recorded permanent file failures only with `--retry-failed-files`

---

## Phase 5: Deep Research Handling

- [x] Detect deep research messages during Markdown conversion
  - Identify initiation: `author.name === "research_kickoff_tool.start_research_task"`
  - Identify results: `metadata.is_async_task_result_message === true`
- [x] Format research results in Markdown output
  - Add metadata header (task title, prompt) before research content
  - Render the research result text (already in `content.parts[]`)
- [ ] *(Optional)* Implement research process capture via SSE stream
  - `GET /backend-api/tasks/{task_id}/stream`
  - Parse SSE events for `summary`, `search`, `website_open`, `file_open` rows
  - Save as supplementary `{conversation_id}_research_{task_id}.json`

---

## Phase 6: Markdown Enhancements

- [x] Handle `multimodal_text` content type in `extractMessageContent()`
  - Extract text parts (strings) from `parts[]`
  - For `image_asset_pointer` parts: render as `![image](files/{file_id}.{ext})` if files downloaded, or note as `[Image: {file_id}]`
- [x] Handle `tether_browsing_display` content type
  - Extract browsing result summary text
- [x] Handle `thoughts` content type (o1/o3 reasoning)
  - Render under a "Thinking" subsection or collapsible block
- [x] Handle `reasoning_recap` content type
  - Render as brief reasoning summary
- [x] Handle tool messages in Markdown output
  - `research_kickoff_tool` → "Deep Research: {task_title}"
  - `file_search` → "Searched files: ..."
  - Other tools → generic "Tool: {name}" with content
- [x] Select Pro edited/regenerated branch from `current_node`; retain the returned whole mapping in JSON
- [x] Rewrite matching Work `sandbox:` file links to local paths using `content_references`

---

## Phase 7: Integration & Orchestration

- [x] Wire project export into `main()` flow
  - Unless `--no-projects`, run project export; `--projects-only` forces it
  - Unless an only mode is selected, run regular export
  - Use enabled file-type flags for downloads
- [x] Implement unified progress save on auth error
  - Persist regular, project and file progress; propagate auth expiry as an incomplete run
- [x] Print combined summary at end
  - Regular conversations: downloaded / skipped / errors
  - Projects: count, conversations per project
  - Files: downloaded / skipped / errors

---

## Phase 8: Documentation & Testing

- [x] Update README.md with new features
  - New CLI flags and examples
  - Project export usage
  - File download usage
  - Updated output structure diagram
- [ ] End-to-end manual testing
  - Regular-only export (backward compatibility)
  - Default regular + project export
  - `--projects-only` export
  - Default file downloads with regular/project conversations
  - Resumption after token expiry mid-project-export
  - Empty projects (no conversations)
  - Conversations with deep research results

---

## Phase 9: Owned Library Export

- [x] Separate `lib/library.js`, `--include-library` and `--library-only`
- [x] Use global nodes, recursively paginate owned folders, exclude shared/unknown-access nodes
- [x] Paginate returned file versions; save per-file folders, manifests and version-prefixed binaries
- [x] Resume partial indexing and refresh completed Library indexes on later runs
- [x] Skip locally complete version files, reuse matching ordinary/project files, renew download URLs
- [x] Respect file-type flags and explicit retry of recorded errors
- [ ] Continue live-account audit of failed versions and `_versions_error` fallback cases; do not infer completeness from a finished-pass flag

---

## Phase 10: Owned Dot Export

- [x] Separate `lib/dots.js`, `--include-dots` and `--dots-only`
- [x] Enumerate profiles and verify current-user creator, DM type, Dot ID and room ID
- [x] Save profiles, rooms, JSON messages, readable Markdown and nested widget payloads
- [x] Preserve visible/hidden linked-task IDs and parent/visibility metadata
- [x] Persist `coverage` and `bodies_exported: false`; do not claim internal task bodies are exported
- [x] Save per-page message checkpoints; resume interrupted older pages and refresh latest/history pages
- [x] Identify human/Dot authors by sender/member IDs, not the shared `role: user` value
- [x] Resolve fresh `CalpicoFile` metadata, download via `.part`, reuse complete files, handle permanent failures explicitly
- [x] Combine Dot-only with `--include-library` for Library-only results
- [x] Reject incompatible only modes; report Dot failures as incomplete with exit code 1
- [ ] Run real-account Dot chat/file export and verify content, file bytes, ownership and auth interruption
- [ ] Capture a non-null message cursor and the matching older-page request, then confirm `prev_cursor` → `before`
- [ ] Capture per-task body/history API from Activity, including hidden tasks if available; implement only after observing its schema
- [ ] Identify an independent download-list API, if present; current `downloads.json` is derived from message attachments
- [ ] Establish Dot-to-Library provenance before claiming per-Dot Library association

See [_docs/DOTS_EXPORT_RESEARCH.md](_docs/DOTS_EXPORT_RESEARCH.md) for exactly
which sanitized requests/responses are needed. Private notes/memory and external
Slack/Teams messages are outside the current exporter, not implicitly covered
by Dot room export.

---

## Phase 11: Checkpoints and Documentation Validation

- [x] Preserve existing 1–4 and legacy patches; add 5th incremental Dot patch on the pre-Dot Library state
- [x] Validate 5th patch application against its baseline; do not alter the real Git index or create a commit
- [x] Last full automated run: 356 tests / 20 suites passed (Dot HTTP responses are mocked)
- [x] Sync README, specification, this checklist, research notes and changelog with local behavior
- [ ] Complete the live checks above; automated pass does not establish live endpoint coverage

---

### Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| v0.1.0 | 2025-03-04 | user | Initial TODO plan |
| v0.1.1 | 2026-03-04 | audit-docs | Marked Phases 1–7 and documentation tasks complete per implementation. Remaining: optional SSE research stream capture, end-to-end manual testing |
| v0.2.0 | 2026-03-31 | user | Software release: all Phase 1–7 work shipped. Remaining open items carried forward: optional SSE research stream capture, end-to-end manual testing. |
| local checkpoint | 2026-10-01 | local update | Replaced planned flags/prompts with actual CLI behavior; recorded archive/404/Pro/Work fixes, Library/Dot implementation and outstanding real-account/internal-task verification. |
