# ChatGPT Projects Export - API Spec

## Overview

ChatGPT Projects (internally called "gizmos" with type "snorlax") store conversations separately from the main conversation list. They require different API endpoints than regular conversations.

This spec documents the API endpoints needed to export conversations from Projects.

## Current Local Implementation Notes (2026-10-01)

This is an observation/research document, not an official supported API contract.
Examples below describe observed shapes, not a complete account-data schema.
[README](../README.md) and [SPECIFICATION](../SPECIFICATION.md) describe the
current local CLI and output layout.

- Projects/files are enabled by default; use `--no-projects`, `--projects-only`, and granular `--no-*` file flags. Export scope does not use interactive questions.
- Project conversations are filtered by authenticated-user ownership; shared/unknown-owner entries are excluded even if listed inside a shared project.
- Regular archived chats need `--include-archived`; saved regular/project bodies need `--update` to refresh.
- Conversation filenames use a 13-character ID prefix. Markdown follows the selected `current_node` branch, while JSON retains all branches returned in the mapping.
- File extraction also handles attachments and Pro/Work `content_references`, not just image pointers. Work sandbox links are rewritten when matching durable references exist.
- File resolvers can vary; signed URLs are refreshed before download, and browser cookies may be needed only for specific same-origin Library web routes. Cookie input does not guarantee access or fix deleted files.
- The separate Library exporter recursively scans owned nodes and returned versions; the separate Dot exporter uses room/`CalpicoFile` APIs, not ordinary conversation-file assumptions.
- Dot task metadata is not a body/history export. See [Dot research](DOTS_EXPORT_RESEARCH.md) for that limitation and pending capture requirements.
- Optional deep-research SSE process capture described below is not implemented; embedded final results are supported.

---

## Authentication

Same as regular conversations:

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | `Bearer {token}` |
| `chatgpt-account-id` | Teams only | Account ID for Teams workspaces |

---

## API Endpoints

### 1. List All Projects

**Endpoint:**
```
GET https://chatgpt.com/backend-api/gizmos/snorlax/sidebar
```

**Query Parameters:**

| Parameter | Value | Description |
|-----------|-------|-------------|
| `owned_only` | `true` | Only return your projects |
| `conversations_per_gizmo` | `0` | Set to 0 since we fetch conversations separately |
| `cursor` | `{cursor}` | Pagination cursor (URL-encoded, from previous response) |

**Example Request:**
```
GET /backend-api/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0
```

**Response Structure:**
```json
{
  "items": [
    {
      "gizmo": {
        "gizmo": {
          "id": "g-p-69209166eacc81918dc596f8dd06a034",
          "display": {
            "name": "Qwandery Platform",
            "description": ""
          },
          "workspace_id": "cc47585e-b2fe-4e7d-ac6a-ced32852f07b",
          "created_at": "2025-11-21T16:20:54.917441+00:00",
          "updated_at": "2025-11-21T16:20:55.832364+00:00",
          "instructions": "Project instructions here...",
          "gizmo_type": "snorlax",
          "num_interactions": 26
        },
        "files": [
          {
            "id": "67c1fbf1bffc81918cfd0963df836c81",
            "file_id": "file-T5e2eECiYRBr1RoqueqcPG",
            "name": "Document.pdf",
            "type": "application/pdf",
            "size": 1404959
          }
        ],
        "conversations": {
          "items": [],
          "cursor": null
        }
      }
    }
  ],
  "cursor": "K1JJRDp+RzRVLUFKT0l6aG5sYyt3QkFNQm1Edz09..."
}
```

**Key Fields:**

| Path | Description |
|------|-------------|
| `items[].gizmo.gizmo.id` | Project ID (format: `g-p-{hex}`) |
| `items[].gizmo.gizmo.display.name` | Project name (use for folder naming) |
| `items[].gizmo.gizmo.instructions` | Project instructions/context |
| `items[].gizmo.gizmo.workspace_id` | Workspace ID |
| `items[].gizmo.files` | Array of project files (metadata only) |
| `cursor` | Pagination cursor (`null` = last page) |

**Pagination:**
- If `cursor` is not null, make another request with `?cursor={cursor}` (URL-encoded)
- Continue until `cursor` is null

---

### 2. List Conversations in a Project

**Endpoint:**
```
GET https://chatgpt.com/backend-api/gizmos/{gizmo_id}/conversations
```

