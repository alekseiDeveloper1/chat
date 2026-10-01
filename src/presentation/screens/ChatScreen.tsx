import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Button, FlatList, StyleSheet, Linking, Pressable } from 'react-native';
import { useChat } from '@/presentation/hooks/useChat';
import { FileAttachment, MAX_ATTACHMENT_BYTES } from '@/domain/entities/Message';
import { ConnectionStatus } from '@/domain/services/INetworkService';
import { AttachmentError, openAttachment, pickAttachment } from '@/data/files/ChatAttachments';
import { AppLogEntry, AppLogLevel, appLogger } from '@/shared/logging/AppLogger';
import { splitMessageLinks } from '@/shared/links/messageLinks';

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'В СЕТИ (Прямой канал)',
  connecting: 'Восстановление соединения...',
  disconnected: 'Отключено',
  failed: 'Не удалось подключиться',
  signaling: 'Подключение...',
};

const getStatusColor = (status: ConnectionStatus): string => {
  if (status === 'connected') return 'green';
  if (status === 'failed') return 'red';
  return 'orange';
};

const ALERT_COLORS: Record<AppLogLevel, string> = {
  debug: '#607D8B',
  info: '#0B6B44',
  warn: '#8A5A00',
  error: '#B00020',
};

const FEATURE_LABELS: Record<AppLogEntry['feature'], string> = {
  chat: 'CHAT',
  webrtc: 'WEBRTC',
  mqtt: 'MQTT',
};

const formatLogTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const formatFileSize = (size: number): string => {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
};

