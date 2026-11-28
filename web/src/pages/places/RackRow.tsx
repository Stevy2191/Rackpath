// Racks side by side, the way they stand: grouped by row (A, B…), left to
// right in row order, at one scale, front or rear. From the rear a row is
// seen from the other aisle, so its order is mirrored.
//
// Click a free U to add a device (or place one from Unplaced), drag devices
// between racks, drag a rack's heading onto another to reorder the row.
import { useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowDownToLine, GripVertical, Plus } from 'lucide-react';
import { api } from '../../api';
import { link } from '../../links';
import type { Device, Placement, Rack, RackSummary } from '../../types';
import { Button, ErrorBox, Modal, Spinner, message, useLoad, useToast } from '../../ui';
import { DeviceForm } from '../devices/DeviceForm';
import { PlaceInRack, useUnplaced } from './Quick';
import { Elevation } from './Rack';

type Face = 'front' | 'rear';
type RackSlot = Extract<Placement, { type: 'rack' }>;
const DRAG_RACK = 'text/rackpath-rack';

/** Racks grouped by row, each group in row order (racks without a row last,
 * by code). */
export function rowsOf<T extends Pick<Rack, 'code' | 'row_label' | 'row_position'>>(racks: T[]): { row: string | null; racks: T[] }[] {
  const groups = new Map<string | null, T[]>();
  for (const r of racks) {
    const k = r.row_label ?? null;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const order = (a: T, b: T) => (a.row_position ?? 1e9) - (b.row_position ?? 1e9) || a.code.localeCompare(b.code);
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b, undefined, { numeric: true })))
    .map(([row, list]) => ({ row, racks: [...list].sort(order) }));
}

