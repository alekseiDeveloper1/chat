import 'react-native-get-random-values'
jest.mock('expo-router', () => ({
    router: {
        replace: jest.fn(),
    },
}));

jest.mock('expo-crypto', () => {
    const crypto = require('crypto');
    return {
        digestStringAsync: async (algorithm, str) => {
            return crypto.createHash('sha256').update(str).digest('hex');
        },
        CryptoDigestAlgorithm: {
            SHA256: 'SHA-256',
        },
    };
});
jest.mock('expo-sqlite', () => {
    const mockDb = {
        execAsync: jest.fn().mockResolvedValue(undefined),
        runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 }),
        getFirstAsync: jest.fn().mockResolvedValue(null),
        getAllAsync: jest.fn().mockResolvedValue([]),
        closeAsync: jest.fn().mockResolvedValue(undefined),
    };

    return {
        openDatabaseAsync: jest.fn().mockResolvedValue(mockDb),
        useSQLiteContext: () => mockDb,
    };
});

const mockPeerConnections = [];
const createMockDataChannel = () => {
    const listeners = {};

    return {
        send: jest.fn(),
        close: jest.fn(() => listeners.close?.()),
        addEventListener: jest.fn((type, listener) => {
            listeners[type] = listener;
        }),
        __emit: (type, event) => listeners[type]?.(event),
    };
};

const MockRTCPeerConnection = jest.fn().mockImplementation(() => {
    const listeners = {};
    const peerConnection = {
        iceConnectionState: 'new',
        localDescription: null,
        remoteDescription: null,
        createDataChannel: jest.fn(() => {
            const channel = createMockDataChannel();
            peerConnection.__dataChannel = channel;
            return channel;
        }),
        createOffer: jest.fn().mockResolvedValue({ sdp: 'mock-offer', type: 'offer' }),
        createAnswer: jest.fn().mockResolvedValue({ sdp: 'mock-answer', type: 'answer' }),
        setLocalDescription: jest.fn(function (desc) {
            peerConnection.localDescription = desc;
            return Promise.resolve();
        }),
        setRemoteDescription: jest.fn(function (desc) {
            peerConnection.remoteDescription = desc;
            return Promise.resolve();
        }),
        addIceCandidate: jest.fn().mockResolvedValue(null),
        close: jest.fn(),
        addEventListener: jest.fn((type, listener) => {
            listeners[type] = listener;
        }),
        __emitIceConnectionStateChange: (state) => {
            peerConnection.iceConnectionState = state;
            listeners.iceconnectionstatechange?.();
        },
        __emitIceCandidate: (candidate) => listeners.icecandidate?.({ candidate }),
        __emitDataChannel: (channel = createMockDataChannel()) => {
            listeners.datachannel?.({ channel });
            return channel;
        },
    };

    mockPeerConnections.push(peerConnection);
    return peerConnection;
});

global.__mockPeerConnections = mockPeerConnections;

jest.mock('react-native-webrtc', () => ({
    registerGlobals: jest.fn(),
    RTCPeerConnection: MockRTCPeerConnection,
}));

const mockMqttClients = [];
const createMockMqttClient = () => {
    const listeners = {};
    const client = {
        connected: false,
        sentMessages: [],
        subscribedTopics: [],
        on: jest.fn((type, listener) => {
            listeners[type] = listener;
            return client;
        }),
        subscribe: jest.fn((topic, callback) => {
            client.subscribedTopics.push(topic);
            callback?.(null);
        }),
        publish: jest.fn((topic, messageBody, options) => {
            client.sentMessages.push({ topic, messageBody, options });
        }),
        end: jest.fn(() => {
            client.connected = false;
        }),
        __emit: (type, ...args) => listeners[type]?.(...args),
    };

    mockMqttClients.push(client);
    return client;
};
const mockMqttConnect = jest.fn(() => createMockMqttClient());

jest.mock('mqtt', () => ({
    __esModule: true,
    default: {
        connect: mockMqttConnect,
    },
    connect: mockMqttConnect,
    MqttClient: jest.fn(),
    __mockMqttClients: mockMqttClients,
}));

const MockMqttClient = jest.fn().mockImplementation(function () {
    this.connected = false;
    this.sentMessages = [];
    this.subscribedTopics = [];
    this.connect = jest.fn((options) => {
        this.connectOptions = options;
        this.connected = true;
        options.onSuccess?.({});
    });
    this.disconnect = jest.fn(() => {
        this.connected = false;
        this.onConnectionLost?.({ errorCode: 0, errorMessage: '' });
    });
    this.isConnected = jest.fn(() => this.connected);
    this.subscribe = jest.fn((topic) => {
        this.subscribedTopics.push(topic);
    });
    this.send = jest.fn((message) => {
        this.sentMessages.push(message);
    });

    mockMqttClients.push(this);
});

jest.mock('paho-mqtt', () => ({
    Client: MockMqttClient,
    Message: jest.fn().mockImplementation(function (payloadString) {
        this.payloadString = payloadString;
        this.destinationName = '';
        this.qos = 0;
    }),
    __mockMqttClients: mockMqttClients,
}));

beforeEach(() => {
    jest.clearAllMocks();
    mockPeerConnections.length = 0;
    mockMqttClients.length = 0;
});
