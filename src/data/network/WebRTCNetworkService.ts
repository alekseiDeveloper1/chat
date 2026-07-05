import { registerGlobals, RTCPeerConnection } from 'react-native-webrtc';
import { INetworkService, ConnectionStatus } from '@/domain/services/INetworkService';
import { IStrictDataChannel, IStrictPeerConnection, SignalingPacket } from './webrtcTypes';
import {
  DATA_CHANNEL_LABEL,
  DATA_CHANNEL_OPTIONS,
  ICE_BATCH_DELAY_MS,
  RTC_CONFIGURATION,
  SIGNAL_TYPE,
  generatePeerId,
} from './networkConstants';
import {MqttSignalingService} from "@/data/network/MqttSignalingService";
registerGlobals();

export class WebRTCNetworkService implements INetworkService {
  private peerConnection: IStrictPeerConnection | null = null;
  private dataChannel: IStrictDataChannel | null = null;
  private mqttSignaling: MqttSignalingService | null = null;

  private statusCallback: ((status: ConnectionStatus) => void) | null = null;
  private dataCallback: ((payload: string) => void) | null = null;

  private roomHash: string = '';
  private myPeerId = generatePeerId();
  private isInitiator = false;
  private localIceBuffer: unknown[] = [];
  private iceTimeoutRef: ReturnType<typeof setTimeout> | null = null;

  onStatusChanged(callback: (status: ConnectionStatus) => void): void {
    this.statusCallback = callback;
  }

  onDataReceived(callback: (payload: string) => void): void {
    this.dataCallback = callback;
  }

  async connect(roomHash: string): Promise<void> {
    this.roomHash = roomHash;
    this.updateStatus('signaling');

    try {
      this.peerConnection = new RTCPeerConnection(RTC_CONFIGURATION) as unknown as IStrictPeerConnection;
    } catch (nativeError) {
      console.error(`[CRITICAL ERROR] Нативный конструктор WebRTC рухнул:`, nativeError);
      throw nativeError;
    }

    this.setupPeerConnectionListeners();
    this.initMqtt();
  }


  private setupPeerConnectionListeners(): void {
    this.peerConnection?.addEventListener('icecandidate', (event) => {
      if (!event.candidate) {
        return;
      }

      this.localIceBuffer.push(event.candidate);

      if (this.iceTimeoutRef) clearTimeout(this.iceTimeoutRef);

      this.iceTimeoutRef = setTimeout(() => {
        if (this.localIceBuffer.length > 0) {
          this.mqttSignaling?.publish(SIGNAL_TYPE.ICE_BATCH, this.localIceBuffer);
          this.localIceBuffer = [];
        }
      }, ICE_BATCH_DELAY_MS);
    });

    this.peerConnection?.addEventListener('iceconnectionstatechange', () => {
      if (!this.peerConnection) return;
      const state = this.peerConnection.iceConnectionState;

      if (state === 'connected') {
        this.updateStatus('connected');
        this.mqttSignaling?.disconnect()
      }

      if (state === 'failed') {
        console.error('[WebRTC] Соединение ICE упало в статус FAILED');
        this.updateStatus('failed');
      }
    });

    this.peerConnection?.addEventListener('datachannel', (event) => {
      if (event.channel) {
        this.setupDataChannel(event.channel);
      }
    });
  }

  private initMqtt() {
    this.mqttSignaling = new MqttSignalingService(
      (packet) => this.handleSignalingPacket(packet),
      (err) => {
        console.error('[SIGNALLING] Ошибка сигналинга MQTT:', err);
        this.updateStatus('failed');
      },
    );
    this.mqttSignaling.connect(this.roomHash, this.myPeerId);
  }

  private async handleSignalingPacket(packet: SignalingPacket): Promise<void> {
    if (String(packet.senderId) === String(this.myPeerId)) {
      return; // Игнорируем собственные эхо-сообщения из брокера
    }

    if (!this.peerConnection) {
      console.warn(`[SIGNALLING] Получен пакет ${packet.type}, но peerConnection равен null`);
      return;
    }


    try {
      await this.dispatchSignalingPacket(packet);
    } catch (error) {
      console.error(`[SIGNALLING] Критическая ошибка обработки пакета [${packet.type}]:`, error);
    }
  }

  private async dispatchSignalingPacket(packet: SignalingPacket): Promise<void> {
    if (!this.peerConnection) return;

    switch (packet.type) {
      case SIGNAL_TYPE.ICE_BATCH:
        await this.handleIceBatch(packet);
        break;
      case SIGNAL_TYPE.JOIN:
        await this.handleJoin(packet);
        break;
      case SIGNAL_TYPE.HELLO:
        await this.handleHello(packet);
        break;
      case SIGNAL_TYPE.OFFER:
        await this.handleOffer(packet);
        break;
      case SIGNAL_TYPE.ANSWER:
        await this.handleAnswer(packet);
        break;
      default:
        if (packet.type.startsWith('ice_') && !packet.type.endsWith(this.myPeerId)) {
          await this.peerConnection.addIceCandidate(packet.payload).catch((e) => console.warn('[ICE] Ошибка добавления единичного кандидата:', e));
        }
        break;
    }
  }

  private async handleIceBatch(packet: SignalingPacket): Promise<void> {
    if (!this.peerConnection || !Array.isArray(packet.payload)) return;

    for (const candidate of packet.payload) {
      await this.peerConnection.addIceCandidate(candidate).catch((e) => console.warn('[ICE] Нативный отказ добавления кандидата:', e));
    }
  }

  private async handleJoin(packet: SignalingPacket): Promise<void> {
    if (this.dataChannel || !this.peerConnection) {
      return;
    }

    this.isInitiator = Number(this.myPeerId) > Number(packet.senderId);

    if (this.isInitiator) {
      await this.createOfferAsInitiator();
    } else {
      this.mqttSignaling?.publish(SIGNAL_TYPE.HELLO, { peerId: this.myPeerId });
    }
  }

  private async createOfferAsInitiator(): Promise<void> {
    if (!this.peerConnection) return;
    const channel = this.peerConnection.createDataChannel(DATA_CHANNEL_LABEL, DATA_CHANNEL_OPTIONS);
    this.setupDataChannel(channel);
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    this.mqttSignaling?.publish(SIGNAL_TYPE.OFFER, offer);
  }

  private async handleHello(packet: SignalingPacket): Promise<void> {
    if (this.dataChannel || !this.peerConnection || this.peerConnection.remoteDescription) {
      return;
    }

    this.isInitiator = Number(this.myPeerId) > Number(packet.senderId);

    if (this.isInitiator) {
      await this.createOfferAsInitiator();
    }
  }

  private async handleOffer(packet: SignalingPacket): Promise<void> {
    if (this.isInitiator || !this.peerConnection || this.peerConnection.remoteDescription) {
      console.warn('[SIGNALLING] Пакет OFFER отклонен: я инициатор или RemoteDescription уже задан');
      return;
    }

    await this.peerConnection.setRemoteDescription(packet.payload);

    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);

    this.mqttSignaling?.publish(SIGNAL_TYPE.ANSWER, answer);
  }

  private async handleAnswer(packet: SignalingPacket): Promise<void> {
    if (!this.isInitiator || !this.peerConnection || this.peerConnection.remoteDescription) {
      console.warn('[SIGNALLING] Пакет ANSWER отклонен: я не инициатор или RemoteDescription уже задан');
      return;
    }
    await this.peerConnection.setRemoteDescription(packet.payload);
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

  private updateStatus(status: ConnectionStatus) {
    if (this.statusCallback) this.statusCallback(status);
  }
}
