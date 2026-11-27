// Adding a device (by type or from a template), editing its details, and
// moving it somewhere else.
import { useEffect, useState } from 'react';
import { api, qs } from '../../api';
import type { Device, Mount, Placement } from '../../types';
import { FormModal, SelectField, Spinner, Tabs, TextArea, TextField } from '../../ui';
import { num, useDeviceTypes, useForm, useTemplates } from '../places/common';
import { MoveDialog } from '../places/Move';

export const STATUSES = ['planned', 'active', 'spare', 'faulty', 'retired'] as const;
const statusOptions = STATUSES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }));
const faceOptions = [
  { value: 'front', label: 'Front' },
  { value: 'rear', label: 'Rear' },
  { value: 'both', label: 'Full depth (front and rear)' },
];
const mountOptions: { value: Mount; label: string }[] = [
  { value: 'full_width', label: 'Full width' },
  { value: 'half_left', label: 'Left half' },
  { value: 'half_right', label: 'Right half' },
  { value: 'zero_u_left', label: 'Zero-U, left side' },
  { value: 'zero_u_right', label: 'Zero-U, right side' },
];

const fits = (where: Placement['type'], typePlacement: string) =>
  where === 'rack' ? typePlacement === 'rack' || typePlacement === 'either'
  : where === 'room' ? typePlacement === 'floor' || typePlacement === 'either'
  : where === 'tray' ? typePlacement === 'tray' || typePlacement === 'either'
  : true;

