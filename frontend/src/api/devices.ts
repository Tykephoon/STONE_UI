/** Device endpoints. */
import { request } from './client';
import type { Device } from './types';

export function listDevices(signal?: AbortSignal): Promise<{ devices: Device[] }> {
  return request<{ devices: Device[] }>('/api/devices', signal ? { signal } : {});
}

export function getDevice(id: string, signal?: AbortSignal): Promise<{ device: Device }> {
  return request<{ device: Device }>(`/api/devices/${encodeURIComponent(id)}`, signal ? { signal } : {});
}

/** The plaintext key is returned exactly once and is never retrievable again. */
export function createDevice(input: {
  name: string;
  notes?: string | null;
}): Promise<{ device: Device; device_key: string }> {
  return request<{ device: Device; device_key: string }>('/api/devices', {
    method: 'POST',
    body: input,
  });
}

export function updateDevice(
  id: string,
  input: { name?: string; notes?: string | null },
): Promise<{ device: Device }> {
  return request<{ device: Device }>(`/api/devices/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  });
}

export function rotateDeviceKey(
  id: string,
): Promise<{ device_key: string; key_prefix: string; key_rotated_at: string }> {
  return request(`/api/devices/${encodeURIComponent(id)}/rotate-key`, { method: 'POST' });
}

export function deleteDevice(id: string): Promise<void> {
  return request<void>(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
