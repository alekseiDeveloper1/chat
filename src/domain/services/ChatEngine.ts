import { ICryptoService } from './ICryptoService';
import { IMessageRepository } from './IMessageRepository';
import { INetworkService, ConnectionStatus, DisconnectOptions } from './INetworkService';
import { FileAttachment, Message, validateFileAttachment } from '../entities/Message';
import { appLogger } from '@/shared/logging/AppLogger';

// A 5 MiB file is base64 encoded, encrypted, then base64 encoded again.
const MAX_PACKET_CHARACTERS = 12 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class ChatEngine {
  private currentRoomKey: string | null = null;
  private currentRoomId: string | null = null;
  private session = 0;
  private myId: string = 'me';

  constructor(
    private cryptoService: ICryptoService,
    private messageRepository: IMessageRepository,
    private networkService: INetworkService
  ) {}

  async joinRoom(roomName: string, password: string, onNewMessage: () => void, onStatusChange: (status: ConnectionStatus) => void): Promise<void> {
    const session = ++this.session;
    this.currentRoomId = null;
    this.currentRoomKey = null;
    appLogger.info('chat', 'Вход в комнату начат', {
      context: { roomNameLength: roomName.length },
      visibleToUser: true,
    });

    await this.messageRepository.initialize();
    const [roomId, roomKey] = await Promise.all([
      this.cryptoService.generateRoomKey(roomName),
      this.cryptoService.generateRoomKey(password),
    ]);
    if (session !== this.session) return;

    this.currentRoomId = roomId;
    this.currentRoomKey = roomKey;
    appLogger.debug('chat', 'Локальные ключи комнаты подготовлены', {
      context: { roomFingerprint: this.getRoomFingerprint() },
    });

    this.networkService.onStatusChanged((status) => {
      if (session === this.session) onStatusChange(status);
    });

    this.networkService.onDataReceived(async (rawPayload) => {
      if (session !== this.session) return;

      try {
        if (rawPayload.length > MAX_PACKET_CHARACTERS) {
          throw new Error('Пакет превышает допустимый размер');
        }
        const packet: unknown = JSON.parse(rawPayload);
        if (
          !isRecord(packet) ||
          typeof packet.id !== 'string' || !packet.id || packet.id.length > 128 ||
          typeof packet.timestamp !== 'number' || !Number.isSafeInteger(packet.timestamp) ||
          packet.timestamp < 0
        ) {
          throw new Error('Некорректный пакет сообщения');
        }

        let text: string;
        let attachment: FileAttachment | undefined;
        if (packet.version === 2 && packet.contentType === 'attachment') {
          if (typeof packet.encryptedContent !== 'string') {
            throw new Error('Нет зашифрованного содержимого');
          }
          const decrypted = this.cryptoService.decrypt(packet.encryptedContent, roomKey);
          if (!decrypted) return;
          const content: unknown = JSON.parse(decrypted);
          if (!isRecord(content) || typeof content.text !== 'string') {
            throw new Error('Некорректное содержимое сообщения');
          }
          validateFileAttachment(content.attachment);
          text = content.text;
          attachment = content.attachment;
        } else if (
          packet.version === undefined && packet.contentType === undefined &&
          typeof packet.encryptedText === 'string'
        ) {
          // Legacy text is always text, including strings that look like JSON.
          const decrypted = this.cryptoService.decrypt(packet.encryptedText, roomKey);
          if (!decrypted) return;
          text = decrypted;
        } else {
          throw new Error('Неизвестный формат сообщения');
        }

        const incomingMessage: Message = {
          id: packet.id,
          roomId,
          text,
          ...(attachment ? { attachment } : {}),
          senderId: 'peer',
          timestamp: packet.timestamp,
        };

        await this.messageRepository.saveMessage(incomingMessage);
        if (session === this.session) onNewMessage();
        appLogger.debug('chat', 'Входящее сообщение сохранено', {
          context: { hasAttachment: Boolean(attachment), attachmentBytes: attachment?.size },
        });
      } catch {
        appLogger.error('chat', 'Не удалось обработать входящее сообщение', {
          visibleToUser: true,
        });
      }
    });

    await this.networkService.connect(roomId);
  }

  async sendMessage(text: string, attachment?: FileAttachment): Promise<void> {
    const roomKey = this.currentRoomKey;
    const roomId = this.currentRoomId;
    if (!roomKey || !roomId) throw new Error('Вы не вошли в комнату');
    if (attachment) validateFileAttachment(attachment);
    if (!text.trim() && !attachment) throw new Error('Сообщение не может быть пустым');

    const file = attachment ? { ...attachment } : undefined;
    const messageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const timestamp = Date.now();
    const networkPacket = file
      ? {
          id: messageId,
          version: 2,
          contentType: 'attachment',
          encryptedContent: this.cryptoService.encrypt(JSON.stringify({ text, attachment: file }), roomKey),
          timestamp,
        }
      : {
          id: messageId,
          encryptedText: this.cryptoService.encrypt(text, roomKey),
          timestamp,
        };

    const payload = JSON.stringify(networkPacket);
    if (payload.length > MAX_PACKET_CHARACTERS) throw new Error('Сообщение слишком большое');
    await this.networkService.sendData(payload);
    appLogger.debug('chat', 'Исходящий P2P пакет отправлен', {
      context: { roomFingerprint: roomId.slice(0, 8), hasAttachment: Boolean(file), attachmentBytes: file?.size },
    });

    const localMessage: Message = {
      id: messageId,
      roomId,
      text,
      ...(file ? { attachment: file } : {}),
      senderId: this.myId,
      timestamp,
    };

    await this.messageRepository.saveMessage(localMessage);
  }

  disconnect(options: DisconnectOptions = {}): void {
    appLogger.info('chat', 'Комната закрывается', {
      context: {
        reason: options.reason ?? 'manual',
        roomFingerprint: this.getRoomFingerprint(),
      },
      visibleToUser: options.reason !== 'screen_unmount',
    });
    this.session++;
    this.currentRoomKey = null;
    this.currentRoomId = null;
    this.networkService.disconnect(options);
  }

  async getHistory(): Promise<Message[]> {
    if (!this.currentRoomId) return [];
    const session = this.session;
    const history = await this.messageRepository.getMessagesByRoom(this.currentRoomId);
    return session === this.session ? history : [];
  }

  private getRoomFingerprint(): string | null {
    return this.currentRoomId ? this.currentRoomId.slice(0, 8) : null;
  }
}
