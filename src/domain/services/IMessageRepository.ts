import { Message } from '../entities/Message';

export interface IMessageRepository {
  initialize(): Promise<void>;

  saveMessage(message: Message): Promise<void>;

  getMessagesByRoom(roomId: string): Promise<Message[]>;

  clearRoomHistory(roomId: string): Promise<void>;
}
