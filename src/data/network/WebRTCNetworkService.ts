import { registerGlobals, RTCPeerConnection } from 'react-native-webrtc';
import Paho from 'paho-mqtt';
import { INetworkService, ConnectionStatus } from '@/domain/services/INetworkService';

registerGlobals();

interface IStrictDataChannel {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  addEventListener(type: 'open' | 'close', listener: () => void): void;
}

interface IStrictPeerConnection {
  iceConnectionState: string;
  localDescription: any;
  remoteDescription: any;
  close(): void;
  createDataChannel(label: string, options?: object): IStrictDataChannel;
  createOffer(options?: object): Promise<any>;
  createAnswer(options?: object): Promise<any>;
  setLocalDescription(desc: any): Promise<void>;
  setRemoteDescription(desc: any): Promise<void>;
  addIceCandidate(candidate: any): Promise<void>;
  addEventListener(type: 'iceconnectionstatechange', listener: () => void): void;
  addEventListener(type: 'icecandidate', listener: (event: { candidate: any }) => void): void;
  addEventListener(type: 'datachannel', listener: (event: { channel: IStrictDataChannel }) => void): void;
}

export class WebRTCNetworkService implements INetworkService {
  private peerConnection: IStrictPeerConnection | null = null;
  private dataChannel: IStrictDataChannel | null = null;

  private statusCallback: ((status: ConnectionStatus) => void) | null = null;
  private dataCallback: ((payload: string) => void) | null = null;


  private roomHash: string = '';
  private mqttClient: Paho.Client | null = null;
  private myPeerId = Math.floor(Math.random() * 1000000).toString();
  private isInitiator = false;
  private localIceBuffer: any[] = [];
  private iceTimeoutRef: any = null;
  onStatusChanged(callback: (status: ConnectionStatus) => void): void {
    this.statusCallback = callback;
  }

  onDataReceived(callback: (payload: string) => void): void {
    this.dataCallback = callback;
  }