export function RackRow({ projectId, racks, canEdit, onChanged }: { projectId: number; racks: RackSummary[]; canEdit: boolean; onChanged?: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [face, setFace] = useState<Face>('front');
  const [version, setVersion] = useState(0);
  const ids = racks.map((r) => r.id).join(',');
  const full = useLoad(() => Promise.all(racks.map((r) => api.get<Rack>(`/api/racks/${r.id}`))), [ids, version]);
  const [modal, setModal] = useState<{ type: 'choose' | 'add' | 'place'; rack: Rack; u: number } | null>(null);
  const unplaced = useUnplaced(projectId, 'rack', version);
  const waiting = unplaced.devices?.length ?? 0;
  const [error, setError] = useState<string | null>(null);
  const [overRack, setOverRack] = useState<number | null>(null);
  if (full.error) return <ErrorBox error={full.error} onRetry={full.reload} />;
  if (!full.data) return <Spinner />;
  const all = full.data;
  const refresh = () => {
    setVersion((v) => v + 1);
    onChanged?.();
  };
  const allDevices = all.flatMap((r) => r.devices ?? []);
  const find = (id: string) => allDevices.find((d) => String(d.id) === id);

  const moveDevice = (target: Rack) => async (d: Device, u: number) => {
    const p = d.placement as RackSlot;
    try {
      await api.patch(`/api/devices/${d.id}`, { placement: { type: 'rack', rack_id: target.id, u, face: p.face, mount: p.mount.startsWith('zero') ? 'full_width' : p.mount } });
      setError(null);
      refresh();
    } catch (e) {
      setError(message(e));
    }
  };

  /** Drops rack `moved` before `target`: it joins target's row, and the row
   * is renumbered 1, 2, 3… in its new order. */
  const reorder = async (movedId: number, target: Rack) => {
    const moved = all.find((r) => r.id === movedId);
    if (!moved || moved.id === target.id) return;
    const row = target.row_label ?? null;
    const group = rowsOf(all).find((g) => g.row === row)?.racks.filter((r) => r.id !== moved.id) ?? [];
    const at = group.findIndex((r) => r.id === target.id);
    // From the rear the row is drawn mirrored, so "before" is to the right.
    group.splice(face === 'rear' ? at + 1 : at, 0, moved);
    try {
      for (const [i, r] of group.entries()) {
        const position = row === null ? null : i + 1;
        if (r.row_label !== row || r.row_position !== position) {
          await api.patch(`/api/racks/${r.id}`, { row_label: row, row_position: position });
        }
      }
      toast.ok(row ? `Row ${row} reordered` : 'Moved out of the row');
      refresh();
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <div className="segmented" role="group" aria-label="Rack face">
          {(['front', 'rear'] as Face[]).map((x) => (
            <button key={x} type="button" aria-pressed={face === x} onClick={() => setFace(x)}>{x === 'front' ? 'Front' : 'Rear'}</button>
          ))}
        </div>
        <span className="small muted">
          {face === 'rear' ? 'Seen from the rear: rows are mirrored. ' : ''}
          {canEdit ? 'Click a free U to add a device; drag devices between racks; drag a rack’s name to reorder.' : ''}
        </span>
      </div>
      <ErrorBox error={error} />
      {rowsOf(all).map((g) => {
        const list = face === 'rear' ? [...g.racks].reverse() : g.racks;
        return (
          <section key={g.row ?? '-'} className="rack-row-group" aria-label={g.row ? `Row ${g.row}` : 'Racks not in a row'}>
            <h3 className="u-label">{g.row ? `Row ${g.row}` : rowsOf(all).length > 1 ? 'Not in a row' : null}</h3>
            <div className="rack-row">
              {list.map((r) => (
                <div key={r.id} className={`rack-row-item${overRack === r.id ? ' over' : ''}`}>
                  <div
                    className="rack-row-head"
                    draggable={canEdit}
                    onDragStart={(e) => e.dataTransfer.setData(DRAG_RACK, String(r.id))}
                    onDragOver={(e: DragEvent) => {
                      if (canEdit && e.dataTransfer.types.includes(DRAG_RACK)) {
                        e.preventDefault();
                        setOverRack(r.id);
                      }
                    }}
                    onDragLeave={() => setOverRack((o) => (o === r.id ? null : o))}
                    onDrop={(e) => {
                      setOverRack(null);
                      const moved = Number(e.dataTransfer.getData(DRAG_RACK));
                      if (moved) {
                        e.preventDefault();
                        reorder(moved, r);
                      }
                    }}
                  >
                    {canEdit && <GripVertical size={14} className="muted" aria-hidden />}
                    <Link to={link.rack(projectId, r.id)} className="mono">{r.code}</Link>
                    {r.name && <span className="small muted clip">{r.name}</span>}
                    <span className="grow" />
                    <span className="small muted">{r.u_height}U</span>
                  </div>
                  <Elevation
                    rack={r}
                    devices={r.devices ?? []}
                    face={face}
                    selected={null}
                    onSelect={(id) => nav(link.device(projectId, id))}
                    onAdd={canEdit && r.can_edit ? (u) => setModal({ type: waiting > 0 ? 'choose' : 'add', rack: r, u }) : undefined}
                    onMove={canEdit && r.can_edit ? moveDevice(r) : undefined}
                    findDevice={find}
                  />
                </div>
              ))}
            </div>
          </section>
        );
      })}
      {modal?.type === 'choose' && (
        <Modal title={`${modal.rack.code}, U${modal.rack.numbering === 'bottom_up' ? modal.u : modal.rack.u_height - modal.u + 1}`} onClose={() => setModal(null)}>
          <div className="stack">
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => setModal({ ...modal, type: 'add' })}>A new device</Button>
            <Button icon={<ArrowDownToLine size={15} />} onClick={() => setModal({ ...modal, type: 'place' })}>A device from Unplaced ({waiting})</Button>
          </div>
        </Modal>
      )}
      {modal?.type === 'add' && (
        <DeviceForm
          projectId={projectId}
          placement={{ type: 'rack', rack_id: modal.rack.id, u: modal.u, face: face === 'rear' ? 'rear' : 'front', mount: 'full_width' }}
          onClose={() => setModal(null)}
          onSaved={refresh}
        />
      )}
      {modal?.type === 'place' && (
        <PlaceInRack
          projectId={projectId}
          rackId={modal.rack.id}
          u={modal.u}
          face={face}
          topDown={modal.rack.numbering === 'top_down'}
          onClose={() => setModal(null)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
