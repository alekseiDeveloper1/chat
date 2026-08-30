import React, { useState } from 'react';
import { View, Text, TextInput, Button, FlatList } from 'react-native';
import { useChat } from '@/presentation/hooks/useChat';
import { ConnectionStatus } from '@/domain/services/INetworkService';

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

export function ChatScreen() {
  const { messages, connectionStatus, inRoom, joinRoom, sendMessage } = useChat();
  const [text, setText] = useState('');

  if (!inRoom) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: 20 }}>
        <Button
          title="Войти в комнату"
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

        <FlatList
          data={messages}
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
          title="Отправить напрямую"
          disabled={connectionStatus !== 'connected' || !text.trim()}
          onPress={() => { sendMessage(text); setText(''); }}
        />
      </View>
    );

}
