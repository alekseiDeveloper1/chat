export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  // The iOS share extension uses this URL to deliver data, not as a screen path.
  // useShareIntent still receives the original URL through expo-linking.
  if (path.startsWith('chat://dataUrl=') || path.startsWith('dataUrl=')) return '/';
  return path;
}
