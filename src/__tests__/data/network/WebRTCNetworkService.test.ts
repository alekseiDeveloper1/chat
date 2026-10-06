import { WebRTCNetworkService } from '@/data/network/WebRTCNetworkService';
import { router } from 'expo-router';
import { MAX_BUFFERED_AMOUNT } from '@/data/network/DataChannelTransport';
import { RTCPeerConnection } from 'react-native-webrtc';
import { RECONNECT_MAX_ATTEMPTS } from '@/data/network/networkConstants';

type MockDataChannel = {
  readyState: string;
  bufferedAmount: number;
  send: jest.Mock;
  __emit: (type: string, event?: unknown) => void;
};

type MockPeerConnection = {
  __emitIceConnectionStateChange: (state: string) => void;
  __emitDataChannel: () => MockDataChannel;
};

const getMockPeerConnections = (): MockPeerConnection[] =>
  (global as unknown as { __mockPeerConnections: MockPeerConnection[] }).__mockPeerConnections;

describe('WebRTCNetworkService (P2P Транспорт)', () => {
  let networkService: WebRTCNetworkService;

  beforeEach(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    networkService = new WebRTCNetworkService();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('должен корректно инициализироваться в статусе disconnected', () => {
    let currentStatus: string = '';
    networkService.onStatusChanged((status) => {
      currentStatus = status;
    });
    
    expect(currentStatus).toBe('');
  });

  it('должен пробовать восстановить транспорт при неожиданной потере ICE', async () => {
    jest.useFakeTimers();
    const statuses: string[] = [];

    networkService.onStatusChanged((status) => {
      statuses.push(status);
    });

    await networkService.connect('room-hash');
    const [firstPeerConnection] = getMockPeerConnections();

    firstPeerConnection.__emitIceConnectionStateChange('failed');

    expect(statuses).toContain('connecting');
    expect(router.replace).not.toHaveBeenCalled();
    expect(getMockPeerConnections()).toHaveLength(1);

    jest.runOnlyPendingTimers();

    expect(getMockPeerConnections()).toHaveLength(2);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('keeps reconnecting through a transient native constructor failure', async () => {
    jest.useFakeTimers();
    const onStatus = jest.fn();
    networkService.onStatusChanged(onStatus);
    await networkService.connect('room-hash');
    jest.mocked(RTCPeerConnection).mockImplementationOnce(() => {
      throw new Error('Temporary native failure');
    });

    getMockPeerConnections()[0].__emitIceConnectionStateChange('failed');
    jest.advanceTimersToNextTimer();

    expect(getMockPeerConnections()).toHaveLength(1);
    expect(onStatus).not.toHaveBeenCalledWith('failed');
    expect(onStatus).toHaveBeenLastCalledWith('connecting');

    jest.advanceTimersToNextTimer();
    expect(getMockPeerConnections()).toHaveLength(2);
    getMockPeerConnections()[1].__emitIceConnectionStateChange('connected');
    expect(onStatus).toHaveBeenLastCalledWith('connected');
    expect(onStatus).not.toHaveBeenCalledWith('failed');
    networkService.disconnect({ navigateHome: false });
  });

  it('reports terminal failure only after all native constructor retries are exhausted', async () => {
    jest.useFakeTimers();
    const onStatus = jest.fn();
    networkService.onStatusChanged(onStatus);
    await networkService.connect('room-hash');
    for (let attempt = 0; attempt < RECONNECT_MAX_ATTEMPTS; attempt += 1) {
      jest.mocked(RTCPeerConnection).mockImplementationOnce(() => {
        throw new Error('Native constructor unavailable');
      });
    }

    getMockPeerConnections()[0].__emitIceConnectionStateChange('failed');
    jest.runAllTimers();

    expect(RTCPeerConnection).toHaveBeenCalledTimes(RECONNECT_MAX_ATTEMPTS + 1);
    expect(onStatus.mock.calls.filter(([status]) => status === 'failed')).toHaveLength(1);
    expect(onStatus).toHaveBeenLastCalledWith('failed');
    expect(jest.getTimerCount()).toBe(0);
    networkService.disconnect({ navigateHome: false });
  });

  it('должен выбрасывать ошибку при попытке отправить данные без подключения', async () => {
    await expect(networkService.sendData('test-payload')).rejects.toThrow(
      'Нет активного P2P соединения'
    );
  });

  it('собирает фрагменты перед передачей зашифрованных данных подписчику', async () => {
    jest.useFakeTimers();
    const onData = jest.fn();
    networkService.onDataReceived(onData);
    await networkService.connect('room-hash');
    const channel = getMockPeerConnections()[0].__emitDataChannel();
    const chunk = (offset: number, data: string) => '!chat-chunk-v1!' + JSON.stringify({
      id: 'attachment', offset, total: 6, data,
    });
    channel.__emit('message', { data: chunk(0, 'abc') });
    expect(onData).not.toHaveBeenCalled();
    channel.__emit('message', { data: chunk(3, 'def') });
    expect(onData).toHaveBeenCalledWith('abcdef');
    channel.__emit('message', { data: '!chat-chunk-v1!broken' });
    expect(onData).toHaveBeenCalledTimes(1);
    networkService.disconnect({ navigateHome: false });
  });

  it.each(['close', 'error', 'disconnect', 'reconnect'])(
    'отменяет ожидающую отправку при %s и игнорирует старый канал', async (cause) => {
      jest.useFakeTimers();
      const onData = jest.fn();
      const onStatus = jest.fn();
      networkService.onDataReceived(onData);
      networkService.onStatusChanged(onStatus);
      await networkService.connect('room-hash');
      const channel = getMockPeerConnections()[0].__emitDataChannel();
      channel.bufferedAmount = MAX_BUFFERED_AMOUNT;
      const rejected = expect(networkService.sendData('payload')).rejects.toThrow('прервано');
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
      if (cause === 'disconnect') networkService.disconnect({ navigateHome: false });
      else if (cause === 'reconnect') await networkService.connect('new-room');
      else channel.__emit(cause);
      await rejected;
      const statusCount = onStatus.mock.calls.length;
      channel.__emit('message', { data: 'stale' });
      channel.__emit('open');
      expect(channel.send).not.toHaveBeenCalled();
      expect(onData).not.toHaveBeenCalled();
      expect(onStatus).toHaveBeenCalledTimes(statusCount);
      networkService.disconnect({ navigateHome: false });
    },
  );
});