  async connect(roomHash: string): Promise<void> {
    this.roomHash = roomHash;
    this.updateStatus('signaling');

    const configuration = {
      iceServers: [
        {
          urls: [
            'stun:stun.l.google.com:19302'
          ]
        }
      ]
    };

    try {
      this.peerConnection = new RTCPeerConnection(configuration) as unknown as IStrictPeerConnection;
    } catch (nativeError) {
      console.error(`[CRITICAL ERROR] Нативный конструктор WebRTC рухнул:`, nativeError);
      throw nativeError;
    }

    this.peerConnection.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        this.localIceBuffer.push(event.candidate);

        if (this.iceTimeoutRef) clearTimeout(this.iceTimeoutRef);

        this.iceTimeoutRef = setTimeout(() => {
          if (this.localIceBuffer.length > 0) {
            this.publishMqttSignal('ice_batch', this.localIceBuffer);
            this.localIceBuffer = [];
          }
        }, 300);
      }
    });

    this.peerConnection.addEventListener('iceconnectionstatechange', () => {
      if (!this.peerConnection) return;
      const state = this.peerConnection.iceConnectionState;

      if (state === 'connected') {
        this.updateStatus('connected');
        this.disconnectMqtt();
      }
      if (state === 'failed') this.updateStatus('failed');
    });

    this.peerConnection.addEventListener('datachannel', (event) => {
      if (event.channel) this.setupDataChannel(event.channel);
    });

    this.initMqtt();
  }


  private initMqtt() {
    const clientId = `expo_chat_${this.myPeerId}_${Math.random().toString(36).substring(7)}`;

      const wssUrl = `wss://broker.hivemq.com:8884/mqtt`;

      this.mqttClient = new Paho.Client(wssUrl, clientId);

    this.mqttClient.onMessageArrived = async (message: Paho.Message) => {
      try {
        const rawPayload = message.payloadString;
        const packet = JSON.parse(rawPayload);

        if (String(packet.senderId) === String(this.myPeerId) || !this.peerConnection) {
          return;
        }

        if (packet.type === 'ice_batch' && Array.isArray(packet.payload)) {

          for (const candidate of packet.payload) {
            if (this.peerConnection.remoteDescription) {
              await this.peerConnection.addIceCandidate(candidate);
            }
          }
        }

        if (packet.type === 'join' && !this.dataChannel) {
          this.isInitiator = Number(this.myPeerId) > Number(packet.senderId);

          if (this.isInitiator) {
            const channel = this.peerConnection.createDataChannel('chat-channel', { ordered: true });
            this.setupDataChannel(channel);

            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);
            this.publishMqttSignal('offer', offer);
          } else {
            this.publishMqttSignal('hello', { peerId: this.myPeerId });
          }
        }

        else if (packet.type === 'hello' && !this.dataChannel && !this.peerConnection.remoteDescription) {
          this.isInitiator = Number(this.myPeerId) > Number(packet.senderId);

          if (this.isInitiator) {
            const channel = this.peerConnection.createDataChannel('chat-channel', { ordered: true });
            this.setupDataChannel(channel);

            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);
            this.publishMqttSignal('offer', offer);
          }
        }


        if (packet.type === 'offer' && !this.isInitiator && !this.peerConnection.remoteDescription) {
          await this.peerConnection.setRemoteDescription(packet.payload);
          const answer = await this.peerConnection.createAnswer();
          await this.peerConnection.setLocalDescription(answer);
          this.publishMqttSignal('answer', answer);
        }

        if (packet.type === 'answer' && this.isInitiator && !this.peerConnection.remoteDescription) {
          await this.peerConnection.setRemoteDescription(packet.payload);
        }

        if (packet.type.startsWith('ice_') && !packet.type.endsWith(this.myPeerId)) {
          await this.peerConnection.addIceCandidate(packet.payload);
        }

      } catch (e) { }
    };

    this.mqttClient.connect({
      useSSL: true,
      timeout: 10,
      keepAliveInterval: 0,
      reconnect: true,

      onSuccess: () => {
        const topic = `p2p_chat_room_${this.roomHash}`;
        this.mqttClient!.subscribe(topic);

        this.publishMqttSignal('join', { peerId: this.myPeerId });

        const pingInterval = setInterval(() => {
          if (this.mqttClient && this.mqttClient.isConnected()) {
            this.publishMqttSignal('ping', {});
          } else {
            clearInterval(pingInterval); // Если отключились, чистим таймер
          }
        }, 30000);
      },
      onFailure: (err) => {
        console.error('[MQTT CONN FAILED] Не удалось подключиться:', err.errorMessage);
        this.updateStatus('failed');
      }
    });


  }

  private publishMqttSignal(type: string, payload: any) {
    if (!this.mqttClient || !this.mqttClient.isConnected()) return;

    const topic = `p2p_chat_room_${this.roomHash}`;
    const messageBody = JSON.stringify({
      senderId: this.myPeerId,
      type,
      payload
    });

    const message = new Paho.Message(messageBody);
    message.destinationName = topic;
    message.qos = 1;

    this.mqttClient.send(message);
  }

  private setupDataChannel(channel: IStrictDataChannel) {
    this.dataChannel = channel;
    channel.addEventListener('message', (event) => {
      if (this.dataCallback && event.data) this.dataCallback(event.data);
    });
    channel.addEventListener('open', () => this.updateStatus('connected'));
    channel.addEventListener('close', () => this.updateStatus('disconnected'));
  }

  async sendData(payload: string): Promise<void> {
    if (!this.dataChannel) throw new Error('Нет активного P2P соединения');
    this.dataChannel.send(payload);
  }

  private disconnectMqtt() {
    if (this.mqttClient && this.mqttClient.isConnected()) {
      try {
        this.mqttClient.disconnect();
      } catch (e) { }
    }
    this.mqttClient = null;
  }

  async disconnect(): Promise<void> {
    this.disconnectMqtt();
    if (this.dataChannel) this.dataChannel.close();
    if (this.peerConnection) this.peerConnection.close();
    this.dataChannel = null;
    this.peerConnection = null;
    this.updateStatus('disconnected');
  }

  private updateStatus(status: ConnectionStatus) {
    if (this.statusCallback) this.statusCallback(status);
  }
}