export function ChatScreen() {
  const {
    messages,
    connectionStatus,
    inRoom,
    isJoining,
    isSending,
    connectionAlerts,
    joinRoom,
    sendMessage,
    disconnectRoom,
    clearConnectionAlerts,
  } = useChat();
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<FileAttachment | null>(null);
  const [isPickingAttachment, setIsPickingAttachment] = useState(false);
  const [openingAttachmentId, setOpeningAttachmentId] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const roomVersionRef = useRef(0);
  const pickingRef = useRef(false);
  const sendingRef = useRef(false);
  const openingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      roomVersionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    roomVersionRef.current += 1;
    pickingRef.current = false;
    sendingRef.current = false;
    openingRef.current = false;
    setIsPickingAttachment(false);
    setOpeningAttachmentId(null);
    setText('');
    setAttachment(null);
  }, [inRoom]);

  const isCurrentRoom = (roomVersion: number): boolean =>
    mountedRef.current && roomVersion === roomVersionRef.current;

  const handlePickAttachment = async () => {
    if (pickingRef.current || sendingRef.current || isSending || connectionStatus !== 'connected') return;

    const roomVersion = roomVersionRef.current;
    pickingRef.current = true;
    setIsPickingAttachment(true);
    try {
      const selectedAttachment = await pickAttachment();
      if (selectedAttachment && isCurrentRoom(roomVersion)) setAttachment(selectedAttachment);
    } catch (error) {
      if (isCurrentRoom(roomVersion)) {
        appLogger.error('chat', error instanceof AttachmentError ? error.message : 'Не удалось прочитать выбранный файл', {
          visibleToUser: true,
        });
      }
    } finally {
      if (isCurrentRoom(roomVersion)) {
        pickingRef.current = false;
        setIsPickingAttachment(false);
      }
    }
  };

  const handleSend = async () => {
    if (sendingRef.current || pickingRef.current || isSending || connectionStatus !== 'connected') return;

    const roomVersion = roomVersionRef.current;
    sendingRef.current = true;
    try {
      const sent = await sendMessage(text, attachment ?? undefined);
      if (sent && isCurrentRoom(roomVersion)) {
        setText('');
        setAttachment(null);
      }
    } finally {
      if (isCurrentRoom(roomVersion)) sendingRef.current = false;
    }
  };

  const handleOpenAttachment = async (messageId: string, file: FileAttachment) => {
    if (openingRef.current) return;

    const roomVersion = roomVersionRef.current;
    openingRef.current = true;
    setOpeningAttachmentId(messageId);
    try {
      await openAttachment(file);
    } catch (error) {
      if (isCurrentRoom(roomVersion)) {
        appLogger.error('chat', error instanceof AttachmentError ? error.message : 'Не удалось открыть файл', {
          visibleToUser: true,
        });
      }
    } finally {
      if (isCurrentRoom(roomVersion)) {
        openingRef.current = false;
        setOpeningAttachmentId(null);
      }
    }
  };

  const handleOpenLink = async (url: string) => {
    const roomVersion = roomVersionRef.current;
    try {
      await Linking.openURL(url);
    } catch {
      if (isCurrentRoom(roomVersion)) {
        appLogger.error('chat', 'Не удалось открыть ссылку', { visibleToUser: true });
      }
    }
  };

  const handleDisconnect = () => {
    roomVersionRef.current += 1;
    disconnectRoom();
    setText('');
    setAttachment(null);
  };

  const renderConnectionAlert = ({ item }: { item: AppLogEntry }) => {
    const contextText = item.context
      ? Object.entries(item.context).map(([key, value]) => `${key}: ${String(value)}`).join(', ')
      : '';
    const color = ALERT_COLORS[item.level];

    return (
      <View style={[styles.alertItem, { borderLeftColor: color }]}>
        <Text style={[styles.alertMeta, { color }]}>
          {formatLogTime(item.timestamp)} · {FEATURE_LABELS[item.feature]} · {item.level.toUpperCase()}
        </Text>
        <Text style={styles.alertMessage}>{item.message}</Text>
        {item.errorMessage ? <Text style={styles.alertDetails}>Ошибка: {item.errorMessage}</Text> : null}
        {contextText ? <Text style={styles.alertDetails}>{contextText}</Text> : null}
      </View>
    );
  };

  const renderConnectionAlerts = () => {
    if (connectionAlerts.length === 0) return null;

    return (
      <View style={styles.alertPanel}>
        <View style={styles.alertHeader}>
          <Text style={styles.alertTitle}>События соединения</Text>
          <Button title="Очистить" onPress={clearConnectionAlerts} />
        </View>
        <FlatList
          data={connectionAlerts}
          keyExtractor={(item) => item.id}
          renderItem={renderConnectionAlert}
          nestedScrollEnabled
          style={styles.alertList}
        />
      </View>
    );
  };

  if (!inRoom) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: 20 }}>
        {renderConnectionAlerts()}
        <Button
          title={isJoining ? 'Подключение...' : 'Войти в комнату'}
          disabled={isJoining || connectionStatus === 'signaling' || connectionStatus === 'connecting'}
          onPress={() => joinRoom(
            process.env.EXPO_PUBLIC_ROOM_NAME ||'people',
            process.env.EXPO_PUBLIC_ROOM_PASSWORD || 'miska-balalaika'
          )} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, padding: 20, paddingTop: 50 }}>
      <Text style={{
        fontWeight: 'bold',
        marginBottom: 10,
        color: getStatusColor(connectionStatus)
      }}>
        Статус P2P: {STATUS_LABELS[connectionStatus]}
      </Text>

      {renderConnectionAlerts()}

      <FlatList
        data={messages}
        style={{ flex: 1 }}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={[
            styles.messageBubble,
            item.senderId === 'me' ? styles.ownMessage : styles.peerMessage,
          ]}>
            {item.text ? (
              <Text style={styles.messageText}>
                {splitMessageLinks(item.text).map((part, index) => part.url ? (
                  <Text
                    key={index}
                    style={styles.link}
                    accessibilityRole="link"
                    onPress={() => handleOpenLink(part.url!)}
                  >
                    {part.text}
                  </Text>
                ) : part.text)}
              </Text>
            ) : null}
            {item.attachment ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Открыть файл ${item.attachment.name}`}
                accessibilityState={{ disabled: openingAttachmentId !== null, busy: openingAttachmentId === item.id }}
                disabled={openingAttachmentId !== null}
                onPress={() => handleOpenAttachment(item.id, item.attachment!)}
                style={({ pressed }) => [styles.fileCard, pressed && styles.fileCardPressed]}
              >
                <Text style={styles.fileName}>{item.attachment.name}</Text>
                <Text style={styles.fileDetails}>
                  {formatFileSize(item.attachment.size)} · {openingAttachmentId === item.id ? 'Открытие...' : 'Открыть / сохранить'}
                </Text>
              </Pressable>
            ) : null}
          </View>
        )}
      />

      {attachment ? (
        <View style={styles.attachmentPreview}>
          <View style={styles.attachmentDescription}>
            <Text style={styles.fileName} numberOfLines={2}>{attachment.name}</Text>
            <Text style={styles.fileDetails}>{formatFileSize(attachment.size)}</Text>
          </View>
          <Button
            title="Убрать"
            accessibilityLabel="Убрать прикреплённый файл"
            disabled={isSending || isPickingAttachment}
            onPress={() => setAttachment(null)}
          />
        </View>
      ) : null}

      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={attachment ? 'Подпись к файлу (необязательно)...' : 'Напишите сообщение или вставьте ссылку...'}
        accessibilityLabel={attachment ? 'Подпись к файлу' : 'Текст сообщения или ссылка'}
        style={styles.messageInput}
        editable={connectionStatus === 'connected' && !isSending}
        multiline
      />

      <View style={styles.composerActions}>
        <Button
          title={isPickingAttachment ? 'Чтение файла...' : 'Прикрепить файл'}
          disabled={connectionStatus !== 'connected' || isSending || isPickingAttachment}
          onPress={handlePickAttachment}
        />
        <Button
          title={isSending ? 'Отправка...' : 'Отправить'}
          disabled={connectionStatus !== 'connected' || isSending || isPickingAttachment || (!text.trim() && !attachment)}
          onPress={handleSend}
        />
      </View>
      <Text style={styles.attachmentHint}>Файлы до {MAX_ATTACHMENT_BYTES / (1024 * 1024)} МБ</Text>

      <View style={{ marginTop: 10 }}>
        <Button
          title="Разорвать соединение"
          color="#B00020"
          onPress={handleDisconnect}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  messageBubble: {
    maxWidth: '90%',
    marginVertical: 5,
    padding: 10,
    borderRadius: 10,
    elevation: 1,
    gap: 8,
  },
  ownMessage: {
    alignSelf: 'flex-end',
    backgroundColor: '#DCF8C6',
  },
  peerMessage: {
    alignSelf: 'flex-start',
    backgroundColor: '#FFFFFF',
  },
  messageText: {
    color: '#24292F',
  },
  link: {
    color: '#075CB3',
    textDecorationLine: 'underline',
  },
  fileCard: {
    padding: 10,
    borderWidth: 1,
    borderColor: '#AABBCB',
    borderRadius: 6,
    backgroundColor: '#F6F8FA',
  },
  fileCardPressed: {
    opacity: 0.7,
  },
  fileName: {
    color: '#075CB3',
    fontWeight: '600',
  },
  fileDetails: {
    marginTop: 4,
    color: '#57606A',
    fontSize: 12,
  },
  attachmentPreview: {
    marginVertical: 10,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#AABBCB',
    borderRadius: 6,
    backgroundColor: '#F6F8FA',
  },
  attachmentDescription: {
    flex: 1,
    marginRight: 8,
  },
  messageInput: {
    borderWidth: 1,
    borderColor: '#CCCCCC',
    padding: 10,
    marginBottom: 10,
    borderRadius: 5,
    maxHeight: 120,
  },
  composerActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 8,
  },
  attachmentHint: {
    color: '#57606A',
    fontSize: 12,
    marginTop: 6,
  },
  alertPanel: {
    maxHeight: 190,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#D8DEE4',
    borderRadius: 8,
    backgroundColor: '#F6F8FA',
  },
  alertHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 4,
  },
  alertTitle: {
    fontWeight: '700',
  },
  alertList: {
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  alertItem: {
    marginBottom: 8,
    padding: 8,
    borderLeftWidth: 4,
    borderRadius: 6,
    backgroundColor: '#FFFFFF',
  },
  alertMeta: {
    marginBottom: 4,
    fontSize: 11,
    fontWeight: '700',
  },
  alertMessage: {
    color: '#24292F',
    fontSize: 13,
  },
  alertDetails: {
    marginTop: 3,
    color: '#57606A',
    fontSize: 11,
  },
});
