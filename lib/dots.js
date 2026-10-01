'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONFIG, PATHS, verboseLog } = require('./config');
const { createApiHeaders, fetchWithRetry, throttle, verifyToken } = require('./auth');
const { normalizeWorkspaceUserId } = require('./api');
const { ensureDir, saveProgress } = require('./storage');
const { downloadFile } = require('./downloader');
const { mimeToExtension } = require('./formatter');
const { sanitizeMetadata, stripUrlSecrets, safeSegment, fileLooksComplete } = require('./library');

const COVERAGE = {
  room_messages: 'exported',
  message_attachments: 'indexed; downloads respect file flags',
  linked_task_metadata: 'exported including hidden task links',
  linked_task_bodies: 'not_exported: body API has not been captured or verified',
  independent_download_list: 'not_verified: downloads.json is derived from message attachments',
  library_results: 'use --include-library to also export Library-only results',
};

function readJson(filename, fallback) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') verboseLog(`  Warning: Could not read Dot checkpoint ${path.basename(filename)}`);
    return fallback;
  }
}

function writeJson(filename, value) {
  ensureDir(path.dirname(filename));
  const temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(sanitizeMetadata(value), null, 2));
  fs.renameSync(temporary, filename);
}

function safeError(error) {
  return String(error.message || error).replace(/https?:\/\/[^\s"<>]+/g, stripUrlSecrets).slice(0, 500);
}

function keySuffix(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function apiUrl(route, query = {}) {
  const url = new URL(`${CONFIG.apiBase}${route}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.href;
}

async function getJson(accessToken, url) {
  await throttle();
  const response = await fetchWithRetry(url, { headers: createApiHeaders(accessToken) });
  return response.json();
}

async function fetchCursorItems(accessToken, route, query) {
  const items = new Map();
  const seenCursors = new Set();
  let cursor = null;
  do {
    const data = await getJson(accessToken, apiUrl(route, { ...query, cursor }));
    if (!Array.isArray(data?.items)) throw new Error(`Dot ${route} response is missing items`);
    for (const item of data.items) {
      const id = item?.id || item?.thread_id;
      if (id) items.set(id, item);
    }
    cursor = typeof data.cursor === 'string' && data.cursor ? data.cursor : null;
    if (cursor && seenCursors.has(cursor)) throw new Error(`Dot ${route} repeated a pagination cursor`);
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return Array.from(items.values());
}

function fetchDotList(accessToken) {
  return fetchCursorItems(accessToken, '/tbo', { limit: CONFIG.dotsPageSize, include_room_preview: false });
}

function fetchDotThreads(accessToken, dotId) {
  return fetchCursorItems(accessToken, `/tbo/${encodeURIComponent(dotId)}/threads`, { limit: 100, include_hidden: true });
}

function isOwnedRoom(room, dot) {
  const currentUser = normalizeWorkspaceUserId(CONFIG.currentUserId);
  const creator = normalizeWorkspaceUserId(room?.creator_account_user_id);
  return Boolean(currentUser && creator === currentUser && room.id === dot.messaging_room_id &&
    room.aeon_id === dot.id && room.type === 'DM');
}

function sortedMessages(messages) {
  return [...messages.values()].sort((a, b) =>
    String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.id.localeCompare(b.id));
}

async function fetchDotMessages(accessToken, roomId, directory, state, progress) {
  const outputPath = path.join(directory, 'messages.json');
  const partialPath = path.join(directory, '.messages.partial.json');
  const previous = readJson(outputPath, { items: [] });
  const partial = readJson(partialPath, null);
  const resumable = partial?.room_id === roomId && partial.incomplete === true;
  const messages = new Map((previous.items || []).filter(item => item?.id).map(item => [item.id, item]));
  if (resumable) for (const item of partial.items || []) if (item?.id) messages.set(item.id, item);

  const scan = async (initialBefore, seenBefore = []) => {
    let before = initialBefore;
    const seen = new Set(seenBefore);
    while (true) {
      const data = await getJson(accessToken, apiUrl(`/messaging/rooms/${encodeURIComponent(roomId)}/messages`, {
        limit: CONFIG.dotMessagePageSize, before,
      }));
      if (!Array.isArray(data?.items)) throw new Error('Dot messages response is missing items');
      for (const item of data.items) {
        if (typeof item?.id !== 'string') throw new Error('Dot message response contains a missing message ID');
        messages.set(item.id, item);
      }

      // The captured room response returns messages in chronological order.
      // prev_cursor points backwards; next_cursor must not be used with before.
      const oldest = [...data.items].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))[0];
      const nextBefore = data.items.length === 0 ? null
        : (typeof data.prev_cursor === 'string' && data.prev_cursor ? data.prev_cursor
          : (Object.hasOwn(data, 'prev_cursor') ? null : oldest.id));
      const repeated = nextBefore && (nextBefore === before || seen.has(nextBefore));
      if (nextBefore) seen.add(nextBefore);
      writeJson(partialPath, {
        room_id: roomId, incomplete: true, before: nextBefore,
        seen_before: [...seen], items: sortedMessages(messages),
      });
      state.messagesComplete = false;
      state.before = nextBefore;
      saveProgress(progress);
      if (repeated) throw new Error('Dot message pagination repeated a cursor; partial messages were saved');
      if (!nextBefore) break;
      before = nextBefore;
    }
  };

  // Continue interrupted history, then scan from the latest page to include
  // messages sent while the exporter was stopped. Ordinary runs refresh all
  // pages so edits/reactions are updated without requiring --update.
  if (resumable && partial.before) await scan(partial.before, partial.seen_before || []);
  await scan(null);
  const document = {
    room_id: roomId, exported_at: new Date().toISOString(),
    indexing_complete: true, items: sortedMessages(messages),
  };
  writeJson(outputPath, document);
  if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
  state.messagesComplete = true;
  state.before = null;
  saveProgress(progress);
  return document.items;
}

function collectDotFiles(messages) {
  const files = new Map();
  for (const message of messages) {
    for (const attachment of message.content?.attachments || []) {
      if (!['file', 'image'].includes(attachment.type)) continue;
      const fileId = attachment.file_id || attachment.file?.file_id || attachment.file?.id;
      if (!fileId) continue;
      const existing = files.get(fileId);
      const messageIds = new Set(existing?.message_ids || []);
      messageIds.add(message.id);
      files.set(fileId, {
        ...existing, file_id: fileId,
        name: attachment.file?.name || existing?.name || fileId,
        mime_type: attachment.file?.mime_type || existing?.mime_type || '',
        metadata: { ...(existing?.metadata || {}), ...(attachment.file || {}) },
        message_ids: [...messageIds],
      });
    }
  }
  return [...files.values()];
}

function dotFileName(file) {
  const name = safeSegment(file.name, 'file', 90);
  const extension = path.extname(name) || mimeToExtension(file.mime_type) || '';
  const stem = path.extname(name) ? name.slice(0, -path.extname(name).length) : name;
  return `${stem}__${keySuffix(file.file_id)}${extension}`;
}

function fileTypeEnabled(file) {
  const image = String(file.mime_type || '').startsWith('image/') ||
    /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name || '');
  return CONFIG.downloadFiles && (image ? CONFIG.downloadImages
    : (file.metadata?.library_artifact_type === 'canvas' ? CONFIG.downloadCanvas : CONFIG.downloadAttachments));
}

async function downloadDotFiles(accessToken, roomId, messages, directory, progress, summary) {
  const manifestPath = path.join(directory, 'downloads.json');
  const previous = readJson(manifestPath, { items: [] });
  const priorById = new Map((previous.items || []).map(file => [file.file_id, file]));
  const files = collectDotFiles(messages);
  summary.files += files.length;
  const save = () => {
    writeJson(manifestPath, { room_id: roomId, source: 'message_attachments', items: files });
    saveProgress(progress);
  };

  for (const file of files) {
    const prior = priorById.get(file.file_id);
    const failureKey = `${roomId}~${file.file_id}`;
    const filename = dotFileName(file);
    const outputPath = path.join(directory, 'files', filename);
    const priorBytes = prior?._export?.bytes;
    const alreadySaved = ['downloaded', 'existing'].includes(prior?._export?.status);

    if (!fileTypeEnabled(file)) {
      file._export = { status: 'filtered', local_path: null };
      summary.filtered++;
      save();
      continue;
    }
    if (!CONFIG.updateExisting && alreadySaved && fileLooksComplete(outputPath, priorBytes)) {
      file._export = { status: 'existing', local_path: `files/${filename}`, bytes: fs.statSync(outputPath).size };
      delete progress.dotsFailedFileIds[failureKey];
      summary.existing++;
      save();
      continue;
    }
    if (progress.dotsFailedFileIds[failureKey] && !CONFIG.retryFailedFiles) {
      file._export = { status: 'failed', error: progress.dotsFailedFileIds[failureKey], local_path: null };
      summary.failedFiles++;
      save();
      continue;
    }

    try {
      const resolver = apiUrl(`/messaging/rooms/${encodeURIComponent(roomId)}/files/${encodeURIComponent(file.file_id)}`);
      for (let attempt = 0; attempt < 2; attempt++) {
        // Never use the (possibly expired) URL embedded in messages.json.
        const metadata = await getJson(accessToken, resolver);
        if (!metadata?.download_url || (metadata.file_id || metadata.id) !== file.file_id) {
          throw new Error(`Dot file resolver returned no matching download URL for ${file.file_id}`);
        }
        file.metadata = metadata;
        verboseLog(`    Downloading Dot file: ${file.name}`);
        const temporary = `${outputPath}.part`;
        try {
          const result = await downloadFile(metadata.download_url, temporary, accessToken);
          const expectedBytes = metadata.file_size_bytes ?? metadata.size_bytes;
          if (typeof expectedBytes === 'number' && result.bytes !== expectedBytes) {
            throw new Error('Dot file download size does not match file metadata');
          }
          fs.renameSync(temporary, outputPath);
          file._export = {
            status: 'downloaded', local_path: `files/${filename}`, bytes: result.bytes,
            downloaded_at: new Date().toISOString(),
          };
          break;
        } catch (error) {
          // A signed CDN URL can expire independently of the bearer token.
          // Resolve it again once before classifying a file-specific failure.
          if (attempt === 0 && [401, 403].includes(error.status)) continue;
          throw error;
        }
      }
      delete progress.dotsFailedFileIds[failureKey];
      summary.downloaded++;
    } catch (error) {
      if (error.authError && !await verifyToken(accessToken)) throw error;
      const message = safeError(error);
      file._export = { status: 'failed', error: message, local_path: null };
      if (error.authError || [401, 403, 404, 410].includes(error.status) || /HTTP (404|410)/.test(message)) {
        progress.dotsFailedFileIds[failureKey] = message;
      }
      summary.failedFiles++;
      console.log(`    Warning: Dot file ${file.file_id} failed: ${message}`);
    }
    save();
  }
  // An empty room still gets a download inventory.
  save();
  return files;
}

function dotMessagesToMarkdown(dot, room, messages, files) {
  const fileById = new Map(files.map(file => [file.file_id, file]));
  const memberById = new Map((room.members || []).map(member => [member.account_user_id, member]));
  const currentUser = normalizeWorkspaceUserId(CONFIG.currentUserId);
  const lines = [`# ${dot.display_name || room.name || 'Dot'}`, '', `Room: ${room.id}`, ''];
  for (const message of messages) {
    const member = memberById.get(message.account_user_id);
    const isDot = member?.aeon_id === dot.id || String(message.account_user_id).startsWith('calpico-member-');
    const isUser = currentUser && normalizeWorkspaceUserId(message.account_user_id) === currentUser;
    const author = isDot ? (dot.display_name || 'Dot') : (isUser ? 'User' : (member?.name || message.role || 'Unknown'));
    lines.push(`## ${author}`, '', `${message.created_at || ''}${message.deleted_at ? ' (deleted)' : ''}`, '');
    if (message.content?.text) lines.push(message.content.text, '');
    for (const attachment of message.content?.attachments || []) {
      const fileId = attachment.file_id || attachment.file?.file_id || attachment.file?.id;
      const file = fileById.get(fileId);
      if (file?._export?.local_path) {
        const label = file.name.replace(/[\[\]\\]/g, '_');
        const localUrl = file._export.local_path.split('/').map(encodeURIComponent).join('/');
        lines.push(`[${label}](${localUrl})`, '');
      } else if (file) {
        lines.push(`[File: ${file.name}; ${file._export?.status || 'metadata only'}]`, '');
      } else {
        lines.push(`[${attachment.type || 'Attachment'}: ${attachment.attachment_id || 'unknown'}; full data in messages.json]`, '');
      }
    }
    if (message.reply_to) lines.push(`Reply to: ${message.reply_to}`, '');
    if (Object.keys(message.reactions || {}).length) lines.push(`Reactions: ${JSON.stringify(message.reactions)}`, '');
  }
  return lines.join('\n');
}

async function exportDots(accessToken, progress) {
  ensureDir(CONFIG.outputDir);
  ensureDir(PATHS.dotsDir);
  progress.dots = progress.dots || {};
  progress.dotsFailedFileIds = progress.dotsFailedFileIds || {};
  const summary = { count: 0, messages: 0, files: 0, downloaded: 0, existing: 0,
    filtered: 0, failedFiles: 0, threads: 0, hiddenThreads: 0, errors: 0, skipped: 0 };
  const previousIndex = readJson(PATHS.dotsIndexFile, { items: [] });
  const records = new Map((previousIndex.items || []).map(item => [item.id, item]));
  const saveIndex = () => writeJson(PATHS.dotsIndexFile, {
    schema_version: 1, exported_at: new Date().toISOString(), coverage: COVERAGE, items: [...records.values()],
  });

  try {
    const dots = await fetchDotList(accessToken);
    console.log(`  Found ${dots.length} Dot profile(s)`);
    for (const dot of dots) {
      if (!dot.messaging_room_id) { records.delete(dot.id); summary.skipped++; continue; }
      try {
        const room = await getJson(accessToken, apiUrl(`/messaging/rooms/${encodeURIComponent(dot.messaging_room_id)}`));
        if (!isOwnedRoom(room, dot)) {
          records.delete(dot.id);
          summary.skipped++;
          continue;
        }
        summary.count++;
        // Keep the ID suffix stable so renaming a Dot retains its checkpoint
        // and downloaded files. Only accept a single child directory here.
        const previousDirectory = records.get(dot.id)?._export?.directory;
        const priorName = typeof previousDirectory === 'string' && /^dots\/[^/\\]+$/.test(previousDirectory)
          ? previousDirectory.slice(5) : null;
        const name = priorName && priorName.endsWith(`__${keySuffix(dot.id)}`)
          ? priorName : `${safeSegment(dot.display_name, 'Dot', 45)}__${keySuffix(dot.id)}`;
        const directory = path.join(PATHS.dotsDir, name);
        ensureDir(directory);
        const state = progress.dots[room.id] || (progress.dots[room.id] = {});
        state.downloadComplete = false;
        saveProgress(progress);
        writeJson(path.join(directory, 'profile.json'), dot);
        writeJson(path.join(directory, 'room.json'), room);
        const record = { ...dot, _export: {
          directory: path.relative(CONFIG.outputDir, directory).split(path.sep).join('/'),
          status: 'in_progress', coverage: COVERAGE,
        } };
        records.set(dot.id, record);
        saveIndex();
        console.log(`  Exporting Dot "${dot.display_name || 'Dot'}"`);

        try {
          const threads = await fetchDotThreads(accessToken, dot.id);
          writeJson(path.join(directory, 'threads.json'), { items: threads, cursor: null,
            _export: { bodies_exported: false, reason: COVERAGE.linked_task_bodies } });
          summary.threads += threads.length;
          summary.hiddenThreads += threads.filter(thread => thread.is_user_visible === false).length;
          state.threadsMetadataComplete = true;
        } catch (error) {
          if (error.authError) throw error;
          state.threadsMetadataComplete = false;
          const priorThreads = readJson(path.join(directory, 'threads.json'), { items: [] });
          writeJson(path.join(directory, 'threads.json'), { items: priorThreads.items, error: safeError(error),
            _export: { bodies_exported: false, metadata_complete: false } });
          summary.errors++;
        }

        const messages = await fetchDotMessages(accessToken, room.id, directory, state, progress);
        summary.messages += messages.length;
        const failedBefore = summary.failedFiles;
        const files = await downloadDotFiles(accessToken, room.id, messages, directory, progress, summary);
        if (CONFIG.exportFormat !== 'json') {
          fs.writeFileSync(path.join(directory, 'messages.md'), dotMessagesToMarkdown(dot, room, messages, files));
        }
        state.downloadComplete = summary.failedFiles === failedBefore;
        state.lastExportedAt = new Date().toISOString();
        record._export.status = state.downloadComplete && state.threadsMetadataComplete ? 'complete' : 'incomplete';
        record._export.messages = messages.length;
        record._export.files = files.length;
        saveProgress(progress);
        saveIndex();
      } catch (error) {
        const record = records.get(dot.id);
        if (record) record._export = { ...record._export, status: 'incomplete', error: safeError(error) };
        if (error.authError) throw error;
        summary.errors++;
        console.log(`  Warning: Dot ${dot.id} export incomplete: ${safeError(error)}`);
        saveProgress(progress);
        saveIndex();
      }
    }
    saveIndex();
    saveProgress(progress);
    return summary;
  } catch (error) {
    saveIndex();
    saveProgress(progress);
    error.dotSummary = summary;
    throw error;
  }
}

module.exports = { COVERAGE, fetchDotList, fetchDotThreads, isOwnedRoom, fetchDotMessages,
  collectDotFiles, dotFileName, downloadDotFiles, dotMessagesToMarkdown, exportDots };
