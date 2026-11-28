// A floor: its plan image, rooms drawn as polygons, and racks and
// floor-standing devices positioned on it (in plan pixels).
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ImagePlus, MoveRight, Pencil, PenLine, Plus, RotateCw, Trash2, X } from 'lucide-react';
import { api } from '../../api';
import { useProject } from '../../layout/Shell';
import { link } from '../../links';
import type { Device, Floor, RackSummary, Room } from '../../types';
import { Badge, Button, Card, Empty, ErrorBox, FormModal, PageHeader, SelectField, Spinner, Tabs, TextField, message, useLoad, useToast } from '../../ui';
import { Crumbs, DeleteModal } from './common';
import { FloorForm } from './Locations';
import { RackForm } from './Rack';
import { RoomForm } from './Room';
import { MoveFloor } from './Move';
import { RackRow } from './RackRow';
import { ReportButton } from '../Exports';

const DEFAULT_W = 1200;
const DEFAULT_H = 800;

type Item = { kind: 'rack' | 'device'; id: number };
type Mode = { type: 'view' } | { type: 'draw'; points: [number, number][]; roomId?: number } | { type: 'place'; item: Item };

const rackMetres = (r: RackSummary): [number, number] => [
  r.width === '23in' ? 0.75 : r.width === '10in' ? 0.35 : 0.6,
  (r.depth_mm ?? 1000) / 1000,
];

