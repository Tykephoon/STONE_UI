/**
 * Device endpoints — read-only.
 *
 * There is no create, rotate, or delete here because the API exposes none.
 * Minting a device key is what stops a stranger writing to the readings table,
 * so it is a local operation: `npm run device -- add` on the server.
 */
import { request } from './client';
import type { Device } from './types';

export function listDevices(signal?: AbortSignal): Promise<{ devices: Device[] }> {
  return request<{ devices: Device[] }>('/api/devices', signal ? { signal } : {});
}

export function getDevice(id: string, signal?: AbortSignal): Promise<{ device: Device }> {
  return request<{ device: Device }>(`/api/devices/${encodeURIComponent(id)}`, signal ? { signal } : {});
}
