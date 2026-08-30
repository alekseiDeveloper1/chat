import { WebRTCNetworkService } from '@/data/network/WebRTCNetworkService';
import { router } from 'expo-router';

type MockPeerConnection = {
  __emitIceConnectionStateChange: (state: string) => void;
};

const getMockPeerConnections = (): MockPeerConnection[] =>
  (global as unknown as { __mockPeerConnections: MockPeerConnection[] }).__mockPeerConnections;

describe('WebRTCNetworkService (P2P Транспорт)', () => {
  let networkService: WebRTCNetworkService;

  beforeEach(() => {
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

  it('должен выбрасывать ошибку при попытке отправить данные без подключения', async () => {
    await expect(networkService.sendData('test-payload')).rejects.toThrow(
      'Нет активного P2P соединения'
    );
  });
});