export function DeviceForm({
  projectId,
  placement,
  onClose,
  onSaved,
}: {
  projectId: number;
  placement: Placement;
  onClose: () => void;
  onSaved: (d: Device) => void;
}) {
  const types = useDeviceTypes(projectId);
  const templates = useTemplates(projectId);
  const [source, setSource] = useState<'type' | 'template'>('type');
  const [codeTouched, setCodeTouched] = useState(false);
  const f = useForm({
    device_type_id: '',
    template_id: '',
    code: '',
    name: '',
    status: 'active',
    u: placement.type === 'rack' && placement.u != null ? String(placement.u) : '',
    u_height: placement.type === 'rack' ? '1' : '',
    face: placement.type === 'rack' ? placement.face : 'front',
    mount: placement.type === 'rack' ? placement.mount : 'full_width',
    manufacturer: '',
    model: '',
    serial_number: '',
    notes: '',
  });
  const usableTypes = (types.data ?? []).filter((t) => fits(placement.type, t.placement));
  const usableTemplates = (templates.data ?? []).filter((t) => usableTypes.some((ty) => ty.key === t.device_type));
  const typeId =
    source === 'type'
      ? f.values.device_type_id
      : String(usableTypes.find((t) => t.key === usableTemplates.find((x) => String(x.id) === f.values.template_id)?.device_type)?.id ?? '');

  // Default selections once the lists arrive.
  const setValues = f.setValues;
  useEffect(() => {
    setValues((v) => ({
      ...v,
      device_type_id: v.device_type_id || String(usableTypes[0]?.id ?? ''),
      template_id: v.template_id || String(usableTemplates[0]?.id ?? ''),
    }));
  }, [usableTypes.length, usableTemplates.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Suggest the next free code for the chosen type and place.
  const where = placement.type === 'rack' ? { rack_id: placement.rack_id } : placement.type === 'room' ? { room_id: placement.room_id } : placement.type === 'tray' ? { tray_id: placement.tray_id } : {};
  const whereKey = JSON.stringify(where);
  useEffect(() => {
    if (!typeId || codeTouched) return;
    api
      .get<{ code: string }>(`/api/projects/${projectId}/next-code${qs({ device_type_id: typeId, ...JSON.parse(whereKey) })}`)
      .then((r) => setValues((v) => ({ ...v, code: r.code })))
      .catch(() => {});
  }, [typeId, codeTouched, projectId, whereKey, setValues]);

  if (!types.data || !templates.data) return null;
  const v = f.values;
  const zeroU = v.mount.startsWith('zero');
  return (
    <FormModal
      title="Add device"
      wide
      onClose={onClose}
      onSubmit={async () => {
        const place =
          placement.type === 'rack'
            ? { type: 'rack', rack_id: placement.rack_id, u: zeroU ? null : num(v.u), face: v.face, mount: v.mount }
            : placement;
        const body: Record<string, unknown> = {
          code: v.code || undefined,
          name: v.name,
          status: v.status,
          placement: place,
          serial_number: v.serial_number,
          notes: v.notes,
        };
        if (source === 'template') {
          body.template_id = Number(v.template_id);
        } else {
          body.device_type_id = Number(v.device_type_id);
          body.manufacturer = v.manufacturer;
          body.model = v.model;
          if (placement.type === 'rack' && !zeroU) body.u_height = num(v.u_height) ?? undefined;
        }
        onSaved(await api.post<Device>(`/api/projects/${projectId}/devices`, body));
      }}
    >
      <Tabs
        tabs={[
          { id: 'type', label: 'By type' },
          { id: 'template', label: `From a template (${usableTemplates.length})` },
        ]}
        value={source}
        onChange={setSource}
      />
      {source === 'type' ? (
        <div className="grid-2">
          <SelectField label="Type" {...f.bind('device_type_id')} options={usableTypes.map((t) => ({ value: String(t.id), label: t.label }))} />
          <TextField label="Manufacturer" {...f.bind('manufacturer')} />
          <TextField label="Model" {...f.bind('model')} />
          {placement.type === 'rack' && !zeroU && <TextField label="Height (U)" type="number" min={0.5} max={60} step={0.5} {...f.bind('u_height')} />}
        </div>
      ) : usableTemplates.length === 0 ? (
        <p className="muted">No templates fit here yet.</p>
      ) : (
        <SelectField
          label="Template"
          {...f.bind('template_id')}
          options={usableTemplates.map((t) => ({
            value: String(t.id),
            label: `${t.name}${t.u_height ? ` (${t.u_height}U)` : ''}${t.builtin ? ' · built-in' : ''}`,
          }))}
        />
      )}
      <div className="grid-2">
        <TextField
          label="Code"
          maxLength={16}
          value={v.code}
          onChange={(e) => {
            setCodeTouched(true);
            f.set('code', e.target.value);
          }}
          hint="Suggested from the type; leave as is or change it"
        />
        <TextField label="Name" {...f.bind('name')} />
        <SelectField label="Status" {...f.bind('status')} options={statusOptions} />
        <TextField label="Serial number" {...f.bind('serial_number')} />
      </div>
      {placement.type === 'rack' && (
        <div className="grid-3">
          <SelectField label="Mount" {...f.bind('mount')} options={mountOptions} />
          {!zeroU && <TextField label="Lowest U" type="number" min={1} step={0.5} hint="Blank to add it without a position" {...f.bind('u')} />}
          {!zeroU && <SelectField label="Face" {...f.bind('face')} options={faceOptions} />}
        </div>
      )}
      <TextArea label="Notes" {...f.bind('notes')} />
    </FormModal>
  );
}

export function DeviceEdit({ device, onClose, onSaved }: { device: Device; onClose: () => void; onSaved: () => void }) {
  const f = useForm({
    code: device.code,
    name: device.name ?? '',
    status: device.status,
    manufacturer: device.manufacturer ?? '',
    model: device.model ?? '',
    serial_number: device.serial_number ?? '',
    asset_tag: device.asset_tag ?? '',
    hostname: device.hostname ?? '',
    mac: device.mac ?? '',
    os: device.os ?? '',
    firmware: device.firmware ?? '',
    u_height: device.u_height != null ? String(device.u_height) : '',
    purchase_date: device.purchase_date ?? '',
    warranty_expiry: device.warranty_expiry ?? '',
    in_service_date: device.in_service_date ?? '',
    notes: device.notes ?? '',
  });
  return (
    <FormModal
      title={`Edit ${device.code}`}
      wide
      onClose={onClose}
      onSubmit={async () => {
        const v = f.values;
        await api.patch(`/api/devices/${device.id}`, {
          ...v,
          u_height: num(v.u_height) ?? undefined,
          mac: v.mac || null,
          purchase_date: v.purchase_date || null,
          warranty_expiry: v.warranty_expiry || null,
          in_service_date: v.in_service_date || null,
        });
        onSaved();
      }}
    >
      <div className="grid-3">
        <TextField label="Code" required maxLength={16} {...f.bind('code')} />
        <TextField label="Name" {...f.bind('name')} />
        <SelectField label="Status" {...f.bind('status')} options={statusOptions} />
        <TextField label="Manufacturer" {...f.bind('manufacturer')} />
        <TextField label="Model" {...f.bind('model')} />
        <TextField label="Height (U)" type="number" min={0.5} step={0.5} {...f.bind('u_height')} />
        <TextField label="Serial number" {...f.bind('serial_number')} />
        <TextField label="Asset tag" {...f.bind('asset_tag')} />
        <TextField label="Hostname" {...f.bind('hostname')} />
        <TextField label="MAC address" {...f.bind('mac')} />
        <TextField label="Operating system" {...f.bind('os')} />
        <TextField label="Firmware" {...f.bind('firmware')} />
        <TextField label="Purchased" type="date" {...f.bind('purchase_date')} />
        <TextField label="Warranty until" type="date" {...f.bind('warranty_expiry')} />
        <TextField label="In service since" type="date" {...f.bind('in_service_date')} />
      </div>
      <TextArea label="Notes" {...f.bind('notes')} />
    </FormModal>
  );
}

export interface PlaceOption {
  kind: 'location' | 'floor' | 'room' | 'rack';
  id: number;
  path: string;
}

/** Moves a device to a rack position, a room, or the Unplaced list, with a
 * preview of what the move does (cables cut, a code clash). */
export function MoveDevice({ device, projectId, onClose, onSaved }: { device: Device; projectId: number; onClose: () => void; onSaved: () => void }) {
  const p = device.placement;
  const [kind, setKind] = useState<'rack' | 'room' | 'unplaced'>(p.type === 'room' ? 'room' : p.type === 'unplaced' ? 'unplaced' : 'rack');
  const [target, setTarget] = useState(p.type === 'rack' ? String(p.rack_id) : p.type === 'room' ? String(p.room_id) : '');
  const f = useForm({
    u: p.type === 'rack' && p.u != null ? String(p.u) : '',
    face: p.type === 'rack' ? p.face : 'front',
    mount: p.type === 'rack' ? p.mount : 'full_width',
  });
  const [places, setPlaces] = useState<PlaceOption[] | null>(null);
  useEffect(() => {
    api.get<PlaceOption[]>(`/api/projects/${projectId}/places`).then(setPlaces, () => setPlaces([]));
  }, [projectId]);
  const options = (places ?? []).filter((x) => x.kind === kind);
  const zeroU = f.values.mount.startsWith('zero');
  const id = Number(target || options[0]?.id) || null;
  const placement =
    kind === 'unplaced'
      ? { type: 'unplaced' }
      : !id
        ? null
        : kind === 'room'
          ? { type: 'room', room_id: id, x: null, y: null, rotation: null }
          : { type: 'rack', rack_id: id, u: zeroU ? null : num(f.values.u), face: f.values.face, mount: f.values.mount };
  return (
    <MoveDialog
      title={`Move ${device.code}`}
      resource={{ type: 'device', id: device.id }}
      target={placement ? { placement } : null}
      onClose={onClose}
      onMoved={() => onSaved()}
    >
      <SelectField
        label="Move to"
        value={kind}
        onChange={(e) => {
          setKind(e.target.value as typeof kind);
          setTarget('');
        }}
        options={[
          { value: 'rack', label: 'A rack' },
          { value: 'room', label: 'A room (floor-standing)' },
          { value: 'unplaced', label: 'Unplaced' },
        ]}
      />
      {kind !== 'unplaced' &&
        (places ? (
          <SelectField label={kind === 'rack' ? 'Rack' : 'Room'} value={target} onChange={(e) => setTarget(e.target.value)} options={options.map((o) => ({ value: String(o.id), label: o.path.split('/').slice(1).join(' / ') }))} />
        ) : (
          <Spinner />
        ))}
      {kind === 'rack' && (
        <div className="grid-3">
          <SelectField label="Mount" {...f.bind('mount')} options={mountOptions} />
          {!zeroU && <TextField label="Lowest U" type="number" min={1} step={0.5} {...f.bind('u')} />}
          {!zeroU && <SelectField label="Face" {...f.bind('face')} options={faceOptions} />}
        </div>
      )}
    </MoveDialog>
  );
}
