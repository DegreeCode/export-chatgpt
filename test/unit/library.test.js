'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../lib/auth', () => ({
  createApiHeaders: jest.fn(() => ({ Authorization: 'Bearer test' })),
  fetchWithRetry: jest.fn(),
  throttle: jest.fn(async () => {}),
  verifyToken: jest.fn(async () => true),
}));

const auth = require('../../lib/auth');

describe('ChatGPT Library export', () => {
  let tmpDir;
  let CONFIG;
  let PATHS;
  let library;

  function progress(overrides = {}) {
    return {
      indexingComplete: false,
      lastOffset: 0,
      downloadedIds: [],
      projectsIndexingComplete: false,
      projectsLastCursor: null,
      projects: {},
      downloadedFileIds: [],
      failedFileIds: {},
      libraryIndexingComplete: false,
      libraryDownloadComplete: false,
      libraryLastCursor: null,
      libraryDownloadedFileIds: [],
      libraryFailedFileIds: {},
      ...overrides,
    };
  }

  function jsonResponse(data) {
    return { json: async () => data };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-export-test-'));
    const config = require('../../lib/config');
    CONFIG = config.CONFIG;
    CONFIG.outputDir = tmpDir;
    CONFIG.throttleMs = 0;
    CONFIG.libraryVersionPageSize = 20;
    CONFIG.downloadFiles = true;
    CONFIG.downloadImages = true;
    CONFIG.downloadCanvas = true;
    CONFIG.downloadAttachments = true;
    CONFIG.retryFailedFiles = false;
    CONFIG.updateExisting = false;
    config.initPaths();
    PATHS = config.PATHS;
    library = require('../../lib/library');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('paginates all nodes, recursively scans folders, and keeps only owned items', async () => {
    auth.fetchWithRetry.mockImplementation(async url => {
      const parsed = new URL(url);
      const parent = parsed.searchParams.get('parent_directory_id');
      const cursor = parsed.searchParams.get('cursor');
      if (!parent && !cursor) return jsonResponse({
        items: [
          { kind: 'directory', id: 'dir-root', name: 'Folder', parent_directory_id: 'virtual-root', access_kind: 'owned' },
          { kind: 'file', id: 'lib-root', file_id: 'file-root', name: 'root.txt', parent_directory_id: 'virtual-root', access_kind: 'owned' },
          { kind: 'file', id: 'lib-shared', file_id: 'file-shared', name: 'shared.txt', access_kind: 'shared' },
        ],
        cursor: 'next-page',
      });
      if (!parent && cursor === 'next-page') return jsonResponse({
        items: [{ kind: 'directory', id: 'dir-empty', name: 'Empty', parent_directory_id: 'dir-root', access_kind: 'owned' }],
        cursor: null,
      });
      if (parent === 'dir-root') return jsonResponse({
        items: [{ kind: 'file', id: 'lib-child', file_id: 'file-child', name: 'child.zip', parent_directory_id: 'dir-root', access_kind: 'owned' }],
        cursor: null,
      });
      if (parent === 'dir-empty') return jsonResponse({ items: [], cursor: null });
      throw new Error(`Unexpected URL: ${url}`);
    });

    const state = progress();
    const result = await library.fetchLibraryIndex('token', state);

    expect(result.items.map(item => item.id).sort()).toEqual([
      'dir-empty', 'dir-root', 'lib-child', 'lib-root',
    ]);
    expect(result.stats).toEqual(expect.objectContaining({
      owned_files: 2,
      owned_directories: 2,
      shared_or_unknown_skipped: 1,
    }));
    expect(state.libraryIndexingComplete).toBe(true);
    expect(state.libraryLastCursor).toBeNull();
    const urls = auth.fetchWithRetry.mock.calls.map(call => call[0]);
    expect(urls.some(url => url.includes('parent_directory_id=dir-root'))).toBe(true);
    expect(urls.some(url => url.includes('parent_directory_id=dir-empty'))).toBe(true);
    expect(fs.existsSync(PATHS.libraryIndexFile)).toBe(true);
    expect(fs.existsSync(PATHS.libraryPartialIndexFile)).toBe(false);
  });

  test('paginates every version for one Library file', async () => {
    auth.fetchWithRetry
      .mockResolvedValueOnce(jsonResponse({
        items: [{ library_file_id: 'lib-one', version_number: 0, file_id: 'file-v0', file_name: 'archive.zip' }],
        cursor: 'versions-next',
      }))
      .mockResolvedValueOnce(jsonResponse({
        items: [{ library_file_id: 'lib-one', version_number: 1, file_id: 'file-v1', file_name: 'archive.zip' }],
        cursor: null,
      }));

    const versions = await library.fetchLibraryVersions('token', { id: 'lib-one', kind: 'file' });

    expect(versions.map(version => version.file_id)).toEqual(['file-v0', 'file-v1']);
    expect(auth.fetchWithRetry.mock.calls[1][0]).toContain('cursor=versions-next');
  });

  test('downloads every version into the recursive Library folder structure', async () => {
    auth.fetchWithRetry.mockImplementation(async url => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/files/library/nodes')) {
        const parent = parsed.searchParams.get('parent_directory_id');
        if (parent === 'dir-one') return jsonResponse({ items: [], cursor: null });
        return jsonResponse({
          items: [
            { kind: 'directory', id: 'dir-one', name: 'Sources', parent_directory_id: 'virtual-root', access_kind: 'owned' },
            { kind: 'file', id: 'lib-one', file_id: 'file-v1', name: 'archive.zip', parent_directory_id: 'dir-one', mime_type: 'application/zip', access_kind: 'owned' },
          ],
          cursor: null,
        });
      }
      if (parsed.pathname.endsWith('/files/library/files/lib-one/versions')) {
        return jsonResponse({
          items: [
            { library_file_id: 'lib-one', version_number: 0, is_current: false, file_id: 'file-v0', file_name: 'archive.zip', file_size_bytes: 2, mime_type: 'application/zip' },
            { library_file_id: 'lib-one', version_number: 1, is_current: true, file_id: 'file-v1', file_name: 'archive.zip', file_size_bytes: 2, mime_type: 'application/zip' },
          ],
          cursor: null,
        });
      }
      if (parsed.pathname.includes('/files/download/')) {
        const fileId = decodeURIComponent(parsed.pathname.split('/').pop());
        return jsonResponse({ status: 'success', download_url: `https://cdn.example.test/${fileId}` });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/zip' },
      arrayBuffer: async () => Buffer.from('ok'),
    });

    const state = progress();
    const result = await library.exportLibrary('token', state);

    expect(result).toEqual(expect.objectContaining({ files: 1, directories: 1, versions: 2, downloaded: 2 }));
    const allFiles = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else allFiles.push(full);
      }
    };
    walk(PATHS.libraryFilesDir);
    expect(allFiles.some(file => path.basename(file) === 'v000_archive.zip')).toBe(true);
    expect(allFiles.some(file => path.basename(file) === 'v001_archive.zip')).toBe(true);
    expect(allFiles.some(file => path.basename(file) === '.directory.json')).toBe(true);
    expect(allFiles.some(file => path.basename(file) === 'versions.json')).toBe(true);
    expect(state.libraryDownloadedFileIds.sort()).toEqual(['file-v0', 'file-v1']);
    expect(state.libraryDownloadComplete).toBe(true);

    const resumed = await library.exportLibrary('token', state);
    expect(resumed).toEqual(expect.objectContaining({ downloaded: 0, existing: 2 }));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  test('resolves downloads through the confirmed direct Library file resolver first', async () => {
    auth.fetchWithRetry.mockResolvedValueOnce(jsonResponse({
      status: 'success',
      download_url: 'https://chatgpt.com/backend-api/estuary/content?id=file-one&sig=secret&v=0',
    }));

    const result = await library.resolveLibraryDownload('token', {}, { file_id: 'file-one' });

    expect(result.status).toBe('success');
    expect(auth.fetchWithRetry.mock.calls[0][0]).toContain('/files/download/file-one?inline=false');
  });

  test('sanitizes signed URL query strings before writing metadata', () => {
    expect(library.stripUrlSecrets('https://chatgpt.com/file?sig=secret#fragment'))
      .toBe('https://chatgpt.com/file');
  });
});
