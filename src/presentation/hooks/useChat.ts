import { useEffect, useState, useMemo, useRef } from 'react';
import { ChatEngine } from '@/domain/services/ChatEngine';
import { AESCryptoService } from '@/data/crypto/AESCryptoService';
import { SQLiteMessageRepository } from '@/data/database/SQLiteMessageRepository';
import { WebRTCNetworkService } from '@/data/network/WebRTCNetworkService';
import { Message } from '@/domain/entities/Message';
import { ConnectionStatus } from '@/domain/services/INetworkService';
import { AppLogEntry, appLogger } from '@/shared/logging/AppLogger';

const MAX_VISIBLE_ALERTS = 8;

export function useChat() {
  const engine = useMemo(() => {
    return new ChatEngine(
      new AESCryptoService(),
      new SQLiteMessageRepository(),
      new WebRTCNetworkService()
    );
  }, []);

  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [inRoom, setInRoom] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [connectionAlerts, setConnectionAlerts] = useState<AppLogEntry[]>([]);
  const joinInProgressRef = useRef(false);

  useEffect(() => {
    const unsubscribe = appLogger.subscribe((entry) => {
      if (!entry.visibleToUser) return;

      setConnectionAlerts((currentAlerts) => [entry, ...currentAlerts].slice(0, MAX_VISIBLE_ALERTS));
    }, { replay: true });

    return () => {
      joinInProgressRef.current = false;
      unsubscribe();
      engine.disconnect({ navigateHome: false, reason: 'screen_unmount' });
    };
  }, [engine]);

  const refreshMessages = async () => {
    const history = await engine.getHistory();
    setMessages(history);
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
    setIsJoining(true);
    try {
      await engine.joinRoom(roomName, password, refreshMessages, setStatus);
      setInRoom(true);
      await refreshMessages();
      appLogger.info('chat', 'Вход в комнату завершен', {
        visibleToUser: true,
      });
    } catch (error) {
      setStatus('failed');
      appLogger.error('chat', 'Не удалось войти в комнату', {
        error,
        visibleToUser: true,
      });
    } finally {
      joinInProgressRef.current = false;
      setIsJoining(false);
    }
  };

  const send = async (text: string) => {
    if (!text.trim()) return;
    try {
      await engine.sendMessage(text);
      await refreshMessages();
    } catch (error) {
      appLogger.error('chat', 'Не удалось отправить сообщение', {
        error,
        visibleToUser: true,
      });
    }
  };

  const disconnect = () => {
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
      joinInProgressRef.current = false;
      setIsJoining(false);
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
    connectionAlerts,
    joinRoom: join,
    sendMessage: send,
    disconnectRoom: disconnect,
    clearConnectionAlerts,
  };
}
