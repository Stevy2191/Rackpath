import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Plus, Pencil, Trash2, MapPin } from 'lucide-react';
import './TopologySwitcher.css';

export default function TopologySwitcher({
  topologies,
  activeTopologyId,
  onSwitch,
  onCreate,
  onEdit,
  onDelete,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const active = topologies.find((t) => t.id === activeTopologyId) || topologies[0];

  const handleSwitch = (topo) => {
    setOpen(false);
    if (topo.id !== activeTopologyId) onSwitch(topo.id);
  };

  const isOnlyTopology = topologies.length <= 1;

  return (
    <div className="topo-switcher" ref={ref}>
      <button
        type="button"
        className="topo-switcher-trigger"
        onClick={() => setOpen((o) => !o)}
        title="Switch topology"
      >
        <span className="topo-switcher-name">{active?.name || 'Topology'}</span>
        {active?.location_name && (
          <span className="topo-switcher-location">
            <MapPin size={10} /> {active.location_name}
          </span>
        )}
        <ChevronDown size={13} className={`topo-switcher-caret${open ? ' open' : ''}`} />
      </button>

      {open && (
        <div className="topo-switcher-dropdown">
          {topologies.map((topo) => {
            const isCurrent = topo.id === activeTopologyId;
            const canDelete = !topo.is_master || !isOnlyTopology;
            return (
              <div key={topo.id} className={`topo-switcher-item${isCurrent ? ' active' : ''}`}>
                <button
                  type="button"
                  className="topo-switcher-item-name"
                  onClick={() => handleSwitch(topo)}
                >
                  <span>{topo.name}</span>
                  {topo.location_name && (
                    <span className="topo-switcher-item-loc">
                      <MapPin size={9} /> {topo.location_name}
                    </span>
                  )}
                </button>
                <div className="topo-switcher-item-actions">
                  <button
                    type="button"
                    title="Edit topology"
                    onClick={(e) => { e.stopPropagation(); setOpen(false); onEdit(topo); }}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    title={!canDelete ? 'Cannot delete the only topology' : 'Delete topology'}
                    disabled={!canDelete}
                    className="topo-switcher-delete"
                    onClick={(e) => { e.stopPropagation(); setOpen(false); onDelete(topo); }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        className="topo-switcher-add"
        title="New topology"
        onClick={() => { setOpen(false); onCreate(); }}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
