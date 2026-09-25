import mqtt, {MqttClient} from 'mqtt';
import { AppLogger, appLogger } from '@/shared/logging/AppLogger';

import {
  MQTT_BROKER_URL,
  MQTT_MESSAGE_QOS,
  buildMqttClientId,
} from './networkConstants';
import { SignalingPacket } from './webrtcTypes';

export type SignalingMessageHandler = (packet: SignalingPacket) => void | Promise<void>;
export type ConnectionFailureHandler = (errorMessage: string) => void;

export class MqttSignalingService {
  private client: mqtt.MqttClient | null = null;
  private roomHash = '';
  private peerId = '';
  private connectionGeneration = 0;

  constructor(
    private readonly onMessage: SignalingMessageHandler,
    private readonly onConnectionFailure: ConnectionFailureHandler,
    private readonly logger: AppLogger = appLogger,
  ) {}

  connect(roomHash: string, peerId: string): void {
    this.disconnect();

    this.roomHash = roomHash;
    this.peerId = peerId;

    const username = process.env.EXPO_PUBLIC_MQTT_USER || '';
    const password = process.env.EXPO_PUBLIC_MQTT_PASSWORD || '';

    const topic = `${username}/rooms/${this.roomHash}`;
    const clientId = buildMqttClientId(peerId);
    const connectionGeneration = ++this.connectionGeneration;
    this.logger.info('mqtt', 'Подключение MQTT сигналинга', {
      context: {
        roomFingerprint: this.getRoomFingerprint(),
        peerId: this.peerId,
        generation: connectionGeneration,
      },
      visibleToUser: true,
    });

    this.client = mqtt.connect(MQTT_BROKER_URL, {
      username: username,
      password: password,
      clientId: clientId,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 15000,
    });

    this.client.on('connect', () => {
      if (!this.client) return;

      this.logger.info('mqtt', 'MQTT сигналинг подключен', {
        context: {
          roomFingerprint: this.getRoomFingerprint(),
          peerId: this.peerId,
          generation: connectionGeneration,
        },
        visibleToUser: true,
      });

      this.client.subscribe(topic, (err) => {
        if (err) {
          this.logger.error('mqtt', 'Ошибка MQTT подписки на комнату', {
            error: err,
            context: {
              roomFingerprint: this.getRoomFingerprint(),
              generation: connectionGeneration,
            },
            visibleToUser: true,
          });
        } else {
          this.logger.info('mqtt', 'MQTT подписка на комнату активна', {
            context: {
              roomFingerprint: this.getRoomFingerprint(),
              generation: connectionGeneration,
            },
            visibleToUser: true,
          });
          this.publish('join', { peerId: this.peerId });
        }
      });
    });

    this.client.on('message', (incomingTopic, message) => {
      if (!this.isCurrentClient(this.client, connectionGeneration)) {
        return;
      }
      try {
        const packet = JSON.parse(message.toString());

        if (packet.senderId === this.peerId) return;

        this.logger.info('mqtt', `Получен signaling пакет: ${packet.type}`, {
          context: {
            roomFingerprint: this.getRoomFingerprint(),
            generation: connectionGeneration,
          },
          visibleToUser: this.shouldShowSignalingPacket(packet.type),
        });
        this.onMessage(packet);
      } catch (e) {
        this.logger.warn('mqtt', 'Ошибка парсинга MQTT сообщения', {
          error: e,
          visibleToUser: true,
        });
      }
    });

    this.client.on('error', (error) => {
      this.logger.error('mqtt', 'Ошибка MQTT сигналинга', {
        error,
        context: {
          roomFingerprint: this.getRoomFingerprint(),
          generation: connectionGeneration,
        },
        visibleToUser: true,
      });
      this.onConnectionFailure(error.message);
    });
  }


  publish(type: string, payload: unknown): void {
    if (!this.client?.connected) {
      this.logger.warn('mqtt', `MQTT пакет не отправлен: клиент не подключен (${type})`, {
        context: { roomFingerprint: this.getRoomFingerprint() },
        visibleToUser: this.shouldShowSignalingPacket(type),
      });
      return;
    }

    const username = process.env.EXPO_PUBLIC_MQTT_USER || '';
    const topic = `${username}/rooms/${this.roomHash}`;

    const messageBody = JSON.stringify({
      senderId: this.peerId,
      type,
      payload,
    });

    this.client.publish(topic, messageBody, { qos: MQTT_MESSAGE_QOS });
    this.logger.info('mqtt', `Отправлен signaling пакет: ${type}`, {
      context: { roomFingerprint: this.getRoomFingerprint() },
      visibleToUser: this.shouldShowSignalingPacket(type),
    });
  }

  disconnect(): void {
    if (this.client) {
      this.logger.debug('mqtt', 'MQTT клиент закрывается', {
        context: {
          roomFingerprint: this.getRoomFingerprint(),
          generation: this.connectionGeneration,
        },
      });
      this.client.end();
      this.client = null;
    }
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }
  private isCurrentClient(mqttClient: MqttClient | null, connectionGeneration: number): boolean {
    return this.client === mqttClient && this.connectionGeneration === connectionGeneration;
  }

  private getRoomFingerprint(): string | null {
    return this.roomHash ? this.roomHash.slice(0, 8) : null;
  }

  private shouldShowSignalingPacket(type: string): boolean {
    return type !== 'ice_batch' && !type.startsWith('ice_');
  }
}
