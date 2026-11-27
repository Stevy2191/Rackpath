// The media catalog from the server, loaded once per page load.
import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { MediaCatalog } from '../../types';

let cached: Promise<MediaCatalog> | null = null;

export function useMedia(): MediaCatalog | null {
  const [m, setM] = useState<MediaCatalog | null>(null);
  useEffect(() => {
    cached ??= api.get<MediaCatalog>('/api/media');
    cached.then(setM, () => {
      cached = null;
    });
  }, []);
  return m;
}

export const speedText = (mbps: number | null | undefined) =>
  mbps == null ? '' : mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`;

export const isPower = (medium: string) => medium === 'power';
