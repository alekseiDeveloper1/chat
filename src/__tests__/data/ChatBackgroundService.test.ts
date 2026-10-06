import type { ChatBackgroundService } from '@/data/notifications/ChatBackgroundService';

let mockPlatform = 'android';
let mockAppState = 'active';
let mockRunning = false;
let mockModuleLoads = 0;
const mockTasks: Promise<void>[] = [];
const mockBackgroundActions = {
  start: jest.fn(),
  stop: jest.fn(),
  isRunning: jest.fn(() => mockRunning),
};

jest.mock('react-native', () => ({
  Platform: { get OS() { return mockPlatform; } },
  AppState: { get currentState() { return mockAppState; } },
}));

jest.mock('react-native-background-actions', () => {
  mockModuleLoads += 1;
  return { __esModule: true, default: mockBackgroundActions };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('ChatBackgroundService', () => {
  let Service: typeof ChatBackgroundService;

  beforeEach(() => {
    jest.resetModules();
    mockPlatform = 'android';
    mockAppState = 'active';
    mockRunning = false;
    mockModuleLoads = 0;
    mockTasks.length = 0;
    mockBackgroundActions.start.mockReset().mockImplementation(async (task: () => Promise<void>) => {
      const result = task();
      mockTasks.push(result);
      // Match v4: settling a task automatically stops the singleton service.
      void result.then(() => mockBackgroundActions.stop());
      mockRunning = true;
    });
    mockBackgroundActions.stop.mockReset().mockImplementation(async () => { mockRunning = false; });
    mockBackgroundActions.isRunning.mockClear();
    Service = jest.requireActual<typeof import('@/data/notifications/ChatBackgroundService')>(
      '@/data/notifications/ChatBackgroundService',
    ).ChatBackgroundService;
  });

  it.each(['ios', 'web'])('does not load the native service on %s', async (platform) => {
    mockPlatform = platform;
    const service = new Service();
    await service.start();
    await service.stop();
    expect(mockModuleLoads).toBe(0);
  });

  it('starts one visible Android service and stops it on leaving the room', async () => {
    const service = new Service();
    await Promise.all([service.start(), service.start()]);
    expect(mockBackgroundActions.start).toHaveBeenCalledTimes(1);
    expect(mockBackgroundActions.start).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      linkingURI: 'chat://',
      taskIcon: { name: 'ic_launcher', type: 'mipmap' },
    }));
    await Promise.all([service.stop(), service.stop()]);
    expect(mockBackgroundActions.stop).toHaveBeenCalledTimes(1);
    expect(mockRunning).toBe(false);
  });

  it('rejects a start after the activity has moved to the background', async () => {
    const service = new Service();
    mockAppState = 'background';
    await expect(service.start()).rejects.toThrow('откройте приложение');
    expect(mockBackgroundActions.start).not.toHaveBeenCalled();
    mockAppState = 'active';
    await service.start();
    await service.stop();
    expect(mockBackgroundActions.start).toHaveBeenCalledTimes(1);
  });

  it('waits for a pending start and stop before quickly joining again', async () => {
    const service = new Service();
    const startGate = deferred();
    const stopGate = deferred();
    mockBackgroundActions.start.mockImplementationOnce(async () => {
      await startGate.promise;
      mockRunning = true;
    });
    mockBackgroundActions.stop.mockImplementationOnce(async () => {
      await stopGate.promise;
      mockRunning = false;
    });
    const firstStart = service.start();
    const leaving = service.stop();
    const rejoining = service.start();
    await Promise.resolve();
    expect(mockBackgroundActions.start).toHaveBeenCalledTimes(1);
    expect(mockBackgroundActions.stop).not.toHaveBeenCalled();
    startGate.resolve();
    await firstStart;
    await Promise.resolve();
    expect(mockBackgroundActions.stop).toHaveBeenCalledTimes(1);
    expect(mockBackgroundActions.start).toHaveBeenCalledTimes(1);
    stopGate.resolve();
    await Promise.all([leaving, rejoining]);
    expect(mockBackgroundActions.start).toHaveBeenCalledTimes(2);
    expect(mockRunning).toBe(true);
    await service.stop();
  });

  it('does not settle an old task and accidentally stop a new room', async () => {
    const service = new Service();
    await service.start();
    const oldTaskSettled = jest.fn();
    void mockTasks[0].then(oldTaskSettled);
    await service.stop();
    await service.start();
    await Promise.resolve();
    expect(oldTaskSettled).not.toHaveBeenCalled();
    expect(mockBackgroundActions.stop).toHaveBeenCalledTimes(1);
    expect(mockRunning).toBe(true);
    await service.stop();
  });

  it('protects a remounted hook from the previous hook cleanup', async () => {
    const previous = new Service();
    const current = new Service();
    await previous.start();
    await current.start();
    await previous.stop();
    expect(mockBackgroundActions.stop).not.toHaveBeenCalled();
    expect(mockBackgroundActions.start).toHaveBeenCalledTimes(1);
    expect(mockRunning).toBe(true);
    await current.stop();
    expect(mockBackgroundActions.stop).toHaveBeenCalledTimes(1);
  });

  it('propagates native failures and allows a later start or stop retry', async () => {
    const service = new Service();
    mockBackgroundActions.start.mockRejectedValueOnce(new Error('start failed'));
    await expect(service.start()).rejects.toThrow('start failed');
    expect(mockBackgroundActions.stop).toHaveBeenCalledTimes(1);
    await service.start();
    mockBackgroundActions.stop.mockRejectedValueOnce(new Error('stop failed'));
    await expect(service.stop()).rejects.toThrow('stop failed');
    await service.stop();
    expect(mockBackgroundActions.start).toHaveBeenCalledTimes(2);
    expect(mockBackgroundActions.stop).toHaveBeenCalledTimes(3);
    expect(mockRunning).toBe(false);
  });

  it('allows cleanup retry when both a native start and its cleanup fail', async () => {
    const service = new Service();
    mockBackgroundActions.start.mockRejectedValueOnce(new Error('start failed'));
    mockBackgroundActions.stop.mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(service.start()).rejects.toThrow('start failed');
    await service.stop();
    expect(mockBackgroundActions.stop).toHaveBeenCalledTimes(2);
  });
});
