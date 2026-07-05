export const RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
};

export const MQTT_BROKER_URL = 'wss://broker.hivemq.com:8884/mqtt';

export const MQTT_CONNECT_OPTIONS = {
  useSSL: true,
  timeout: 15,
  keepAliveInterval: 0,
  reconnect: true,
}

export const MQTT_MESSAGE_QOS = 1;

export const ICE_BATCH_DELAY_MS = 300;
export const MQTT_PING_INTERVAL_MS = 30_000;

export const DATA_CHANNEL_LABEL = 'chat-channel';
export const DATA_CHANNEL_OPTIONS = { ordered: true }

export const ROOM_TOPIC_PREFIX = 'p2p_chat_room_';
export const MQTT_CLIENT_ID_PREFIX = 'expo_chat_';

export const PEER_ID_RANDOM_RANGE = 1_000_000;

export const SIGNAL_TYPE = {
  ICE_BATCH: 'ice_batch',
  JOIN: 'join',
  HELLO: 'hello',
  OFFER: 'offer',
  ANSWER: 'answer',
  PING: 'ping',
} as const;

export const SEND_DATA_NO_CONNECTION_ERROR = 'Нет активного P2P соединения';

export const buildRoomTopic = (roomHash: string): string =>
  `${ROOM_TOPIC_PREFIX}${roomHash}`;

export const buildMqttClientId = (peerId: string): string =>
  `${MQTT_CLIENT_ID_PREFIX}${peerId}_${Math.random().toString(36).substring(7)}`;

export const generatePeerId = (): string =>
  Math.floor(Math.random() * PEER_ID_RANDOM_RANGE).toString();
