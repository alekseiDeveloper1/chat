import { ICryptoService } from './ICryptoService';
import { IMessageRepository } from './IMessageRepository';
import { INetworkService, ConnectionStatus } from './INetworkService';
import { Message } from '../entities/Message';

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
    await this.messageRepository.initialize();

    this.currentRoomId = await this.cryptoService.generateRoomKey(roomName);
    this.currentRoomKey = await this.cryptoService.generateRoomKey(password);

    this.networkService.onStatusChanged(onStatusChange);

    this.networkService.onDataReceived(async (rawPayload) => {
      if (!this.currentRoomKey || !this.currentRoomId) return;

      try {
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
        console.error('Ошибка обработки входящего P2P пакета:', e);
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

    const localMessage: Message = {
      id: messageId,
      roomId: this.currentRoomId,
      text: text,
      senderId: this.myId,
      timestamp,
    };

    await this.messageRepository.saveMessage(localMessage);
  }

  async getHistory(): Promise<Message[]> {
    if (!this.currentRoomId) return [];
    return this.messageRepository.getMessagesByRoom(this.currentRoomId);
  }
}
