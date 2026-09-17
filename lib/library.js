'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, PATHS, verboseLog } = require('./config');
const { createApiHeaders, fetchWithRetry, throttle, verifyToken } = require('./auth');
const { ensureDir, saveProgress } = require('./storage');
const { downloadFile } = require('./downloader');
const { mimeToExtension, sanitizeFilename } = require('./formatter');

const NODES_ENDPOINT = '/files/library/nodes';

function stripUrlSecrets(value) {
  if (typeof value !== 'string' || !value) return value;
  try {
    const parsed = new URL(value, CONFIG.baseUrl);
    if (!/^https?:$/.test(parsed.protocol)) return value;
    parsed.search = '';
    parsed.hash = '';
    return /^https?:\/\//i.test(value) ? parsed.href : parsed.pathname;
  } catch {
    return value;
  }
}

function sanitizeMetadata(value) {
  if (Array.isArray(value)) return value.map(sanitizeMetadata);
  if (!value || typeof value !== 'object') return value;

  const clean = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === '_scan') continue;
    clean[key] = /(?:^|_)url$/i.test(key) ? stripUrlSecrets(entry) : sanitizeMetadata(entry);
  }
  return clean;
}

function createIndexDocument() {
  return {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    endpoints: {
      nodes: `${CONFIG.apiBase}${NODES_ENDPOINT}`,
      versions: `${CONFIG.apiBase}/files/library/files/{library_file_id}/versions`,
      download_resolver: `${CONFIG.apiBase}/files/download/{file_id}`,
    },
    stats: {
      owned_files: 0,
      owned_directories: 0,
      shared_or_unknown_skipped: 0,
    },
    items: [],
  };
}

function readIndexDocument(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data && Array.isArray(data.items)) return data;
  } catch (error) {
    verboseLog(`  Warning: Could not read Library index "${filePath}": ${error.message}`);
  }
  return null;
}

function updateDocumentStats(document) {
  document.stats = document.stats || {};
  document.stats.owned_files = document.items.filter(item => item.kind === 'file').length;
  document.stats.owned_directories = document.items.filter(item => item.kind === 'directory').length;
  document.stats.shared_or_unknown_skipped = document._scan?.shared_skipped_ids?.length ||
    document.stats.shared_or_unknown_skipped || 0;
}

function writeIndexDocument(filePath, document, includeScanState = false) {
  ensureDir(path.dirname(filePath));
  document.generated_at = new Date().toISOString();
  updateDocumentStats(document);
  const output = includeScanState ? document : sanitizeMetadata(document);
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2));
}

function mergePriorItemState(item, prior) {
  if (!prior) return item;
  const merged = { ...item };
  if (Array.isArray(prior.versions)) merged.versions = prior.versions;
  if (prior._versions_error) merged._versions_error = prior._versions_error;
  if (prior._export) merged._export = prior._export;
  return merged;
}

function buildNodesUrl(parentDirectoryId, cursor) {
  const url = new URL(`${CONFIG.apiBase}${NODES_ENDPOINT}`);
  if (parentDirectoryId) url.searchParams.set('parent_directory_id', parentDirectoryId);
  if (cursor) url.searchParams.set('cursor', cursor);
  url.searchParams.set('hydrate_folder_thumbnails', 'true');
  url.searchParams.set('include_onedrive', 'true');
  url.searchParams.set('include_folder_counts', 'true');
  url.searchParams.set('include_saved_entities', 'true');
  return url.href;
}

function makeInitialScanState() {
  return {
    queue: [{ parent_directory_id: null, cursor: null }],
    visited_directory_ids: [],
    shared_skipped_ids: [],
  };
}

