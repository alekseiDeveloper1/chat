import { File } from 'expo-file-system';
import { copyAsync, deleteAsync } from 'expo-file-system/legacy';
import { importSharedContent, IncomingSharePayload, MAX_SHARED_FILES } from '@/data/sharing/IncomingShare';
import { MAX_ATTACHMENT_BYTES } from '@/domain/entities/Message';

const mockBase64 = jest.fn();
let mockFileSize: number | null = 3;
let mockFileExists = true;
let mockFileType = '';

jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  File: jest.fn().mockImplementation((...parts: string[]) => ({
    uri: parts.join('/'),
    exists: mockFileExists,
    size: mockFileSize,
    type: mockFileType,
    base64: mockBase64,
  })),
}));

jest.mock('expo-file-system/legacy', () => ({
  copyAsync: jest.fn(),
  deleteAsync: jest.fn(),
}));

const sharedFile = {
  path: 'file:///cache/report.txt',
  fileName: 'report.txt',
  mimeType: 'text/plain',
  size: 3,
};
const emptyPayload: IncomingSharePayload = { text: null, webUrl: null, files: null };

describe('incoming shared content', () => {
  beforeEach(() => {
    mockFileSize = 3;
    mockFileExists = true;
    mockFileType = '';
    mockBase64.mockReset().mockResolvedValue('YWJj');
    (copyAsync as jest.Mock).mockReset().mockResolvedValue(undefined);
    (deleteAsync as jest.Mock).mockReset().mockResolvedValue(undefined);
  });

  it('imports plain text without accessing files', async () => {
    const result = await importSharedContent({ ...emptyPayload, text: '  Сообщение\nиз другого приложения  ' });
    expect(result).toEqual({ drafts: [{ id: expect.any(String), text: 'Сообщение\nиз другого приложения' }], errors: [] });
    expect(File).not.toHaveBeenCalled();
  });

  it('combines text and a separate link and adds a page title to a bare URL', async () => {
    const result = await importSharedContent({ ...emptyPayload, text: 'Посмотри', webUrl: 'https://example.com/article' });
    expect(result.drafts[0].text).toBe('Посмотри\nhttps://example.com/article');
    const titled = await importSharedContent({ ...emptyPayload, webUrl: 'https://example.com/article', meta: { title: 'Статья' } });
    expect(titled.drafts[0].text).toBe('Статья\nhttps://example.com/article');
  });

  it.each([
    ['https://example.com', 'https://example.com'],
    ['Посмотри https://example.com/.', 'https://example.com'],
    ['Текст (https://example.com/article)', 'https://example.com/article'],
  ])('does not duplicate a link already in the text: %s', async (text, webUrl) => {
    const result = await importSharedContent({ ...emptyPayload, text, webUrl });
    expect(result.drafts[0].text).toBe(text);
  });

  it('keeps a separate URL when it is only a prefix of a link in the text', async () => {
    const result = await importSharedContent({ ...emptyPayload, text: 'https://example.com/article', webUrl: 'https://example.com' });
    expect(result.drafts[0].text).toBe('https://example.com/article\nhttps://example.com');
  });

  it('creates ordered drafts with one file each and a caption only on the first', async () => {
    const result = await importSharedContent({
      ...emptyPayload,
      text: 'Два файла',
      files: [sharedFile, { ...sharedFile, path: 'content://provider/documents/2', fileName: 'second.txt' }],
    });
    expect(result.errors).toEqual([]);
    expect(result.drafts).toEqual([
      { id: expect.any(String), text: 'Два файла', attachment: { name: 'report.txt', mimeType: 'text/plain', size: 3, base64: 'YWJj' } },
      { id: expect.any(String), text: '', attachment: { name: 'second.txt', mimeType: 'text/plain', size: 3, base64: 'YWJj' } },
    ]);
    expect(new Set(result.drafts.map((draft) => draft.id)).size).toBe(2);
    expect(copyAsync).toHaveBeenCalledWith({
      from: 'content://provider/documents/2',
      to: expect.stringMatching(/^file:\/\/\/cache\/incoming-share-\d+-\d+\.txt$/),
    });
    expect(File).not.toHaveBeenCalledWith('content://provider/documents/2');
    expect(deleteAsync).toHaveBeenCalledWith((copyAsync as jest.Mock).mock.calls[0][0].to, { idempotent: true });
  });

  it('supports raw iOS paths and normalizes unsafe names and parameterized MIME types', async () => {
    const result = await importSharedContent({
      ...emptyPayload,
      files: [{ ...sharedFile, path: '/private/shared/my file.txt', fileName: '../folder/unsafe\u0000.txt', mimeType: 'TEXT/PLAIN; charset=utf-8' }],
    });
    expect(File).toHaveBeenCalledWith('file:///private/shared/my%20file.txt');
    expect(result.drafts[0].attachment).toMatchObject({ name: 'unsafe_.txt', mimeType: 'text/plain' });
    expect(copyAsync).not.toHaveBeenCalled();
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('encodes Unicode and URI delimiters in raw absolute filenames', async () => {
    const result = await importSharedContent({
      ...emptyPayload,
      files: [{ ...sharedFile, path: '/private/Общие файлы/фото#1?50%.txt' }],
    });
    expect(File).toHaveBeenCalledWith('file:///private/%D0%9E%D0%B1%D1%89%D0%B8%D0%B5%20%D1%84%D0%B0%D0%B9%D0%BB%D1%8B/%D1%84%D0%BE%D1%82%D0%BE%231%3F50%25.txt');
    expect(result.errors).toEqual([]);
  });

  it('preserves existing percent escapes in file URIs', async () => {
    const path = 'file:///private/shared/%D1%84%D0%BE%D1%82%D0%BE%20%231%3F50%25.txt';
    const result = await importSharedContent({ ...emptyPayload, files: [{ ...sharedFile, path }] });
    expect(File).toHaveBeenCalledWith(path);
    expect(result.errors).toEqual([]);
    expect(copyAsync).not.toHaveBeenCalled();
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('uses distinct temporary files for concurrent shares with the same name', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(123456789);
    try {
      const results = await Promise.all([
        importSharedContent({ ...emptyPayload, files: [{ ...sharedFile, path: 'content://provider/first' }] }),
        importSharedContent({ ...emptyPayload, files: [{ ...sharedFile, path: 'content://provider/second' }] }),
      ]);
      expect(results.every((result) => result.errors.length === 0)).toBe(true);
      const copies = (copyAsync as jest.Mock).mock.calls.map(([options]) => options);
      expect(new Set(copies.map(({ to }) => to)).size).toBe(2);
      for (const { from, to } of copies) {
        expect(to).toMatch(/^file:\/\/\/cache\/incoming-share-123456789-\d+\.txt$/);
        expect(deleteAsync).toHaveBeenCalledWith(to, { idempotent: true });
        expect(deleteAsync).not.toHaveBeenCalledWith(from, expect.anything());
      }
    } finally {
      now.mockRestore();
    }
  });

  it('rejects oversized provider metadata before creating or copying a temporary file', async () => {
    const result = await importSharedContent({
      ...emptyPayload,
      files: [{ ...sharedFile, path: 'content://provider/large', size: MAX_ATTACHMENT_BYTES + 1 }],
    });
    expect(result.drafts).toEqual([]);
    expect(result.errors[0]).toContain('5 МБ');
    expect(File).not.toHaveBeenCalled();
    expect(copyAsync).not.toHaveBeenCalled();
    expect(deleteAsync).not.toHaveBeenCalled();
    expect(mockBase64).not.toHaveBeenCalled();
  });

  it('checks the copied file size before loading bytes and removes an oversized copy', async () => {
    mockFileSize = MAX_ATTACHMENT_BYTES + 1;
    const result = await importSharedContent({ ...emptyPayload, files: [{ ...sharedFile, path: 'content://provider/large', size: null }] });
    expect(result.drafts).toEqual([]);
    expect(result.errors[0]).toContain('5 МБ');
    expect(copyAsync).toHaveBeenCalledTimes(1);
    expect(mockBase64).not.toHaveBeenCalled();
    expect(deleteAsync).toHaveBeenCalledWith((copyAsync as jest.Mock).mock.calls[0][0].to, { idempotent: true });
  });

  it('checks that a copied file exists before trying to read it', async () => {
    mockFileExists = false;
    const result = await importSharedContent({ ...emptyPayload, files: [{ ...sharedFile, path: 'content://provider/missing' }] });
    expect(result.errors[0]).toContain('больше недоступен');
    expect(mockBase64).not.toHaveBeenCalled();
    expect(deleteAsync).toHaveBeenCalledWith((copyAsync as jest.Mock).mock.calls[0][0].to, { idempotent: true });
  });

  it('cleans up a partial copy when the content provider fails', async () => {
    (copyAsync as jest.Mock).mockRejectedValueOnce(new Error('provider access revoked'));
    const path = 'content://provider/revoked';
    const result = await importSharedContent({ ...emptyPayload, text: 'Подпись', files: [{ ...sharedFile, path }] });
    expect(result.drafts).toEqual([{ id: expect.any(String), text: 'Подпись' }]);
    expect(result.errors).toEqual(['Файл 1: Не удалось прочитать файл. Поделитесь им повторно.']);
    expect(mockBase64).not.toHaveBeenCalled();
    expect(deleteAsync).toHaveBeenCalledTimes(1);
    expect(deleteAsync).toHaveBeenCalledWith((copyAsync as jest.Mock).mock.calls[0][0].to, { idempotent: true });
    expect(deleteAsync).not.toHaveBeenCalledWith(path, expect.anything());
  });

  it('removes its temporary copy when reading fails', async () => {
    mockBase64.mockRejectedValueOnce(new Error('read failure'));
    const result = await importSharedContent({ ...emptyPayload, files: [{ ...sharedFile, path: 'content://provider/unreadable' }] });
    expect(result.drafts).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(deleteAsync).toHaveBeenCalledWith((copyAsync as jest.Mock).mock.calls[0][0].to, { idempotent: true });
  });

  it('keeps a successfully imported attachment if temporary file cleanup fails', async () => {
    (deleteAsync as jest.Mock).mockRejectedValueOnce(new Error('cleanup failure'));
    const result = await importSharedContent({ ...emptyPayload, files: [{ ...sharedFile, path: 'content://provider/readable' }] });
    expect(result.drafts[0].attachment).toMatchObject({ size: 3, base64: 'YWJj' });
    expect(result.errors).toEqual([]);
  });

  it('uses native MIME metadata when the source provides a wildcard', async () => {
    mockFileType = 'image/png';
    const result = await importSharedContent({ ...emptyPayload, files: [{ ...sharedFile, mimeType: '*/*' }] });
    expect(result.drafts[0].attachment?.mimeType).toBe('image/png');
  });

  it('provides a fallback for missing or invalid filename and MIME metadata', async () => {
    const result = await importSharedContent({ ...emptyPayload, files: [{ ...sharedFile, fileName: '..', mimeType: 'invalid' }] });
    expect(result.drafts[0].attachment).toMatchObject({ name: 'shared-file', mimeType: 'application/octet-stream' });
  });

  it('rejects oversized source metadata before opening the file', async () => {
    const result = await importSharedContent({ ...emptyPayload, files: [{ ...sharedFile, size: MAX_ATTACHMENT_BYTES + 1 }] });
    expect(result.drafts).toEqual([]);
    expect(result.errors[0]).toContain('5 МБ');
    expect(File).not.toHaveBeenCalled();
    expect(mockBase64).not.toHaveBeenCalled();
  });

  it('checks the real file size before loading base64', async () => {
    mockFileSize = MAX_ATTACHMENT_BYTES + 1;
    const result = await importSharedContent({ ...emptyPayload, files: [sharedFile] });
    expect(result.drafts).toEqual([]);
    expect(result.errors[0]).toContain('5 МБ');
    expect(mockBase64).not.toHaveBeenCalled();
  });

  it('checks loaded bytes even when a content provider reports an incorrect size', async () => {
    mockBase64.mockResolvedValue('AAAA'.repeat(Math.ceil((MAX_ATTACHMENT_BYTES + 1) / 3)));
    const result = await importSharedContent({ ...emptyPayload, files: [sharedFile] });
    expect(result.drafts).toEqual([]);
    expect(result.errors[0]).toContain('5 МБ');
  });

  it('imports files whose provider does not report a size', async () => {
    mockFileSize = null;
    const result = await importSharedContent({ ...emptyPayload, files: [{ ...sharedFile, size: null }] });
    expect(result.drafts[0].attachment?.size).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it('imports empty files', async () => {
    mockFileSize = 0;
    mockBase64.mockResolvedValue('');
    const result = await importSharedContent({ ...emptyPayload, files: [{ ...sharedFile, size: 0 }] });
    expect(result.drafts[0].attachment).toMatchObject({ size: 0, base64: '' });
  });

  it('preserves later readable files and the caption when a file fails', async () => {
    mockBase64.mockRejectedValueOnce(new Error('secret native path /data/private'));
    const result = await importSharedContent({ ...emptyPayload, text: 'Подпись', files: [sharedFile, sharedFile] });
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({ text: 'Подпись', attachment: { name: 'report.txt' } });
    expect(result.errors).toEqual(['Файл 1: Не удалось прочитать файл. Поделитесь им повторно.']);
  });

  it('keeps the shared text when every file is unreadable', async () => {
    mockFileExists = false;
    const result = await importSharedContent({ ...emptyPayload, text: 'Подпись', files: [sharedFile] });
    expect(result.drafts).toEqual([{ id: expect.any(String), text: 'Подпись' }]);
    expect(result.errors[0]).toContain('больше недоступен');
    expect(mockBase64).not.toHaveBeenCalled();
  });

  it.each(['https://example.com/file', 'data:image/png;base64,YWJj', 'relative/file.txt', 'file://remote/path'])('rejects unsupported file paths: %s', async (path) => {
    const result = await importSharedContent({ ...emptyPayload, files: [{ ...sharedFile, path }] });
    expect(result.drafts).toEqual([]);
    expect(result.errors[0]).toContain('не поддерживается');
    expect(File).not.toHaveBeenCalled();
  });

  it('rejects corrupt native file contents without exposing the underlying exception', async () => {
    mockBase64.mockResolvedValue('invalid!');
    const result = await importSharedContent({ ...emptyPayload, files: [sharedFile] });
    expect(result.drafts).toEqual([]);
    expect(result.errors).toEqual(['Файл 1: Не удалось прочитать файл. Поделитесь им повторно.']);
  });

  it('reports excess files and imports at most the configured limit', async () => {
    const result = await importSharedContent({ ...emptyPayload, files: Array(MAX_SHARED_FILES + 1).fill(sharedFile) });
    expect(result.drafts).toHaveLength(MAX_SHARED_FILES);
    expect(mockBase64).toHaveBeenCalledTimes(MAX_SHARED_FILES);
    expect(result.errors).toEqual([`За один раз можно переслать до ${MAX_SHARED_FILES} файлов. Остальные не добавлены.`]);
  });

  it('explains when a source sends no supported content', async () => {
    const result = await importSharedContent(emptyPayload);
    expect(result.drafts).toEqual([]);
    expect(result.errors).toEqual(['Приложение-источник не передало текст, ссылку или доступный файл.']);
  });
});
