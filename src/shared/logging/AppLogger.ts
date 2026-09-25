export type AppLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type AppLogFeature = 'chat' | 'webrtc' | 'mqtt';

type AppLogContextValue = string | number | boolean | null;
type AppLogContext = Record<string, AppLogContextValue | undefined>;
type AppLogListener = (entry: AppLogEntry) => void;

export interface AppLogEntry {
  id: string;
  timestamp: number;
  level: AppLogLevel;
  feature: AppLogFeature;
  message: string;
  context?: Record<string, AppLogContextValue>;
  errorMessage?: string;
  visibleToUser: boolean;
}

interface AppLogOptions {
  context?: AppLogContext;
  error?: unknown;
  visibleToUser?: boolean;
}

interface SubscribeOptions {
  replay?: boolean;
}

const MAX_LOG_ENTRIES = 200;
const SENSITIVE_KEY_PATTERN = /(password|secret|token|payload|message|text|encrypted|hash|key)/i;

const serializeError = (error: unknown): string | undefined => {
  if (!error) return undefined;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const sanitizeContext = (context?: AppLogContext): Record<string, AppLogContextValue> | undefined => {
  if (!context) return undefined;

  const safeContext: Record<string, AppLogContextValue> = {};

  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || SENSITIVE_KEY_PATTERN.test(key)) {
      continue;
    }

    safeContext[key] = value;
  }

  return Object.keys(safeContext).length > 0 ? safeContext : undefined;
};

export class AppLogger {
  private entries: AppLogEntry[] = [];
  private listeners = new Set<AppLogListener>();
  private sequence = 0;

  subscribe(listener: AppLogListener, options: SubscribeOptions = {}): () => void {
    this.listeners.add(listener);

    if (options.replay) {
      this.entries.forEach(listener);
    }

    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.entries = [];
  }

  debug(feature: AppLogFeature, message: string, options: AppLogOptions = {}): void {
    this.log('debug', feature, message, options);
  }

  info(feature: AppLogFeature, message: string, options: AppLogOptions = {}): void {
    this.log('info', feature, message, options);
  }

  warn(feature: AppLogFeature, message: string, options: AppLogOptions = {}): void {
    this.log('warn', feature, message, options);
  }

  error(feature: AppLogFeature, message: string, options: AppLogOptions = {}): void {
    this.log('error', feature, message, options);
  }

  private log(
    level: AppLogLevel,
    feature: AppLogFeature,
    message: string,
    options: AppLogOptions,
  ): void {
    const entry: AppLogEntry = {
      id: `${Date.now().toString(36)}-${this.sequence++}`,
      timestamp: Date.now(),
      level,
      feature,
      message,
      context: sanitizeContext(options.context),
      errorMessage: serializeError(options.error),
      visibleToUser: options.visibleToUser ?? false,
    };

    this.entries = [...this.entries, entry].slice(-MAX_LOG_ENTRIES);
    this.writeToConsole(entry);
    this.listeners.forEach((listener) => listener(entry));
  }

  private writeToConsole(entry: AppLogEntry): void {
    const details = {
      feature: entry.feature,
      context: entry.context,
      errorMessage: entry.errorMessage,
    };

    switch (entry.level) {
      case 'debug':
        console.debug(entry.message, details);
        break;
      case 'info':
        console.info(entry.message, details);
        break;
      case 'warn':
        console.warn(entry.message, details);
        break;
      case 'error':
        console.error(entry.message, details);
        break;
    }
  }
}

export const appLogger = new AppLogger();
