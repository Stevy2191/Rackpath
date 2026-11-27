// Project pages, added as phase 7 lands (nav entries live in layout/Shell.tsx).
import type { ReactNode } from 'react';
import { Route } from 'react-router-dom';
import { PortPage } from './pages/cabling/PortPage';
import { AddressPage } from './pages/ipam/Address';
import { IpamPage } from './pages/ipam/Ipam';
import { PrefixPage } from './pages/ipam/Prefix';
import { VlansPage } from './pages/network/Vlans';
import { TemplatePage } from './pages/templates/Designer';
import { TemplatesPage } from './pages/templates/Templates';
import { ProjectSettingsPage } from './pages/ProjectSettings';
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
    <Route path="ports/:id" element={<PortPage />} />
    <Route path="ipam" element={<IpamPage />} />
    <Route path="ipam/prefixes/:id" element={<PrefixPage />} />
    <Route path="ipam/addresses/:id" element={<AddressPage />} />
    <Route path="vlans" element={<VlansPage />} />
    <Route path="templates" element={<TemplatesPage />} />
    <Route path="templates/:id" element={<TemplatePage />} />
    <Route path="settings" element={<ProjectSettingsPage />} />
  </>
);
