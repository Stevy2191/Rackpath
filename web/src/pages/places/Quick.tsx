// Shortcuts that keep set-up simple: add a rack from anywhere (one "Where"
// picker instead of walking location → floor → room), and put devices
// waiting in Unplaced (often from an integration) into a rack or room.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, qs } from '../../api';
import { link } from '../../links';
import type { Device, Rack } from '../../types';
import { Button, FormModal, SelectField, Spinner, TextField, message, useLoad, useToast } from '../../ui';
import type { PlaceOption } from '../devices/DeviceForm';
import { useDeviceTypes } from './common';
import { LocationForm } from './Locations';
import { RackForm } from './Rack';

/** A room as a "Where" choice: "HOME / 0 / DEFAULT" shown as "HOME". */
export interface RoomChoice {
  id: number;
  label: string;
  locationId: number | null;
}

/** Turns places into room choices, leaving out the parts that add nothing:
 * the default room, and floor 0 when a location has only that floor. */
export function roomChoices(places: PlaceOption[]): RoomChoice[] {
  const strip = (p: string) => p.split('/').slice(1);
  const locations = places.filter((p) => p.kind === 'location');
  const floorsOf = (loc: string) => places.filter((p) => p.kind === 'floor' && strip(p.path)[0] === loc).length;
  return places
    .filter((p) => p.kind === 'room')
    .map((p) => {
      const [loc, floor, room] = strip(p.path);
      const parts = [loc];
      if (floorsOf(loc) > 1) parts.push(`floor ${floor}`);
      if (room !== 'DEFAULT') parts.push(room);
      return { id: p.id, label: parts.join(' / '), locationId: locations.find((l) => strip(l.path)[0] === loc)?.id ?? null };
    });
}

/** "Add rack" that works from any page. With no location yet, it offers to
 * add one first. Opens the new rack when it's saved. */
export function AddRackButton({
  projectId,
  locationId,
  variant = 'secondary',
  label = 'Add rack',
  onSaved,
}: {
  projectId: number;
  /** Only offer this location's rooms. */
  locationId?: number;
  variant?: 'secondary' | 'primary' | 'ghost';
  label?: string;
  /** Instead of opening the new rack. */
  onSaved?: (r: Rack) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} icon={<Plus size={15} />} onClick={() => setOpen(true)}>{label}</Button>
      {open && <AddRackFlow projectId={projectId} locationId={locationId} onClose={() => setOpen(false)} onSaved={onSaved} />}
    </>
  );
}

