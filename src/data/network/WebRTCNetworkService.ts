import { router } from 'expo-router';
import { registerGlobals, RTCPeerConnection } from 'react-native-webrtc';
import { INetworkService, ConnectionStatus, DisconnectOptions } from '@/domain/services/INetworkService';
import { IStrictDataChannel, IStrictPeerConnection, SignalingPacket } from './webrtcTypes';
import {
  DATA_CHANNEL_LABEL,
  DATA_CHANNEL_OPTIONS,
  ICE_BATCH_DELAY_MS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
  RTC_CONFIGURATION,
  SIGNAL_TYPE,
  generatePeerId,
} from './networkConstants';
import {MqttSignalingService} from "@/data/network/MqttSignalingService";
import { AppLogger, appLogger } from '@/shared/logging/AppLogger';
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
  private reconnectTimeoutRef: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private connectionGeneration = 0;
  private isManualDisconnect = true;

  constructor(private readonly logger: AppLogger = appLogger) {}

  onStatusChanged(callback: (status: ConnectionStatus) => void): void {
    this.statusCallback = callback;
  }

  onDataReceived(callback: (payload: string) => void): void {
    this.dataCallback = callback;
  }

  async connect(roomHash: string): Promise<void> {
    if (!this.isManualDisconnect && (this.peerConnection || this.dataChannel || this.mqttSignaling)) {
      this.logger.warn('webrtc', 'Повторный запуск P2P транспорта при активных ресурсах', {
        context: this.getResourceSnapshot(),
        visibleToUser: true,
      });
    }

    this.roomHash = roomHash;
    this.isManualDisconnect = false;
    this.reconnectAttempt = 0;
    this.clearReconnectTimeout();
    this.logger.info('webrtc', 'P2P транспорт запускается', {
      context: {
        roomFingerprint: this.getRoomFingerprint(),
        peerId: this.myPeerId,
      },
      visibleToUser: true,
    });
    this.startConnection('signaling', true);
  }

  private startConnection(status: ConnectionStatus, rethrowNativeError = false): void {
    this.releaseConnectionResources();
    this.isInitiator = false;
    this.logger.info('webrtc', 'Создание WebRTC PeerConnection', {
      context: {
        ...this.getResourceSnapshot(),
        targetStatus: status,
        rethrowNativeError,
      },
      visibleToUser: true,
    });
    this.updateStatus(status);

    try {
      this.peerConnection = new RTCPeerConnection(RTC_CONFIGURATION) as unknown as IStrictPeerConnection;
    } catch (nativeError) {
      this.logger.error('webrtc', 'Нативный конструктор WebRTC не создал соединение', {
        error: nativeError,
        context: this.getResourceSnapshot(),
        visibleToUser: true,
      });
      this.updateStatus('failed');

      if (!rethrowNativeError && !this.isManualDisconnect) {
        this.scheduleReconnect('native WebRTC constructor failed', this.connectionGeneration, true);
      }

      if (!rethrowNativeError) {
        return;
      }

      throw nativeError;
    }

    this.logger.debug('webrtc', 'WebRTC PeerConnection создан', {
      context: this.getResourceSnapshot(),
    });
    this.setupPeerConnectionListeners(this.connectionGeneration);
    this.initMqtt(this.connectionGeneration);
  }


  private setupPeerConnectionListeners(connectionGeneration: number): void {
    this.peerConnection?.addEventListener('icecandidate', (event) => {
      if (!this.isCurrentConnection(connectionGeneration)) {
        return;
      }

      if (!event.candidate) {
        return;
      }

      this.localIceBuffer.push(event.candidate);

      if (this.iceTimeoutRef) {
        clearTimeout(this.iceTimeoutRef);
        this.iceTimeoutRef = null;
      }

      this.iceTimeoutRef = setTimeout(() => {
        if (this.isCurrentConnection(connectionGeneration) && this.localIceBuffer.length > 0) {
          this.logger.debug('webrtc', 'Отправляется batch ICE кандидатов', {
            context: {
              candidateCount: this.localIceBuffer.length,
              generation: connectionGeneration,
              roomFingerprint: this.getRoomFingerprint(),
            },
          });
          this.mqttSignaling?.publish(SIGNAL_TYPE.ICE_BATCH, this.localIceBuffer);
          this.localIceBuffer = [];
        }
      }, ICE_BATCH_DELAY_MS);
    });

    this.peerConnection?.addEventListener('iceconnectionstatechange', () => {
      if (!this.isCurrentConnection(connectionGeneration) || !this.peerConnection) return;
      const state = this.peerConnection.iceConnectionState;
      this.logger.info('webrtc', `ICE состояние изменилось: ${state}`, {
        context: {
          generation: connectionGeneration,
          reconnectAttempt: this.reconnectAttempt,
          roomFingerprint: this.getRoomFingerprint(),
        },
        visibleToUser: state === 'connected' || state === 'completed' || state === 'failed' || state === 'disconnected',
      });

      if (state === 'connected' || state === 'completed') {
        this.reconnectAttempt = 0;
        this.clearReconnectTimeout();
        this.updateStatus('connected');
        this.logger.info('webrtc', 'Прямое ICE соединение установлено, MQTT сигналинг отключается', {
          context: this.getResourceSnapshot(),
          visibleToUser: true,
        });
        this.mqttSignaling?.disconnect();
        this.mqttSignaling = null;
      }

      if (state === 'failed' || state === 'disconnected') {
        this.logger.warn('webrtc', `ICE соединение потеряно: ${state}`, {
          context: this.getResourceSnapshot(),
          visibleToUser: true,
        });
        this.scheduleReconnect(`ICE ${state}`, connectionGeneration, state === 'failed');
      }
    });

    this.peerConnection?.addEventListener('datachannel', (event) => {
      if (!this.isCurrentConnection(connectionGeneration)) {
        return;
      }

      if (event.channel) {
        this.logger.info('webrtc', 'Получен входящий DataChannel', {
          context: {
            generation: connectionGeneration,
            roomFingerprint: this.getRoomFingerprint(),
          },
          visibleToUser: true,
        });
        this.setupDataChannel(event.channel, connectionGeneration);
      }
    });
  }

  private initMqtt(connectionGeneration: number) {
    this.logger.info('webrtc', 'Запуск MQTT сигналинга для обмена WebRTC пакетами', {
      context: {
        generation: connectionGeneration,
        roomFingerprint: this.getRoomFingerprint(),
      },
      visibleToUser: true,
    });
    this.mqttSignaling = new MqttSignalingService(
      (packet) => {
        if (!this.isCurrentConnection(connectionGeneration)) {
          return;
        }

        return this.handleSignalingPacket(packet);
      },
      (err) => {
        if (!this.isCurrentConnection(connectionGeneration)) {
          return;
        }

        this.logger.error('webrtc', 'Ошибка MQTT сигналинга в WebRTC слое', {
          error: err,
          context: {
            generation: connectionGeneration,
            roomFingerprint: this.getRoomFingerprint(),
          },
          visibleToUser: true,
        });
        this.scheduleReconnect('MQTT signaling failure', connectionGeneration, false);
      },
      this.logger,
    );
    this.mqttSignaling.connect(this.roomHash, this.myPeerId);
  }

  private async handleSignalingPacket(packet: SignalingPacket): Promise<void> {
    if (String(packet.senderId) === String(this.myPeerId)) {
      return;
    }

    if (!this.peerConnection) {
      this.logger.warn('webrtc', `Получен signaling пакет ${packet.type}, но PeerConnection отсутствует`, {
        context: this.getResourceSnapshot(),
        visibleToUser: true,
      });
      return;
    }


    try {
      await this.dispatchSignalingPacket(packet);
    } catch (error) {
      this.logger.error('webrtc', `Критическая ошибка обработки signaling пакета: ${packet.type}`, {
        error,
        context: this.getResourceSnapshot(),
        visibleToUser: true,
      });
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
          await this.peerConnection.addIceCandidate(packet.payload).catch((e) => {
            this.logger.warn('webrtc', 'Ошибка добавления единичного ICE кандидата', {
              error: e,
              context: this.getResourceSnapshot(),
            });
          });
        }
        break;
    }
  }

  private async handleIceBatch(packet: SignalingPacket): Promise<void> {
    if (!this.peerConnection || !Array.isArray(packet.payload)) return;

    this.logger.debug('webrtc', 'Обработка batch ICE кандидатов', {
      context: {
        candidateCount: packet.payload.length,
        roomFingerprint: this.getRoomFingerprint(),
      },
    });

    for (const candidate of packet.payload) {
      await this.peerConnection.addIceCandidate(candidate).catch((e) => {
        this.logger.warn('webrtc', 'Ошибка добавления ICE кандидата из batch', {
          error: e,
          context: this.getResourceSnapshot(),
        });
      });
    }
  }

  private async handleJoin(packet: SignalingPacket): Promise<void> {
    if (this.dataChannel || !this.peerConnection) {
      return;
    }

    this.isInitiator = Number(this.myPeerId) > Number(packet.senderId);
    this.logger.info('webrtc', 'Обнаружен участник комнаты', {
      context: {
        generation: this.connectionGeneration,
        isInitiator: this.isInitiator,
        roomFingerprint: this.getRoomFingerprint(),
      },
      visibleToUser: true,
    });

    if (this.isInitiator) {
      await this.createOfferAsInitiator();
    } else {
      this.mqttSignaling?.publish(SIGNAL_TYPE.HELLO, { peerId: this.myPeerId });
    }
  }

  private async createOfferAsInitiator(): Promise<void> {
    if (!this.peerConnection) return;
    this.logger.info('webrtc', 'Создание WebRTC offer как инициатор', {
      context: this.getResourceSnapshot(),
      visibleToUser: true,
    });
    const channel = this.peerConnection.createDataChannel(DATA_CHANNEL_LABEL, DATA_CHANNEL_OPTIONS);
    this.setupDataChannel(channel, this.connectionGeneration);
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    this.mqttSignaling?.publish(SIGNAL_TYPE.OFFER, offer);
  }

  private async handleHello(packet: SignalingPacket): Promise<void> {
    if (this.dataChannel || !this.peerConnection || this.peerConnection.remoteDescription) {
      return;
    }

    this.isInitiator = Number(this.myPeerId) > Number(packet.senderId);
    this.logger.info('webrtc', 'Получен HELLO от участника комнаты', {
      context: {
        generation: this.connectionGeneration,
        isInitiator: this.isInitiator,
        roomFingerprint: this.getRoomFingerprint(),
      },
      visibleToUser: true,
    });

    if (this.isInitiator) {
      await this.createOfferAsInitiator();
    }
  }

  private async handleOffer(packet: SignalingPacket): Promise<void> {
    if (this.isInitiator || !this.peerConnection || this.peerConnection.remoteDescription) {
      this.logger.warn('webrtc', 'Пакет OFFER отклонен', {
        context: {
          ...this.getResourceSnapshot(),
          isInitiator: this.isInitiator,
          hasRemoteDescription: Boolean(this.peerConnection?.remoteDescription),
        },
        visibleToUser: true,
      });
      return;
    }

    this.logger.info('webrtc', 'Получен WebRTC offer, создается answer', {
      context: this.getResourceSnapshot(),
      visibleToUser: true,
    });
    await this.peerConnection.setRemoteDescription(packet.payload);

    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);

    this.mqttSignaling?.publish(SIGNAL_TYPE.ANSWER, answer);
  }

  private async handleAnswer(packet: SignalingPacket): Promise<void> {
    if (!this.isInitiator || !this.peerConnection || this.peerConnection.remoteDescription) {
      this.logger.warn('webrtc', 'Пакет ANSWER отклонен', {
        context: {
          ...this.getResourceSnapshot(),
          isInitiator: this.isInitiator,
          hasRemoteDescription: Boolean(this.peerConnection?.remoteDescription),
        },
        visibleToUser: true,
      });
      return;
    }
    this.logger.info('webrtc', 'Получен WebRTC answer', {
      context: this.getResourceSnapshot(),
      visibleToUser: true,
    });
    await this.peerConnection.setRemoteDescription(packet.payload);
  }

  private setupDataChannel(channel: IStrictDataChannel, connectionGeneration: number) {
    this.dataChannel = channel;
    this.logger.info('webrtc', 'DataChannel настроен', {
      context: {
        generation: connectionGeneration,
        roomFingerprint: this.getRoomFingerprint(),
      },
      visibleToUser: true,
    });
    channel.addEventListener('message', (event) => {
      if (!this.isCurrentConnection(connectionGeneration)) {
        return;
      }

      if (this.dataCallback && event.data) this.dataCallback(event.data);
    });
    channel.addEventListener('open', () => {
      if (!this.isCurrentConnection(connectionGeneration)) {
        return;
      }

      this.reconnectAttempt = 0;
      this.clearReconnectTimeout();
      this.logger.info('webrtc', 'Прямой канал сообщений открыт', {
        context: this.getResourceSnapshot(),
        visibleToUser: true,
      });
      this.updateStatus('connected');
    });
    channel.addEventListener('close', () => {
      if (!this.isCurrentConnection(connectionGeneration)) {
        return;
      }

      if (this.dataChannel === channel) {
        this.dataChannel = null;
      }

      this.logger.warn('webrtc', 'DataChannel закрылся', {
        context: this.getResourceSnapshot(),
        visibleToUser: true,
      });
      this.scheduleReconnect('data channel closed', connectionGeneration, false);
    });
  }

  async sendData(payload: string): Promise<void> {
    if (!this.dataChannel) {
      this.logger.error('webrtc', 'Отправка невозможна: нет активного P2P соединения', {
        context: this.getResourceSnapshot(),
        visibleToUser: true,
      });
      throw new Error('Нет активного P2P соединения');
    }

    this.dataChannel.send(payload);
    this.logger.debug('webrtc', 'Данные отправлены через DataChannel', {
      context: this.getResourceSnapshot(),
    });
  }

  disconnect(options: DisconnectOptions = {}):void {
    this.isManualDisconnect = true;
    this.logger.info('webrtc', 'P2P транспорт отключается', {
      context: {
        ...this.getResourceSnapshot(),
        reason: options.reason ?? 'manual',
      },
      visibleToUser: options.reason !== 'screen_unmount',
    });
    this.roomHash = '';
    this.reconnectAttempt = 0;
    this.clearReconnectTimeout();
    this.releaseConnectionResources();

    if (options.reason === 'screen_unmount') {
      this.statusCallback = null;
      this.dataCallback = null;
    } else {
      this.updateStatus('disconnected');
    }

    if (options.navigateHome ?? true) {
      router.replace('/');
    }
  }

  private scheduleReconnect(reason: string, connectionGeneration: number, immediate: boolean): void {
    if (!this.isCurrentConnection(connectionGeneration) || this.reconnectTimeoutRef) {
      return;
    }

    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      this.logger.error('webrtc', `Попытки восстановления исчерпаны: ${reason}`, {
        context: this.getResourceSnapshot(),
        visibleToUser: true,
      });
      this.releaseConnectionResources();
      this.updateStatus('failed');
      return;
    }

    const attempt = this.reconnectAttempt + 1;
    const delayMs = immediate
      ? 0
      : Math.min(RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_DELAY_MS);

    this.reconnectAttempt = attempt;
    this.updateStatus('connecting');
    this.logger.warn('webrtc', `Запланировано восстановление соединения: ${reason}`, {
      context: {
        ...this.getResourceSnapshot(),
        attempt,
        delayMs,
      },
      visibleToUser: true,
    });

    this.reconnectTimeoutRef = setTimeout(() => {
      this.reconnectTimeoutRef = null;

      if (!this.isCurrentConnection(connectionGeneration)) {
        return;
      }

      this.logger.warn('webrtc', `Попытка восстановления ${attempt}/${RECONNECT_MAX_ATTEMPTS}: ${reason}`, {
        context: this.getResourceSnapshot(),
        visibleToUser: true,
      });
      this.startConnection('connecting');
    }, delayMs);
  }

  private releaseConnectionResources(): void {
    const hadResources = Boolean(this.mqttSignaling || this.dataChannel || this.peerConnection || this.iceTimeoutRef);
    const previousSnapshot = this.getResourceSnapshot();
    this.connectionGeneration += 1;
    this.clearIceTimeout();
    this.localIceBuffer = [];

    const mqttSignaling = this.mqttSignaling;
    const dataChannel = this.dataChannel;
    const peerConnection = this.peerConnection;

    this.mqttSignaling = null;
    this.dataChannel = null;
    this.peerConnection = null;

    mqttSignaling?.disconnect();

    try {
      dataChannel?.close();
    } catch {
      // ignore close errors
    }

    try {
      peerConnection?.close();
    } catch {
      // ignore close errors
    }

    if (hadResources) {
      this.logger.debug('webrtc', 'Ресурсы соединения освобождены', {
        context: previousSnapshot,
      });
    }
  }

  private isCurrentConnection(connectionGeneration: number): boolean {
    return !this.isManualDisconnect && connectionGeneration === this.connectionGeneration;
  }

  private clearIceTimeout(): void {
    if (this.iceTimeoutRef) {
      clearTimeout(this.iceTimeoutRef);
      this.iceTimeoutRef = null;
    }
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeoutRef) {
      clearTimeout(this.reconnectTimeoutRef);
      this.reconnectTimeoutRef = null;
    }
  }

  private updateStatus(status: ConnectionStatus) {
    this.logger.info('webrtc', `Статус P2P изменен: ${status}`, {
      context: this.getResourceSnapshot(),
      visibleToUser: status !== 'disconnected',
    });
    if (this.statusCallback) this.statusCallback(status);
  }

  private getRoomFingerprint(): string | null {
    return this.roomHash ? this.roomHash.slice(0, 8) : null;
  }

  private getResourceSnapshot() {
    return {
      generation: this.connectionGeneration,
      roomFingerprint: this.getRoomFingerprint(),
      peerId: this.myPeerId,
      reconnectAttempt: this.reconnectAttempt,
      hasPeerConnection: Boolean(this.peerConnection),
      hasDataChannel: Boolean(this.dataChannel),
      hasMqtt: Boolean(this.mqttSignaling),
      hasIceTimer: Boolean(this.iceTimeoutRef),
      hasReconnectTimer: Boolean(this.reconnectTimeoutRef),
    };
  }
}