async function fetchLibraryIndex(accessToken, progress) {
  ensureDir(PATHS.libraryDir);

  const finalDocument = readIndexDocument(PATHS.libraryIndexFile);
  const partialDocument = readIndexDocument(PATHS.libraryPartialIndexFile);
  const resuming = !!(partialDocument?._scan?.queue?.length && !progress.libraryIndexingComplete);
  const document = resuming ? partialDocument : createIndexDocument();
  document._scan = resuming ? document._scan : makeInitialScanState();

  const priorById = new Map((finalDocument?.items || []).map(item => [item.id, item]));
  const itemsById = new Map((document.items || []).map(item => [item.id, item]));
  const visited = new Set(document._scan.visited_directory_ids || []);
  const skipped = new Set(document._scan.shared_skipped_ids || []);

  progress.libraryIndexingComplete = false;
  progress.libraryDownloadComplete = false;
  saveProgress(progress);

  let page = 0;
  while (document._scan.queue.length > 0) {
    const scope = document._scan.queue[0];
    const parentId = scope.parent_directory_id || null;
    const requestCursor = scope.cursor || null;

    await throttle();
    page++;
    const label = parentId ? `folder ${parentId.slice(-8)}` : 'all items';
    process.stdout.write(`  Indexing Library ${label}, page ${page}${resuming ? ' (resume)' : ''}... `);
    const response = await fetchWithRetry(buildNodesUrl(parentId, requestCursor), {
      headers: createApiHeaders(accessToken),
    });
    const data = await response.json();
    if (!data || !Array.isArray(data.items)) {
      throw new Error('Library nodes response did not contain an items array.');
    }

    let ownedOnPage = 0;
    for (const rawItem of data.items) {
      if (rawItem?.access_kind !== 'owned') {
        if (rawItem?.id) skipped.add(rawItem.id);
        continue;
      }
      if (!rawItem.id || !['file', 'directory'].includes(rawItem.kind)) continue;

      const item = sanitizeMetadata(rawItem);
      const existing = itemsById.get(item.id) || priorById.get(item.id);
      itemsById.set(item.id, mergePriorItemState(item, existing));
      ownedOnPage++;
    }

    const nextCursor = typeof data.cursor === 'string' && data.cursor ? data.cursor : null;
    if (nextCursor && nextCursor === requestCursor) {
      throw new Error('Library pagination returned the same cursor twice; partial index was preserved.');
    }

    if (nextCursor) {
      scope.cursor = nextCursor;
    } else {
      document._scan.queue.shift();
      if (parentId) visited.add(parentId);

      const queuedDirectoryIds = new Set(document._scan.queue
        .map(entry => entry.parent_directory_id)
        .filter(Boolean));
      for (const item of itemsById.values()) {
        if (item.kind !== 'directory' || visited.has(item.id) || queuedDirectoryIds.has(item.id)) continue;
        document._scan.queue.push({ parent_directory_id: item.id, cursor: null });
        queuedDirectoryIds.add(item.id);
      }
    }

    document.items = Array.from(itemsById.values());
    document._scan.visited_directory_ids = Array.from(visited);
    document._scan.shared_skipped_ids = Array.from(skipped);
    progress.libraryLastCursor = document._scan.queue[0]?.cursor || null;
    writeIndexDocument(PATHS.libraryPartialIndexFile, document, true);
    saveProgress(progress);
    console.log(`${ownedOnPage} owned${data.items.length - ownedOnPage ? `, ${data.items.length - ownedOnPage} skipped/duplicate` : ''}`);
  }

  document.items = Array.from(itemsById.values());
  document.stats.shared_or_unknown_skipped = skipped.size;
  delete document._scan;
  writeIndexDocument(PATHS.libraryIndexFile, document);
  try {
    fs.unlinkSync(PATHS.libraryPartialIndexFile);
  } catch (error) {
    if (error.code !== 'ENOENT') verboseLog(`  Warning: Could not remove partial Library index: ${error.message}`);
  }

  progress.libraryIndexingComplete = true;
  progress.libraryLastCursor = null;
  saveProgress(progress);
  return document;
}

function buildVersionsUrl(libraryFileId, cursor) {
  const id = encodeURIComponent(libraryFileId);
  const url = new URL(`${CONFIG.apiBase}/files/library/files/${id}/versions`);
  url.searchParams.set('limit', String(CONFIG.libraryVersionPageSize));
  if (cursor) url.searchParams.set('cursor', cursor);
  return url.href;
}

function currentVersionFallback(item) {
  if (!item.file_id) return [];
  return [{
    library_file_id: item.id,
    version_number: null,
    is_current: true,
    file_id: item.file_id,
    file_name: item.name || null,
    mime_type: item.mime_type || null,
    file_extension: item.file_extension || null,
    file_size_bytes: item.file_size_bytes ?? null,
    version_created_at: item.updated_at || item.record_creation_time || null,
    _fallback_from_library_node: true,
  }];
}

