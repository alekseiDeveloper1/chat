import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Button, FlatList, ScrollView, StyleSheet, Linking, Pressable, Image, Animated, Easing } from 'react-native';
import { useChat } from '@/presentation/hooks/useChat';
import { FileAttachment, MAX_ATTACHMENT_BYTES } from '@/domain/entities/Message';
import { ConnectionStatus } from '@/domain/services/INetworkService';
import { AttachmentError, openAttachment, pickAttachment } from '@/data/files/ChatAttachments';
import { AppLogEntry, AppLogLevel, appLogger } from '@/shared/logging/AppLogger';
import { splitMessageLinks } from '@/shared/links/messageLinks';
import { SharedDraft } from '@/data/sharing/IncomingShare';
import { useIncomingShares } from '@/presentation/sharing/IncomingShareProvider';

const HOME_DOG = require('../../../assets/images/home-dog.png');

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'В СЕТИ (Прямой канал)',
  connecting: 'Восстановление соединения...',
  disconnected: 'Отключено',
  failed: 'Не удалось подключиться',
  signaling: 'Подключение...',
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
  notifications: 'УВЕДОМЛЕНИЯ',
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
  const { drafts: sharedDrafts, isImporting, removeDraft } = useIncomingShares();
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<FileAttachment | null>(null);
  const [isPickingAttachment, setIsPickingAttachment] = useState(false);
  const [openingAttachmentId, setOpeningAttachmentId] = useState<string | null>(null);
  const [sendingSharedDraftId, setSendingSharedDraftId] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const roomVersionRef = useRef(0);
  const pickingRef = useRef(false);
  const sendingRef = useRef(false);
  const openingRef = useRef(false);
  const breathing = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (inRoom) return;
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(breathing, { toValue: 1, duration: 2200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(breathing, { toValue: 0, duration: 2200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    animation.start();
    return () => animation.stop();
  }, [breathing, inRoom]);

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
    setSendingSharedDraftId(null);
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

  const handleSendSharedDraft = async (draft: SharedDraft) => {
    if (!inRoom || sendingRef.current || pickingRef.current || isSending || connectionStatus !== 'connected') return;

    const roomVersion = roomVersionRef.current;
    sendingRef.current = true;
    setSendingSharedDraftId(draft.id);
    try {
      const sent = await sendMessage(draft.text, draft.attachment);
      if (sent && isCurrentRoom(roomVersion)) removeDraft(draft.id);
    } finally {
      if (isCurrentRoom(roomVersion)) {
        sendingRef.current = false;
        setSendingSharedDraftId(null);
      }
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

  const canSend = connectionStatus === 'connected'
    && !isSending
    && !isPickingAttachment
    && sendingSharedDraftId === null
    && Boolean(text.trim() || attachment);

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

  const renderSharedDrafts = () => {
    if (!isImporting && sharedDrafts.length === 0) return null;

    const busy = isSending || isPickingAttachment || sendingSharedDraftId !== null;
    return (
      <View style={styles.sharedPanel}>
        <Text style={styles.sharedTitle}>Пересыл из другого приложения</Text>
        {isImporting ? <Text style={styles.sharedHint}>Получение пересыла...</Text> : null}
        {!inRoom ? (
          <Text style={styles.sharedHint}>Войдите в комнату, чтобы отправить пересыл.</Text>
        ) : connectionStatus !== 'connected' ? (
          <Text style={styles.sharedHint}>Пересыл можно отправить после подключения.</Text>
        ) : null}
        <ScrollView style={styles.sharedList} nestedScrollEnabled>
          {sharedDrafts.map((draft, index) => (
            <View key={draft.id} style={styles.sharedDraft}>
              {draft.text ? <Text selectable style={styles.messageText}>{draft.text}</Text> : null}
              {draft.attachment ? (
                <View style={styles.fileCard}>
                  <Text style={styles.fileName}>{draft.attachment.name}</Text>
                  <Text style={styles.fileDetails}>{formatFileSize(draft.attachment.size)}</Text>
                </View>
              ) : null}
              <View style={styles.composerActions}>
                <Button
                  title={sendingSharedDraftId === draft.id ? 'Отправка пересыла...' : 'Отправить в комнату'}
                  accessibilityLabel={`Отправить пересыл ${index + 1} в комнату`}
                  disabled={!inRoom || connectionStatus !== 'connected' || busy}
                  onPress={() => handleSendSharedDraft(draft)}
                />
                <Button
                  title="Убрать пересыл"
                  accessibilityLabel={`Убрать пересыл ${index + 1}`}
                  disabled={sendingSharedDraftId === draft.id}
                  onPress={() => removeDraft(draft.id)}
                />
              </View>
            </View>
          ))}
        </ScrollView>
      </View>
    );
  };

  if (!inRoom) {
    return (
      <View style={styles.homeScreen}>
        {renderConnectionAlerts()}
        {renderSharedDrafts()}
        <View style={styles.homeContent}>
          <View style={styles.brandRow}>
            <View style={styles.brandMark}><Text style={styles.brandPaw}>🐾</Text></View>
            <Text style={styles.brandName}>Рядом</Text>
            <View style={styles.privateBadge}><View style={styles.privateDot} /><Text style={styles.privateText}>ЛИЧНЫЙ ЧАТ</Text></View>
          </View>
          <View style={styles.hero}>
            <View style={styles.dogHalo} />
            <Animated.View style={[styles.dogImageFrame, { transform: [{ scale: breathing.interpolate({ inputRange: [0, 1], outputRange: [1, 1.035] }) }] }]}>
              <Image source={HOME_DOG} style={styles.dogImage} resizeMode="cover" accessibilityLabel="Спокойная собака" />
            </Animated.View>
            <View style={styles.breathingLabel}><View style={styles.breathingDot} /><Text style={styles.breathingText}>дышим спокойно</Text></View>
          </View>
          <View style={styles.homeCopy}>
            <Text style={styles.eyebrow}>СВОИ РЯДОМ, ДАЖЕ НА РАССТОЯНИИ</Text>
            <Text style={styles.homeTitle}>Тихое место{'\n'}для своих</Text>
            <Text style={styles.homeDescription}>Подключитесь к комнате и общайтесь напрямую. Просто, спокойно и без лишнего.</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isJoining ? 'Подключаемся к комнате' : 'Подключиться к комнате'}
            accessibilityState={{ disabled: isJoining || connectionStatus === 'signaling' || connectionStatus === 'connecting', busy: isJoining }}
            disabled={isJoining || connectionStatus === 'signaling' || connectionStatus === 'connecting'}
            onPress={() => joinRoom(process.env.EXPO_PUBLIC_ROOM_NAME || 'people', process.env.EXPO_PUBLIC_ROOM_PASSWORD || 'miska-balalaika')}
            style={({ pressed }) => [styles.connectButton, pressed && styles.connectButtonPressed, (isJoining || connectionStatus === 'signaling' || connectionStatus === 'connecting') && styles.connectButtonBusy]}
          >
            <View style={styles.connectPaw}><Text style={styles.connectPawText}>🐾</Text></View>
            <Text style={styles.connectButtonText}>{isJoining ? 'Подключаемся…' : 'Подключиться'}</Text>
            <Text style={styles.connectArrow}>→</Text>
          </Pressable>
          <Text style={styles.homeFootnote}>Нажмите лапку, чтобы войти в комнату</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.chatScreen}>
      <View style={styles.connectionCard} accessibilityRole="summary">
        <View style={[styles.connectionDot, { backgroundColor: connectionStatus === 'connected' ? '#74876B' : connectionStatus === 'failed' ? '#B16B5D' : '#C59A5C' }]} />
        <View style={styles.connectionCopy}>
          <Text style={styles.connectionTitle}>{connectionStatus === 'connected' ? 'Вы на связи' : 'Подключение'}</Text>
          <Text style={styles.connectionSubtitle}>P2P · {STATUS_LABELS[connectionStatus]}</Text>
        </View>
        <View style={[styles.connectionPill, { backgroundColor: connectionStatus === 'connected' ? '#E7EEE3' : connectionStatus === 'failed' ? '#F4E8E4' : '#F3EEE3' }]}>
          <Text style={[styles.connectionPillText, { color: connectionStatus === 'connected' ? '#63765B' : connectionStatus === 'failed' ? '#A65F50' : '#987745' }]}>{connectionStatus === 'connected' ? 'ГОТОВО' : connectionStatus === 'failed' ? 'ОШИБКА' : 'ЖДЁМ'}</Text>
        </View>
      </View>

      {renderConnectionAlerts()}
      {renderSharedDrafts()}

      <FlatList
        data={messages}
        style={styles.messageList}
        contentContainerStyle={messages.length === 0 ? styles.emptyListContent : styles.messageListContent}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={(
          <View style={styles.emptyChat}>
            <View style={styles.emptyChatPaw}><Text style={styles.emptyChatPawText}>🐾</Text></View>
            <Text style={styles.emptyChatTitle}>Здесь начинается разговор</Text>
            <Text style={styles.emptyChatHint}>Напишите первым — ваши сообщения появятся здесь.</Text>
          </View>
        )}
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

      <View style={styles.composerCard}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={attachment ? 'Подпись к файлу (необязательно)...' : 'Напишите сообщение...'}
          placeholderTextColor="#AAA398"
          accessibilityLabel={attachment ? 'Подпись к файлу' : 'Текст сообщения или ссылка'}
          style={styles.messageInput}
          editable={connectionStatus === 'connected' && !isSending && sendingSharedDraftId === null}
          multiline
        />

        <View style={styles.composerActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isPickingAttachment ? 'Чтение файла' : 'Прикрепить файл'}
            accessibilityState={{ disabled: connectionStatus !== 'connected' || isSending || isPickingAttachment || sendingSharedDraftId !== null, busy: isPickingAttachment }}
            disabled={connectionStatus !== 'connected' || isSending || isPickingAttachment || sendingSharedDraftId !== null}
            onPress={handlePickAttachment}
            style={({ pressed }) => [styles.attachButton, pressed && styles.attachButtonPressed]}
          >
            <Text style={styles.attachButtonIcon}>＋</Text>
            <Text style={styles.attachButtonText}>{isPickingAttachment ? 'Читаем…' : 'Файл'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isSending ? 'Отправка сообщения' : canSend ? 'Отправить сообщение' : connectionStatus !== 'connected' ? 'Нет соединения' : 'Введите сообщение для отправки'}
            accessibilityState={{ disabled: !canSend, busy: isSending }}
            disabled={!canSend}
            onPress={handleSend}
            style={({ pressed }) => [styles.sendButton, canSend ? styles.sendButtonReady : styles.sendButtonDisabled, pressed && canSend && styles.sendButtonPressed]}
          >
            <Text style={[styles.sendButtonText, !canSend && styles.sendButtonTextDisabled]}>
              {isSending ? 'Отправляем…' : canSend ? 'Отправить' : connectionStatus !== 'connected' ? 'Нет связи' : 'Введите текст'}
            </Text>
            <Text style={[styles.sendArrow, !canSend && styles.sendButtonTextDisabled]}>↗</Text>
          </Pressable>
        </View>
        <Text style={styles.attachmentHint}>Файлы до {MAX_ATTACHMENT_BYTES / (1024 * 1024)} МБ</Text>
      </View>

      <View style={{ marginTop: 10 }}>
        <Pressable accessibilityRole="button" onPress={handleDisconnect} style={({ pressed }) => [styles.disconnectButton, pressed && styles.disconnectButtonPressed]}>
          <Text style={styles.disconnectIcon}>×</Text>
          <Text style={styles.disconnectText}>Завершить соединение</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chatScreen: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 54,
    paddingBottom: 14,
    backgroundColor: '#F8F6F1',
  },
  messageList: { flex: 1 },
  messageListContent: { paddingVertical: 8, paddingBottom: 18 },
  emptyListContent: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 28 },
  emptyChat: { alignItems: 'center', maxWidth: 280, marginTop: -20 },
  emptyChatPaw: { width: 58, height: 58, borderRadius: 21, backgroundColor: '#EEE7DA', alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  emptyChatPawText: { fontSize: 27 },
  emptyChatTitle: { color: '#4A443C', fontSize: 17, fontWeight: '700', textAlign: 'center' },
  emptyChatHint: { color: '#918A80', fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 7 },
  composerCard: {
    padding: 10,
    borderWidth: 1,
    borderColor: '#ECE7DE',
    borderRadius: 20,
    backgroundColor: '#FFFEFC',
    shadowColor: '#77644B',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  attachButton: {
    minWidth: 82,
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 11,
    borderRadius: 14,
    backgroundColor: '#F1EEE7',
  },
  attachButtonPressed: { opacity: 0.7 },
  attachButtonIcon: { color: '#77756D', fontSize: 21, lineHeight: 23 },
  attachButtonText: { color: '#716B61', fontSize: 12, fontWeight: '600' },
  sendButton: {
    minHeight: 46,
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 15,
    borderRadius: 14,
  },
  sendButtonReady: { backgroundColor: '#829078', elevation: 2, shadowColor: '#55634D', shadowOpacity: 0.16, shadowRadius: 5, shadowOffset: { width: 0, height: 2 } },
  sendButtonDisabled: { backgroundColor: '#F1EFEA' },
  sendButtonPressed: { opacity: 0.82, transform: [{ scale: 0.98 }] },
  sendButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  sendButtonTextDisabled: { color: '#AAA398' },
  sendArrow: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  homeScreen: {
    flex: 1,
    backgroundColor: '#F8F6F1',
    paddingHorizontal: 24,
    paddingTop: 54,
    paddingBottom: 24,
  },
  homeContent: {
    flex: 1,
    justifyContent: 'center',
    width: '100%',
    maxWidth: 430,
    alignSelf: 'center',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  brandMark: {
    width: 34,
    height: 34,
    borderRadius: 12,
    backgroundColor: '#EEE7DA',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 9,
  },
  brandPaw: { fontSize: 18 },
  brandName: { color: '#39342D', fontSize: 17, fontWeight: '700', letterSpacing: 0.2 },
  privateBadge: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: '#F0EDE6',
  },
  privateDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#81917A' },
  privateText: { color: '#77756D', fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  hero: { height: 282, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  dogHalo: {
    position: 'absolute',
    width: 238,
    height: 238,
    borderRadius: 119,
    backgroundColor: '#EEE4D2',
    opacity: 0.75,
  },
  dogImageFrame: {
    width: 228,
    height: 228,
    overflow: 'hidden',
    borderRadius: 114,
    borderWidth: 7,
    borderColor: '#FBF9F4',
    backgroundColor: '#EAD8B9',
    elevation: 5,
    shadowColor: '#77644B',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  dogImage: { width: '100%', height: '100%' },
  breathingLabel: {
    position: 'absolute',
    bottom: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: '#FBF9F4',
    elevation: 2,
  },
  breathingDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#92A184' },
  breathingText: { color: '#77756D', fontSize: 11, letterSpacing: 0.15 },
  homeCopy: { alignItems: 'center', marginBottom: 23, paddingHorizontal: 4 },
  eyebrow: { color: '#99866D', fontSize: 9, fontWeight: '700', letterSpacing: 1.5, textAlign: 'center', marginBottom: 10 },
  homeTitle: { color: '#37332E', fontSize: 32, lineHeight: 38, fontWeight: '700', textAlign: 'center', letterSpacing: -0.6 },
  homeDescription: { maxWidth: 310, color: '#817B72', fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 10 },
  connectButton: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    borderRadius: 20,
    backgroundColor: '#829078',
    elevation: 3,
    shadowColor: '#55634D',
    shadowOpacity: 0.17,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
  },
  connectButtonPressed: { opacity: 0.88, transform: [{ scale: 0.985 }] },
  connectButtonBusy: { backgroundColor: '#A7AE9F', elevation: 0, shadowOpacity: 0 },
  connectPaw: { width: 42, height: 42, borderRadius: 14, backgroundColor: '#FFFFFF2B', alignItems: 'center', justifyContent: 'center' },
  connectPawText: { fontSize: 21 },
  connectButtonText: { flex: 1, marginLeft: 12, color: '#FFFFFF', fontSize: 16, fontWeight: '700', letterSpacing: 0.1 },
  connectArrow: { marginHorizontal: 10, color: '#FFFFFF', fontSize: 22, fontWeight: '400' },
  homeFootnote: { color: '#A29B90', fontSize: 11, textAlign: 'center', marginTop: 12 },
  connectionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: '#F4F1EA',
  },
  connectionDot: { width: 9, height: 9, borderRadius: 5, marginRight: 11 },
  connectionCopy: { flex: 1 },
  connectionTitle: { color: '#39342D', fontSize: 14, fontWeight: '700' },
  connectionSubtitle: { color: '#898278', fontSize: 11, marginTop: 3 },
  connectionPill: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 12 },
  connectionPillText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.8 },
  disconnectButton: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: '#E6D8D2',
    borderRadius: 14,
    backgroundColor: '#FBF7F4',
  },
  disconnectButtonPressed: { opacity: 0.7, backgroundColor: '#F4E8E4' },
  disconnectIcon: { color: '#A65F50', fontSize: 21, lineHeight: 22 },
  disconnectText: { color: '#A65F50', fontSize: 13, fontWeight: '600' },
  sharedPanel: {
    marginBottom: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: '#AABBCB',
    borderRadius: 8,
    backgroundColor: '#F0F6FC',
  },
  sharedTitle: {
    color: '#24292F',
    fontWeight: '700',
    marginBottom: 6,
  },
  sharedHint: {
    color: '#57606A',
    marginBottom: 6,
  },
  sharedList: {
    maxHeight: 240,
  },
  sharedDraft: {
    gap: 8,
    paddingVertical: 8,
  },
  messageBubble: {
    maxWidth: '90%',
    marginVertical: 5,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 18,
    gap: 8,
  },
  ownMessage: {
    alignSelf: 'flex-end',
    backgroundColor: '#E5EBDD',
    borderBottomRightRadius: 6,
  },
  peerMessage: {
    alignSelf: 'flex-start',
    backgroundColor: '#FFFEFC',
    borderBottomLeftRadius: 6,
    borderWidth: 1,
    borderColor: '#EEE9E0',
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
    minHeight: 48,
    maxHeight: 120,
    paddingHorizontal: 9,
    paddingTop: 12,
    paddingBottom: 8,
    color: '#39342D',
    fontSize: 14,
    lineHeight: 20,
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
    marginTop: 8,
    marginLeft: 4,
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
