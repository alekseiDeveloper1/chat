import { useEffect, useState, useSyncExternalStore } from 'react';
import { getChatSession } from '@/application/ChatSession';
import { AppLogEntry, appLogger } from '@/shared/logging/AppLogger';

const MAX_VISIBLE_ALERTS = 8;

export function useChat() {
  const [session] = useState(getChatSession);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [connectionAlerts, setConnectionAlerts] = useState<AppLogEntry[]>([]);

  useEffect(() => {
    return appLogger.subscribe((entry) => {
      if (!entry.visibleToUser) return;
      setConnectionAlerts((current) => [entry, ...current].slice(0, MAX_VISIBLE_ALERTS));
    }, { replay: true });
  }, []);

  const clearConnectionAlerts = () => {
    appLogger.clear();
    setConnectionAlerts([]);
  };

  return {
    ...state,
    connectionAlerts,
    joinRoom: session.joinRoom,
    sendMessage: session.sendMessage,
    disconnectRoom: session.disconnectRoom,
    clearConnectionAlerts,
  };
}
