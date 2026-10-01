export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface FileAttachment {
  name: string;
  mimeType: string;
  size: number;
  base64: string;
}

export function validateFileAttachment(value: unknown): asserts value is FileAttachment {
  if (!value || typeof value !== 'object') {
    throw new Error('Некорректное вложение');
  }

  const attachment = value as Record<string, unknown>;
  if (
    typeof attachment.name !== 'string' ||
    !attachment.name.trim() ||
    attachment.name === '.' || attachment.name === '..' ||
    attachment.name.length > 255 ||
    /[\\/\u0000-\u001f\u007f]/.test(attachment.name) ||
    typeof attachment.mimeType !== 'string' ||
    attachment.mimeType.length > 255 ||
    !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(attachment.mimeType)
  ) {
    throw new Error('Некорректные сведения о файле');
  }

  if (
    typeof attachment.size !== 'number' ||
    !Number.isSafeInteger(attachment.size) ||
    attachment.size < 0 ||
    attachment.size > MAX_ATTACHMENT_BYTES
  ) {
    throw new Error('Размер файла не должен превышать 5 МБ');
  }

  const encoded = attachment.base64;
  if (
    typeof encoded !== 'string' ||
    encoded.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new Error('Некорректные данные файла');
  }

  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  if (
    (padding === 2 && !/[AQgw]==$/.test(encoded)) ||
    (padding === 1 && !/[AEIMQUYcgkosw048]=$/.test(encoded))
  ) {
    throw new Error('Некорректное заполнение данных файла');
  }
  const decodedSize = (encoded.length / 4) * 3 - padding;
  if (decodedSize !== attachment.size) {
    throw new Error('Размер файла не соответствует его содержимому');
  }
}

export interface Message {
  id: string;
  roomId: string;
  text: string;
  attachment?: FileAttachment;
  senderId: string;
  timestamp: number;
}
