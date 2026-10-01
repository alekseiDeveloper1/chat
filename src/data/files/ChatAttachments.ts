import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { FileAttachment, MAX_ATTACHMENT_BYTES, validateFileAttachment } from '@/domain/entities/Message';

export class AttachmentError extends Error {}

function checkSize(size: number): void {
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError('Файл слишком большой. Максимальный размер — 5 МБ.');
  }
}

function readWebFile(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reader.onabort = () => reject(new AttachmentError('Не удалось прочитать файл.'));
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.includes(',')) {
        reject(new AttachmentError('Не удалось прочитать файл.'));
        return;
      }
      resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

export async function pickAttachment(): Promise<FileAttachment | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    multiple: false,
    copyToCacheDirectory: true,
    base64: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;

  try {
    if (asset.size !== undefined) checkSize(asset.size);
    let base64: string;
    let size: number;
    if (Platform.OS === 'web') {
      if (!asset.file) throw new AttachmentError('Не удалось прочитать файл.');
      size = asset.file.size;
      checkSize(size);
      base64 = await readWebFile(asset.file);
    } else {
      const file = new File(asset.uri);
      if (!file.exists) throw new AttachmentError('Файл больше недоступен. Выберите его повторно.');
      size = file.size;
      checkSize(size);
      base64 = await file.base64();
    }

    const attachment: FileAttachment = {
      name: asset.name,
      mimeType: asset.mimeType || 'application/octet-stream',
      size,
      base64,
    };
    validateFileAttachment(attachment);
    return attachment;
  } finally {
    if (Platform.OS === 'web' && asset.uri.startsWith('blob:')) {
      URL.revokeObjectURL(asset.uri);
    }
  }
}

export async function openAttachment(attachment: FileAttachment): Promise<void> {
  validateFileAttachment(attachment);
  if (Platform.OS === 'web') {
    const binary = atob(attachment.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes], { type: attachment.mimeType }));
    const link = document.createElement('a');
    link.href = url;
    link.download = attachment.name;
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return;
  }

  if (!(await Sharing.isAvailableAsync())) {
    throw new AttachmentError('На этом устройстве недоступно сохранение файлов через меню «Поделиться».');
  }
  const directory = new Directory(Paths.cache, 'chat-attachments', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  directory.create({ intermediates: true });
  const safeName = attachment.name.replace(/[<>:"/\\|?*%]/g, '_');
  const file = new File(directory, safeName);
  file.write(attachment.base64, { encoding: 'base64' });
  await Sharing.shareAsync(file.uri, { mimeType: attachment.mimeType, dialogTitle: 'Сохранить или открыть файл' });
}
