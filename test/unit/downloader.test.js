'use strict';

describe('downloader', () => {
  let extractFileReferences, getFileDownloadUrl, getExtensionFromFilename, getLocalFileName, getCompositePreviewSourceId, downloadFile, retryPendingFiles;

  beforeEach(() => {
    jest.resetModules();
    ({ extractFileReferences, getFileDownloadUrl, getExtensionFromFilename, getLocalFileName, getCompositePreviewSourceId, downloadFile, retryPendingFiles } = require('../../lib/downloader'));
  });

  describe('extractFileReferences', () => {
    test('extracts image references from multimodal content', () => {
      const data = {
        id: 'conv-1',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [
                  { content_type: 'image_asset_pointer', asset_pointer: 'file-service://img-123', metadata: {}, size_bytes: 5000 },
                ],
              },
            },
          },
        },
      };
      const refs = extractFileReferences(data);
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({
        fileId: 'img-123',
        conversationId: 'conv-1',
        type: 'image',
        metadata: {},
        sizeBytes: 5000,
      });
    });

    test('extracts canvas references', () => {
      const data = {
        id: 'conv-2',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [
                  { content_type: 'canvas_asset_pointer', asset_pointer: 'sediment://canvas-456', metadata: {} },
                ],
              },
            },
          },
        },
      };
      const refs = extractFileReferences(data);
      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('canvas');
      expect(refs[0].fileId).toBe('canvas-456');
    });

    test('extracts standalone canvas content', () => {
      const data = {
        id: 'conv-3',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'canvas',
                asset_pointer: 'file-service://standalone-canvas',
                metadata: {},
              },
            },
          },
        },
      };
      const refs = extractFileReferences(data);
      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('canvas');
    });

    test('extracts attachment references', () => {
      const data = {
        id: 'conv-4',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [
                  { content_type: 'other_pointer', asset_pointer: 'file-service://file-789', metadata: {} },
                ],
              },
            },
          },
        },
      };
      const refs = extractFileReferences(data);
      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('attachment');
    });

    test('returns empty array for no mapping', () => {
      expect(extractFileReferences({})).toEqual([]);
    });

    test('returns empty array for messages without content', () => {
      const data = {
        id: 'conv-5',
        mapping: {
          node1: { message: null },
          node2: { message: { content: null } },
        },
      };
      expect(extractFileReferences(data)).toEqual([]);
    });

    test('skips parts without asset_pointer', () => {
      const data = {
        id: 'conv-6',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: ['just text', null, { no_pointer: true }],
              },
            },
          },
        },
      };
      expect(extractFileReferences(data)).toEqual([]);
    });

    test('handles multiple files from same conversation', () => {
      const data = {
        id: 'conv-7',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [
                  { content_type: 'image_asset_pointer', asset_pointer: 'file-service://img-1', metadata: {} },
                  { content_type: 'image_asset_pointer', asset_pointer: 'file-service://img-2', metadata: {} },
                ],
              },
            },
          },
          node2: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [
                  { content_type: 'image_asset_pointer', asset_pointer: 'file-service://img-3', metadata: {} },
                ],
              },
            },
          },
        },
      };
      expect(extractFileReferences(data)).toHaveLength(3);
    });

    test('extracts non-image files from message metadata attachments', () => {
      const data = {
        id: 'conv-docs',
        mapping: {
          node1: {
            message: {
              content: { content_type: 'text', parts: ['See attachments'] },
              metadata: {
                attachments: [
                  { id: 'file-md', name: 'notes.md', mime_type: 'text/markdown', size: 123 },
                  { id: 'file-zip', name: 'source.zip', mime_type: 'application/zip', size: 456 },
                ],
              },
            },
          },
        },
      };

      expect(extractFileReferences(data)).toEqual([
        expect.objectContaining({ fileId: 'file-md', type: 'attachment', filename: 'notes.md' }),
        expect.objectContaining({ fileId: 'file-zip', type: 'attachment', filename: 'source.zip' }),
      ]);
    });

    test('extracts Pro and Work files from content references', () => {
      const data = {
        id: 'conv-work',
        mapping: {
          node1: {
            message: {
              content: { content_type: 'text', parts: ['Download'] },
              metadata: {
                content_references: [{
                  type: 'file',
                  id: 'file_work_zip',
                  name: 'source-code.zip',
                  source: 'my_files',
                  library_file_id: 'libfile_work_zip',
                }],
              },
            },
          },
        },
      };

      expect(extractFileReferences(data)).toEqual([
        expect.objectContaining({
          fileId: 'file_work_zip',
          conversationId: 'conv-work',
          type: 'attachment',
          filename: 'source-code.zip',
          libraryFileId: 'libfile_work_zip',
          source: 'my_files',
        }),
      ]);
    });

    test('keeps separate versions of the same Library file', () => {
      const data = {
        id: 'conv-work-versions',
        mapping: {
          v0: { message: { content: {}, metadata: { content_references: [
            { type: 'file', id: 'file_version_0', name: 'site.zip', library_file_id: 'libfile_site' },
          ] } } },
          v1: { message: { content: {}, metadata: { content_references: [
            { type: 'file', id: 'file_version_1', name: 'site.zip', library_file_id: 'libfile_site' },
          ] } } },
        },
      };

      const refs = extractFileReferences(data);
      expect(refs.map(ref => ref.fileId)).toEqual(['file_version_0', 'file_version_1']);
      expect(refs.every(ref => ref.libraryFileId === 'libfile_site')).toBe(true);
    });

    test('deduplicates files represented in both content and metadata', () => {
      const data = {
        id: 'conv-duplicate',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-image' }],
              },
              metadata: {
                attachments: [{ id: 'file-image', name: 'image.png', mime_type: 'image/png' }],
              },
            },
          },
        },
      };

      const refs = extractFileReferences(data);
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual(expect.objectContaining({ fileId: 'file-image', filename: 'image.png', type: 'image' }));
    });

    test('retains Library metadata when a file has multiple representations', () => {
      const data = {
        id: 'conv-library-duplicate',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-image' }],
              },
              metadata: {
                attachments: [{ id: 'file-image', name: 'image.png', mime_type: 'image/png' }],
                content_references: [{
                  type: 'file', id: 'file-image', name: 'image.png',
                  library_file_id: 'libfile-image', source: 'my_files',
                }],
              },
            },
          },
        },
      };

      expect(extractFileReferences(data)).toEqual([
        expect.objectContaining({
          fileId: 'file-image',
          filename: 'image.png',
          type: 'image',
          libraryFileId: 'libfile-image',
          source: 'my_files',
        }),
      ]);
    });
  });

  describe('getExtensionFromFilename', () => {
    test('extracts extension', () => {
      expect(getExtensionFromFilename('photo.jpg')).toBe('.jpg');
      expect(getExtensionFromFilename('document.pdf')).toBe('.pdf');
      expect(getExtensionFromFilename('archive.tar.gz')).toBe('.gz');
    });

    test('returns empty string for no extension', () => {
      expect(getExtensionFromFilename('README')).toBe('');
    });

    test('returns empty string for null/undefined', () => {
      expect(getExtensionFromFilename(null)).toBe('');
      expect(getExtensionFromFilename(undefined)).toBe('');
    });
  });

  describe('getLocalFileName', () => {
    test('does not append a duplicate extension to composite image IDs', () => {
      expect(getLocalFileName('asset#file_123#p_3.image.jpg', '.png'))
        .toBe('asset#file_123#p_3.image.jpg');
      expect(getLocalFileName('file_123', '.pdf')).toBe('file_123.pdf');
    });
  });

  describe('composite document page previews', () => {
    test('extracts the downloadable source file ID', () => {
      const preview = 'a7aa4ee34102db1#file_000000001760720887f972b8d93a0c4f#p_3.dc8710894f.jpg';
      expect(getCompositePreviewSourceId(preview))
        .toBe('file_000000001760720887f972b8d93a0c4f');
      expect(getCompositePreviewSourceId('file_ordinary')).toBeNull();
    });

    test('deduplicates page previews into one source attachment', () => {
      const data = {
        id: 'conv-pages',
        mapping: {
          one: { message: { content: { content_type: 'multimodal_text', parts: [
            { content_type: 'image_asset_pointer', asset_pointer: 'sediment://hash1#file_source#p_1.a.jpg' },
            { content_type: 'image_asset_pointer', asset_pointer: 'sediment://hash2#file_source#p_2.b.jpg' },
          ] } } },
        },
      };

      expect(extractFileReferences(data)).toEqual([
        expect.objectContaining({ fileId: 'file_source', type: 'attachment', compositePreview: true }),
      ]);
    });
  });

  describe('getFileDownloadUrl', () => {
    test('encodes composite asset IDs so hash characters reach the server', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', download_url: 'https://cdn.example.com/file.jpg' }),
      });

      const fileId = 'asset#file_123#p_3.image.jpg';
      await getFileDownloadUrl('secret', fileId, 'conversation/with special');

      const requestedUrl = global.fetch.mock.calls[0][0];
      expect(requestedUrl).toContain('/files/download/asset%23file_123%23p_3.image.jpg');
      expect(requestedUrl).toContain('conversation_id=conversation%2Fwith%20special');
      expect(new URL(requestedUrl).hash).toBe('');
    });

    test('falls back to the conversation attachment resolver after a 404', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ status: 'success', download_url: '/api/library/files/libfile_1/project-content' }),
        });

      const result = await getFileDownloadUrl('secret', 'file_123', 'conv-123');

      expect(result.status).toBe('success');
      expect(global.fetch.mock.calls[1][0])
        .toContain('/conversation/conv-123/attachment/file_123/download');
    });

    test('falls back to the file-service resolver after both conversation routes return 404', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })
        .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ status: 'success', download_url: 'https://cdn.example.com/recovered.pdf' }),
        });

      const result = await getFileDownloadUrl('secret', 'file_123', 'conv-123');

      expect(result.status).toBe('success');
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(global.fetch.mock.calls[2][0])
        .toBe('https://chatgpt.com/backend-api/files/file_123/download');
    });

    test('falls back after structured file_not_found responses from both conversation routes', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ status: 'error', error_code: 'file_not_found' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ status: 'error', error_code: 'file_not_found' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ status: 'success', download_url: 'https://cdn.example.com/recovered.pdf' }),
        });

      const result = await getFileDownloadUrl('secret', 'file_123', 'conv-123');

      expect(result.status).toBe('success');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('downloadFile — credential forwarding', () => {
    let fs, os, path, tmpDir;

    beforeEach(() => {
      fs = require('fs');
      os = require('os');
      path = require('path');
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-security-test-'));
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/octet-stream' },
        arrayBuffer: async () => Buffer.from('test'),
      });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('sends authorization to trusted OpenAI hosts', async () => {
      await downloadFile('https://chatgpt.com/backend-api/file', path.join(tmpDir, 'file'), 'secret');
      expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
    });

    test('does not send authorization to external signed URLs', async () => {
      await downloadFile('https://cdn.example.com/signed-file', path.join(tmpDir, 'file'), 'secret');
      expect(global.fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
    });

    test('resolves root-relative Library URLs and sends authorization', async () => {
      await downloadFile('/api/library/files/libfile_1/project-content', path.join(tmpDir, 'file'), 'secret');
      expect(global.fetch.mock.calls[0][0])
        .toBe('https://chatgpt.com/api/library/files/libfile_1/project-content');
      expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
    });

    test('retries a Library URL without bearer when the signed route rejects it', async () => {
      global.fetch
        .mockResolvedValueOnce({ ok: false, status: 401, headers: { get: () => '' } })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: () => 'image/png' },
          arrayBuffer: async () => Buffer.from('image'),
        });

      await downloadFile('/api/library/files/libfile_1/project-content?sig=signed', path.join(tmpDir, 'file'), 'secret');

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
      expect(global.fetch.mock.calls[1][1].headers.Authorization).toBeUndefined();
    });

    test('uses the browser session cookie only on chatgpt.com Library URLs', async () => {
      const { CONFIG } = require('../../lib/config');
      CONFIG.sessionCookie = '__Secure-authjs.session-token.0=part0; __Secure-authjs.session-token.1=part1';

      await downloadFile('/api/library/files/libfile_1/project-content', path.join(tmpDir, 'file'), 'secret');

      expect(global.fetch.mock.calls[0][1].headers.Cookie).toBe(CONFIG.sessionCookie);
    });

    test('never forwards the browser session cookie to external signed URLs', async () => {
      const { CONFIG } = require('../../lib/config');
      CONFIG.sessionCookie = 'sensitive=session';

      await downloadFile('https://cdn.example.com/signed-file', path.join(tmpDir, 'file'), 'secret');

      expect(global.fetch.mock.calls[0][1].headers.Cookie).toBeUndefined();
    });

    test('rejects non-HTTPS download URLs', async () => {
      await expect(downloadFile('http://chatgpt.com/file', path.join(tmpDir, 'file'), 'secret'))
        .rejects.toThrow('must use HTTPS');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('retryPendingFiles — saved JSON backfill', () => {
    test('keeps permanent failures skipped unless explicitly requested', async () => {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-skip-failure-test-'));

      try {
        const { CONFIG, PATHS, initPaths } = require('../../lib/config');
        CONFIG.outputDir = tmpDir;
        CONFIG.downloadFiles = true;
        CONFIG.downloadImages = true;
        CONFIG.downloadCanvas = true;
        CONFIG.downloadAttachments = true;
        CONFIG.retryFailedFiles = false;
        initPaths();
        fs.mkdirSync(PATHS.jsonDir, { recursive: true });
        fs.writeFileSync(path.join(PATHS.jsonDir, 'conversation.json'), JSON.stringify({
          id: 'conv-known-failure',
          mapping: {
            node1: {
              message: {
                content: { content_type: 'text', parts: ['Document'] },
                metadata: {
                  attachments: [{ id: 'file-known-failure', name: 'missing.pdf', mime_type: 'application/pdf' }],
                },
              },
            },
          },
        }));

        global.fetch = jest.fn();
        const progress = {
          downloadedFileIds: [],
          failedFileIds: { 'file-known-failure': 'file_not_found' },
          fileResolverVersion: 2,
        };

        const downloaded = await retryPendingFiles('secret', progress);

        expect(downloaded).toBe(0);
        expect(progress.failedFileIds['file-known-failure']).toBe('file_not_found');
        expect(progress.fileResolverVersion).toBe(2);
        expect(global.fetch).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test('discovers and downloads metadata attachments without re-fetching the conversation', async () => {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-backfill-test-'));

      try {
        const { CONFIG, PATHS, initPaths } = require('../../lib/config');
        CONFIG.outputDir = tmpDir;
        CONFIG.downloadFiles = true;
        CONFIG.downloadImages = true;
        CONFIG.downloadCanvas = true;
        CONFIG.downloadAttachments = true;
        CONFIG.retryFailedFiles = true;
        initPaths();
        fs.mkdirSync(PATHS.jsonDir, { recursive: true });
        fs.writeFileSync(path.join(PATHS.jsonDir, 'conversation.json'), JSON.stringify({
          id: 'conv-backfill',
          mapping: {
            node1: {
              message: {
                content: { content_type: 'text', parts: ['Document'] },
                metadata: {
                  attachments: [{ id: 'file-backfill', name: 'document.txt', mime_type: 'text/plain' }],
                },
              },
            },
          },
        }));

        global.fetch = jest.fn().mockImplementation((url) => {
          if (url.includes('/files/download/file-backfill')) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                status: 'success',
                download_url: 'https://cdn.example.com/document.txt',
                file_name: 'document.txt',
              }),
            });
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: () => 'text/plain' },
            arrayBuffer: async () => Buffer.from('document body'),
          });
        });

        const progress = {
          downloadedFileIds: [],
          failedFileIds: { 'file-backfill': 'file_not_found' },
          fileResolverVersion: 1,
        };
        const downloaded = await retryPendingFiles('secret', progress);

        expect(downloaded).toBe(1);
        expect(progress.downloadedFileIds).toContain('file-backfill');
        expect(progress.failedFileIds['file-backfill']).toBeUndefined();
        expect(progress.fileResolverVersion).toBe(4);
        expect(fs.existsSync(path.join(PATHS.filesDir, 'file-backfill.txt'))).toBe(true);
        expect(global.fetch.mock.calls.some(([url]) => url.includes('/conversation/conv-backfill'))).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
