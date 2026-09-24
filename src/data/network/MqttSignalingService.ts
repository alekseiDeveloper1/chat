import mqtt, {MqttClient} from 'mqtt';

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

      this.client.subscribe(topic, (err) => {
        if (err) {
          console.error('[MQTT] Ошибка подписки:', err);
        } else {
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

        this.onMessage(packet);
      } catch (e) {
        console.warn('[MQTT] Ошибка парсинга сообщения:', e);
      }
    });

    this.client.on('error', (error) => {
      console.error('[MQTT ERROR]:', error.message);
      this.onConnectionFailure(error.message);
    });
  }


  publish(type: string, payload: unknown): void {
    if (!this.client?.connected) return;

    const username = process.env.EXPO_PUBLIC_MQTT_USER || '';
    const topic = `${username}/rooms/${this.roomHash}`;

    const messageBody = JSON.stringify({
      senderId: this.peerId,
      type,
      payload,
    });

    this.client.publish(topic, messageBody, { qos: MQTT_MESSAGE_QOS });
  }

  disconnect(): void {
    if (this.client) {
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
}