function AddRackFlow({ projectId, locationId, onClose, onSaved }: { projectId: number; locationId?: number; onClose: () => void; onSaved?: (r: Rack) => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const [newLocation, setNewLocation] = useState<number | null>(null);
  const places = useLoad(() => api.get<PlaceOption[]>(`/api/projects/${projectId}/places`), [projectId, version]);
  if (!places.data) return places.error ? null : <Spinner />;
  const only = newLocation ?? locationId;
  const rooms = roomChoices(places.data).filter((r) => only == null || r.locationId === only);
  if (rooms.length === 0) {
    return (
      <LocationForm
        projectId={projectId}
        intro="A rack lives in a location (a building). Add one first; you can add floors and rooms later if you need them."
        onClose={onClose}
        onSaved={(l) => {
          setNewLocation(l.id);
          setVersion((v) => v + 1);
          return false;
        }}
      />
    );
  }
  return (
    <RackForm
      projectId={projectId}
      rooms={[]}
      choices={rooms}
      onClose={onClose}
      onSaved={(r) => {
        toast.ok(`Added rack ${r.code}`);
        if (onSaved) onSaved(r);
        else nav(link.rack(projectId, r.id));
      }}
    />
  );
}

// ---------------------------------------------------------------- placing

/** Devices waiting in Unplaced that can go in a rack, or in a room. */
export function useUnplaced(projectId: number, where: 'rack' | 'room', version = 0) {
  const types = useDeviceTypes(projectId);
  const list = useLoad(
    () => api.get<{ devices: Device[] }>(`/api/projects/${projectId}/devices${qs({ unplaced: true, limit: 200 })}`).then((r) => r.devices),
    [projectId, version],
  );
  const fits = (d: Device) => {
    const p = types.data?.find((t) => t.id === d.device_type.id)?.placement;
    return where === 'rack' ? p === 'rack' || p === 'either' || p === 'tray' : p === 'floor' || p === 'either';
  };
  return { devices: list.data && types.data ? list.data.filter(fits) : null, error: list.error ?? types.error, reload: list.reload };
}

const label = (d: Device) => `${d.code}${d.name ? ` · ${d.name}` : ''}${d.model ? ` (${d.model})` : ''}`;

/** Puts an Unplaced device into a rack at a U position. */
export function PlaceInRack({
  projectId,
  rackId,
  u,
  face,
  topDown,
  onClose,
  onSaved,
}: {
  projectId: number;
  rackId: number;
  u: number | null;
  /** The rack numbers U1 at the top; positions are still counted from the bottom. */
  topDown?: boolean;
  face: 'front' | 'rear';
  onClose: () => void;
  onSaved: (d: Device) => void;
}) {
  const toast = useToast();
  const unplaced = useUnplaced(projectId, 'rack');
  const [deviceId, setDeviceId] = useState('');
  const [pos, setPos] = useState(u != null ? String(u) : '');
  const [side, setSide] = useState<'front' | 'rear' | 'both'>(face);
  useEffect(() => {
    if (!deviceId && unplaced.devices?.length) setDeviceId(String(unplaced.devices[0].id));
  }, [deviceId, unplaced.devices]);
  return (
    <FormModal
      title="Place a device in this rack"
      submitLabel="Place it"
      onClose={onClose}
      onSubmit={async () => {
        if (!deviceId) throw new Error('Choose a device');
        const d = await api.patch<Device>(`/api/devices/${deviceId}`, {
          placement: { type: 'rack', rack_id: rackId, u: pos ? Number(pos) : null, face: side, mount: 'full_width' },
        });
        toast.ok(`Placed ${d.code}`);
        onSaved(d);
      }}
    >
      {unplaced.error && <p className="small">{message(unplaced.error)}</p>}
      {!unplaced.devices ? (
        <Spinner />
      ) : unplaced.devices.length === 0 ? (
        <p className="small muted">No devices are waiting in Unplaced. Use <strong>Add device</strong> to create one here.</p>
      ) : (
        <>
          <SelectField
            label="Device"
            hint="Devices waiting in Unplaced, e.g. ones an integration brought in"
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            options={unplaced.devices.map((d) => ({ value: String(d.id), label: label(d) }))}
          />
          <div className="grid-2">
            <TextField label="Position (U)" type="number" min={1} step={0.5} value={pos} onChange={(e) => setPos(e.target.value)} hint={`Its lowest U${topDown ? ", counted from the bottom" : ""}. Empty: in the rack, no position yet`} />
            <SelectField
              label="Face"
              value={side}
              onChange={(e) => setSide(e.target.value as typeof side)}
              options={[
                { value: 'front', label: 'Front' },
                { value: 'rear', label: 'Rear' },
                { value: 'both', label: 'Full depth (front and rear)' },
              ]}
            />
          </div>
        </>
      )}
    </FormModal>
  );
}

/** Puts an Unplaced device in a room (floor-standing: APs, printers…). */
export function PlaceInRoom({ projectId, roomId, onClose, onSaved }: { projectId: number; roomId: number; onClose: () => void; onSaved: (d: Device) => void }) {
  const toast = useToast();
  const unplaced = useUnplaced(projectId, 'room');
  const [deviceId, setDeviceId] = useState('');
  useEffect(() => {
    if (!deviceId && unplaced.devices?.length) setDeviceId(String(unplaced.devices[0].id));
  }, [deviceId, unplaced.devices]);
  return (
    <FormModal
      title="Place a device here"
      submitLabel="Place it"
      onClose={onClose}
      onSubmit={async () => {
        if (!deviceId) throw new Error('Choose a device');
        const d = await api.patch<Device>(`/api/devices/${deviceId}`, { placement: { type: 'room', room_id: roomId, x: null, y: null, rotation: null } });
        toast.ok(`Placed ${d.code}`);
        onSaved(d);
      }}
    >
      {!unplaced.devices ? (
        <Spinner />
      ) : unplaced.devices.length === 0 ? (
        <p className="small muted">No floor-standing devices (access points, printers, desktops…) are waiting in Unplaced.</p>
      ) : (
        <SelectField
          label="Device"
          hint="Devices waiting in Unplaced that stand on the floor or mount on a wall or ceiling"
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          options={unplaced.devices.map((d) => ({ value: String(d.id), label: label(d) }))}
        />
      )}
    </FormModal>
  );
}