async function fetchLibraryVersions(accessToken, item) {
  if (item.kind !== 'file') return [];

  const versions = new Map();
  const seenCursors = new Set();
  let cursor = null;
  try {
    do {
      if (cursor && seenCursors.has(cursor)) {
        throw new Error('Library version pagination returned the same cursor twice.');
      }
      if (cursor) seenCursors.add(cursor);
      await throttle();
      const response = await fetchWithRetry(buildVersionsUrl(item.id, cursor), {
        headers: createApiHeaders(accessToken),
      });
      const data = await response.json();
      if (!data || !Array.isArray(data.items)) {
        throw new Error('Library versions response did not contain an items array.');
      }
      for (const rawVersion of data.items) {
        if (!rawVersion?.file_id) continue;
        const version = sanitizeMetadata(rawVersion);
        versions.set(version.file_id, version);
      }
      cursor = typeof data.cursor === 'string' && data.cursor ? data.cursor : null;
    } while (cursor);
    return Array.from(versions.values()).sort((a, b) =>
      Number(a.version_number ?? Number.MAX_SAFE_INTEGER) - Number(b.version_number ?? Number.MAX_SAFE_INTEGER));
  } catch (error) {
    if (error.authError) throw error;
    error.libraryVersionsFallback = true;
    error.fallbackVersions = currentVersionFallback(item);
    throw error;
  }
}

async function tryResolver(accessToken, url) {
  try {
    const response = await fetchWithRetry(url, { headers: createApiHeaders(accessToken) });
    const data = await response.json();
    if (data?.download_url && (!data.status || data.status === 'success')) return data;
    return null;
  } catch (error) {
    if (error.authError) {
      if (!await verifyToken(accessToken)) throw error;
      return null;
    }
    if (!/HTTP 404/.test(error.message)) verboseLog(`    Library resolver failed: ${error.message}`);
    return null;
  }
}

async function resolveLibraryDownload(accessToken, item, version) {
  const fileId = encodeURIComponent(version.file_id);
  const candidates = [
    `${CONFIG.apiBase}/files/download/${fileId}?inline=false`,
    `${CONFIG.apiBase}/files/${fileId}/download`,
  ];
  const threadId = version.origination_thread_id || item.origination_thread_id;
  if (threadId) {
    candidates.push(`${CONFIG.apiBase}/files/download/${fileId}?conversation_id=${encodeURIComponent(threadId)}&inline=false`);
  }

  for (const url of candidates) {
    await throttle();
    const resolved = await tryResolver(accessToken, url);
    if (resolved) return resolved;
  }
  throw new Error(`Could not resolve Library file ${version.file_id}`);
}

function safeSegment(name, fallback = 'untitled', maxLength = 80) {
  let value = sanitizeFilename(name || fallback).replace(/[. ]+$/g, '').slice(0, maxLength);
  if (!value) value = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = `_${value}`;
  return value;
}

function idSuffix(id) {
  const clean = String(id || '').replace(/[^a-z0-9]/gi, '');
  return clean.slice(-10) || 'unknown';
}

function buildDirectoryPathMap(items) {
  const directories = new Map(items.filter(item => item.kind === 'directory').map(item => [item.id, item]));
  const paths = new Map();

  const resolve = (id, stack = new Set()) => {
    if (paths.has(id)) return paths.get(id);
    const item = directories.get(id);
    if (!item || stack.has(id)) return '';

    const nextStack = new Set(stack);
    nextStack.add(id);
    const parentPath = directories.has(item.parent_directory_id)
      ? resolve(item.parent_directory_id, nextStack)
      : '';
    const segment = `${safeSegment(item.name, 'folder')}__${idSuffix(item.id)}`;
    const relativePath = parentPath ? path.join(parentPath, segment) : segment;
    paths.set(id, relativePath);
    return relativePath;
  };

  for (const id of directories.keys()) resolve(id);
  return paths;
}

function normalizeExtension(extension) {
  if (!extension) return '';
  return extension.startsWith('.') ? extension : `.${extension}`;
}

function versionFileName(item, version) {
  let name = safeSegment(version.file_name || item.name || version.file_id, version.file_id, 100);
  if (!path.extname(name)) {
    name += normalizeExtension(version.file_extension) || mimeToExtension(version.mime_type || item.mime_type);
  }
  const number = Number.isInteger(version.version_number)
    ? `v${String(version.version_number).padStart(3, '0')}`
    : 'current';
  return `${number}_${name}`;
}