**Path Parameters:**

| Parameter | Description |
|-----------|-------------|
| `gizmo_id` | Full project ID (e.g., `g-p-69209166eacc81918dc596f8dd06a034`) |

**Query Parameters:**

| Parameter | Value | Description |
|-----------|-------|-------------|
| `cursor` | `0` or `{cursor}` | Start with `0`, then use cursor from previous response |

**Example Request:**
```
GET /backend-api/gizmos/g-p-69209166eacc81918dc596f8dd06a034/conversations?cursor=0
```

**Response Structure:**
```json
{
  "items": [
    {
      "id": "68811872-cde4-8003-a4cc-513116c072b0",
      "title": "Terms of Service Draft",
      "create_time": "2025-07-23T17:14:27.231284Z",
      "update_time": "2025-08-17T20:49:57.087149Z",
      "gizmo_id": "g-p-67c1f3e262b88191b3dacb70c6d68354",
      "conversation_template_id": "g-p-67c1f3e262b88191b3dacb70c6d68354",
      "workspace_id": "cc47585e-b2fe-4e7d-ac6a-ced32852f07b",
      "is_archived": false,
      "snippet": "Preview text of the conversation...",
      "owner": {
        "user_id": "user-8yqSwKy8G9WZVPxDvgi1VwbZ__cc47585e-...",
        "user_email": "brian@qwandery.com",
        "name": "Brian Lacy"
      }
    }
  ],
  "cursor": "K1JJRDp+ZVo1eEFKTENNK0FGQkNJQUFBQVFEZz09..."
}
```

**Key Fields:**

| Path | Description |
|------|-------------|
| `items[].id` | Conversation ID (same format as regular conversations) |
| `items[].title` | Conversation title |
| `items[].create_time` | Creation timestamp (ISO format) |
| `items[].update_time` | Last update timestamp (ISO format) |
| `items[].gizmo_id` | Parent project ID |
| `items[].snippet` | Preview text |
| `cursor` | Pagination cursor (`null` = last page) |

**Pagination:**
- Start with `?cursor=0`
- If response `cursor` is not null, make another request with that cursor
- Continue until `cursor` is null

---

### 3. Fetch Full Conversation

**Endpoint:**
```
GET https://chatgpt.com/backend-api/conversation/{conversation_id}
```

This is **identical to regular conversations** — no changes needed. The conversation data structure is the same.

**Example Request:**
```
GET /backend-api/conversation/68811872-cde4-8003-a4cc-513116c072b0
```

---

### 4. Download Conversation Files (Images, Attachments)

Files referenced in conversations (DALL-E generated images, user uploads) use `asset_pointer` references in the conversation data.

**Step 1: Get signed download URL**

**Endpoint:**
```
GET https://chatgpt.com/backend-api/files/download/{file_id}?conversation_id={conversation_id}&inline=false
```

**Parameters:**

| Parameter | Location | Description |
|-----------|----------|-------------|
| `file_id` | Path | The file ID extracted from asset_pointer |
| `conversation_id` | Query | The conversation containing the file |
| `inline` | Query | `false` for download, `true` for inline display |

**Example Request:**
```
GET /backend-api/files/download/file_00000000842871f5b6a1bab8e3499232?conversation_id=698e728e-6498-8333-9bb6-5e6b3b1b3e36&inline=false
```

**Response:**
```json
{
  "status": "success",
  "download_url": "https://chatgpt.com/backend-api/estuary/content?id=file_00000000842871f5b6a1bab8e3499232&ts=492403&p=fs&cid=1&sig=0ef4152f6c70d8f60b1887bf9469862647a9f906eefc13397df7f93be756ab73&v=0",
  "file_name": "user-8yqSwKy8G9WZVPxDvgi1VwbZ__cc47585e-b2fe-4e7d-ac6a-ced32852f07b/941d4670-0d4f-4bb2-901f-89aaabc66988.png",
  "file_size_bytes": 305531
}
```

**Step 2: Download the actual file**

Fetch the `download_url` directly — it's a signed URL that returns the binary file content.

```bash
curl -o image.png "{download_url}"
```

---

### Finding Files in Conversation Data

Files appear in message nodes with `content_type: "multimodal_text"`. Look for `image_asset_pointer` parts:

