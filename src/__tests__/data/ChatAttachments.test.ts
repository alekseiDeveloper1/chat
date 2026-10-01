import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { openAttachment, pickAttachment } from '@/data/files/ChatAttachments';
import { FileAttachment, MAX_ATTACHMENT_BYTES } from '@/domain/entities/Message';

const mockBase64 = jest.fn();
const mockWrite = jest.fn();
const mockCreate = jest.fn();
let mockFileSize = 3;

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache/' },
  File: jest.fn().mockImplementation(() => ({
    exists: true,
    size: mockFileSize,
    base64: mockBase64,
    write: mockWrite,
    uri: 'file:///cache/chat-attachments/shared.txt',
  })),
  Directory: jest.fn().mockImplementation(() => ({ create: mockCreate })),
}));

const attachment: FileAttachment = { name: 'report.txt', mimeType: 'text/plain', size: 3, base64: 'YWJj' };

describe('native file attachments', () => {
  beforeEach(() => {
    mockFileSize = 3;
    mockBase64.mockResolvedValue('YWJj');
    jest.mocked(Sharing.isAvailableAsync).mockResolvedValue(true);
    jest.mocked(Sharing.shareAsync).mockResolvedValue(undefined);
    jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///cache/report.txt', name: attachment.name, mimeType: attachment.mimeType, size: 3, lastModified: 0 }],
    });
  });

  it('treats picker cancellation as a harmless no-op', async () => {
    jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: true, assets: null });
    await expect(pickAttachment()).resolves.toBeNull();
    expect(File).not.toHaveBeenCalled();
  });

  it('reads the selected file and keeps its original metadata', async () => {
    await expect(pickAttachment()).resolves.toEqual(attachment);
    expect(DocumentPicker.getDocumentAsync).toHaveBeenCalledWith(expect.objectContaining({ copyToCacheDirectory: true, base64: false }));
  });

  it('rejects oversized files before reading their contents', async () => {
    mockFileSize = MAX_ATTACHMENT_BYTES + 1;
    await expect(pickAttachment()).rejects.toThrow('5 МБ');
    expect(mockBase64).not.toHaveBeenCalled();
  });

  it('rejects oversized picker metadata before accessing the file', async () => {
    jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///cache/large', name: 'large', size: MAX_ATTACHMENT_BYTES + 1, lastModified: 0 }],
    });
    await expect(pickAttachment()).rejects.toThrow('5 МБ');
    expect(File).not.toHaveBeenCalled();
  });

  it('accepts empty files with an unknown MIME type', async () => {
    mockFileSize = 0;
    mockBase64.mockResolvedValue('');
    jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
      canceled: false, assets: [{ uri: 'file:///cache/empty', name: 'empty', lastModified: 0 }],
    });
    await expect(pickAttachment()).resolves.toEqual({ name: 'empty', mimeType: 'application/octet-stream', size: 0, base64: '' });
  });

  it('writes decoded bytes with the SDK 54 API before opening the share sheet', async () => {
    await openAttachment(attachment);
    expect(mockCreate).toHaveBeenCalledWith({ intermediates: true });
    expect(mockWrite).toHaveBeenCalledWith('YWJj', { encoding: 'base64' });
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/chat-attachments/shared.txt', expect.objectContaining({ mimeType: 'text/plain' }));
  });

  it('reports unavailable sharing without creating cache files', async () => {
    jest.mocked(Sharing.isAvailableAsync).mockResolvedValue(false);
    await expect(openAttachment(attachment)).rejects.toThrow('недоступно');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('rejects unsafe filenames before writing files', async () => {
    await expect(openAttachment({ ...attachment, name: '../secret' })).rejects.toThrow();
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
