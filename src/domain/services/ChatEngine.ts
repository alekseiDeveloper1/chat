import { ICryptoService } from './ICryptoService';
import { IMessageRepository } from './IMessageRepository';
import { INetworkService, ConnectionStatus, DisconnectOptions } from './INetworkService';
import { Message } from '../entities/Message';
import { appLogger } from '@/shared/logging/AppLogger';

export class ChatEngine {
  private currentRoomKey: string | null = null;
  private currentRoomId: string | null = null;
  private myId: string = 'me';

  constructor(
    private cryptoService: ICryptoService,
    private messageRepository: IMessageRepository,
    private networkService: INetworkService
  ) {}

  async joinRoom(roomName: string, password: string, onNewMessage: () => void, onStatusChange: (status: ConnectionStatus) => void): Promise<void> {
    appLogger.info('chat', 'Вход в комнату начат', {
      context: { roomNameLength: roomName.length },
      visibleToUser: true,
    });

    await this.messageRepository.initialize();
    this.currentRoomId = await this.cryptoService.generateRoomKey(roomName);
    this.currentRoomKey = await this.cryptoService.generateRoomKey(password);
    appLogger.debug('chat', 'Локальные ключи комнаты подготовлены', {
      context: { roomFingerprint: this.getRoomFingerprint() },
    });

    this.networkService.onStatusChanged(onStatusChange);

    this.networkService.onDataReceived(async (rawPayload) => {
      if (!this.currentRoomKey || !this.currentRoomId) return;

      try {
        appLogger.debug('chat', 'Получен входящий P2P пакет', {
          context: { roomFingerprint: this.getRoomFingerprint() },
        });

        const packet = JSON.parse(rawPayload);

        const decryptedText = this.cryptoService.decrypt(packet.encryptedText, this.currentRoomKey);

        if (decryptedText) {
          const incomingMessage: Message = {
            id: packet.id,
            roomId: this.currentRoomId,
            text: decryptedText,
            senderId: 'peer',
            timestamp: packet.timestamp,
          };

          await this.messageRepository.saveMessage(incomingMessage);
          onNewMessage();
        }
      } catch (e) {
        appLogger.error('chat', 'Ошибка обработки входящего P2P пакета', {
          error: e,
          visibleToUser: true,
        });
      }
    });

    await this.networkService.connect(this.currentRoomId);
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.currentRoomKey || !this.currentRoomId) throw new Error('Вы не вошли в комнату');

    const messageId = Math.random().toString(36).substring(7);
    const timestamp = Date.now();

    const encryptedText = this.cryptoService.encrypt(text, this.currentRoomKey);

    const networkPacket = {
      id: messageId,
      encryptedText,
      timestamp,
    };

    await this.networkService.sendData(JSON.stringify(networkPacket));
    appLogger.debug('chat', 'Исходящий P2P пакет отправлен', {
      context: { roomFingerprint: this.getRoomFingerprint() },
    });

    const localMessage: Message = {
      id: messageId,
      roomId: this.currentRoomId,
      text: text,
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
    this.networkService.disconnect(options);
    this.currentRoomKey = null;
    this.currentRoomId = null;
  }

  async getHistory(): Promise<Message[]> {
    if (!this.currentRoomId) return [];
    return this.messageRepository.getMessagesByRoom(this.currentRoomId);
  }

  private getRoomFingerprint(): string | null {
    return this.currentRoomId ? this.currentRoomId.slice(0, 8) : null;
  }
}
