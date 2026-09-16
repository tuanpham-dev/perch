import type { Platform } from './types.ts';
import { posix } from './posix.ts';
import { windows } from './windows.ts';

export type { Platform } from './types.ts';

export const platform: Platform = process.platform === 'win32' ? windows : posix;
