import { Platform } from 'react-native';
import type * as ExpoNotifications from 'expo-notifications';
import { Message } from '@/domain/entities/Message';
import { appLogger } from '@/shared/logging/AppLogger';

export const MESSAGE_CHANNEL_ID = 'chat-messages';

let notifications: typeof ExpoNotifications | undefined;

function getNotifications(): typeof ExpoNotifications {
  if (!notifications) {
    notifications = require('expo-notifications') as typeof ExpoNotifications;
    notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  }
  return notifications;
}

function hasPermission(settings: ExpoNotifications.NotificationPermissionsStatus): boolean {
  return settings.granted ||
    settings.ios?.status === getNotifications().IosAuthorizationStatus.PROVISIONAL;
}

export class ChatNotifications {
  async prepare(): Promise<void> {
    if (Platform.OS === 'web') return;

    try {
      const api = getNotifications();
      if (Platform.OS === 'android') {
        await api.setNotificationChannelAsync(MESSAGE_CHANNEL_ID, {
          name: 'Сообщения чата',
          importance: api.AndroidImportance.HIGH,
          sound: 'default',
          vibrationPattern: [0, 250, 250, 250],
          lockscreenVisibility: api.AndroidNotificationVisibility.PRIVATE,
        });
      }

      let settings = await api.getPermissionsAsync();
      if (!hasPermission(settings) && settings.canAskAgain) {
        settings = await api.requestPermissionsAsync({
          ios: { allowAlert: true, allowSound: true, allowBadge: false },
        });
      }

      if (!hasPermission(settings)) {
        appLogger.warn('notifications', 'Уведомления отключены. Разрешите их в настройках приложения.', {
          visibleToUser: true,
        });
      }
    } catch {
      appLogger.error('notifications', 'Не удалось настроить уведомления. Проверьте нативную сборку приложения.', {
        visibleToUser: true,
      });
    }
  }

  async showMessage(message: Message, isCurrentRoom: () => boolean): Promise<void> {
    if (Platform.OS === 'web' || message.senderId !== 'peer' || !isCurrentRoom()) return;

    try {
      const api = getNotifications();
      const settings = await api.getPermissionsAsync();
      if (!hasPermission(settings) || !isCurrentRoom()) return;

      const preview = message.text.trim() ||
        (message.attachment ? `Файл: ${message.attachment.name}` : 'Получено новое сообщение');

      await api.scheduleNotificationAsync({
        identifier: `chat:${message.roomId}:${message.id}`,
        content: {
          title: 'Новое сообщение',
          body: preview.slice(0, 160),
          sound: 'default',
          data: { roomId: message.roomId, messageId: message.id },
        },
        trigger: Platform.OS === 'android' ? { channelId: MESSAGE_CHANNEL_ID } : null,
      });
      appLogger.debug('notifications', 'Уведомление о входящем сообщении показано');
    } catch {
      appLogger.error('notifications', 'Не удалось показать уведомление о сообщении', {
        visibleToUser: true,
      });
    }
  }
}
