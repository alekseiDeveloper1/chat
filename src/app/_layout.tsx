import React from 'react';
import 'react-native-get-random-values';
import { Slot } from 'expo-router';
import { IncomingShareProvider } from '@/presentation/sharing/IncomingShareProvider';

export default function RootLayout() {
  return (
    <IncomingShareProvider>
      <Slot />
    </IncomingShareProvider>
  );
}
