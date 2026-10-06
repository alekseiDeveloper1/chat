import { useEffect, useState, useMemo, useRef } from 'react';
import { ChatEngine } from '@/domain/services/ChatEngine';
import { AESCryptoService } from '@/data/crypto/AESCryptoService';
import { SQLiteMessageRepository } from '@/data/database/SQLiteMessageRepository';
import { WebRTCNetworkService } from '@/data/network/WebRTCNetworkService';
import { FileAttachment, Message } from '@/domain/entities/Message';
import { ConnectionStatus } from '@/domain/services/INetworkService';
import { AppLogEntry, appLogger } from '@/shared/logging/AppLogger';
import { Platform } from 'react-native';
import { ChatNotifications } from '@/data/notifications/ChatNotifications';
import { ChatBackgroundService } from '@/data/notifications/ChatBackgroundService';

const MAX_VISIBLE_ALERTS = 8;

const logBackgroundStopError = () => {
  appLogger.error('notifications', 'Не удалось остановить фоновую службу чата', { visibleToUser: true });
};

export function useChat() {
  const engine = useMemo(() => {
    return new ChatEngine(
      new AESCryptoService(),
      new SQLiteMessageRepository(),
      new WebRTCNetworkService()
    );
  }, []);
  const notifications = useMemo(() => new ChatNotifications(), []);
  const backgroundService = useMemo(() => new ChatBackgroundService(), []);

  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [inRoom, setInRoom] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [connectionAlerts, setConnectionAlerts] = useState<AppLogEntry[]>([]);
  const joinInProgressRef = useRef(false);
  const sendInProgressRef = useRef(false);
  const mountedRef = useRef(false);
  const roomVersionRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = appLogger.subscribe((entry) => {
      if (!entry.visibleToUser) return;

      setConnectionAlerts((currentAlerts) => [entry, ...currentAlerts].slice(0, MAX_VISIBLE_ALERTS));
    }, { replay: true });

    return () => {
      mountedRef.current = false;
      roomVersionRef.current += 1;
      joinInProgressRef.current = false;
      sendInProgressRef.current = false;
      unsubscribe();
      backgroundService.stop().catch(logBackgroundStopError);
      engine.disconnect({ navigateHome: false, reason: 'screen_unmount' });
    };
  }, [engine, backgroundService]);

  const refreshMessages = async (roomVersion = roomVersionRef.current) => {
    const history = await engine.getHistory();
    if (mountedRef.current && roomVersion === roomVersionRef.current) {
      setMessages(history);
    }
  };

  const join = async (roomName: string, password: string) => {
    if (joinInProgressRef.current || status === 'signaling' || status === 'connecting' || status === 'connected') {
      appLogger.warn('chat', 'Повторное подключение заблокировано', {
        context: { status, isJoining: joinInProgressRef.current },
        visibleToUser: true,
      });
      return;
    }

    joinInProgressRef.current = true;
    const roomVersion = ++roomVersionRef.current;
    setIsJoining(true);
    try {
      await notifications.prepare();
      if (!mountedRef.current || roomVersion !== roomVersionRef.current) return;
      try {
        await backgroundService.start();
      } catch {
        if (mountedRef.current && roomVersion === roomVersionRef.current) {
          appLogger.warn('notifications', 'Фоновая служба не запущена. При сворачивании прием сообщений может остановиться.', {
            visibleToUser: true,
          });
        }
      }
      if (!mountedRef.current || roomVersion !== roomVersionRef.current) return;
      if (Platform.OS === 'ios') {
        appLogger.warn('notifications', 'На iOS сообщения поступают, пока приложение активно.', {
          visibleToUser: true,
        });
      }
      await engine.joinRoom(roomName, password, (message) => {
        if (!mountedRef.current || roomVersion !== roomVersionRef.current) return;
        notifications.showMessage(message, () => mountedRef.current && roomVersion === roomVersionRef.current);
        refreshMessages(roomVersion).catch(() => {
          if (mountedRef.current && roomVersion === roomVersionRef.current) {
            appLogger.error('chat', 'Не удалось обновить историю сообщений', { visibleToUser: true });
          }
        });
      }, (nextStatus) => {
        if (!mountedRef.current || roomVersion !== roomVersionRef.current) return;
        setStatus(nextStatus);
        if (nextStatus === 'failed') {
          backgroundService.stop().catch(logBackgroundStopError);
        }
      });
      if (!mountedRef.current || roomVersion !== roomVersionRef.current) return;
      setInRoom(true);
      await refreshMessages(roomVersion);
      if (!mountedRef.current || roomVersion !== roomVersionRef.current) return;
      appLogger.info('chat', 'Вход в комнату завершен', {
        visibleToUser: true,
      });
    } catch (error) {
      if (!mountedRef.current || roomVersion !== roomVersionRef.current) return;
      backgroundService.stop().catch(logBackgroundStopError);
      try {
        engine.disconnect({ navigateHome: false, reason: 'join_failed' });
      } catch {
        appLogger.error('chat', 'Не удалось освободить соединение после ошибки входа');
      }
      setInRoom(false);
      setStatus('failed');
      appLogger.error('chat', 'Не удалось войти в комнату', {
        error,
        visibleToUser: true,
      });
    } finally {
      if (mountedRef.current && roomVersion === roomVersionRef.current) {
        joinInProgressRef.current = false;
        setIsJoining(false);
      }
    }
  };

  const send = async (text: string, attachment?: FileAttachment): Promise<boolean> => {
    if ((!text.trim() && !attachment) || sendInProgressRef.current || !inRoom || status !== 'connected' || !mountedRef.current) {
      return false;
    }

    const roomVersion = roomVersionRef.current;
    sendInProgressRef.current = true;
    setIsSending(true);
    try {
      await engine.sendMessage(text, attachment);
      if (!mountedRef.current || roomVersion !== roomVersionRef.current) return false;
      try {
        await refreshMessages(roomVersion);
      } catch {
        if (mountedRef.current && roomVersion === roomVersionRef.current) {
          appLogger.error('chat', 'Сообщение отправлено, но историю не удалось обновить', { visibleToUser: true });
        }
      }
      return mountedRef.current && roomVersion === roomVersionRef.current;
    } catch {
      if (!mountedRef.current || roomVersion !== roomVersionRef.current) return false;
      appLogger.error('chat', 'Не удалось отправить сообщение', {
        visibleToUser: true,
      });
      return false;
    } finally {
      if (mountedRef.current && roomVersion === roomVersionRef.current) {
        sendInProgressRef.current = false;
        setIsSending(false);
      }
    }
  };

  const disconnect = () => {
    roomVersionRef.current += 1;
    backgroundService.stop().catch(logBackgroundStopError);
    try {
      engine.disconnect({ navigateHome: true, reason: 'manual' });
    } catch (error) {
      appLogger.error('chat', 'Не удалось разорвать соединение', {
        error,
        visibleToUser: true,
      });
    } finally {
      setStatus('disconnected');
      setInRoom(false);
      setMessages([]);
      joinInProgressRef.current = false;
      sendInProgressRef.current = false;
      setIsJoining(false);
      setIsSending(false);
    }
  };

  const clearConnectionAlerts = () => {
    appLogger.clear();
    setConnectionAlerts([]);
  };

  return {
    messages,
    connectionStatus: status,
    inRoom,
    isJoining,
    isSending,
    connectionAlerts,
    joinRoom: join,
    sendMessage: send,
    disconnectRoom: disconnect,
    clearConnectionAlerts,
  };
}
