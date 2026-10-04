import { File, Paths } from 'expo-file-system';
import { copyAsync, deleteAsync } from 'expo-file-system/legacy';
import { FileAttachment, MAX_ATTACHMENT_BYTES, validateFileAttachment } from '@/domain/entities/Message';
import { splitMessageLinks } from '@/shared/links/messageLinks';

export const MAX_SHARED_FILES = 10;

export interface IncomingSharePayload {
  text?: string | null;
  webUrl: string | null;
  files: {
    path: string;
    fileName: string;
    mimeType: string;
    size: number | null;
  }[] | null;
  meta?: { title?: string | null } | null;
}

export interface SharedDraft {
  id: string;
  text: string;
  attachment?: FileAttachment;
}

class IncomingShareError extends Error {}

let draftSequence = 0;
let temporaryFileSequence = 0;

function createDraft(text: string, attachment?: FileAttachment): SharedDraft {
  draftSequence += 1;
  return { id: `share-${Date.now()}-${draftSequence}`, text, ...(attachment ? { attachment } : {}) };
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeUrl(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return value;
  }
}

function sharedText(payload: IncomingSharePayload): string {
  const text = cleanText(payload.text);
  const webUrl = cleanText(payload.webUrl);
  const title = cleanText(payload.meta?.title);
  const alreadyIncludesUrl = text === webUrl || splitMessageLinks(text).some(
    (part) => part.url && normalizeUrl(part.url) === normalizeUrl(webUrl),
  );
  const parts = [text];
  if (webUrl && !alreadyIncludesUrl) parts.push(webUrl);
  // A page title adds context when the source only supplied a URL.
  if (title && webUrl && title !== webUrl && (!text || normalizeUrl(text) === normalizeUrl(webUrl))) {
    parts.unshift(title);
  }
  return parts.filter(Boolean).join('\n');
}

function localUri(path: string): string {
  if (typeof path !== 'string' || !path || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new IncomingShareError('Приложение-источник не предоставило доступный файл.');
  }
  if (path.startsWith('/') && !path.startsWith('//')) {
    return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  if (/^file:\/\/\/[^/]/i.test(path) || /^content:\/\/[^/]+\/.+/i.test(path)) return path;
  throw new IncomingShareError('Этот источник файла не поддерживается. Поделитесь файлом из памяти устройства.');
}

function safeFileName(value: unknown): string {
  const name = cleanText(value).split(/[\\/]/).pop()!
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '_')
    .trim().slice(0, 255);
  return name && name !== '.' && name !== '..' ? name : 'shared-file';
}

function safeMimeType(value: unknown): string | null {
  const mimeType = cleanText(value).split(';')[0].trim().toLowerCase();
  return mimeType.length <= 255 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)
    ? mimeType : null;
}

function checkSize(size: number | null): void {
  if (typeof size === 'number' && size > MAX_ATTACHMENT_BYTES) {
    throw new IncomingShareError('Размер файла превышает 5 МБ.');
  }
}

async function readAttachment(sharedFile: NonNullable<IncomingSharePayload['files']>[number]): Promise<FileAttachment> {
  checkSize(sharedFile.size);
  const sourceUri = localUri(sharedFile.path);
  const isContentUri = /^content:\/\//i.test(sourceUri);
  // SDK 54's File API treats content:// as a SAF tree, which excludes common
  // FileProvider shares. The legacy copy API supports these read-only sources.
  const extension = safeFileName(sharedFile.fileName).match(/\.[a-z0-9]{1,16}$/i)?.[0] ?? '';
  const file = isContentUri
    ? new File(Paths.cache, `incoming-share-${Date.now()}-${++temporaryFileSequence}${extension}`)
    : new File(sourceUri);

  try {
    if (isContentUri) await copyAsync({ from: sourceUri, to: file.uri });
    if (!file.exists) throw new IncomingShareError('Файл больше недоступен. Поделитесь им повторно.');
    checkSize(file.size);
    const base64 = await file.base64();
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    // Some Android content providers omit the size; the actual bytes are authoritative.
    const size = (base64.length / 4) * 3 - padding;
    checkSize(size);
    const attachment: FileAttachment = {
      name: safeFileName(sharedFile.fileName),
      mimeType: safeMimeType(sharedFile.mimeType) || safeMimeType(file.type) || 'application/octet-stream',
      size,
      base64,
    };
    validateFileAttachment(attachment);
    return attachment;
  } finally {
    if (isContentUri) {
      // Remove even a partial copy, and never delete the externally supplied source.
      // Cache eviction can clean up if deletion fails; retain the import result.
      await deleteAsync(file.uri, { idempotent: true }).catch(() => undefined);
    }
  }
}

export async function importSharedContent(payload: IncomingSharePayload): Promise<{ drafts: SharedDraft[]; errors: string[] }> {
  const drafts: SharedDraft[] = [];
  const errors: string[] = [];
  const text = sharedText(payload);
  const files = Array.isArray(payload.files) ? payload.files : [];

  if (files.length > MAX_SHARED_FILES) {
    errors.push(`За один раз можно переслать до ${MAX_SHARED_FILES} файлов. Остальные не добавлены.`);
  }

  for (const [index, sharedFile] of files.slice(0, MAX_SHARED_FILES).entries()) {
    try {
      const attachment = await readAttachment(sharedFile);
      drafts.push(createDraft(drafts.length === 0 ? text : '', attachment));
    } catch (error) {
      const reason = error instanceof IncomingShareError
        ? error.message : 'Не удалось прочитать файл. Поделитесь им повторно.';
      errors.push(`Файл ${index + 1}: ${reason}`);
    }
  }

  if (text && drafts.length === 0) drafts.push(createDraft(text));
  if (drafts.length === 0 && errors.length === 0) {
    errors.push('Приложение-источник не передало текст, ссылку или доступный файл.');
  }
  return { drafts, errors };
}
