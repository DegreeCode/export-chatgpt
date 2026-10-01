'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../lib/auth', () => ({
  createApiHeaders: jest.fn(() => ({ Authorization: 'Bearer test-token' })),
  fetchWithRetry: jest.fn(),
  throttle: jest.fn(async () => {}),
  verifyToken: jest.fn(async () => true),
}));

const auth = require('../../lib/auth');
const { CONFIG, PATHS, initPaths } = require('../../lib/config');
const { loadProgress } = require('../../lib/storage');
const dots = require('../../lib/dots');

const dot = { id: 'workspace~dot-one', display_name: '도우미', messaging_room_id: 'room-one', active_root_thread_id: 'task-root' };
const room = {
  id: 'room-one', type: 'DM', aeon_id: dot.id, creator_account_user_id: 'user-test__workspace',
  members: [
    { account_user_id: 'user-test__workspace', name: 'Human' },
    { account_user_id: 'calpico-member-test', name: '도우미', aeon_id: dot.id },
  ],
};
const fileId = 'CalpicoFile_test-one';
const file = {
  file_id: fileId, id: fileId, name: '도우미_설명.txt', mime_type: 'text/plain',
  download_url: 'https://cdn.example.test/expired?sig=embedded-secret', library_file_id: null,
};
const attachment = { attachment_id: 'attachment-one', type: 'file', file_id: fileId, file };
function message(id, author = 'calpico-member-test', attachments = [], text = '안녕하세요') {
  return { id, created_at: `2026-10-01T00:00:0${id.endsWith('1') ? '1' : '2'}Z`,
    role: 'user', account_user_id: author, content: { text, attachments }, reactions: {}, reply_to: null };
}
function response(data) { return { json: async () => data }; }
function authError() { return Object.assign(new Error('HTTP 401: token expired'), { status: 401, authError: true }); }
function summary() { return { files: 0, downloaded: 0, existing: 0, filtered: 0, failedFiles: 0 }; }