```json
{
  "content": {
    "content_type": "multimodal_text",
    "parts": [
      {
        "content_type": "image_asset_pointer",
        "asset_pointer": "sediment://file_00000000842871f5b6a1bab8e3499232",
        "size_bytes": 305531,
        "width": 1024,
        "height": 1024,
        "metadata": {
          "dalle": {
            "gen_id": "3b3d1145-dbee-4094-b4bb-3c962e4a1047",
            "prompt": ""
          },
          "generation": {
            "gen_id": "3b3d1145-dbee-4094-b4bb-3c962e4a1047",
            "height": 1024,
            "width": 1024,
            "transparent_background": false,
            "orientation": "square"
          }
        }
      }
    ]
  }
}
```

**Extracting file ID from asset_pointer:**
```javascript
// asset_pointer: "sediment://file_00000000842871f5b6a1bab8e3499232"
const fileId = assetPointer.replace('sediment://', '');
// Result: "file_00000000842871f5b6a1bab8e3499232"
```

**Key metadata fields:**

| Field | Description |
|-------|-------------|
| `asset_pointer` | Reference to file, extract ID after `sediment://` |
| `size_bytes` | File size in bytes |
| `width`, `height` | Image dimensions |
| `metadata.dalle.gen_id` | DALL-E generation ID (for AI-generated images) |
| `metadata.generation.transparent_background` | Whether PNG has transparency |
| `metadata.generation.orientation` | `square`, `portrait`, or `landscape` |

---

## Key Differences from Regular Conversations

| Aspect | Regular Conversations | Projects |
|--------|----------------------|----------|
| List endpoint | `/backend-api/conversations` | `/backend-api/gizmos/snorlax/sidebar` |
| Pagination | `offset` (numeric) | `cursor` (opaque string) |
| Per-project listing | N/A | `/backend-api/gizmos/{id}/conversations` |
| Conversation fetch | Same | Same |
| Conversation data structure | Same | Same |

---

## Implementation Recommendations

### Current Output Structure (ordinary/project scopes)

```
exports/{user_id}/
├── json/
│   └── {date}_{title}_{13-character-id}.json
├── markdown/
│   └── {date}_{title}_{13-character-id}.md
├── projects/
│   ├── {ProjectName}/
│   │   ├── json/
│   │   ├── markdown/
│   │   ├── files/
│   │   └── conversation-index.json
│   └── project-index.json
├── files/
├── conversation-index.json
└── .export-progress.json
```

Library and Dots add their own optional trees; see [README](../README.md).

### Progress Tracking

The implementation extends `.export-progress.json` with project export state.
The subset below omits later archive/file/Library/Dot fields, which are specified
in [SPECIFICATION](../SPECIFICATION.md):

```json
{
  "indexingComplete": true,
  "lastOffset": 1227,
  "downloadedIds": ["..."],

  "projectsIndexingComplete": false,
  "projectsLastCursor": "K1JJRDp...",
  "projects": {
    "g-p-69209166eacc81918dc596f8dd06a034": {
      "name": "Qwandery Platform",
      "indexingComplete": true,
      "lastCursor": null,
      "downloadedIds": ["68811872-cde4-8003-a4cc-513116c072b0"]
    },
    "g-p-677eeb83c16c81918d4b91632cf3aca8": {
      "name": "Qwandery.com Website",
      "indexingComplete": false,
      "lastCursor": "K1JJRDp...",
      "downloadedIds": []
    }
  }
}
```

### Current CLI Usage (local checkout)

```bash
# Export everything (regular + projects)
node export-chatgpt.js

# Export only projects
node export-chatgpt.js --projects-only

# Export only regular conversations (skip projects)
node export-chatgpt.js --no-projects

# Default file downloads can be disabled
node export-chatgpt.js --no-files

# Add archived regular chats plus the optional Library and Dot scopes
node export-chatgpt.js --include-archived --include-library --include-dots
```

### Sanitize Project Names for Folders

```javascript
function sanitizeForFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')  // Remove illegal filesystem chars
    .replace(/\s+/g, '_')            // Replace spaces with underscores
    .trim()
    .substring(0, 50);               // Limit length
}
```

### Export Flow

