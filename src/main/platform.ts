export type NativeAudioDriver = 'wasapi' | 'coreaudio' | 'asio-bridge' | 'offline';

export function nativeExecutableName(baseName: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${baseName}.exe` : baseName;
}

export function nativeAudioDriverForPlatform(platform: NodeJS.Platform = process.platform): NativeAudioDriver {
  if (platform === 'win32') return 'wasapi';
  if (platform === 'darwin') return 'coreaudio';
  return 'offline';
}

export function nativeAudioBackendLabel(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'WASAPI';
  if (platform === 'darwin') return 'CoreAudio';
  return 'native real-time';
}

export function nativeAudioDriverLabel(driver: NativeAudioDriver): string {
  if (driver === 'wasapi') return 'WASAPI';
  if (driver === 'coreaudio') return 'CoreAudio';
  if (driver === 'asio-bridge') return 'ASIO-BRIDGE';
  return 'offline';
}

export function profileIdentityInput(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.toLowerCase() : path.normalize('NFC');
}
