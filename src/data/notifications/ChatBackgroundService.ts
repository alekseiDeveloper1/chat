import { AppState, Platform } from 'react-native';

type BackgroundActions = typeof import('react-native-background-actions').default;

let backgroundActions: BackgroundActions | undefined;
let owner: ChatBackgroundService | undefined;
let pendingOperation: Promise<void> = Promise.resolve();

function getBackgroundActions(): BackgroundActions {
  if (!backgroundActions) {
    backgroundActions = require('react-native-background-actions').default as BackgroundActions;
  }
  return backgroundActions;
}

function enqueue(operation: () => Promise<void>): Promise<void> {
  const result = pendingOperation.then(operation);
  pendingOperation = result.catch(() => undefined);
  return result;
}

export class ChatBackgroundService {
  start(): Promise<void> {
    if (Platform.OS !== 'android') return Promise.resolve();

    return enqueue(async () => {
      const service = getBackgroundActions();
      if (owner && service.isRunning()) {
        owner = this;
        return;
      }
      if (AppState.currentState !== 'active') {
        throw new Error('Для запуска фонового приёма сообщений откройте приложение');
      }

      owner = this;
      try {
        await service.start(
          () => new Promise<void>(() => undefined),
          {
            taskName: 'ChatMessages',
            taskTitle: 'Фоновый прием сообщений',
            taskDesc: 'Ожидание новых сообщений в фоне',
            taskIcon: { name: 'ic_launcher', type: 'mipmap' },
            color: '#208AEF',
            linkingURI: 'chat://',
          },
        );
      } catch (error) {
        try {
          await service.stop();
          owner = undefined;
        } catch { }
        throw error;
      }
    });
  }

  stop(): Promise<void> {
    if (Platform.OS !== 'android') return Promise.resolve();

    return enqueue(async () => {
      if (owner !== this) return;
      await getBackgroundActions().stop();
      owner = undefined;
    });
  }
}
