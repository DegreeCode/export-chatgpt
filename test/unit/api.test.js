'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('api', () => {
  let CONFIG, PATHS, initPaths, fetchConversationListIncremental, fetchProjectList, fetchProjectConversations;
  let tmpDir;

  beforeEach(() => {
    jest.resetModules();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-api-test-'));

    jest.spyOn(console, 'log').mockImplementation();

    ({ CONFIG, PATHS, initPaths } = require('../../lib/config'));
    CONFIG.outputDir = tmpDir;
    CONFIG.throttleMs = 0;
    CONFIG.conversationsPerPage = 28;
    CONFIG.currentUserId = 'user-current';
    initPaths();

    ({ fetchConversationListIncremental, fetchProjectList, fetchProjectConversations } = require('../../lib/api'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProgress(overrides = {}) {
    return {
      indexingComplete: false,
      lastOffset: 0,
      downloadedIds: [],
      projectsIndexingComplete: false,
      projectsLastCursor: null,
      projects: {},
      downloadedFileIds: [],
      ...overrides,
    };
  }

  function makeConv(id, update_time) {
    return { id, title: `Chat ${id}`, create_time: 1700000000, update_time };
  }

  function mockFetchPages(pages) {
    let call = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      const page = pages[call] ?? { items: [], total: 0, limit: 28, offset: 0 };
      call++;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(page),
      });
    });
  }

  describe('fetchProjectList — conversation_count initialization (issue #9)', () => {
    function makeSidebarResponse(gizmos, cursor = null) {
      return {
        items: gizmos.map(g => ({
          gizmo: { gizmo: g, files: g.files || [] },
        })),
        cursor,
      };
    }

    function makeGizmo(id, name = 'Test Project') {
      return {
        id,
        display: { name, description: '' },
        instructions: '',
        workspace_id: null,
        created_at: '2024-01-01',
        updated_at: '2024-01-02',
        num_interactions: 5,
      };
    }

    test('initializes conversation_count as null, not 0', async () => {
      mockFetchPages([makeSidebarResponse([makeGizmo('proj-1')])]);

      const progress = makeProgress();
      const projects = await fetchProjectList('token', progress);

      expect(projects).toHaveLength(1);
      expect(projects[0].conversation_count).toBeNull();
    });

    test('conversation_count is null in saved project-index.json', async () => {
      mockFetchPages([makeSidebarResponse([
        makeGizmo('proj-1', 'Alpha'),
        makeGizmo('proj-2', 'Beta'),
      ])]);

      const progress = makeProgress();
      await fetchProjectList('token', progress);

      const saved = JSON.parse(fs.readFileSync(PATHS.projectIndexFile, 'utf8'));
      expect(saved).toHaveLength(2);
      for (const p of saved) {
        expect(p.conversation_count).toBeNull();
      }
    });

    test('conversation_count updates to real count after fetchProjectConversations', async () => {
      // Call 1: fetchProjectList sidebar response
      // Call 2: fetchProjectConversations returns 3 conversations
      mockFetchPages([
        makeSidebarResponse([makeGizmo('proj-1')]),
        {
          items: [
            { id: 'c1', title: 'Chat 1', owner: { user_id: 'user-current' } },
            { id: 'c2', title: 'Chat 2', owner: { user_id: 'user-current' } },
            { id: 'c3', title: 'Chat 3', owner: { user_id: 'user-current' } },
          ],
          cursor: null,
        },
      ]);

      const progress = makeProgress();
      const projects = await fetchProjectList('token', progress);
      expect(projects[0].conversation_count).toBeNull();

      await fetchProjectConversations('token', projects[0], progress);

      expect(projects[0].conversation_count).toBe(3);

      // Verify the persisted index also updated
      const saved = JSON.parse(fs.readFileSync(PATHS.projectIndexFile, 'utf8'));
      expect(saved[0].conversation_count).toBe(3);
    });
  });

  describe('fetchProjectConversations — ownership filtering', () => {
    test('keeps only conversations created by the authenticated user', async () => {
      mockFetchPages([{
        items: [
          { id: 'mine-1', title: 'Mine', owner: { user_id: 'user-current__workspace-1' } },
          { id: 'theirs-1', title: 'Theirs', owner: { user_id: 'user-other__workspace-1' } },
          { id: 'unknown-1', title: 'Unknown' },
        ],
        cursor: null,
      }]);

      const progress = makeProgress();
      const project = { id: 'proj-owned-filter', name: 'Shared Project' };
      const conversations = await fetchProjectConversations('token', project, progress);

      expect(conversations.map(c => c.id)).toEqual(['mine-1']);
      const saved = JSON.parse(fs.readFileSync(
        path.join(PATHS.projectsDir, 'Shared_Project', 'conversation-index.json'),
        'utf8'
      ));
      expect(saved.map(c => c.id)).toEqual(['mine-1']);
      expect(project.conversation_count).toBe(1);
    });

    test('sanitizes a previously completed index before returning it', async () => {
      const project = { id: 'proj-resume', name: 'Resume Project' };
      const projectDir = path.join(PATHS.projectsDir, 'Resume_Project');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'conversation-index.json'), JSON.stringify([
        { id: 'mine-2', owner: { user_id: 'user-current' } },
        { id: 'theirs-2', owner: { user_id: 'user-other' } },
      ]));
      const progress = makeProgress({
        projects: {
          'proj-resume': { name: project.name, indexingComplete: true, lastCursor: null, downloadedIds: [] },
        },
      });

      const conversations = await fetchProjectConversations('token', project, progress);
      expect(conversations.map(c => c.id)).toEqual(['mine-2']);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('fetchConversationListIncremental — re-scan when indexingComplete', () => {
    test('always starts from offset 0 even when lastOffset is set', async () => {
      const existingIndex = new Map([['conv-1', makeConv('conv-1', 1700001000)]]);
      // Simulate a previously-completed run with lastOffset saved
      const progress = makeProgress({ indexingComplete: true, lastOffset: 1232 });

      // Only one page returned (partial) — if it started at offset 1232 it would be empty
      mockFetchPages([
        { items: [makeConv('conv-1', 1700001000)], total: 1, limit: 28, offset: 0 },
      ]);

      const result = await fetchConversationListIncremental('token', existingIndex, progress);

      expect(result).toBe(existingIndex);
      // Verify the URL used offset=0, not offset=1232
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('offset=0'),
        expect.anything()
      );
    });

    test('stops after 3 pages with no new conversations', async () => {
      // 3 full pages of already-indexed conversations, then the loop breaks
      const convs = Array.from({ length: 28 }, (_, i) => makeConv(`conv-${i}`, 1700001000 + i));
      const existingIndex = new Map(convs.map(c => [c.id, c]));
      const progress = makeProgress({ indexingComplete: true });

      mockFetchPages([
        { items: convs, total: 84, limit: 28, offset: 0 },
        { items: convs, total: 84, limit: 28, offset: 28 },
        { items: convs, total: 84, limit: 28, offset: 56 },
        { items: convs, total: 84, limit: 28, offset: 84 }, // should never be fetched
      ]);

      await fetchConversationListIncremental('token', existingIndex, progress);

      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    test('finds new conversation and adds it to the index', async () => {
      const existingIndex = new Map([['conv-old', makeConv('conv-old', 1700001000)]]);
      const progress = makeProgress({ indexingComplete: true });

      mockFetchPages([
        {
          items: [makeConv('conv-new', 1700002000), makeConv('conv-old', 1700001000)],
          total: 2, limit: 28, offset: 0,
        },
      ]);

      const result = await fetchConversationListIncremental('token', existingIndex, progress);

      expect(result.has('conv-new')).toBe(true);
      expect(result.size).toBe(2);
    });
  });
});
