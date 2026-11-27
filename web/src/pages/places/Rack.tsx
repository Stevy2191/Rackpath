// A rack: front and rear elevations in half-U steps, zero-U devices at the
// sides, and devices added by clicking a free U or moved by dragging.
import { useEffect, useState, type DragEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MoveRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { useProject } from '../../layout/Shell';
import { link } from '../../links';
import type { Device, Placement, Rack, Room } from '../../types';
import { Badge, Button, Card, ErrorBox, FormModal, PageHeader, SelectField, Spinner, Tabs, TextArea, TextField, message, useLoad, useToast } from '../../ui';
import { DeviceForm, MoveDevice } from '../devices/DeviceForm';
import { PortsPanel } from '../cabling/PortsPanel';
import { RackPowerPanel } from '../power/Power';
import { Crumbs, DeleteModal, KeyValues, num, useForm } from './common';
import { MoveRack } from './Move';
import { BomButton, ReportButton } from '../Exports';

export function RackForm({ rooms, projectId, existing, onClose, onSaved }: { rooms: Room[]; projectId: number; existing?: Rack; onClose: () => void; onSaved: (r: Rack) => void }) {
  const f = useForm({
    room_id: String(existing?.room_id ?? rooms.find((r) => !r.is_default)?.id ?? rooms[0]?.id ?? ''),
    code: existing?.code ?? '',
    name: existing?.name ?? '',
    u_height: String(existing?.u_height ?? 42),
    width: existing?.width ?? '19in',
    depth_mm: existing?.depth_mm != null ? String(existing.depth_mm) : '',
    numbering: existing?.numbering ?? 'bottom_up',
    rack_type: existing?.rack_type ?? 'enclosed',
    notes: existing?.notes ?? '',
  });
  const roomId = f.values.room_id;
  const setValues = f.setValues;
  useEffect(() => {
    if (existing || !roomId) return;
    api
      .get<{ code: string }>(`/api/projects/${projectId}/next-code?kind=rack&room_id=${roomId}`)
      .then((r) => setValues((v) => (v.code ? v : { ...v, code: r.code })))
      .catch(() => {});
  }, [existing, projectId, roomId, setValues]);
  return (
    <FormModal
      title={existing ? `Edit rack ${existing.code}` : 'Add rack'}
      onClose={onClose}
      onSubmit={async () => {
        const body = { ...f.values, room_id: Number(f.values.room_id), u_height: Number(f.values.u_height), depth_mm: num(f.values.depth_mm) };
        const saved = existing
          ? await api.patch<Rack>(`/api/racks/${existing.id}`, body)
          : await api.post<Rack>(`/api/rooms/${body.room_id}/racks`, body);
        onSaved(saved);
      }}
    >
      {rooms.length > 1 && (
        <SelectField label="Room" {...f.bind('room_id')} options={rooms.map((r) => ({ value: String(r.id), label: `${r.code}${r.name ? ` (${r.name})` : ''}` }))} />
      )}
      <div className="grid-2">
        <TextField label="Code" required maxLength={16} {...f.bind('code')} />
        <TextField label="Name" {...f.bind('name')} />
        <TextField label="Height (U)" type="number" min={1} max={60} required {...f.bind('u_height')} />
        <TextField label="Depth (mm)" type="number" min={1} {...f.bind('depth_mm')} />
        <SelectField label="Width" {...f.bind('width')} options={[{ value: '19in', label: '19 inch' }, { value: '23in', label: '23 inch' }, { value: '10in', label: '10 inch' }]} />
        <SelectField
          label="Type"
          {...f.bind('rack_type')}
          options={[{ value: 'enclosed', label: 'Enclosed cabinet' }, { value: 'open_frame', label: 'Open frame' }, { value: 'wall_mount', label: 'Wall mount' }, { value: 'other', label: 'Other' }]}
        />
        <SelectField label="U numbering" {...f.bind('numbering')} options={[{ value: 'bottom_up', label: 'U1 at the bottom' }, { value: 'top_down', label: 'U1 at the top' }]} />
      </div>
      <TextArea label="Notes" {...f.bind('notes')} />
    </FormModal>
  );
}

type Face = 'front' | 'rear';
type RackSlot = Extract<Placement, { type: 'rack' }>;

export function RackPage() {
  const { project } = useProject();
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const rack = useLoad(() => api.get<Rack>(`/api/racks/${id}`), [id]);
  const [face, setFace] = useState<Face>('front');
  const [params, setParams] = useSearchParams();
  const view = (['patching', 'power'] as const).find((v) => v === params.get('view')) ?? 'elevation';
  const [selected, setSelected] = useState<number | null>(null);
  const [modal, setModal] = useState<{ type: 'edit' | 'delete' | 'move' | 'move-rack' } | { type: 'add'; u: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (rack.error) return <ErrorBox error={rack.error} onRetry={rack.reload} />;
  if (!rack.data) return <Spinner />;
  const r = rack.data;
  const devices = r.devices ?? [];
  const sel = devices.find((d) => d.id === selected);
  const edit = !!r.can_edit;

  const move = async (d: Device, u: number) => {
    const p = d.placement as RackSlot;
    try {
      await api.patch(`/api/devices/${d.id}`, { placement: { type: 'rack', rack_id: r.id, u, face: p.face, mount: p.mount } });
      setError(null);
      rack.reload();
    } catch (e) {
      setError(message(e));
    }
  };

  const zero = (side: 'zero_u_left' | 'zero_u_right') => devices.filter((d) => d.placement.type === 'rack' && d.placement.mount === side);

  return (
    <div>
      <Crumbs path={r.path} links={[undefined, undefined, link.room(project.id, r.room_id)]} />
      <PageHeader
        title={<><span className="mono">{r.code}</span>{r.name && <span className="title-name"> {r.name}</span>}</>}
        subtitle={`${r.u_height}U · ${r.width} · ${r.rack_type.replace('_', ' ')}${r.depth_mm ? ` · ${r.depth_mm} mm deep` : ''}`}
        actions={
          <>
            <ReportButton type="rack" id={r.id} />
            <BomButton rackId={r.id} />
            {edit && (
              <>
                <Button variant="primary" icon={<Plus size={15} />} onClick={() => setModal({ type: 'add', u: null })}>Add device</Button>
                <Button icon={<Pencil size={15} />} onClick={() => setModal({ type: 'edit' })}>Edit</Button>
                <Button icon={<MoveRight size={15} />} onClick={() => setModal({ type: 'move-rack' })}>Move</Button>
                <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setModal({ type: 'delete' })}>Delete</Button>
              </>
            )}
          </>
        }
      />
      <ErrorBox error={error} />
      <Tabs
        tabs={[
          { id: 'elevation', label: 'Elevation' },
          { id: 'patching', label: 'Patching' },
          { id: 'power', label: 'Power' },
        ]}
        value={view}
        onChange={(v) => setParams(v === 'elevation' ? {} : { view: v }, { replace: true })}
      />
      {view === 'power' ? (
        <div className="tab-panel">
          <RackPowerPanel projectId={project.id} rackId={r.id} />
        </div>
      ) : view === 'patching' ? (
        <div className="tab-panel">
          <PortsPanel
            projectId={project.id}
            rackId={r.id}
            canEdit={edit}
            groupBy={(p) => {
              const d = devices.find((x) => x.id === p.device_id);
              return d ? `${d.code}${d.name ? ` · ${d.name}` : ''}${d.placement.type === 'rack' && d.placement.u != null ? ` · U${d.placement.u}` : ''}` : p.path.split('/').slice(-2, -1)[0];
            }}
          />
        </div>
      ) : (
      <div className="rack-layout">
        <div>
          <div className="segmented" role="group" aria-label="Rack face">
            {(['front', 'rear'] as Face[]).map((x) => (
              <button key={x} type="button" aria-pressed={face === x} onClick={() => setFace(x)}>{x === 'front' ? 'Front' : 'Rear'}</button>
            ))}
          </div>
          <div className="rack-frame-wrap">
            <ZeroU devices={zero('zero_u_left')} label="Left" onSelect={setSelected} selected={selected} />
            <Elevation
              rack={r}
              devices={devices}
              face={face}
              selected={selected}
              onSelect={setSelected}
              onAdd={edit ? (u) => setModal({ type: 'add', u }) : undefined}
              onMove={edit ? move : undefined}
            />
            <ZeroU devices={zero('zero_u_right')} label="Right" onSelect={setSelected} selected={selected} />
          </div>
        </div>
        <aside className="stack">
          {sel ? (
            <Card title={`${sel.code}${sel.name ? ` · ${sel.name}` : ''}`}>
              <div className="stack">
                <KeyValues
                  rows={[
                    ['Type', sel.device_type.label],
                    ['Model', [sel.manufacturer, sel.model].filter(Boolean).join(' ')],
                    ['Position', describe(sel.placement as RackSlot, sel.u_height, r)],
                    ['Status', <Badge tone={sel.status === 'active' ? 'ok' : sel.status === 'faulty' ? 'danger' : 'neutral'}>{sel.status}</Badge>],
                    ['Serial', sel.serial_number],
                    ['Hostname', sel.hostname],
                  ]}
                />
                <div className="row">
                  <Link to={link.device(project.id, sel.id)}>Open device</Link>
                  {edit && <Button variant="ghost" onClick={() => setModal({ type: 'move' })}>Move…</Button>}
                </div>
              </div>
            </Card>
          ) : (
            <Card title="Rack">
              <KeyValues
                rows={[
                  ['Devices', devices.length],
                  ['Used', `${usedU(devices)} of ${r.u_height}U (front)`],
                  ['Numbering', r.numbering === 'bottom_up' ? 'U1 at the bottom' : 'U1 at the top'],
                  ['Notes', r.notes && <span className="pre">{r.notes}</span>],
                ]}
              />
              {edit && <p className="small muted">Click a free U to add a device there; drag a device to move it.</p>}
            </Card>
          )}
        </aside>
      </div>
      )}
      {modal?.type === 'move-rack' && (
        <MoveRack
          projectId={project.id}
          rackId={r.id}
          roomId={r.room_id}
          onClose={() => setModal(null)}
          onMoved={(m) => {
            toast.ok(`Moved to ${m.to.split('/').slice(1, -1).join(' / ')}`);
            rack.reload();
          }}
        />
      )}
      {modal?.type === 'edit' && (
        <RackEdit rack={r} projectId={project.id} onClose={() => setModal(null)} onSaved={rack.reload} />
      )}
      {modal?.type === 'add' && (
        <DeviceForm
          projectId={project.id}
          placement={{ type: 'rack', rack_id: r.id, u: modal.u, face: face === 'rear' ? 'rear' : 'front', mount: 'full_width' }}
          onClose={() => setModal(null)}
          onSaved={(d) => {
            setSelected(d.id);
            rack.reload();
          }}
        />
      )}
      {modal?.type === 'move' && sel && <MoveDevice device={sel} projectId={project.id} onClose={() => setModal(null)} onSaved={rack.reload} />}
      {modal?.type === 'delete' && (
        <DeleteModal
          kind="rack"
          code={r.code}
          url={`/api/racks/${r.id}`}
          devices={devices.length}
          onClose={() => setModal(null)}
          onDone={() => {
            toast.ok(`Deleted ${r.code}`);
            nav(link.room(project.id, r.room_id));
          }}
        />
      )}
    </div>
  );
}

function RackEdit({ rack, projectId, onClose, onSaved }: { rack: Rack; projectId: number; onClose: () => void; onSaved: () => void }) {
  // The room list for moving a rack comes from its floor.
  const rooms = useLoad(
    () => api.get<Room>(`/api/rooms/${rack.room_id}`).then((room) => api.get<{ rooms: Room[] }>(`/api/floors/${room.floor_id}`)).then((f) => f.rooms),
    [rack.room_id],
  );
  if (!rooms.data) return null;
  return <RackForm rooms={rooms.data} projectId={projectId} existing={rack} onClose={onClose} onSaved={onSaved} />;
}

function describe(p: RackSlot, h: number | null, rack: Rack): string {
  if (p.mount === 'zero_u_left' || p.mount === 'zero_u_right') return `Zero-U, ${p.mount === 'zero_u_left' ? 'left' : 'right'} side`;
  if (p.u == null) return 'In the rack, no position';
  const label = (n: number) => (rack.numbering === 'bottom_up' ? n : rack.u_height - n + 1);
  const bottom = Math.floor(p.u);
  const top = Math.max(bottom, Math.ceil(p.u + (h ?? 1)) - 1);
  const [a, b] = [label(bottom), label(top)].sort((x, y) => x - y);
  const span = a === b ? `U${a}` : `U${a}–U${b}`;
  const mount = p.mount === 'half_left' ? ', left half' : p.mount === 'half_right' ? ', right half' : '';
  const face = p.face === 'both' ? 'full depth' : p.face;
  return `${span}${p.u % 1 ? ' (half-U offset)' : ''}, ${face}${mount}`;
}

function usedU(devices: Device[]): number {
  return devices
    .filter((d) => d.placement.type === 'rack' && d.placement.face !== 'rear' && !d.placement.mount.startsWith('zero'))
    .reduce((n, d) => n + (d.u_height ?? 0) * (d.placement.type === 'rack' && d.placement.mount.startsWith('half') ? 0.5 : 1), 0);
}

function ZeroU({ devices, label, selected, onSelect }: { devices: Device[]; label: string; selected: number | null; onSelect: (id: number) => void }) {
  return (
    <div className="rack-zero" aria-label={`Zero-U ${label.toLowerCase()}`}>
      {devices.map((d) => (
        <button key={d.id} className={`rack-zero-item${selected === d.id ? ' selected' : ''}`} onClick={() => onSelect(d.id)} title={d.name ?? d.code}>
          {d.code}
        </button>
      ))}
    </div>
  );
}

/** The elevation: one grid row per half U, top row first. */
export function Elevation({
  rack,
  devices,
  face,
  selected,
  onSelect,
  onAdd,
  onMove,
}: {
  rack: Rack;
  devices: Device[];
  face: Face;
  selected: number | null;
  onSelect: (id: number) => void;
  onAdd?: (u: number) => void;
  onMove?: (d: Device, u: number) => void;
}) {
  const U = rack.u_height;
  const rows = U * 2;
  const [over, setOver] = useState<number | null>(null);
  const placed = devices.filter((d) => d.placement.type === 'rack' && d.placement.u != null && !d.placement.mount.startsWith('zero'));
  const label = (n: number) => (rack.numbering === 'bottom_up' ? n : U - n + 1);
  const rowOf = (u: number, h: number) => rows - (u - 1) * 2 - h * 2 + 1;
  const drop = (u: number) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const d = devices.find((x) => String(x.id) === e.dataTransfer.getData('text/rackpath-device'));
    if (d && onMove) onMove(d, u);
  };
  return (
    <div className="rack-elevation" style={{ gridTemplateRows: `repeat(${rows}, var(--rack-half))` }} data-face={face}>
      {Array.from({ length: U }, (_, i) => {
        const n = i + 1;
        const row = rowOf(n, 1);
        return (
          <div key={`u${n}`} style={{ display: 'contents' }}>
            <div className="rack-u-label" style={{ gridRow: `${row} / span 2` }}>{label(n)}</div>
            <div
              className={`rack-slot${over === n ? ' over' : ''}`}
              style={{ gridRow: `${row} / span 2` }}
              onClick={onAdd ? () => onAdd(n) : undefined}
              onDragOver={onMove ? (e) => { e.preventDefault(); setOver(n); } : undefined}
              onDragLeave={() => setOver((o) => (o === n ? null : o))}
              onDrop={onMove ? drop(n) : undefined}
              role={onAdd ? 'button' : undefined}
              aria-label={onAdd ? `Add a device at U${label(n)}` : undefined}
            />
            <div className="rack-u-label right" style={{ gridRow: `${row} / span 2` }}>{label(n)}</div>
          </div>
        );
      })}
      {placed.map((d) => {
        const p = d.placement as RackSlot;
        const h = d.u_height ?? 1;
        const mine = p.face === 'both' || p.face === face;
        const col = p.mount === 'half_left' ? '2 / span 1' : p.mount === 'half_right' ? '3 / span 1' : '2 / span 2';
        return (
          <div
            key={d.id}
            className={`rack-device${mine ? '' : ' other-face'}${selected === d.id ? ' selected' : ''} status-${d.status}`}
            style={{ gridRow: `${rowOf(p.u!, h)} / span ${Math.max(1, h * 2)}`, gridColumn: col }}
            draggable={mine && !!onMove}
            onDragStart={(e) => e.dataTransfer.setData('text/rackpath-device', String(d.id))}
            onClick={() => mine && onSelect(d.id)}
            title={`${d.code}${d.name ? ` – ${d.name}` : ''}`}
            data-device={d.code}
          >
            {mine && (
              <>
                <span className="mono">{d.code}</span>
                {h >= 1 && <span className="rack-device-name">{d.name ?? d.model ?? d.device_type.label}</span>}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