export function FloorPage() {
  const { project } = useProject();
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const floor = useLoad(() => api.get<Floor>(`/api/floors/${id}`), [id]);
  const [mode, setMode] = useState<Mode>({ type: 'view' });
  const [selected, setSelected] = useState<{ kind: 'room' | 'rack' | 'device'; id: number } | null>(null);
  const [modal, setModal] = useState<'edit' | 'delete' | 'room' | 'rack' | 'shape' | 'move' | null>(null);
  const [moved, setMoved] = useState<Record<string, [number, number]>>({});
  const [drag, setDrag] = useState<{ item: Item; start: [number, number]; at: [number, number]; origin: [number, number] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [params, setParams] = useSearchParams();

  if (floor.error) return <ErrorBox error={floor.error} onRetry={floor.reload} />;
  if (!floor.data) return <Spinner />;
  const f = floor.data;
  const rooms = f.rooms ?? [];
  const racks = f.racks ?? [];
  const devices = f.devices ?? [];
  // Racks first; a floor with a plan image opens on its plan.
  const defaultView = f.plan_image_type ? 'plan' : 'racks';
  const asked = params.get('view');
  const view: 'plan' | 'racks' = asked === 'plan' || asked === 'racks' ? asked : defaultView;
  const W = f.plan_width ?? DEFAULT_W;
  const H = f.plan_height ?? DEFAULT_H;
  const scale = f.scale_px_per_m ?? Math.min(W, H) / 15;
  const edit = !!f.can_edit;
  // Keep the positions just saved until the reloaded floor has them.
  const reload = () => floor.reload().then(() => setMoved({}));
  const totalDevices = devices.length + racks.reduce((n, r) => n + r.device_count, 0);

  const toPlan = (e: { clientX: number; clientY: number }): [number, number] => {
    const el = svg.current;
    const m = el?.getScreenCTM();
    if (!el || !m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [Math.round(Math.max(0, Math.min(W, p.x))), Math.round(Math.max(0, Math.min(H, p.y)))];
  };

  const posOf = (item: Item): [number, number] | null => {
    const key = `${item.kind}:${item.id}`;
    if (drag && drag.item.kind === item.kind && drag.item.id === item.id) return drag.at;
    if (moved[key]) return moved[key];
    if (item.kind === 'rack') {
      const r = racks.find((r) => r.id === item.id);
      return r && r.plan_x != null && r.plan_y != null ? [r.plan_x, r.plan_y] : null;
    }
    const d = devices.find((d) => d.id === item.id);
    return d && d.placement.type === 'room' && d.placement.x != null && d.placement.y != null ? [d.placement.x, d.placement.y] : null;
  };

  const savePos = async (item: Item, p: [number, number], rotation?: number) => {
    setMoved((m) => ({ ...m, [`${item.kind}:${item.id}`]: p }));
    try {
      if (item.kind === 'rack') {
        await api.patch(`/api/racks/${item.id}`, { plan_x: p[0], plan_y: p[1], ...(rotation !== undefined && { plan_rotation: rotation }) });
      } else {
        const d = devices.find((d) => d.id === item.id) ?? (await api.get<Device>(`/api/devices/${item.id}`));
        const pl = d.placement.type === 'room' ? d.placement : null;
        const roomId = pl?.room_id ?? roomAt(p)?.id ?? rooms.find((r) => r.is_default)?.id ?? rooms[0]?.id;
        await api.patch(`/api/devices/${item.id}`, {
          placement: { type: 'room', room_id: roomId, x: p[0], y: p[1], rotation: rotation ?? pl?.rotation ?? null },
        });
      }
      setError(null);
    } catch (e) {
      setError(message(e));
      reload();
    }
  };

  const roomAt = ([x, y]: [number, number]): Room | undefined =>
    rooms.find((r) => r.shape && inside(x, y, r.shape.points));

  const onCanvasClick = (e: React.MouseEvent) => {
    if (mode.type === 'draw') {
      setMode({ ...mode, points: [...mode.points, toPlan(e)] });
    } else if (mode.type === 'place') {
      savePos(mode.item, toPlan(e)).then(reload);
      setMode({ type: 'view' });
    } else {
      setSelected(null);
    }
  };

  const startDrag = (item: Item) => (e: ReactPointerEvent) => {
    e.stopPropagation();
    if (mode.type !== 'view') return;
    setSelected({ kind: item.kind, id: item.id });
    if (!edit) return;
    const p = posOf(item);
    if (!p) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const start = toPlan(e);
    setDrag({ item, start, at: p, origin: p });
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const c = toPlan(e);
    setDrag({ ...drag, at: [Math.round(drag.origin[0] + c[0] - drag.start[0]), Math.round(drag.origin[1] + c[1] - drag.start[1])] });
  };
  const onUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.at[0] !== d.origin[0] || d.at[1] !== d.origin[1]) savePos(d.item, d.at);
  };

  const upload = async (fl: File) => {
    try {
      await api.upload('PUT', `/api/floors/${f.id}/plan-image`, fl, fl.type || 'application/octet-stream');
      toast.ok('Floor plan uploaded');
      reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const selRoom = selected?.kind === 'room' ? rooms.find((r) => r.id === selected.id) : undefined;
  const selRack = selected?.kind === 'rack' ? racks.find((r) => r.id === selected.id) : undefined;
  const selDevice = selected?.kind === 'device' ? devices.find((d) => d.id === selected.id) : undefined;
  const unplacedRacks = racks.filter((r) => !posOf({ kind: 'rack', id: r.id }));
  const unplacedDevices = devices.filter((d) => !posOf({ kind: 'device', id: d.id }));

  return (
    <div>
      <Crumbs path={f.path} links={[link.location(project.id, f.location_id)]} />
      <PageHeader
        title={<><span className="mono">{f.code}</span>{f.name && <span className="title-name"> {f.name}</span>}</>}
        subtitle={`Level ${f.level}`}
        actions={
          <>
            <ReportButton type="floor" id={f.id} />
            {edit && (
              <>
                <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
                <Button icon={<ImagePlus size={15} />} onClick={() => file.current?.click()}>{f.plan_image_type ? 'Replace plan' : 'Upload plan'}</Button>
                {f.plan_image_type && (
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      await api.del(`/api/floors/${f.id}/plan-image`).catch((e) => toast.error(e));
                      reload();
                    }}
                  >
                    Remove plan
                  </Button>
                )}
                <Button icon={<Pencil size={15} />} onClick={() => setModal('edit')}>Edit</Button>
                <Button icon={<MoveRight size={15} />} onClick={() => setModal('move')}>Move</Button>
                <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setModal('delete')}>Delete</Button>
              </>
            )}
          </>
        }
      />
      <ErrorBox error={error} />
      <Tabs
        tabs={[
          { id: 'racks', label: `Racks (${racks.length})` },
          { id: 'plan', label: f.plan_image_type ? 'Floor plan' : 'Floor plan and rooms' },
        ]}
        value={view}
        onChange={(v) => setParams(v === defaultView ? {} : { view: v }, { replace: true })}
      />
      {view === 'racks' ? (
        <div className="tab-panel">
          <Card title="Racks side by side" actions={edit && <Button variant="ghost" icon={<Plus size={15} />} onClick={() => setModal('rack')}>Add rack</Button>}>
            {racks.length === 0 ? (
              <Empty title="No racks on this floor">The floor plan is optional: add racks here and put devices in them.</Empty>
            ) : (
              <RackRow projectId={project.id} racks={racks} canEdit={edit} onChanged={reload} />
            )}
          </Card>
        </div>
      ) : (
      <div className="plan-layout">
          <div className="plan-wrap">
            {mode.type !== 'view' && (
              <div className="plan-banner">
                {mode.type === 'draw' ? (
                  <>
                    <span>Click to add corners ({mode.points.length} so far).</span>
                    <Button
                      variant="primary"
                      disabled={mode.points.length < 3}
                      onClick={() => (mode.roomId ? saveShape(mode.roomId, mode.points) : setModal('shape'))}
                    >
                      Finish
                    </Button>
                    <Button variant="ghost" disabled={mode.points.length === 0} onClick={() => setMode({ ...mode, points: mode.points.slice(0, -1) })}>Undo</Button>
                  </>
                ) : (
                  <span>Click on the plan to place it.</span>
                )}
                <Button variant="ghost" icon={<X size={15} />} onClick={() => setMode({ type: 'view' })}>Cancel</Button>
              </div>
            )}
            <svg
              ref={svg}
              className={`plan${mode.type !== 'view' ? ' plan-crosshair' : ''}`}
              viewBox={`0 0 ${W} ${H}`}
              role="img"
              aria-label={`Floor plan of ${f.code}`}
              onClick={onCanvasClick}
              onPointerMove={onMove}
              onPointerUp={onUp}
            >
              <defs>
                <pattern id="plan-grid" width={scale} height={scale} patternUnits="userSpaceOnUse">
                  <path d={`M ${scale} 0 L 0 0 0 ${scale}`} className="plan-gridline" />
                </pattern>
              </defs>
              {f.plan_image_type ? (
                <image href={`/api/floors/${f.id}/plan-image?v=${encodeURIComponent(f.updated_at)}`} width={W} height={H} />
              ) : (
                <rect width={W} height={H} fill="url(#plan-grid)" />
              )}
              {rooms.map(
                (r) =>
                  r.shape && (
                    <g key={r.id} className={`plan-room${selRoom?.id === r.id ? ' selected' : ''}`} onClick={(e) => { if (mode.type === 'view') { e.stopPropagation(); setSelected({ kind: 'room', id: r.id }); } }}>
                      <polygon points={r.shape.points.map((p) => p.join(',')).join(' ')} style={{ fill: r.color ?? undefined, stroke: r.color ?? undefined }} />
                      <text x={centroid(r.shape.points)[0]} y={centroid(r.shape.points)[1]} className="plan-label">{r.code}</text>
                    </g>
                  ),
              )}
              {mode.type === 'draw' && mode.points.length > 0 && (
                <g className="plan-drawing">
                  <polyline points={mode.points.map((p) => p.join(',')).join(' ')} />
                  {mode.points.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={4} />)}
                </g>
              )}
              {racks.map((r) => {
                const p = posOf({ kind: 'rack', id: r.id });
                if (!p) return null;
                const [wm, dm] = rackMetres(r);
                const w = wm * scale;
                const d = dm * scale;
                return (
                  <g
                    key={r.id}
                    className={`plan-rack${selRack?.id === r.id ? ' selected' : ''}`}
                    transform={`translate(${p[0]} ${p[1]}) rotate(${r.plan_rotation ?? 0})`}
                    onPointerDown={startDrag({ kind: 'rack', id: r.id })}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={() => nav(link.rack(project.id, r.id))}
                    data-rack={r.code}
                  >
                    <rect x={-w / 2} y={-d / 2} width={w} height={d} />
                    <line x1={-w / 2} y1={d / 2} x2={w / 2} y2={d / 2} className="plan-front" />
                    <text y={4} className="plan-label">{r.code}</text>
                  </g>
                );
              })}
              {devices.map((dv) => {
                const p = posOf({ kind: 'device', id: dv.id });
                if (!p) return null;
                return (
                  <g
                    key={dv.id}
                    className={`plan-device${selDevice?.id === dv.id ? ' selected' : ''}`}
                    transform={`translate(${p[0]} ${p[1]})`}
                    onPointerDown={startDrag({ kind: 'device', id: dv.id })}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={() => nav(link.device(project.id, dv.id))}
                  >
                    <circle r={scale * 0.25} />
                    <text y={-scale * 0.35} className="plan-label">{dv.code}</text>
                  </g>
                );
              })}
            </svg>
            {!f.plan_image_type && <p className="small muted">No plan image yet{edit ? ': upload a PNG, JPEG or WebP drawing of this floor.' : '.'} Each grid square is a metre until you set the plan scale.</p>}
          </div>
          <aside className="plan-side stack">
            {selRoom && (
              <Card title={`Room ${selRoom.code}`}>
                <div className="stack">
                  <div>{selRoom.name}</div>
                  <div className="row">
                    <Link to={link.room(project.id, selRoom.id)}>Open room</Link>
                    {edit && <Button variant="ghost" icon={<PenLine size={15} />} onClick={() => setMode({ type: 'draw', points: [], roomId: selRoom.id })}>Redraw shape</Button>}
                  </div>
                </div>
              </Card>
            )}
            {selRack && (
              <Card title={`Rack ${selRack.code}`}>
                <div className="stack">
                  <div className="small muted">{selRack.u_height}U · {selRack.device_count} device(s) · in {rooms.find((r) => r.id === selRack.room_id)?.code}</div>
                  <div className="row">
                    <Link to={link.rack(project.id, selRack.id)}>Open rack</Link>
                    {edit && (
                      <Button
                        variant="ghost"
                        icon={<RotateCw size={15} />}
                        onClick={async () => {
                          const p = posOf({ kind: 'rack', id: selRack.id });
                          if (p) await savePos({ kind: 'rack', id: selRack.id }, p, ((selRack.plan_rotation ?? 0) + 90) % 360);
                          reload();
                        }}
                      >
                        Rotate
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            )}
            {selDevice && (
              <Card title={`Device ${selDevice.code}`}>
                <div className="stack">
                  <div className="small muted">{selDevice.device_type.label}{selDevice.name ? ` · ${selDevice.name}` : ''}</div>
                  <Link to={link.device(project.id, selDevice.id)}>Open device</Link>
                </div>
              </Card>
            )}
            <Card
              title="Rooms"
              actions={
                edit && (
                  <>
                    <Button variant="ghost" icon={<PenLine size={15} />} onClick={() => setMode({ type: 'draw', points: [] })}>Draw</Button>
                    <Button variant="ghost" icon={<Plus size={15} />} onClick={() => setModal('room')}>Add</Button>
                  </>
                )
              }
            >
              <ul className="list">
                {rooms.map((r) => (
                  <li key={r.id} className="row">
                    <span className="swatch" style={{ background: r.color ?? 'var(--color-border-strong)' }} />
                    <Link to={link.room(project.id, r.id)} className="mono">{r.code}</Link>
                    <span className="small">{r.name}</span>
                    {r.is_default && <Badge>default</Badge>}
                    {!r.shape && !r.is_default && <span className="small muted">not drawn</span>}
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="Racks" actions={edit && <Button variant="ghost" icon={<Plus size={15} />} onClick={() => setModal('rack')}>Add</Button>}>
              {racks.length === 0 ? (
                <p className="small muted">No racks on this floor.</p>
              ) : (
                <ul className="list">
                  {racks.map((r) => (
                    <li key={r.id} className="row">
                      <Link to={link.rack(project.id, r.id)} className="mono">{r.code}</Link>
                      <span className="small muted">{r.u_height}U · {r.device_count} dev.</span>
                      <span className="grow" />
                      {edit && unplacedRacks.includes(r) && (
                        <Button variant="ghost" onClick={() => setMode({ type: 'place', item: { kind: 'rack', id: r.id } })}>Place</Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {unplacedDevices.length > 0 && (
              <Card title="Floor devices not on the plan">
                <ul className="list">
                  {unplacedDevices.map((d) => (
                    <li key={d.id} className="row">
                      <Link to={link.device(project.id, d.id)} className="mono">{d.code}</Link>
                      <span className="grow" />
                      {edit && <Button variant="ghost" onClick={() => setMode({ type: 'place', item: { kind: 'device', id: d.id } })}>Place</Button>}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </aside>
        </div>
      )}
      {modal === 'move' && (
        <MoveFloor
          projectId={project.id}
          floorId={f.id}
          locationId={f.location_id}
          onClose={() => setModal(null)}
          onMoved={(r) => {
            toast.ok(`Moved to ${r.to.split('/').slice(1).join(' / ')}`);
            setModal(null);
            if (r.project_changed) nav(link.floor(r.project_id, f.id));
            else reload();
          }}
        />
      )}
      {modal === 'edit' && <FloorForm locationId={f.location_id} existing={f} onClose={() => setModal(null)} onSaved={reload} />}
      {modal === 'room' && <RoomForm floorId={f.id} onClose={() => setModal(null)} onSaved={reload} />}
      {modal === 'rack' && <RackForm rooms={rooms} projectId={project.id} onClose={() => setModal(null)} onSaved={reload} />}
      {modal === 'shape' && mode.type === 'draw' && (
        <ShapeTarget
          rooms={rooms}
          floorId={f.id}
          points={mode.points}
          onClose={() => setModal(null)}
          onSaved={() => {
            setMode({ type: 'view' });
            reload();
          }}
        />
      )}
      {modal === 'delete' && (
        <DeleteModal
          kind="floor"
          code={f.code}
          url={`/api/floors/${f.id}`}
          devices={totalDevices}
          onClose={() => setModal(null)}
          onDone={() => {
            toast.ok(`Deleted ${f.code}`);
            nav(link.location(project.id, f.location_id));
          }}
        />
      )}
    </div>
  );

  async function saveShape(roomId: number, points: [number, number][]) {
    try {
      await api.patch(`/api/rooms/${roomId}`, { shape: { type: 'polygon', points } });
      setMode({ type: 'view' });
      reload();
    } catch (e) {
      setError(message(e));
    }
  }
}

/** Where a newly drawn outline goes: an existing room without a shape,
 * or a new room. */
function ShapeTarget({ rooms, floorId, points, onClose, onSaved }: { rooms: Room[]; floorId: number; points: [number, number][]; onClose: () => void; onSaved: () => void }) {
  const candidates = rooms.filter((r) => !r.is_default);
  const [target, setTarget] = useState(candidates.find((r) => !r.shape)?.id.toString() ?? 'new');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  return (
    <FormModal
      title="Save room outline"
      onClose={onClose}
      onSubmit={async () => {
        const shape = { type: 'polygon', points };
        if (target === 'new') await api.post(`/api/floors/${floorId}/rooms`, { code, name, shape });
        else await api.patch(`/api/rooms/${target}`, { shape });
        onSaved();
      }}
    >
      <SelectField
        label="Room"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        options={[{ value: 'new', label: 'A new room' }, ...candidates.map((r) => ({ value: String(r.id), label: `${r.code}${r.name ? ` (${r.name})` : ''}${r.shape ? ' – replace outline' : ''}` }))]}
      />
      {target === 'new' && (
        <div className="grid-2">
          <TextField label="Code" required maxLength={16} value={code} onChange={(e) => setCode(e.target.value)} />
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      )}
    </FormModal>
  );
}

function centroid(points: [number, number][]): [number, number] {
  const n = points.length || 1;
  return [points.reduce((a, p) => a + p[0], 0) / n, points.reduce((a, p) => a + p[1], 0) / n];
}

function inside(x: number, y: number, pts: [number, number][]): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
