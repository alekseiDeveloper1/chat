import Paho from 'paho-mqtt';
import {
  MQTT_BROKER_URL,
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

  constructor(
    private readonly onMessage: SignalingMessageHandler,
    private readonly onConnectionFailure: ConnectionFailureHandler,
  ) {}

  connect(roomHash: string, peerId: string): void {
    this.roomHash = roomHash;
    this.peerId = peerId;

    const clientId = buildMqttClientId(peerId);
    this.mqttClient = new Paho.Client(MQTT_BROKER_URL, clientId);

    this.mqttClient.onMessageArrived = (message: Paho.Message) => {
      try {
        const packet = JSON.parse(message.payloadString) as SignalingPacket;
        this.onMessage(packet);
      } catch {
        // ignore
      }
    };


    this.mqttClient.connect({
      useSSL: true,
      timeout: 15,
      keepAliveInterval: 0,
      reconnect: true,

      onSuccess: () => {
        this.handleConnectSuccess();
      },
      onFailure: (err) => {
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
    this.clearPingInterval();

    if (this.mqttClient?.isConnected()) {
      try {
        this.mqttClient.disconnect();
      } catch {
        // ignore disconnect errors
      }
    }

    this.mqttClient = null;
  }

  isConnected(): boolean {
    return this.mqttClient?.isConnected() ?? false;
  }

  private handleConnectSuccess(): void {
    const topic = buildRoomTopic(this.roomHash);
    this.mqttClient!.subscribe(topic);
    this.publish(SIGNAL_TYPE.JOIN, { peerId: this.peerId });
    this.startPingInterval();
  }

  private startPingInterval(): void {
    this.pingIntervalRef = setInterval(() => {
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
}
