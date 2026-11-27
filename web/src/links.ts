// Where each kind of thing lives in the app.
import type { SearchHit } from './types';

export const link = {
  project: (p: number) => `/p/${p}`,
  locations: (p: number) => `/p/${p}/locations`,
  location: (p: number, id: number) => `/p/${p}/locations/${id}`,
  floor: (p: number, id: number) => `/p/${p}/floors/${id}`,
  room: (p: number, id: number) => `/p/${p}/rooms/${id}`,
  rack: (p: number, id: number) => `/p/${p}/racks/${id}`,
  devices: (p: number) => `/p/${p}/devices`,
  device: (p: number, id: number) => `/p/${p}/devices/${id}`,
  port: (p: number, id: number) => `/p/${p}/ports/${id}`,
  ipam: (p: number) => `/p/${p}/ipam`,
  vlans: (p: number) => `/p/${p}/vlans`,
  prefix: (p: number, id: number) => `/p/${p}/ipam/prefixes/${id}`,
  address: (p: number, id: number) => `/p/${p}/ipam/addresses/${id}`,
};

export function hitLink(h: SearchHit): string {
  switch (h.kind) {
    case 'location':
      return link.location(h.project_id, h.id);
    case 'floor':
      return link.floor(h.project_id, h.id);
    case 'room':
      return link.room(h.project_id, h.id);
    case 'rack':
      return link.rack(h.project_id, h.id);
    case 'device':
      return link.device(h.project_id, h.id);
    case 'port':
      return link.port(h.project_id, h.id);
    case 'prefix':
      return link.prefix(h.project_id, h.id);
    case 'address':
      return link.address(h.project_id, h.id);
  }
}
