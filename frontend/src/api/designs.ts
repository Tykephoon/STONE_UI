/** Saved design endpoints, including share links. */
import { request } from './client';
import type { Design, DesignParams, SharedDesign } from './types';

export function listDesigns(signal?: AbortSignal): Promise<{ designs: Design[] }> {
  return request<{ designs: Design[] }>('/api/designs', signal ? { signal } : {});
}

export function getDesign(id: string, signal?: AbortSignal): Promise<{ design: Design }> {
  return request<{ design: Design }>(
    `/api/designs/${encodeURIComponent(id)}`,
    signal ? { signal } : {},
  );
}

export interface DesignInput {
  name: string;
  params: DesignParams;
  latitude?: number | null;
  longitude?: number | null;
  place_label?: string | null;
}

export function createDesign(input: DesignInput): Promise<{ design: Design }> {
  return request<{ design: Design }>('/api/designs', { method: 'POST', body: input });
}

export function updateDesign(
  id: string,
  input: Partial<DesignInput>,
): Promise<{ design: Design }> {
  return request<{ design: Design }>(`/api/designs/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: input,
  });
}

export function deleteDesign(id: string): Promise<void> {
  return request<void>(`/api/designs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function createShareLink(id: string): Promise<{ share_token: string }> {
  return request<{ share_token: string }>(`/api/designs/${encodeURIComponent(id)}/share`, {
    method: 'POST',
  });
}

export function revokeShareLinks(id: string): Promise<{ revoked: number }> {
  return request<{ revoked: number }>(`/api/designs/${encodeURIComponent(id)}/share`, {
    method: 'DELETE',
  });
}

/** Fetch a shared design by token. Returns that one record and nothing else. */
export function getSharedDesign(
  token: string,
  signal?: AbortSignal,
): Promise<{ design: SharedDesign }> {
  return request<{ design: SharedDesign }>(`/api/share/${encodeURIComponent(token)}`, {
    ...(signal ? { signal } : {}),
  });
}