describe('Dot chats and attachment export', () => {
  let tmpDir;
  let fetchSpy;
  let progress;

  beforeEach(() => {
    jest.clearAllMocks();
    auth.verifyToken.mockResolvedValue(true);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-export-test-'));
    Object.assign(CONFIG, {
      outputDir: tmpDir, currentUserId: 'user-test', throttleMs: 0,
      dotsPageSize: 25, dotMessagePageSize: 32, exportFormat: 'both',
      downloadFiles: true, downloadImages: true, downloadCanvas: true, downloadAttachments: true,
      retryFailedFiles: false, updateExisting: false, includeDots: true, dotsOnly: true,
      includeLibrary: false, libraryOnly: false, includeProjects: false, projectsOnly: false,
      showSummary: true, verbose: false, sessionCookie: 'test-cookie',
    });
    initPaths();
    progress = loadProgress();
    jest.spyOn(console, 'log').mockImplementation();
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, status: 200, headers: { get: () => 'text/plain' },
      arrayBuffer: async () => Buffer.from('test-content'),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function routes({ messages = [message('message-1', 'user-test__workspace'), message('message-2', undefined, [attachment])],
    threadsError = null, resolverError = null, profiles = [dot], metadata = file } = {}) {
    auth.fetchWithRetry.mockImplementation(async url => {
      const parsed = new URL(url);
      const route = decodeURIComponent(parsed.pathname);
      if (route.endsWith('/tbo')) return response({ items: profiles, cursor: null });
      if (route.endsWith('/messaging/rooms/room-one')) return response(room);
      if (route.endsWith('/threads')) {
        if (threadsError) throw threadsError;
        return response({ items: [
          { thread_id: 'task-root', parent_thread_id: null, is_user_visible: true },
          { thread_id: 'task-hidden', parent_thread_id: 'task-root', is_user_visible: false },
        ], cursor: null });
      }
      if (route.endsWith('/messages')) return response({ items: messages, prev_cursor: null, next_cursor: null });
      if (route.endsWith(`/files/${fileId}`)) {
        if (resolverError) throw resolverError;
        return response({ ...metadata, download_url: 'https://cdn.example.test/fresh?sig=refreshed-secret', file_size_bytes: 12 });
      }
      if (route.endsWith('/files/library/nodes')) return response({ items: [], cursor: null });
      throw new Error(`Unexpected URL: ${url}`);
    });
  }

  function exportedDirectory() {
    const index = JSON.parse(fs.readFileSync(PATHS.dotsIndexFile, 'utf8'));
    return path.join(tmpDir, index.items[0]._export.directory);
  }

  test('paginates profiles and hidden task links using distinct cursor queries', async () => {
    auth.fetchWithRetry
      .mockResolvedValueOnce(response({ items: [dot], cursor: 'profiles-next' }))
      .mockResolvedValueOnce(response({ items: [{ ...dot, display_name: 'Renamed' }, { id: 'second' }], cursor: null }))
      .mockResolvedValueOnce(response({ items: [{ thread_id: 'root' }], cursor: 'threads-next' }))
      .mockResolvedValueOnce(response({ items: [{ thread_id: 'hidden', is_user_visible: false }], cursor: null }));
    const profiles = await dots.fetchDotList('token');
    expect(profiles.map(item => item.id)).toEqual([dot.id, 'second']);
    expect(profiles[0].display_name).toBe('Renamed');
    const threads = await dots.fetchDotThreads('token', dot.id);
    expect(threads).toHaveLength(2);
    const urls = auth.fetchWithRetry.mock.calls.map(([url]) => new URL(url));
    expect(urls[0].searchParams.get('include_room_preview')).toBe('false');
    expect(urls[1].searchParams.get('cursor')).toBe('profiles-next');
    expect(decodeURIComponent(urls[2].pathname)).toContain('/tbo/workspace~dot-one/threads');
    expect(urls[2].searchParams.get('include_hidden')).toBe('true');
    expect(urls[3].searchParams.get('cursor')).toBe('threads-next');
  });

  test('rejects repeated list cursors', async () => {
    auth.fetchWithRetry.mockResolvedValue(response({ items: [dot], cursor: 'same' }));
    await expect(dots.fetchDotList('token')).rejects.toThrow('repeated a pagination cursor');
    expect(auth.fetchWithRetry).toHaveBeenCalledTimes(2);
  });

  test('ownership requires creator, room identity and Dot identity, not role user', () => {
    expect(dots.isOwnedRoom(room, dot)).toBe(true);
    for (const override of [
      { creator_account_user_id: 'other-user' }, { creator_account_user_id: null },
      { aeon_id: 'another-dot' }, { id: 'another-room' }, { type: 'GROUP' },
    ]) expect(dots.isOwnedRoom({ ...room, ...override }, dot)).toBe(false);
    CONFIG.currentUserId = null;
    expect(dots.isOwnedRoom(room, dot)).toBe(false);
  });

  test('does not fetch messages or files from shared or unknown-owner rooms', async () => {
    routes();
    const base = auth.fetchWithRetry.getMockImplementation();
    auth.fetchWithRetry.mockImplementation(async url =>
      new URL(url).pathname.endsWith('/rooms/room-one')
        ? response({ ...room, creator_account_user_id: 'other-user' }) : base(url));
    const result = await dots.exportDots('token', progress);
    expect(result).toMatchObject({ count: 0, skipped: 1, downloaded: 0 });
    expect(auth.fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('paginates before cursors, deduplicates by ID and preserves widgets and edits', async () => {
    const edited = { ...message('message-2'), content: { text: '수정됨', attachments: [{ type: 'widget', messages: [{ content: { text: 'untrusted tool data' } }] }] } };
    auth.fetchWithRetry
      .mockResolvedValueOnce(response({ items: [message('message-2')], prev_cursor: 'room~cursor+value', next_cursor: 'not-before' }))
      .mockResolvedValueOnce(response({ items: [message('message-1'), edited], prev_cursor: null, next_cursor: null }));
    const state = {};
    const items = await dots.fetchDotMessages('token', room.id, tmpDir, state, progress);
    expect(items.map(item => item.id)).toEqual(['message-1', 'message-2']);
    expect(items[1].content).toEqual(edited.content);
    const secondUrl = new URL(auth.fetchWithRetry.mock.calls[1][0]);
    expect(secondUrl.searchParams.get('before')).toBe('room~cursor+value');
    expect(secondUrl.searchParams.get('before')).not.toBe('not-before');
    expect(state).toMatchObject({ messagesComplete: true, before: null });
    expect(fs.existsSync(path.join(tmpDir, '.messages.partial.json'))).toBe(false);
  });

  test('auth interruption resumes saved history then refreshes latest messages', async () => {
    const state = {};
    auth.fetchWithRetry
      .mockResolvedValueOnce(response({ items: [message('message-2')], prev_cursor: 'older-page' }))
      .mockRejectedValueOnce(authError());
    await expect(dots.fetchDotMessages('token', room.id, tmpDir, state, progress)).rejects.toMatchObject({ authError: true });
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, '.messages.partial.json'), 'utf8')).before).toBe('older-page');
    auth.fetchWithRetry.mockReset()
      .mockResolvedValueOnce(response({ items: [message('message-1')], prev_cursor: null }))
      .mockResolvedValueOnce(response({ items: [message('message-3')], prev_cursor: null }));
    const items = await dots.fetchDotMessages('new-token', room.id, tmpDir, state, progress);
    expect(items.map(item => item.id)).toEqual(['message-1', 'message-2', 'message-3']);
    expect(new URL(auth.fetchWithRetry.mock.calls[0][0]).searchParams.get('before')).toBe('older-page');
    expect(new URL(auth.fetchWithRetry.mock.calls[1][0]).searchParams.has('before')).toBe(false);
  });

  test('message cursor loops are incomplete, with partial data retained', async () => {
    auth.fetchWithRetry.mockResolvedValue(response({ items: [message('message-1')], prev_cursor: 'loop' }));
    const state = {};
    await expect(dots.fetchDotMessages('token', room.id, tmpDir, state, progress)).rejects.toThrow('repeated a cursor');
    expect(state.messagesComplete).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, '.messages.partial.json'), 'utf8')).items).toHaveLength(1);
    expect(fs.existsSync(path.join(tmpDir, 'messages.json'))).toBe(false);
  });

  test('missing cursor falls back to oldest message ID until an empty page', async () => {
    auth.fetchWithRetry
      .mockResolvedValueOnce(response({ items: [message('message-1')] }))
      .mockResolvedValueOnce(response({ items: [] }));
    expect(await dots.fetchDotMessages('token', room.id, tmpDir, {}, progress)).toHaveLength(1);
    expect(new URL(auth.fetchWithRetry.mock.calls[1][0]).searchParams.get('before')).toBe('message-1');
  });

  test('deduplicates attachment IDs but retains every message link and safe Korean filename', () => {
    const files = dots.collectDotFiles([message('message-1', undefined, [attachment]), message('message-2', undefined, [attachment, { type: 'widget' }])]);
    expect(files).toHaveLength(1);
    expect(files[0].message_ids).toEqual(['message-1', 'message-2']);
    expect(files[0].metadata.library_file_id).toBeNull();
    expect(dots.dotFileName(files[0])).toMatch(/^도우미_설명__[0-9a-f]{16}\.txt$/);
    expect(dots.dotFileName({ ...files[0], name: '../../bad:name.txt' })).not.toContain('/');
  });

  test('exports raw messages, readable author labels, hidden links and fresh file downloads', async () => {
    routes();
    const result = await dots.exportDots('token', progress);
    expect(result).toMatchObject({ count: 1, messages: 2, files: 1, downloaded: 1, threads: 2, hiddenThreads: 1, failedFiles: 0, errors: 0 });
    const dir = exportedDirectory();
    const markdown = fs.readFileSync(path.join(dir, 'messages.md'), 'utf8');
    expect(markdown).toContain('## User');
    expect(markdown).toContain('## 도우미');
    expect(markdown).toContain('files/');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'downloads.json'), 'utf8'));
    expect(fs.readFileSync(path.join(dir, manifest.items[0]._export.local_path), 'utf8')).toBe('test-content');
    expect(manifest.source).toBe('message_attachments');
    expect(manifest.items[0].metadata.download_url).toBe('https://cdn.example.test/fresh');
    const raw = fs.readFileSync(path.join(dir, 'messages.json'), 'utf8');
    expect(raw).not.toContain('embedded-secret');
    expect(fs.readFileSync(path.join(dir, 'threads.json'), 'utf8')).toContain('"bodies_exported": false');
    expect(progress.dots[room.id]).toMatchObject({ messagesComplete: true, downloadComplete: true });
    expect(fetchSpy.mock.calls[0]).toEqual(['https://cdn.example.test/fresh?sig=refreshed-secret', { headers: {} }]);
  });

  test('refreshes chats but reuses complete files, even after a Dot is renamed', async () => {
    routes();
    await dots.exportDots('token', progress);
    const firstDirectory = exportedDirectory();
    routes({ profiles: [{ ...dot, display_name: 'New name' }], messages: [message('message-3', undefined, [attachment])] });
    const result = await dots.exportDots('token', progress);
    expect(result).toMatchObject({ messages: 3, downloaded: 0, existing: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(exportedDirectory()).toBe(firstDirectory);
    expect(fs.readFileSync(path.join(firstDirectory, 'messages.md'), 'utf8')).toContain('# New name');
  });

  test('redownloads truncated or missing files without --update; --update forces redownload', async () => {
    routes();
    await dots.exportDots('token', progress);
    const dir = exportedDirectory();
    const savedFile = path.join(dir, 'files', dots.dotFileName(dots.collectDotFiles([message('message-2', undefined, [attachment])])[0]));
    fs.writeFileSync(savedFile, 'short');
    expect((await dots.exportDots('token', progress)).downloaded).toBe(1);
    fs.unlinkSync(savedFile);
    expect((await dots.exportDots('token', progress)).downloaded).toBe(1);
    CONFIG.updateExisting = true;
    expect((await dots.exportDots('token', progress)).downloaded).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  test('refreshes the resolver once after CDN 403 and never uses an embedded old URL', async () => {
    routes();
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 403 });
    const result = await dots.exportDots('token', progress);
    expect(result.downloaded).toBe(1);
    const resolvers = auth.fetchWithRetry.mock.calls.filter(([url]) => url.endsWith(`/files/${fileId}`));
    expect(resolvers).toHaveLength(2);
    expect(fetchSpy.mock.calls.every(([url]) => url.includes('/fresh?'))).toBe(true);
  });

  test('records permanent file failures and only reopens them with --retry-failed-files', async () => {
    routes({ resolverError: Object.assign(new Error('HTTP 404'), { status: 404 }) });
    expect((await dots.exportDots('token', progress)).failedFiles).toBe(1);
    expect(progress.dotsFailedFileIds[`${room.id}~${fileId}`]).toBe('HTTP 404');
    routes();
    auth.fetchWithRetry.mockClear();
    expect((await dots.exportDots('token', progress)).failedFiles).toBe(1);
    expect(auth.fetchWithRetry.mock.calls.some(([url]) => url.endsWith(`/files/${fileId}`))).toBe(false);
    CONFIG.retryFailedFiles = true;
    expect((await dots.exportDots('token', progress)).downloaded).toBe(1);
    expect(progress.dotsFailedFileIds).toEqual({});
  });

  test('expired bearer in file resolver interrupts; valid bearer with file denial only marks that file', async () => {
    routes({ resolverError: authError() });
    auth.verifyToken.mockResolvedValue(false);
    await expect(dots.exportDots('token', progress)).rejects.toMatchObject({ authError: true, dotSummary: { count: 1 } });
    expect(progress.dots[room.id].downloadComplete).toBe(false);
    expect(progress.dotsFailedFileIds).toEqual({});
    auth.verifyToken.mockResolvedValue(true);
    const result = await dots.exportDots('token', progress);
    expect(result.failedFiles).toBe(1);
    expect(progress.dotsFailedFileIds[`${room.id}~${fileId}`]).toContain('HTTP 401');
  });

  test('--no-files preserves raw widgets and inventories without resolving any files', async () => {
    CONFIG.downloadFiles = false;
    routes({ messages: [message('message-1', undefined, [attachment, { type: 'widget', attachment_id: 'widget', messages: [{ content: { text: 'raw widget' } }] }])] });
    expect((await dots.exportDots('token', progress)).filtered).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(auth.fetchWithRetry.mock.calls.some(([url]) => url.includes(`/files/${fileId}`))).toBe(false);
    const dir = exportedDirectory();
    expect(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8')).toContain('raw widget');
    expect(fs.readFileSync(path.join(dir, 'messages.md'), 'utf8')).toContain('widget');
  });

  test('respects --no-images and JSON-only output while retaining attachment metadata', async () => {
    CONFIG.downloadImages = false;
    CONFIG.exportFormat = 'json';
    routes({ messages: [message('message-1', undefined, [{ ...attachment, type: 'image', file: { ...file, name: 'image.png', mime_type: 'image/png' } }])] });
    expect((await dots.exportDots('token', progress)).filtered).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(exportedDirectory(), 'messages.md'))).toBe(false);
    expect(fs.existsSync(path.join(exportedDirectory(), 'messages.json'))).toBe(true);
  });

  test('keeps previous linked-task metadata on a later endpoint failure', async () => {
    routes();
    await dots.exportDots('token', progress);
    routes({ threadsError: new Error('HTTP 500') });
    expect((await dots.exportDots('token', progress)).errors).toBe(1);
    const document = JSON.parse(fs.readFileSync(path.join(exportedDirectory(), 'threads.json'), 'utf8'));
    expect(document.items).toHaveLength(2);
    expect(document._export.metadata_complete).toBe(false);
  });

  test('Dot-only orchestration supports Library too and never calls ordinary chats, projects or legacy file retries', async () => {
    routes();
    CONFIG.includeLibrary = true;
    const { run } = require('../../lib/exporter');
    const result = await run('token');
    expect(result.dots.downloaded).toBe(1);
    expect(result.library.files).toBe(0);
    expect(result.regular.success).toBe(0);
    expect(result.projects.count).toBe(0);
    const urls = auth.fetchWithRetry.mock.calls.map(([url]) => url);
    expect(urls.some(url => url.includes('/files/library/nodes'))).toBe(true);
    expect(urls.some(url => /\/conversations\?|\/gizmos|\/projects/.test(url))).toBe(false);
  });

  test('run reports incomplete and the internal-log limitation rather than a success banner', async () => {
    routes({ resolverError: Object.assign(new Error('HTTP 404'), { status: 404 }) });
    const { run } = require('../../lib/exporter');
    const result = await run('token');
    expect(result.incomplete).toBe(true);
    const output = console.log.mock.calls.map(([value]) => value).join('\n');
    expect(output).toContain('Export Incomplete');
    expect(output).toContain('internal task bodies not exported');
    expect(output).not.toContain('Export Complete!');
  });

  test('run includes partial Dot summary when message indexing is interrupted', async () => {
    routes();
    const base = auth.fetchWithRetry.getMockImplementation();
    auth.fetchWithRetry.mockImplementation(async url => {
      if (new URL(url).pathname.endsWith('/messages')) throw authError();
      return base(url);
    });
    const { run } = require('../../lib/exporter');
    await expect(run('token')).rejects.toMatchObject({ authError: true });
    const output = console.log.mock.calls.map(([value]) => value).join('\n');
    expect(output).toContain('authentication expired');
    expect(output).toContain('1 dots');
    expect(output).not.toContain('Export Complete!');
  });
});