function getItemDirectory(item, directoryPaths) {
  const parentPath = directoryPaths.get(item.parent_directory_id) || '';
  const itemFolder = `${safeSegment(item.name || item.id, 'file')}__${idSuffix(item.id)}`;
  return path.join(PATHS.libraryFilesDir, parentPath, itemFolder);
}

function relativeExportPath(filePath) {
  return path.relative(CONFIG.outputDir, filePath).split(path.sep).join('/');
}

function classifyLibraryType(item, version) {
  const mimeType = String(version?.mime_type || item.mime_type || '').toLowerCase();
  if (mimeType.startsWith('image/') || item.library_file_category === 'image') return 'image';
  if (item.library_artifact_type === 'canvas') return 'canvas';
  return 'attachment';
}

function libraryTypeEnabled(item, version) {
  const type = classifyLibraryType(item, version);
  if (type === 'image') return CONFIG.downloadImages;
  if (type === 'canvas') return CONFIG.downloadCanvas;
  return CONFIG.downloadAttachments;
}

function collectNonLibraryFiles() {
  const files = [];
  const visit = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  visit(PATHS.filesDir);
  if (fs.existsSync(PATHS.projectsDir)) {
    for (const entry of fs.readdirSync(PATHS.projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(PATHS.projectsDir, entry.name, 'files'));
    }
  }
  return files;
}

function findExistingFile(fileId, files) {
  return files.find(filePath => {
    const name = path.basename(filePath);
    return name === fileId || name.startsWith(`${fileId}.`);
  }) || null;
}

function fileLooksComplete(filePath, expectedBytes) {
  if (!fs.existsSync(filePath)) return false;
  if (!Number.isFinite(expectedBytes) || expectedBytes < 0) return true;
  try {
    return fs.statSync(filePath).size === expectedBytes;
  } catch {
    return false;
  }
}

function writeItemManifest(item, itemDirectory) {
  ensureDir(itemDirectory);
  fs.writeFileSync(path.join(itemDirectory, 'versions.json'), JSON.stringify(sanitizeMetadata({
    library_file_id: item.id,
    name: item.name,
    parent_directory_id: item.parent_directory_id,
    versions: item.versions || [],
    versions_error: item._versions_error || null,
  }), null, 2));
}

