import React, { useState } from 'react';
import { View, Text, TextInput, Button, FlatList, StyleSheet } from 'react-native';
import { useChat } from '@/presentation/hooks/useChat';
import { ConnectionStatus } from '@/domain/services/INetworkService';
import { AppLogEntry, AppLogLevel } from '@/shared/logging/AppLogger';

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

export function ChatScreen() {
  const {
    messages,
    connectionStatus,
    inRoom,
    isJoining,
    connectionAlerts,
    joinRoom,
    sendMessage,
    disconnectRoom,
    clearConnectionAlerts,
  } = useChat();
  const [text, setText] = useState('');

  const handleDisconnect = () => {
    disconnectRoom();
    setText('');
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
            <View style={{ marginVertical: 5, alignSelf: item.senderId === 'me' ? 'flex-end' : 'flex-start' }}>
              <Text style={{ backgroundColor: item.senderId === 'me' ? '#DCF8C6' : '#FFF', padding: 10, borderRadius: 10, elevation: 1 }}>
                {item.text}
              </Text>
            </View>
          )}
        />

        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Напишите сообщение..."
          style={{ borderWidth: 1, borderColor: '#ccc', padding: 10, marginBottom: 10, borderRadius: 5 }}
          editable={connectionStatus === 'connected'}
        />

        <Button
          title="Отправить"
          disabled={connectionStatus !== 'connected' || !text.trim()}
          onPress={() => { sendMessage(text); setText(''); }}
        />

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
