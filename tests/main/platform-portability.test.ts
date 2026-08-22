import { describe, expect, it } from 'vitest';
import { profileIdForPath } from '../../src/main/profile-identity';
import { nativeAudioBackendLabel, nativeAudioDriverForPlatform, nativeExecutableName, profileIdentityInput } from '../../src/main/platform';

describe('desktop platform seams', () => {
  it('preserves Windows identities and names while defining case-sensitive macOS inputs', () => {
    expect(nativeExecutableName('aimuse-audio', 'win32')).toBe('aimuse-audio.exe');
    expect(nativeExecutableName('aimuse-audio', 'darwin')).toBe('aimuse-audio');
    expect(profileIdentityInput('C:\\Users\\AIMuse', 'win32')).toBe('c:\\users\\aimuse');
    expect(profileIdentityInput('/Users/AIMuse', 'darwin')).toBe('/Users/AIMuse');
    expect(profileIdForPath('/Users/AIMuse', 'darwin')).not.toBe(profileIdForPath('/Users/aimuse', 'darwin'));
  });

  it('declares native audio platform boundaries', () => {
    expect(nativeAudioDriverForPlatform('win32')).toBe('wasapi');
    expect(nativeAudioDriverForPlatform('darwin')).toBe('coreaudio');
    expect(nativeAudioBackendLabel('darwin')).toBe('CoreAudio');
  });
});
