import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { profileIdentityInput } from './platform';

/** A non-secret, stable identifier for one platform-canonical user-data profile path. */
export function profileIdForPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return createHash('sha256').update(profileIdentityInput(resolve(path), platform)).digest('hex').toUpperCase();
}
