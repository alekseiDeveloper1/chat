import Paho from 'paho-mqtt';
import {
  MQTT_BROKER_URL,
  MQTT_CONNECT_OPTIONS,
  MQTT_MESSAGE_QOS,
  MQTT_PING_INTERVAL_MS,
  SIGNAL_TYPE,
  buildMqttClientId,
  buildRoomTopic,
} from './networkConstants';
import { SignalingPacket } from './webrtcTypes';

export type SignalingMessageHandler = (packet: SignalingPacket) => void | Promise<void>;
export type ConnectionFailureHandler = (errorMessage: string) => void;

export class MqttSignalingService {
  private mqttClient: Paho.Client | null = null;
  private pingIntervalRef: ReturnType<typeof setInterval> | null = null;
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

    const clientId = buildMqttClientId(peerId);
    const connectionGeneration = ++this.connectionGeneration;
    const mqttClient = new Paho.Client(MQTT_BROKER_URL, clientId);
    this.mqttClient = mqttClient;

    mqttClient.onMessageArrived = (message: Paho.Message) => {
      if (!this.isCurrentClient(mqttClient, connectionGeneration)) {
        return;
      }

      try {
        const packet = JSON.parse(message.payloadString) as SignalingPacket;
        this.onMessage(packet);
      } catch { }
    };

    mqttClient.onConnectionLost = (err) => {
      if (!this.isCurrentClient(mqttClient, connectionGeneration)) {
        return;
      }

      this.clearPingInterval();

      if (err.errorCode !== 0) {
        console.error('[MQTT CONN LOST] MQTT connection lost:', err.errorMessage);
        this.onConnectionFailure(err.errorMessage);
      }
    };

    mqttClient.connect({
      ...MQTT_CONNECT_OPTIONS,
      onSuccess: () => {
        if (!this.isCurrentClient(mqttClient, connectionGeneration)) {
          return;
        }

        this.handleConnectSuccess(mqttClient, connectionGeneration);
      },
      onFailure: (err) => {
        if (!this.isCurrentClient(mqttClient, connectionGeneration)) {
          return;
        }

        console.error('[MQTT CONN FAILED] Коллбэк onFailure сработал:', err.errorMessage);
        this.onConnectionFailure(err.errorMessage);
      },
    });
  }


  publish(type: string, payload: unknown): void {
    if (!this.mqttClient?.isConnected()) return;

    const messageBody = JSON.stringify({
      senderId: this.peerId,
      type,
      payload,
    });

    const message = new Paho.Message(messageBody);
    message.destinationName = buildRoomTopic(this.roomHash);
    message.qos = MQTT_MESSAGE_QOS;

    this.mqttClient.send(message);
  }

  disconnect(): void {
    this.connectionGeneration += 1;
    this.clearPingInterval();

    const mqttClient = this.mqttClient;
    this.mqttClient = null;

    if (mqttClient?.isConnected()) {
      try {
        mqttClient.disconnect();
      } catch {
        // ignore disconnect errors
      }
    }
  }

  isConnected(): boolean {
    return this.mqttClient?.isConnected() ?? false;
  }

  private handleConnectSuccess(mqttClient: Paho.Client, connectionGeneration: number): void {
    const topic = buildRoomTopic(this.roomHash);
    mqttClient.subscribe(topic);
    this.publish(SIGNAL_TYPE.JOIN, { peerId: this.peerId });
    this.clearPingInterval();
    this.startPingInterval(mqttClient, connectionGeneration);
  }

  private startPingInterval(mqttClient: Paho.Client, connectionGeneration: number): void {
    this.pingIntervalRef = setInterval(() => {
      if (!this.isCurrentClient(mqttClient, connectionGeneration)) {
        this.clearPingInterval();
        return;
      }

      if (this.isConnected()) {
        this.publish(SIGNAL_TYPE.PING, {});
      } else {
        this.clearPingInterval();
      }
    }, MQTT_PING_INTERVAL_MS);
  }

  private clearPingInterval(): void {
    if (this.pingIntervalRef) {
      clearInterval(this.pingIntervalRef);
      this.pingIntervalRef = null;
    }
  }

  private isCurrentClient(mqttClient: Paho.Client, connectionGeneration: number): boolean {
    return this.mqttClient === mqttClient && this.connectionGeneration === connectionGeneration;
  }
}
