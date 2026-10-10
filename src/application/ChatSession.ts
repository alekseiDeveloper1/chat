import { Platform } from 'react-native';
import { ChatEngine } from '@/domain/services/ChatEngine';
import { AESCryptoService } from '@/data/crypto/AESCryptoService';
import { SQLiteMessageRepository } from '@/data/database/SQLiteMessageRepository';
import { WebRTCNetworkService } from '@/data/network/WebRTCNetworkService';
import { ChatNotifications } from '@/data/notifications/ChatNotifications';
import { ChatBackgroundService } from '@/data/notifications/ChatBackgroundService';
import { FileAttachment, Message } from '@/domain/entities/Message';
import { ConnectionStatus } from '@/domain/services/INetworkService';
import { appLogger } from '@/shared/logging/AppLogger';

interface ChatSessionState {
  messages: Message[];
  connectionStatus: ConnectionStatus;
  inRoom: boolean;
  isJoining: boolean;
  isSending: boolean;
}

export class ChatSession {
  private state: ChatSessionState = {
    messages: [],
    connectionStatus: 'disconnected',
    inRoom: false,
    isJoining: false,
    isSending: false,
  };
  private listeners = new Set<() => void>();
  private roomVersion = 0;
  private historyRequest = 0;

  constructor(
    private readonly engine = new ChatEngine(
      new AESCryptoService(),
      new SQLiteMessageRepository(),
      new WebRTCNetworkService(),
    ),
    private readonly notifications = new ChatNotifications(),
    private readonly backgroundService = new ChatBackgroundService(),
  ) {}

  getSnapshot = (): ChatSessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(patch: Partial<ChatSessionState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private stopBackgroundService(): void {
    this.backgroundService.stop().catch(() => {
      appLogger.error('notifications', 'Не удалось остановить фоновую службу чата', { visibleToUser: true });
    });
  }

  private async refreshMessages(roomVersion: number): Promise<void> {
    const request = ++this.historyRequest;
    const history = await this.engine.getHistory();
    if (roomVersion === this.roomVersion && request === this.historyRequest) {
      this.update({ messages: history });
    }
  }

  joinRoom = async (roomName: string, password: string): Promise<void> => {
    const status = this.state.connectionStatus;
    if (this.state.isJoining || status === 'signaling' || status === 'connecting' || status === 'connected') {
      appLogger.warn('chat', 'Повторное подключение заблокировано', {
        context: { status, isJoining: this.state.isJoining },
        visibleToUser: true,
      });
      return;
    }

    const roomVersion = ++this.roomVersion;
    const isCurrentRoom = () => roomVersion === this.roomVersion;
    this.update({ isJoining: true, isSending: false, inRoom: false, messages: [] });
    try {
      await this.notifications.prepare();
      if (!isCurrentRoom()) return;
      try {
        await this.backgroundService.start();
      } catch {
        if (isCurrentRoom()) {
          appLogger.warn('notifications', 'Фоновая служба не запущена. При сворачивании прием сообщений может остановиться.', {
            visibleToUser: true,
          });
        }
      }
      if (!isCurrentRoom()) return;
      if (Platform.OS === 'ios') {
        appLogger.warn('notifications', 'На iOS сообщения поступают, пока приложение активно.', {
          visibleToUser: true,
        });
      }
      await this.engine.joinRoom(roomName, password, (message) => {
        if (!isCurrentRoom()) return;
        void this.notifications.showMessage(message, isCurrentRoom);
        this.refreshMessages(roomVersion).catch(() => {
          if (isCurrentRoom()) {
            appLogger.error('chat', 'Не удалось обновить историю сообщений', { visibleToUser: true });
          }
        });
      }, (connectionStatus) => {
        if (!isCurrentRoom()) return;
        this.update({ connectionStatus });
        if (connectionStatus === 'failed') this.stopBackgroundService();
      });
      if (!isCurrentRoom()) return;
      this.update({ inRoom: true });
      await this.refreshMessages(roomVersion);
      if (!isCurrentRoom()) return;
      appLogger.info('chat', 'Вход в комнату завершен', { visibleToUser: true });
    } catch (error) {
      if (!isCurrentRoom()) return;
      // Invalidate callbacks already queued before a failed join.
      this.roomVersion += 1;
      this.stopBackgroundService();
      try {
        this.engine.disconnect({ navigateHome: false, reason: 'join_failed' });
      } catch {
        appLogger.error('chat', 'Не удалось освободить соединение после ошибки входа');
      }
      this.update({ inRoom: false, connectionStatus: 'failed', isJoining: false });
      appLogger.error('chat', 'Не удалось войти в комнату', { error, visibleToUser: true });
    } finally {
      if (isCurrentRoom()) this.update({ isJoining: false });
    }
  };

  sendMessage = async (text: string, attachment?: FileAttachment): Promise<boolean> => {
    if ((!text.trim() && !attachment) || this.state.isSending ||
        !this.state.inRoom || this.state.connectionStatus !== 'connected') {
      return false;
    }

    const roomVersion = this.roomVersion;
    const isCurrentRoom = () => roomVersion === this.roomVersion;
    this.update({ isSending: true });
    try {
      await this.engine.sendMessage(text, attachment);
      if (!isCurrentRoom()) return false;
      try {
        await this.refreshMessages(roomVersion);
      } catch {
        if (isCurrentRoom()) {
          appLogger.error('chat', 'Сообщение отправлено, но историю не удалось обновить', { visibleToUser: true });
        }
      }
      return isCurrentRoom();
    } catch {
      if (!isCurrentRoom()) return false;
      appLogger.error('chat', 'Не удалось отправить сообщение', { visibleToUser: true });
      return false;
    } finally {
      if (isCurrentRoom()) this.update({ isSending: false });
    }
  };

  disconnectRoom = (): void => {
    this.roomVersion += 1;
    this.stopBackgroundService();
    try {
      this.engine.disconnect({ navigateHome: true, reason: 'manual' });
    } catch (error) {
      appLogger.error('chat', 'Не удалось разорвать соединение', { error, visibleToUser: true });
    } finally {
      this.update({
        connectionStatus: 'disconnected',
        inRoom: false,
        messages: [],
        isJoining: false,
        isSending: false,
      });
    }
  };
}

let session: ChatSession | undefined;

export function getChatSession(): ChatSession {
  session ??= new ChatSession();
  return session;
}
