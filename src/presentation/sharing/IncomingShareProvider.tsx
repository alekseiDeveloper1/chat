import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { useShareIntent } from 'expo-share-intent';
import { importSharedContent, SharedDraft } from '@/data/sharing/IncomingShare';
import { appLogger } from '@/shared/logging/AppLogger';

interface IncomingShares {
  drafts: SharedDraft[];
  isImporting: boolean;
  removeDraft: (id: string) => void;
}

const IncomingShareContext = createContext<IncomingShares | null>(null);

export function IncomingShareProvider({ children }: React.PropsWithChildren) {
  const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntent({
    disabled: Platform.OS === 'web' || Constants.executionEnvironment === ExecutionEnvironment.StoreClient,
    resetOnBackground: false,
  });
  const [drafts, setDrafts] = useState<SharedDraft[]>([]);
  const [importCount, setImportCount] = useState(0);
  const mounted = useRef(false);
  const lastPayload = useRef<string | null>(null);
  const lastError = useRef<string | null>(null);
  const importVersion = useRef(0);
  const pendingImport = useRef<Promise<void>>(Promise.resolve());
  const reset = useRef(resetShareIntent);

  useEffect(() => {
    reset.current = resetShareIntent;
  }, [resetShareIntent]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!hasShareIntent) {
      lastPayload.current = null;
      return;
    }

    // Native refreshes can emit the same pending intent on foreground changes.
    const fingerprint = JSON.stringify(shareIntent);
    if (lastPayload.current === fingerprint) return;
    lastPayload.current = fingerprint;
    const version = ++importVersion.current;
    setImportCount((count) => count + 1);

    // Read shared files before clearing the native intent, in arrival order.
    pendingImport.current = pendingImport.current.then(async () => {
      if (!mounted.current) return;
      try {
        const result = await importSharedContent(shareIntent);
        if (!mounted.current) return;
        setDrafts((current) => [...current, ...result.drafts]);
        for (const message of result.errors) {
          appLogger.warn('chat', message, { visibleToUser: true });
        }
      } catch {
        if (mounted.current) {
          appLogger.error('chat', 'Не удалось прочитать пересыл. Поделитесь контентом ещё раз.', {
            visibleToUser: true,
          });
        }
      } finally {
        if (mounted.current) {
          setImportCount((count) => count - 1);
          // Finishing an older import must not clear a newer native share.
          if (version === importVersion.current) reset.current();
        }
      }
    });
  }, [hasShareIntent, shareIntent]);

  useEffect(() => {
    if (error && error !== lastError.current) {
      appLogger.error('chat', 'Не удалось получить пересыл из другого приложения. Попробуйте ещё раз.', {
        visibleToUser: true,
      });
      reset.current();
    }
    lastError.current = error;
  }, [error]);

  const removeDraft = useCallback((id: string) => {
    setDrafts((current) => current.filter((draft) => draft.id !== id));
  }, []);

  return (
    <IncomingShareContext.Provider value={{ drafts, isImporting: importCount > 0, removeDraft }}>
      {children}
    </IncomingShareContext.Provider>
  );
}

export function useIncomingShares(): IncomingShares {
  const context = useContext(IncomingShareContext);
  if (!context) throw new Error('useIncomingShares requires IncomingShareProvider');
  return context;
}
