'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, PATHS, verboseLog, sleep } = require('./config');
const { createApiHeaders, fetchWithRetry, verifyToken } = require('./auth');
const { saveProgress, ensureDir, loadIndex, mergeFileRefsIntoIndexEntry } = require('./storage');
const { sanitizeProjectFolder, guessFileExtension, mimeToExtension } = require('./formatter');

function getCompositePreviewSourceId(fileId) {
  if (typeof fileId !== 'string') return null;
  // PDF/document page previews use an opaque derivative pointer such as:
  //   <hash>#file_abc#p_3.<hash>.jpg
  // The derivative itself is not downloadable through /files/download.
  // The embedded file_... ID identifies the downloadable source document.
  const match = fileId.match(/#(file[-_][^#]+)#p_\d+(?:\.[^#]+)?$/i);
  return match ? match[1] : null;
}

function normalizeFileReference(ref) {
  const sourceFileId = getCompositePreviewSourceId(ref?.fileId);
  if (!sourceFileId) return ref;
  return {
    ...ref,
    fileId: sourceFileId,
    type: 'attachment',
    sizeBytes: undefined,
    compositePreview: true,
    previewPointer: ref.fileId,
  };
}

function extractFileReferences(conversationData) {
  const files = [];
  if (!conversationData.mapping) return files;

  for (const node of Object.values(conversationData.mapping)) {
    if (!node.message || !node.message.content) continue;
    const content = node.message.content;
    const conversationId = conversationData.id || conversationData.conversation_id;

    // Multimodal messages: images, canvas pointers, and other asset pointers
    if (content.content_type === 'multimodal_text' && content.parts) {
      for (const part of content.parts) {
        if (!part || !part.asset_pointer) continue;
        const rawFileId = part.asset_pointer.replace(/^(sediment|file-service):\/\//, '');
        if (!rawFileId) continue;

        let type = 'attachment';
        if (part.content_type === 'image_asset_pointer') {
          type = 'image';
        } else if (part.content_type === 'canvas_asset_pointer' || part.content_type === 'canvas') {
          type = 'canvas';
        }

        files.push(normalizeFileReference({
          fileId: rawFileId,
          conversationId,
          type,
          metadata: part.metadata || {},
          sizeBytes: part.size_bytes,
        }));
      }
    }

    // Standalone canvas content type
    if ((content.content_type === 'canvas' || content.content_type === 'canvas_asset_pointer') && content.asset_pointer) {
      const rawFileId = content.asset_pointer.replace(/^(sediment|file-service):\/\//, '');
      if (rawFileId) {
        files.push(normalizeFileReference({ fileId: rawFileId, conversationId, type: 'canvas', metadata: content.metadata || {}, sizeBytes: content.size_bytes }));
      }
    }

    // Current ChatGPT responses put ordinary uploads (documents, archives,
    // spreadsheets, and many images) in message metadata rather than in the
    // multimodal content parts above.
    if (Array.isArray(node.message.metadata?.attachments)) {
      for (const attachment of node.message.metadata.attachments) {
        if (!attachment || typeof attachment !== 'object') continue;
        const fileId = attachment.id || attachment.file_id;
        if (!fileId) continue;

        const mimeType = attachment.mime_type || attachment.type || '';
        const filename = attachment.name || '';
        const isImage = mimeType.toLowerCase().startsWith('image/') ||
          ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(path.extname(filename).toLowerCase());
        const isCanvas = attachment.library_artifact_type === 'canvas';

        files.push({
          fileId,
          conversationId,
          type: isCanvas ? 'canvas' : (isImage ? 'image' : 'attachment'),
          filename,
          mimeType,
          metadata: attachment,
          sizeBytes: attachment.size || attachment.size_bytes,
        });
      }
    }
  }

  // The same image may be represented by both an asset_pointer and metadata.
  // Prefer the richer metadata record while returning each file only once.
  const deduplicated = new Map();
  for (const ref of files) {
    const existing = deduplicated.get(ref.fileId);
    if (!existing || (!existing.filename && ref.filename)) {
      deduplicated.set(ref.fileId, ref);
    }
  }
  return Array.from(deduplicated.values());
}

async function getFileDownloadUrl(accessToken, fileId, conversationId) {
  // Asset pointers can contain literal "#" characters (for example,
  // generated image page IDs). Without path-segment encoding, URL parsers
  // treat everything after the first "#" as a fragment and never send it or
  // the query string to ChatGPT, which results in HTTP 422.
  const encodedFileId = encodeURIComponent(fileId);
  const encodedConversationId = encodeURIComponent(conversationId);
  const urls = [
    `${CONFIG.apiBase}/files/download/${encodedFileId}?conversation_id=${encodedConversationId}&inline=false`,
    `${CONFIG.apiBase}/conversation/${encodedConversationId}/attachment/${encodedFileId}/download`,
    `${CONFIG.apiBase}/files/${encodedFileId}/download`,
  ];

  let lastError;
  for (let i = 0; i < urls.length; i++) {
    try {
      const response = await fetchWithRetry(urls[i], {
        headers: createApiHeaders(accessToken),
      });
      const data = await response.json();

      // Current ChatGPT accounts use several resolver routes depending on
      // whether an asset is conversation-scoped or backed by file-service.
      // Exhaust all routes before treating a structured not-found as final.
      if (i < urls.length - 1 && data?.status !== 'success' && data?.error_code === 'file_not_found') {
        continue;
      }
      return data;
    } catch (error) {
      lastError = error;
      if (i < urls.length - 1 && /HTTP 404/.test(error.message)) continue;
      throw error;
    }
  }
  throw lastError || new Error('Could not resolve file download URL');
}

async function downloadFile(downloadUrl, outputPath, accessToken) {
  let parsedUrl;
  try {
    // Library-backed files may return an authenticated root-relative URL
    // instead of an absolute signed CDN URL.
    parsedUrl = new URL(downloadUrl, CONFIG.baseUrl);
  } catch {
    throw new Error('File download URL is invalid');
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('File download URL must use HTTPS');
  }

  // Never forward the bearer token to an arbitrary host. OpenAI-owned API
  // URLs may require it; external pre-signed CDN URLs should work without it.
  const hostname = parsedUrl.hostname.toLowerCase();
  const trustedForAuth = hostname === 'chatgpt.com' || hostname.endsWith('.openai.com');
  const isLibraryContent = hostname === 'chatgpt.com' &&
    /^\/api\/library\/files\/[^/]+\/project-content\/?$/i.test(parsedUrl.pathname);

  const bearerHeaders = accessToken && trustedForAuth ? createApiHeaders(accessToken) : {};
  if (hostname === 'chatgpt.com' && CONFIG.sessionCookie) {
    bearerHeaders.Cookie = CONFIG.sessionCookie;
  }

  // A Library URL is a web-app route rather than a normal /backend-api
  // route. Depending on how it was minted it may accept Bearer + Cookie,
  // Cookie only, or its query signature alone. Try those safe same-origin
  // variants without ever forwarding credentials to an external host.
  const headerCandidates = [bearerHeaders];
  if (isLibraryContent) {
    if (CONFIG.sessionCookie) {
      headerCandidates.push({ Cookie: CONFIG.sessionCookie });
    } else {
      headerCandidates.push({});
    }
  }

  let lastError;
  for (const headers of headerCandidates) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(parsedUrl.href, { headers });
        if (!response.ok) {
          const error = new Error(`File download failed: HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        const contentType = response.headers.get('content-type') || '';
        const buffer = Buffer.from(await response.arrayBuffer());
        ensureDir(path.dirname(outputPath));
        fs.writeFileSync(outputPath, buffer);
        return { bytes: buffer.length, contentType };
      } catch (error) {
        lastError = error;
        // Repeating the same credentials cannot fix an auth rejection. Move
        // immediately to the next same-origin Library auth variant.
        if (error.status === 401 || error.status === 403) break;
        if (attempt === 2) break;
        await sleep(2000);
      }
    }
  }

  if (isLibraryContent && lastError?.status === 401 && !CONFIG.sessionCookie) {
    throw new Error('Library file download requires the ChatGPT browser session cookie (HTTP 401). Set CHATGPT_SESSION_COOKIE and run again.');
  }
  if (isLibraryContent && lastError?.status === 401 && CONFIG.sessionCookie) {
    throw new Error('Library file download was rejected (HTTP 401). Refresh CHATGPT_SESSION_COOKIE and run again.');
  }
  throw lastError || new Error('File download failed');
}

function getExtensionFromFilename(fileName) {
  if (!fileName) return '';
  const ext = path.extname(fileName);
  return ext || '';
}

function getLocalFileName(fileId, extension = '') {
  // Some composite image asset IDs already include their real extension.
  // Do not turn "...image.jpg" into "...image.jpg.png".
  return path.extname(fileId) ? fileId : `${fileId}${extension}`;
}

async function downloadConversationFiles(accessToken, conversationData, filesDir, progress, convIndexEntry) {
  const allRefs = extractFileReferences(conversationData);

  if (convIndexEntry) {
    mergeFileRefsIntoIndexEntry(convIndexEntry, allRefs);
  }

  const fileRefs = allRefs.filter(ref => {
    if (ref.type === 'image') return CONFIG.downloadImages;
    if (ref.type === 'canvas') return CONFIG.downloadCanvas;
    return CONFIG.downloadAttachments;
  });
  if (fileRefs.length === 0) return 0;

  let downloadedCount = 0;

  for (const ref of fileRefs) {
    if (progress.downloadedFileIds.includes(ref.fileId)) continue;
    if (progress.failedFileIds[ref.fileId]) continue;

    try {
      verboseLog(`    Downloading ${ref.type}: ${ref.fileId}${ref.sizeBytes ? ` (${ref.sizeBytes} bytes)` : ''}`);
      const dlInfo = await getFileDownloadUrl(accessToken, ref.fileId, ref.conversationId);

      if (dlInfo.status !== 'success' || !dlInfo.download_url) {
        const errorCode = dlInfo.error_code || 'unknown';
        if (errorCode === 'file_not_found') {
          progress.failedFileIds[ref.fileId] = errorCode;
          saveProgress(progress);
        }
        console.log(`    Warning: Could not get download URL for ${ref.fileId} (${errorCode})`);
        verboseLog(`    Response: ${JSON.stringify(dlInfo)}`);
        continue;
      }

      const filenameExt = getExtensionFromFilename(dlInfo.file_name || ref.filename);
      const ext = filenameExt || mimeToExtension(ref.mimeType || ref.metadata?.mime_type) || guessFileExtension({ metadata: ref.metadata });
      const outputPath = path.join(filesDir, getLocalFileName(ref.fileId, ext));

      // Security fix S2: log only the base URL, not the signed query params.
      verboseLog(`    Download URL: ${dlInfo.download_url.split('?')[0]} [+signature]`);
      const result = await downloadFile(dlInfo.download_url, outputPath, accessToken);

      // If we guessed the extension, check if Content-Type gives a more accurate one
      if (!filenameExt && !path.extname(ref.fileId) && result.contentType) {
        const ctExt = mimeToExtension(result.contentType);
        if (ctExt && ctExt !== ext) {
          const betterPath = path.join(filesDir, `${ref.fileId}${ctExt}`);
          try { fs.renameSync(outputPath, betterPath); } catch (e) {
            verboseLog(`    Warning: Could not rename ${outputPath} to ${betterPath}: ${e.message}`);
          }
        }
      }

      progress.downloadedFileIds.push(ref.fileId);
      saveProgress(progress);
      downloadedCount++;

    } catch (error) {
      if (error.authError) {
        const tokenValid = await verifyToken(accessToken);
        if (!tokenValid) throw error;
        // Token is valid — this is file-specific access denial, not token expiry
        progress.failedFileIds[ref.fileId] = 'access_denied';
        saveProgress(progress);
        console.log(`    Warning: Access denied for file ${ref.fileId} from conversation "${conversationData.title || conversationData.id}" [${ref.conversationId}] — skipping`);
        continue;
      }
      const convTitle = conversationData.title || conversationData.id;
      console.log(`    Warning: Failed to download file ${ref.fileId} from conversation "${convTitle}" [${ref.conversationId}]: ${error.message}`);
    }
  }

  return downloadedCount;
}

async function downloadProjectFiles(accessToken, project, progress) {
  if (!project.files || project.files.length === 0) return 0;

  const folderName = sanitizeProjectFolder(project.name);
  const filesDir = path.join(PATHS.projectsDir, folderName, 'files');
  let count = 0;

  for (const file of project.files) {
    const fileId = file.file_id;
    if (!fileId || progress.downloadedFileIds.includes(fileId)) continue;
    if (progress.failedFileIds[fileId]) continue;

    try {
      const url = `${CONFIG.apiBase}/files/download/${encodeURIComponent(fileId)}?gizmo_id=${encodeURIComponent(project.id)}`;
      const response = await fetchWithRetry(url, { headers: createApiHeaders(accessToken) });
      const dlInfo = await response.json();

      if (dlInfo.status !== 'success' || !dlInfo.download_url) {
        const errorCode = dlInfo.error_code || 'unknown';
        if (errorCode === 'file_not_found') {
          progress.failedFileIds[fileId] = errorCode;
          saveProgress(progress);
        }
        continue;
      }

      const filenameExt = getExtensionFromFilename(dlInfo.file_name || file.name);
      const ext = filenameExt || mimeToExtension(file.type) || '';
      const outputPath = path.join(filesDir, getLocalFileName(fileId, ext));

      // Security fix S2: log only the base URL, not the signed query params.
      verboseLog(`    Download URL: ${dlInfo.download_url.split('?')[0]} [+signature]`);
      const result = await downloadFile(dlInfo.download_url, outputPath, accessToken);

      // If we guessed the extension, check if Content-Type gives a more accurate one
      if (!filenameExt && !path.extname(fileId) && result.contentType) {
        const ctExt = mimeToExtension(result.contentType);
        if (ctExt && ctExt !== ext) {
          const betterPath = path.join(filesDir, `${fileId}${ctExt}`);
          try { fs.renameSync(outputPath, betterPath); } catch (e) {
            verboseLog(`    Warning: Could not rename ${outputPath} to ${betterPath}: ${e.message}`);
          }
        }
      }
      progress.downloadedFileIds.push(fileId);
      saveProgress(progress);
      count++;

    } catch (error) {
      if (error.authError) {
        const tokenValid = await verifyToken(accessToken);
        if (!tokenValid) throw error;
        progress.failedFileIds[fileId] = 'access_denied';
        saveProgress(progress);
        console.log(`    Warning: Access denied for project file "${file.name || fileId}" [${fileId}] from project "${project.name}" — skipping`);
        continue;
      }
      console.log(`    Warning: Failed to download project file "${file.name || fileId}" [${fileId}] from project "${project.name}": ${error.message}`);
    }
  }

  return count;
}

function passesFilter(type) {
  if (type === 'image') return CONFIG.downloadImages;
  if (type === 'canvas') return CONFIG.downloadCanvas;
  return CONFIG.downloadAttachments;
}

async function retryPendingFiles(accessToken, progress) {
  const pending = [];
  const pendingById = new Map();
  Object.defineProperty(progress, 'retryFailureCount', {
    value: 0,
    writable: true,
    configurable: true,
    enumerable: false,
  });

  // Resolver v3 adds /backend-api/files/{file_id}/download, used by
  // file-service-backed assets. Permanently failed IDs are intentionally not
  // reopened during an ordinary export: doing so can add hundreds of slow API
  // calls. The explicit CLI flag makes that recovery cost user-controlled.
  const resolverVersion = 3;
  if (CONFIG.retryFailedFiles) {
    const reopenedFailures = Object.keys(progress.failedFileIds).length;
    progress.failedFileIds = {};
    progress.fileResolverVersion = resolverVersion;
    saveProgress(progress);
    if (reopenedFailures > 0) {
      console.log(`\nReopened ${reopenedFailures} file failure record(s) by request (resolver v${resolverVersion}).`);
    }
  }

  // Older versions attempted to download every derived PDF page-preview
  // pointer and stored each 403 as a permanent failure. Those pointers are
  // not standalone files; remove the stale entries so their source file IDs
  // can be retried below.
  let removedPreviewFailures = 0;
  for (const fileId of Object.keys(progress.failedFileIds)) {
    if (getCompositePreviewSourceId(fileId)) {
      delete progress.failedFileIds[fileId];
      removedPreviewFailures++;
    }
  }
  if (removedPreviewFailures > 0) {
    saveProgress(progress);
    console.log(`\nCleared ${removedPreviewFailures} obsolete page-preview failure record(s).`);
  }

  const enqueue = (ref, conversationId, filesDir) => {
    const normalized = normalizeFileReference(ref);
    if (!normalized?.fileId) return;
    if (progress.downloadedFileIds.includes(normalized.fileId) || progress.failedFileIds[normalized.fileId] || !passesFilter(normalized.type)) return;
    const existing = pendingById.get(normalized.fileId);
    if (existing) {
      if (conversationId && !existing.conversationIds.includes(conversationId)) {
        existing.conversationIds.push(conversationId);
      }
      return;
    }
    const queued = { ...normalized, conversationId, conversationIds: [conversationId], filesDir };
    pendingById.set(normalized.fileId, queued);
    pending.push(queued);
  };

  // Backfill attachments from raw JSON already on disk. Older versions only
  // indexed asset_pointer images, so a normal resume would otherwise skip
  // documents because their conversations are already marked downloaded.
  const scanSavedConversations = (jsonDir, filesDir) => {
    if (!fs.existsSync(jsonDir)) return;
    for (const fileName of fs.readdirSync(jsonDir)) {
      if (!fileName.toLowerCase().endsWith('.json')) continue;
      try {
        const conversation = JSON.parse(fs.readFileSync(path.join(jsonDir, fileName), 'utf8'));
        const conversationId = conversation.id || conversation.conversation_id;
        if (!conversationId) continue;
        for (const ref of extractFileReferences(conversation)) {
          enqueue(ref, conversationId, filesDir);
        }
      } catch {
        verboseLog(`    Warning: Could not scan saved conversation JSON "${fileName}" for attachments`);
      }
    }
  };

  scanSavedConversations(PATHS.jsonDir, PATHS.filesDir);

  // Regular conversations — skip entries merged from projects (_project_id)
  const mainIndex = loadIndex();
  for (const conv of mainIndex.values()) {
    if (conv._project_id || !conv.files?.length) continue;
    for (const ref of conv.files) {
      enqueue(ref, conv.id, PATHS.filesDir);
    }
  }

  // Project conversations — read each project's conversation index from disk
  if (fs.existsSync(PATHS.projectsDir)) {
    for (const entry of fs.readdirSync(PATHS.projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const convIndexFile = path.join(PATHS.projectsDir, entry.name, 'conversation-index.json');
      if (!fs.existsSync(convIndexFile)) continue;
      let convs;
      try { convs = JSON.parse(fs.readFileSync(convIndexFile, 'utf8')); } catch { continue; }
      const filesDir = path.join(PATHS.projectsDir, entry.name, 'files');
      scanSavedConversations(path.join(PATHS.projectsDir, entry.name, 'json'), filesDir);
      for (const conv of convs) {
        if (!conv.files?.length) continue;
        for (const ref of conv.files) {
          enqueue(ref, conv.id, filesDir);
        }
      }
    }
  }

  if (pending.length === 0) return 0;
  console.log(`\nRetrying ${pending.length} previously encountered file(s) not yet downloaded...`);

  let succeeded = 0;
  for (const ref of pending) {
    try {
      verboseLog(`    Retrying ${ref.type}: ${ref.fileId}`);
      let dlInfo = null;
      let lastError = null;
      let allNotFound = true;

      // A file can be referenced by several conversations. File resolver
      // permissions are conversation-scoped, so try every known conversation
      // before declaring the file unavailable.
      for (const conversationId of ref.conversationIds) {
        try {
          const candidate = await getFileDownloadUrl(accessToken, ref.fileId, conversationId);
          if (candidate.status === 'success' && candidate.download_url) {
            dlInfo = candidate;
            ref.conversationId = conversationId;
            break;
          }
          lastError = new Error(candidate.error_code || 'unknown');
          if (candidate.error_code !== 'file_not_found') allNotFound = false;
        } catch (error) {
          lastError = error;
          if (error.authError) {
            const tokenValid = await verifyToken(accessToken);
            if (!tokenValid) throw error;
            allNotFound = false;
            continue;
          }
          if (!/HTTP 404/.test(error.message)) allNotFound = false;
        }
      }

      if (!dlInfo) {
        const errorCode = allNotFound ? 'file_not_found' : 'unresolved';
        if (allNotFound) {
          progress.failedFileIds[ref.fileId] = 'file_not_found';
          saveProgress(progress);
        } else {
          progress.retryFailureCount++;
        }
        console.log(`    Warning: Could not get download URL for ${ref.fileId} (${errorCode})`);
        if (lastError) verboseLog(`    Reason: ${lastError.message}`);
        continue;
      }

      const filenameExt = getExtensionFromFilename(dlInfo.file_name || ref.filename);
      const ext = filenameExt || mimeToExtension(ref.mimeType || ref.metadata?.mime_type) || guessFileExtension({ metadata: ref.metadata });
      const outputPath = path.join(ref.filesDir, getLocalFileName(ref.fileId, ext));

      verboseLog(`    Download URL: ${dlInfo.download_url.split('?')[0]} [+signature]`);
      const result = await downloadFile(dlInfo.download_url, outputPath, accessToken);

      if (!filenameExt && !path.extname(ref.fileId) && result.contentType) {
        const ctExt = mimeToExtension(result.contentType);
        if (ctExt && ctExt !== ext) {
          const betterPath = path.join(ref.filesDir, `${ref.fileId}${ctExt}`);
          try { fs.renameSync(outputPath, betterPath); } catch (e) {
            verboseLog(`    Warning: Could not rename ${outputPath} to ${betterPath}: ${e.message}`);
          }
        }
      }

      progress.downloadedFileIds.push(ref.fileId);
      saveProgress(progress);
      succeeded++;
    } catch (error) {
      if (error.authError) {
        throw error;
      }
      progress.retryFailureCount++;
      console.log(`    Warning: Failed to retry file ${ref.fileId}: ${error.message}`);
    }
  }

  return succeeded;
}

module.exports = {
  extractFileReferences,
  getFileDownloadUrl,
  downloadFile,
  getExtensionFromFilename,
  getLocalFileName,
  getCompositePreviewSourceId,
  normalizeFileReference,
  downloadConversationFiles,
  downloadProjectFiles,
  retryPendingFiles,
};
