// Project pages, added as phase 7 lands (nav entries live in layout/Shell.tsx).
import type { ReactNode } from 'react';
import { Route } from 'react-router-dom';
import { DevicePage, DevicesPage } from './pages/devices/Devices';
import { FloorPage } from './pages/places/Floor';
import { LocationPage, LocationsPage } from './pages/places/Locations';
import { RackPage } from './pages/places/Rack';
import { RoomPage } from './pages/places/Room';

export const projectRoutes: ReactNode = (
  <>
    <Route path="locations" element={<LocationsPage />} />
    <Route path="locations/:id" element={<LocationPage />} />
    <Route path="floors/:id" element={<FloorPage />} />
    <Route path="rooms/:id" element={<RoomPage />} />
    <Route path="racks/:id" element={<RackPage />} />
    <Route path="devices" element={<DevicesPage />} />
    <Route path="devices/:id" element={<DevicePage />} />
  </>
);