```
1. If projects are enabled (default, unless --no-projects) or --projects-only:

   a. INDEX PROJECTS
      - GET /gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0
      - Paginate using cursor until null
      - Save project-index.json

   b. FOR EACH PROJECT:
      - GET /gizmos/{gizmo_id}/conversations?cursor=0
      - Paginate using cursor until null
      - Add conversations to project's index

   c. DOWNLOAD PROJECT CONVERSATIONS:
      - For each conversation in each project:
        - GET /conversation/{id}
        - Save to exports/projects/{ProjectName}/
        - If file downloads are enabled: extract and download referenced files
        - Track in progress file

2. Unless --projects-only:
   - Run existing regular conversation export
   - If file downloads are enabled: extract and download referenced files

3. If file downloads are enabled:
   - Scan conversation JSON for asset_pointer references
   - For each unique file:
     - GET /files/download/{file_id}?conversation_id={id}
     - Fetch the download_url
     - Save to exports/files/ or exports/projects/{name}/files/

4. Handle token expiration gracefully at any point
   - Save progress
   - Exit with clear message to refresh token
```

---

## Example curl Commands

### List Projects
```bash
curl "https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0" \
  -H "Authorization: Bearer {token}" \
  -H "chatgpt-account-id: {account_id}"
```

### List Conversations in Project
```bash
curl "https://chatgpt.com/backend-api/gizmos/g-p-69209166eacc81918dc596f8dd06a034/conversations?cursor=0" \
  -H "Authorization: Bearer {token}" \
  -H "chatgpt-account-id: {account_id}"
```

### Fetch Conversation (same as regular)
```bash
curl "https://chatgpt.com/backend-api/conversation/68811872-cde4-8003-a4cc-513116c072b0" \
  -H "Authorization: Bearer {token}" \
  -H "chatgpt-account-id: {account_id}"
```

### Get File Download URL
```bash
curl "https://chatgpt.com/backend-api/files/download/file_00000000842871f5b6a1bab8e3499232?conversation_id=698e728e-6498-8333-9bb6-5e6b3b1b3e36&inline=false" \
  -H "Authorization: Bearer {token}" \
  -H "chatgpt-account-id: {account_id}"
```

### Stream Deep Research Task Progress (Optional)
```bash
curl "https://chatgpt.com/backend-api/tasks/deepresch_688122e9be4c819193c495cfd34260ac/stream?parent_conversation_id=68811872-cde4-8003-a4cc-513116c072b0&message_id=9253f663-f98c-4d68-8185-ae5edc5292a4" \
  -H "accept: text/event-stream" \
  -H "Authorization: Bearer {token}" \
  -H "chatgpt-account-id: {account_id}"
```

**Note:** The research stream returns Server-Sent Events. Each line starts with `data: ` followed by JSON. The stream ends with `data: [DONE]`.

---

---

### 5. Deep Research / Async Tasks

Some conversations contain "deep research" tasks that run asynchronously. These appear in the conversation data as special message types and can be streamed separately.

**Identifying Async Tasks in Conversation Data:**

Look for messages with `async_task_id` in their metadata:

```json
{
  "id": "9253f663-f98c-4d68-8185-ae5edc5292a4",
  "author": {"role": "tool", "name": "research_kickoff_tool.start_research_task"},
  "metadata": {
    "async_task_id": "deepresch_688122e9be4c819193c495cfd34260ac",
    "async_task_title": "Terms of Service for Qwandery Mobile App (Beta Release)",
    "async_task_prompt": "Generate a comprehensive...",
    "async_task_type": "research",
    "async_task_conversation_id": "688122e9-c244-8003-8437-ca698d60be81",
    "async_task_created_at": "2025-07-23 17:59:11.579369+00:00",
    "deep_research_version": "full"
  }
}
```

The final research result appears as a later message with `is_async_task_result_message: true`:

```json
{
  "id": "1c2fd91d-2d83-490e-9120-e165693d4c90",
  "content": {
    "content_type": "text",
    "parts": ["# Qwandery Terms of Service\n\n## Introduction..."]
  },
  "metadata": {
    "is_async_task_result_message": true,
    "async_task_id": "deepresch_688122e9be4c819193c495cfd34260ac",
    "async_task_title": "Terms of Service for Qwandery Mobile App (Beta Release)"
  }
}
```

**Streaming Research Progress (Optional):**

You can stream the research task's progress in real-time:

**Endpoint:**
```
GET https://chatgpt.com/backend-api/tasks/{task_id}/stream?parent_conversation_id={conversation_id}&message_id={message_id}
```

**Parameters:**

