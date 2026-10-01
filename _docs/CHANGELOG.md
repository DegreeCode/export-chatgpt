# Changelog

All notable changes to the ChatGPT Conversation Exporter.

---

## Unreleased — Local Checkpoints (2026-09-16–2026-10-01)

These changes are in the local checkout and numbered patch sequence, not a
claim of a published npm release. `package.json` remains v0.2.0.

### Conversations, Auth and Recovery

- Filter project conversations to the authenticated user's ownership, including workspace-suffixed user IDs.
- Add archived regular-chat indexing with separate resume offsets via `--include-archived`.
- Add adaptive request pacing, explicit `--retry-failed-files`, and conversation JSON verification/recovery flags.
- Propagate authentication expiry as an incomplete run rather than printing a successful completion banner.
- Expand conversation filename IDs from 8 to 13 characters to avoid collision-based silent skips.
- Render the selected `current_node` branch for edited/regenerated Pro responses while preserving returned branches in JSON.
- Extract Work `content_references`, rewrite matching sandbox links, handle alternate file resolvers and normalize PDF preview references to their source file.
- Restrict credential forwarding by download host; accept and validate optional browser Cookie headers for Library-backed web routes.

### Library

- Add separate `lib/library.js`, `--include-library` and `--library-only`.
- Enumerate global owned Library nodes, recursively follow folders, paginate file versions and save one directory per file.
- Resume interrupted indexes; reuse matching saved conversation/project files or skip complete local version files.
- Preserve metadata/manifests and per-version failures; version-list fallback does not establish historical-version completeness.

### Dots — 2026-10-01

- Add separate `lib/dots.js`, `--include-dots` and `--dots-only`, combinable with `--include-library`.
- Export only current-user-created Dot DM rooms after full room identity/ownership checks.
- Save profile, room, message JSON/Markdown, nested widget data, and visible/hidden linked-task metadata.
- Identify human/Dot senders by IDs despite both having `role: user`.
- Checkpoint and merge message history; refresh edits/reactions and retain previously saved messages.
- Refresh room file URLs before downloading `CalpicoFile` attachments; use `.part`, reuse complete files and explicitly retry permanent failures.
- Reject incompatible only modes, and mark Dot record/file errors incomplete with a nonzero exit code.
- State that internal task bodies, an independent download-list API, private Dot notes and external channel messages are not exported.

### Documentation and Verification

- Update README with local Node/PowerShell commands, scope defaults, file formats, resumability and failure interpretation.
- Align specification/TODO with actual flags, retry timing, ownership, active-branch rendering and Library/Dot coverage.
- Keep captured evidence distinct from official product documentation; record remaining task-body/cursor capture requirements.
- Last full automated run: **356 tests / 20 suites passed**. Dot responses are synthetic; real-account download and multi-page cursor verification remain open.
- Numbered sequence: `1` pre-Library fixes → `2` 404 recovery → `3` Pro/Work → `4` Library → `5` Dots/documentation. Earlier patches and `legacy` remain unchanged.

---

## v0.2.0 — 2026-03-31

Major feature release adding project, file, and deep research export support.

### New Features
- **Projects** — export all ChatGPT Project conversations; cursor-based pagination via sidebar API; per-project `conversation-index.json` and directory layout
- **Files** — download DALL-E images, canvas documents, and user-uploaded attachments; deduplication via file ID tracking
- **Deep research** — captures async research task results embedded in conversations (initiation + result messages)
- **Enhanced Markdown** — browsing results, reasoning/thinking collapsible `<details>` blocks, tool message rendering, deep research result headers, `project_id` frontmatter

### Architecture
- Refactored from single-file script to modular `lib/` layout (`config`, `cli`, `auth`, `storage`, `formatter`, `api`, `downloader`, `exporter`)
- Switched CLI argument parsing to `commander ^12.0.0`

### CLI Changes
- Added `--no-projects` / `--projects-only` flags for project export control
- Added `--no-files` / `--no-images` / `--no-canvas` / `--no-attachments` granular file download flags
- Added `--verbose` flag
- Reduced interactive prompts to bearer token input only (all other config via flags)

---

## v0.1.1 — 2026-03-04

**Audit sync** — Aligned SPECIFICATION.md and TODO.md with the implemented codebase.

### SPECIFICATION.md changes
- Updated interactive prompt defaults from `(Y/n)` to `(y/N)` for update mode, projects, and files prompts (sections 4.4)
- Added per-project `conversation-index.json` to output structure diagram (section 7.1)
- Added `project_id` frontmatter field to Markdown example (section 8.2)
- Added enhanced content type rendering table (section 8.2): multimodal_text, tether_browsing_display, thoughts, reasoning_recap, model_editable_context
- Added tool message rendering table (section 8.2): research_kickoff_tool, file_search, generic tools
- Added deep research result message rendering documentation (section 8.2)
- Changed `model_editable_context` handling from "Skip or include" to "Omitted from Markdown output" (section 9.2)
- Added file download retry documentation (section 13.3)
- Made hidden message handling definitive: "omitted from Markdown output" (section 16, constraint 9)

### TODO.md changes
- Marked Phases 1–7 and documentation update tasks as complete
- Remaining open items: optional SSE research stream capture, end-to-end manual testing

---

## v0.1.0 — 2025-03-04

Initial SPECIFICATION.md and TODO.md created.