async function exportLibrary(accessToken, progress) {
  const document = await fetchLibraryIndex(accessToken, progress);
  ensureDir(PATHS.libraryFilesDir);

  const directories = document.items.filter(item => item.kind === 'directory');
  const files = document.items.filter(item => item.kind === 'file');
  const directoryPaths = buildDirectoryPathMap(document.items);
  for (const directory of directories) {
    const localPath = path.join(PATHS.libraryFilesDir, directoryPaths.get(directory.id));
    ensureDir(localPath);
    directory._export = { local_path: relativeExportPath(localPath) };
    fs.writeFileSync(path.join(localPath, '.directory.json'), JSON.stringify(sanitizeMetadata(directory), null, 2));
  }

  const summary = {
    files: files.length,
    directories: directories.length,
    versions: 0,
    downloaded: 0,
    reused: 0,
    existing: 0,
    filtered: 0,
    failed: 0,
    sharedSkipped: document.stats?.shared_or_unknown_skipped || 0,
  };

  if (CONFIG.retryFailedFiles) progress.libraryFailedFileIds = {};
  progress.libraryDownloadComplete = false;
  saveProgress(progress);
  const reusableFiles = collectNonLibraryFiles();

  for (let itemIndex = 0; itemIndex < files.length; itemIndex++) {
    const item = files[itemIndex];
    const itemDirectory = getItemDirectory(item, directoryPaths);
    ensureDir(itemDirectory);

    try {
      item.versions = await fetchLibraryVersions(accessToken, item);
      delete item._versions_error;
    } catch (error) {
      if (error.authError) throw error;
      item.versions = error.fallbackVersions || currentVersionFallback(item);
      item._versions_error = String(error.message || error).slice(0, 500);
      verboseLog(`  Warning: Could not list versions for ${item.id}; using current node metadata: ${item._versions_error}`);
    }

    summary.versions += item.versions.length;
    for (let versionIndex = 0; versionIndex < item.versions.length; versionIndex++) {
      const version = item.versions[versionIndex];
      const targetPath = path.join(itemDirectory, versionFileName(item, version));
      const expectedBytes = typeof version.file_size_bytes === 'number'
        ? version.file_size_bytes
        : null;

      if (!libraryTypeEnabled(item, version)) {
        version._export = { status: 'filtered', local_path: null };
        summary.filtered++;
        continue;
      }
      if (progress.libraryFailedFileIds[version.file_id] && !CONFIG.retryFailedFiles) {
        version._export = {
          status: 'failed',
          error: progress.libraryFailedFileIds[version.file_id],
        };
        summary.failed++;
        continue;
      }
      if (!CONFIG.updateExisting && fileLooksComplete(targetPath, expectedBytes)) {
        version._export = {
          status: 'existing',
          local_path: relativeExportPath(targetPath),
          bytes: fs.statSync(targetPath).size,
        };
        if (!progress.libraryDownloadedFileIds.includes(version.file_id)) {
          progress.libraryDownloadedFileIds.push(version.file_id);
        }
        delete progress.libraryFailedFileIds[version.file_id];
        summary.existing++;
        continue;
      }

      if (!CONFIG.downloadFiles) {
        version._export = { status: 'metadata_only', local_path: null };
        continue;
      }

      const reusable = CONFIG.updateExisting ? null : findExistingFile(version.file_id, reusableFiles);
      if (reusable && fileLooksComplete(reusable, expectedBytes)) {
        fs.copyFileSync(reusable, targetPath);
        version._export = {
          status: 'reused',
          local_path: relativeExportPath(targetPath),
          copied_from: relativeExportPath(reusable),
          bytes: fs.statSync(targetPath).size,
        };
        if (!progress.libraryDownloadedFileIds.includes(version.file_id)) {
          progress.libraryDownloadedFileIds.push(version.file_id);
        }
        delete progress.libraryFailedFileIds[version.file_id];
        summary.reused++;
        continue;
      }

      try {
        const label = version.file_name || item.name || version.file_id;
        process.stdout.write(`  [${itemIndex + 1}/${files.length} v${version.version_number ?? '?'}] Downloading "${String(label).slice(0, 65)}"... `);
        const resolved = await resolveLibraryDownload(accessToken, item, version);
        verboseLog(`    Download URL: ${resolved.download_url.split('?')[0]} [+signature]`);
        const result = await downloadFile(resolved.download_url, targetPath, accessToken);
        version._export = {
          status: 'downloaded',
          local_path: relativeExportPath(targetPath),
          bytes: result.bytes,
          downloaded_at: new Date().toISOString(),
        };
        if (!progress.libraryDownloadedFileIds.includes(version.file_id)) {
          progress.libraryDownloadedFileIds.push(version.file_id);
        }
        delete progress.libraryFailedFileIds[version.file_id];
        summary.downloaded++;
        console.log('done');
      } catch (error) {
        if (error.authError) throw error;
        const message = String(error.message || error).slice(0, 500);
        version._export = { status: 'failed', error: message, local_path: null };
        progress.libraryFailedFileIds[version.file_id] = message;
        summary.failed++;
        console.log(`failed: ${message}`);
      }

      writeItemManifest(item, itemDirectory);
      writeIndexDocument(PATHS.libraryIndexFile, document);
      saveProgress(progress);
    }

    writeItemManifest(item, itemDirectory);
    writeIndexDocument(PATHS.libraryIndexFile, document);
    saveProgress(progress);
  }

  progress.libraryDownloadComplete = true;
  writeIndexDocument(PATHS.libraryIndexFile, document);
  saveProgress(progress);
  return summary;
}

module.exports = {
  stripUrlSecrets,
  sanitizeMetadata,
  createIndexDocument,
  readIndexDocument,
  buildNodesUrl,
  fetchLibraryIndex,
  buildVersionsUrl,
  fetchLibraryVersions,
  resolveLibraryDownload,
  safeSegment,
  buildDirectoryPathMap,
  versionFileName,
  collectNonLibraryFiles,
  findExistingFile,
  fileLooksComplete,
  exportLibrary,
};