| Parameter | Location | Description |
|-----------|----------|-------------|
| `task_id` | Path | The async task ID (e.g., `deepresch_688122e9be4c819193c495cfd34260ac`) |
| `parent_conversation_id` | Query | The conversation ID containing the task |
| `message_id` | Query | The message ID that initiated the task |

**Response:** Server-Sent Events (SSE) stream with `data:` prefixed JSON objects:

```
data: {"task_status": "completed", "task_id": "deepresch_...", ...}

data: {"task_id": "deepresch_...", "row": {"type": "summary", "id": "...", "summary": "Consulting policies...", "title": "Piecing together guidelines", "created_at": 1753293560.099694}}

data: {"task_id": "deepresch_...", "row": {"type": "search", "id": "...", "query": "Searched for Supabase user avatars privacy", "urls": ["https://www.reddit.com", ...], "created_at": 1753293642.7158895}}

data: {"task_id": "deepresch_...", "row": {"type": "website_open", "id": "...", "url": "https://www.dnb.com", "row_text": "Read [dnb.com](https://www.dnb.com)", ...}}

data: {"task_id": "deepresch_...", "row": {"type": "file_open", "id": "...", "file_name": "Qwandery Moments - Mobile App Specification.pdf", ...}}

data: {"task_id": "deepresch_...", "final_message": {...}}

data: [DONE]
```

**Row Types in Stream:**

| Type | Description | Key Fields |
|------|-------------|------------|
| `summary` | Thinking/progress update | `summary`, `title`, `created_at` |
| `search` | Web search performed | `query`, `urls`, `created_at` |
| `website_open` | Website being read | `url`, `row_text`, `sanitized_url` |
| `file_open` | Uploaded file being read | `file_name`, `file_ext`, `icon_type` |

The stream ends with a `final_message` object containing the complete response, followed by `[DONE]`.

**Note:** For export purposes, streaming is optional. The final research result is already included in the conversation data as a regular message with `is_async_task_result_message: true`. The stream is useful if you want to capture the research process/reasoning steps.

---

## Key Differences from Regular Conversations

| Aspect | Regular Conversations | Projects |
|--------|----------------------|----------|
| List endpoint | `/backend-api/conversations` | `/backend-api/gizmos/snorlax/sidebar` |
| Pagination | `offset` (numeric) | `cursor` (opaque string) |
| Per-project listing | N/A | `/backend-api/gizmos/{id}/conversations` |
| Conversation fetch | Same | Same |
| Conversation data structure | Same | Same |

---

## Notes

1. **Project IDs** always have format `g-p-{32_hex_chars}`

2. **Async Task IDs** for deep research have format `deepresch_{32_hex_chars}`

3. **Timestamps** may be ISO strings or epoch seconds; the formatter accepts both

4. **Conversation data** inside projects is identical to regular conversations — same structure, same fields, same download endpoint

5. **File IDs** may occur in `sediment://` pointers, attachment metadata or Pro/Work `content_references`; derived PDF page previews must be normalized to their source file

6. **Download URLs** are signed and time-limited — fetch them fresh for each download, don't cache them

7. **The `chatgpt-account-id` header** is required for Teams accounts, optional for personal accounts

8. **File types** you may encounter:
   - DALL-E generated images (PNG, with optional transparency)
   - User-uploaded images (various formats)
   - User-uploaded documents (PDF, etc.)

9. **Deduplication**: Files may be referenced in multiple conversations — consider tracking downloaded file IDs to avoid re-downloading

10. **Special message types** to be aware of when parsing conversation data:
    - `content_type: "text"` — Standard text messages
    - `content_type: "multimodal_text"` — Messages with images/files (check for `image_asset_pointer` parts)
    - `content_type: "tether_browsing_display"` — Web browsing results
    - `content_type: "model_editable_context"` — System context
    - `content_type: "thoughts"` — Reasoning/thinking (o1/o3 models)
    - `content_type: "reasoning_recap"` — Summary of reasoning time
    - Tool messages with `author.role: "tool"` and various `author.name` values:
      - `file_search` — File/document search
      - `research_kickoff_tool.start_research_task` — Deep research initiation
      - `research_kickoff_tool.clarify_with_text` — Research clarification

11. **Hidden messages**: Some messages have `is_visually_hidden_from_conversation: true` in metadata — these are typically system messages not shown to users but may contain useful context

12. **Project files** attached to projects (in the sidebar response) are metadata only — separate from conversation file attachments
