import { useState, useMemo } from 'react';
import { ChatEngine } from '@/domain/services/ChatEngine';
import { AESCryptoService } from '@/data/crypto/AESCryptoService';
import { SQLiteMessageRepository } from '@/data/database/SQLiteMessageRepository';
import { WebRTCNetworkService } from '@/data/network/WebRTCNetworkService';
import { Message } from '@/domain/entities/Message';
import { ConnectionStatus } from '@/domain/services/INetworkService';

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

  const refreshMessages = async () => {
    const history = await engine.getHistory();
    setMessages(history);
  };

  const join = async (roomName: string, password: string) => {
    try {
      await engine.joinRoom(roomName, password, refreshMessages, setStatus);
      setInRoom(true);
      await refreshMessages();
    } catch (error) {
      console.error('Не удалось войти в секретную комнату:', error);
    }
  };

  const send = async (text: string) => {
    if (!text.trim()) return;
    await engine.sendMessage(text);
    await refreshMessages();
  };

  return {
    messages,
    connectionStatus: status,
    inRoom,
    joinRoom: join,
    sendMessage: send,
  };
}
