import React, { useState } from 'react';
import { X, ChevronDown, ChevronRight, GripVertical, Trash2 } from 'lucide-react';
import { RACK_CATALOG, CATALOG_CATEGORIES, groupByCategory, findCatalogEntryByModel } from './rackCatalog';
import { normalizeCatalogEntry } from './deviceFieldSchemas';
import { getCategoryStyle } from './deviceRenderConfig';
import './DeviceCatalog.css';

function findNextFreeU(rack, allSlots, uSize, mountedFace) {
  const occupied = new Set();
  for (const s of allSlots) {
    if (s.rack_id !== rack.id) continue;
    // Vertical PDUs are 0U floating elements, not real U-grid occupants —
    // their stored u_position/u_size must never block where a new device
    // from the catalog can land.
    if (s.item_type === 'vertical-pdu') continue;
    const face = s.mounted_face || s.front_back || 'front';
    const targetFace = mountedFace === 'rear' ? 'rear' : 'front';
    if (face !== 'both' && face !== targetFace) continue;
    for (let u = s.u_position; u <= s.u_position + s.u_size - 1; u++) occupied.add(u);
  }
  for (let start = 1; start + uSize - 1 <= rack.u_height; start++) {
    let free = true;
    for (let u = start; u <= start + uSize - 1; u++) {
      if (occupied.has(u)) { free = false; break; }
    }
    if (free) return start;
  }
  return null;
}

function buildBadges(normalized) {
  const badges = [`${normalized.u_size}U`];
  if (normalized.port_count) badges.push(`${normalized.port_count}-port`);
  if (normalized.bay_count) badges.push(`${normalized.bay_count}-bay`);
  if (normalized.capacity_va) badges.push(`${normalized.capacity_va}VA`);
  if (normalized.input_voltage) badges.push(normalized.input_voltage);
  const groups = normalized.outlet_groups || [];
  if (groups.length === 1 && groups[0].count) {
    badges.push(`${groups[0].count}x ${groups[0].type || 'outlet'}`);
  } else if (groups.length > 1) {
    badges.push(`${groups.reduce((sum, g) => sum + (Number(g.count) || 0), 0)} outlets`);
  }
  return badges;
}

function CatalogCard({ entry, source, onClick, onDragStart, onContextMenu, renaming, onRenameSubmit, onRenameCancel, onDelete }) {
  const normalized = normalizeCatalogEntry(entry, source);
  const { color, Icon } = getCategoryStyle({ custom_type: normalized.render_type });
  const iconBoxStyle = { borderColor: `${color}55`, background: `${color}18` };
  const badges = buildBadges(normalized);
  const [renameValue, setRenameValue] = useState(entry.name);

  return (
    <div
      className="dc-card"
      draggable
      onDragStart={onDragStart}
      onClick={renaming ? undefined : onClick}
      onContextMenu={onContextMenu}
      title={`${entry.name} · ${normalized.u_size}U${normalized.mounted_face === 'rear' ? ' · Rear' : ''}`}
    >
      <GripVertical size={12} className="dc-card-grip" />
      <div className="dc-card-icon-box" style={iconBoxStyle}>
        <Icon size={13} color={color} />
      </div>
      {renaming ? (
        <input
          className="dc-card-rename-input"
          autoFocus
          value={renameValue}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameSubmit(renameValue);
            if (e.key === 'Escape') onRenameCancel();
          }}
          onBlur={() => onRenameSubmit(renameValue)}
        />
      ) : (
        <span className="dc-card-name">{entry.name}</span>
      )}
      <div className="dc-card-badges">
        {badges.map((b) => <span key={b} className="dc-card-badge">{b}</span>)}
        {normalized.half_width && <span className="dc-card-badge dc-card-badge-accent">½W</span>}
        {normalized.half_depth && <span className="dc-card-badge dc-card-badge-accent">½D</span>}
        {normalized.mounted_face === 'rear' && <span className="dc-card-badge dc-card-badge-rear">Rear</span>}
      </div>
      {onDelete && (
        <button
          type="button"
          className="dc-card-delete"
          title="Delete"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

function CollapsibleGroup({ title, count, defaultOpen, children }) {
  const [open, setOpen] = useState(defaultOpen !== false);
  return (
    <div className="dc-group">
      <button type="button" className="dc-group-header" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{title}</span>
        <span className="dc-group-count">{count}</span>
      </button>
      {open && <div className="dc-group-body">{children}</div>}
    </div>
  );
}

const TAB_DEFS = [
  { id: 'category',  label: 'Category' },
  { id: 'az',        label: 'A–Z' },
  { id: 'custom',    label: 'Custom' },
];

export default function DeviceCatalog({
  open,
  onClose,
  racks,
  allSlots,
  devices,
  userCatalogEntries,
  focusedRackId,
  actions,
  onRequestPlacement,
  onCustomEntryRenamed,
  onCustomEntryDeleted,
}) {
  const [tab, setTab] = useState('category');
  const [search, setSearch] = useState('');
  const [unrackedOpen, setUnrackedOpen] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [customCtxMenu, setCustomCtxMenu] = useState(null); // { id, x, y }

  if (!open) return null;

  const focusedRack = racks.find((r) => r.id === focusedRackId) || null;
  const rackedDeviceIds = new Set(allSlots.map((s) => s.device_id).filter(Boolean));
  const unrackedDevices = devices.filter((d) => !rackedDeviceIds.has(d.id));

  // Floating (0U) entries, like the vertical PDU, aren't placed into U rows
  // directly — they're attached via a UPS's properties panel instead.
  const placeableCatalog = RACK_CATALOG.filter((e) => !e.floating);

  const searchTerm = search.trim().toLowerCase();
  const filteredCatalog = searchTerm
    ? placeableCatalog.filter((e) => e.name.toLowerCase().includes(searchTerm))
    : placeableCatalog;
  const placeableCustomEntries = userCatalogEntries.filter((c) => c.render_type !== 'pdu-vertical');
  const filteredCustomEntries = searchTerm
    ? placeableCustomEntries.filter((c) => c.name.toLowerCase().includes(searchTerm))
    : placeableCustomEntries;

  const requestCatalogPlacement = (entry) => {
    if (!focusedRack) return;
    const mounted_face = entry.mountedFace || 'front';
    const u_position = findNextFreeU(focusedRack, allSlots, entry.uSize, mounted_face);
    if (u_position == null) return;
    onRequestPlacement({ source: 'catalog', entry, target: { rack_id: focusedRack.id, u_position, mounted_face } });
  };

  const requestCustomPlacement = (custom) => {
    if (!focusedRack) return;
    const mounted_face = custom.mounted_face || 'front';
    const u_position = findNextFreeU(focusedRack, allSlots, custom.u_size, mounted_face);
    if (u_position == null) return;
    onRequestPlacement({ source: 'custom', entry: custom, target: { rack_id: focusedRack.id, u_position, mounted_face } });
  };

  const addUnrackedDevice = (device) => {
    if (!focusedRack) return;
    const catalogMatch = findCatalogEntryByModel(device.model);
    const uSize = catalogMatch ? catalogMatch.uSize : 1;
    const mountedFace = catalogMatch ? catalogMatch.mountedFace : 'front';
    const u_position = findNextFreeU(focusedRack, allSlots, uSize, mountedFace);
    if (u_position == null) return;
    actions.onSlotCreate({
      rack_id: focusedRack.id,
      device_id: device.id,
      item_type: 'device',
      u_position,
      u_size: uSize,
      mounted_face: mountedFace,
      half_depth: catalogMatch?.halfDepth ? 1 : 0,
      half_width: catalogMatch?.halfWidth ? 1 : 0,
    });
  };

  const renderCategoryTab = () => {
    const byCategory = groupByCategory(filteredCatalog);
    return CATALOG_CATEGORIES.filter((c) => byCategory.has(c.id)).map((cat) => {
      const entries = byCategory.get(cat.id);
      return (
        <CollapsibleGroup key={cat.id} title={cat.label} count={entries.length}>
          {entries.map((entry) => (
            <CatalogCard
              key={entry.id}
              entry={entry}
              source="catalog"
              onClick={() => requestCatalogPlacement(entry)}
              onDragStart={(e) => e.dataTransfer.setData('text/catalog-item', JSON.stringify(entry))}
            />
          ))}
        </CollapsibleGroup>
      );
    });
  };

  const renderAZTab = () => {
    const sorted = [...filteredCatalog].sort((a, b) => a.name.localeCompare(b.name));
    const byLetter = new Map();
    for (const entry of sorted) {
      const letter = entry.name[0].toUpperCase();
      if (!byLetter.has(letter)) byLetter.set(letter, []);
      byLetter.get(letter).push(entry);
    }
    return Array.from(byLetter.entries()).map(([letter, entries]) => (
      <CollapsibleGroup key={letter} title={letter} count={entries.length}>
        {entries.map((entry) => (
          <CatalogCard
            key={entry.id}
            entry={entry}
            source="catalog"
            onClick={() => requestCatalogPlacement(entry)}
            onDragStart={(e) => e.dataTransfer.setData('text/catalog-item', JSON.stringify(entry))}
          />
        ))}
      </CollapsibleGroup>
    ));
  };

  const submitRename = (custom, newName) => {
    setRenamingId(null);
    const trimmed = newName.trim();
    if (!trimmed || trimmed === custom.name) return;
    onCustomEntryRenamed(custom.id, trimmed);
  };

  const renderCustomTab = () => (
    <div className="dc-custom-section">
      {filteredCustomEntries.map((custom) => (
        <CatalogCard
          key={custom.id}
          entry={custom}
          source="custom"
          onClick={() => requestCustomPlacement(custom)}
          onDragStart={(e) => e.dataTransfer.setData('text/custom-device-id', String(custom.id))}
          onContextMenu={(e) => { e.preventDefault(); setCustomCtxMenu({ id: custom.id, x: e.clientX, y: e.clientY }); }}
          renaming={renamingId === custom.id}
          onRenameSubmit={(newName) => submitRename(custom, newName)}
          onRenameCancel={() => setRenamingId(null)}
          onDelete={() => onCustomEntryDeleted(custom.id)}
        />
      ))}
      {filteredCustomEntries.length === 0 && (
        <p className="dc-empty">
          No saved devices yet. Place a device, then use "Save to Catalog" in its properties panel.
        </p>
      )}
    </div>
  );

  return (
    <div className="device-catalog">
      <div className="dc-header">
        <span className="dc-title">Device Catalog</span>
        <button type="button" className="dc-close" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      <p className="dc-hint">
        {focusedRack
          ? `Click to add to "${focusedRack.name}", or drag to any rack.`
          : 'Click a rack to enable click-to-add, or drag cards onto any rack.'}
      </p>

      <div className="dc-tabs">
        {TAB_DEFS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="dc-search-row">
        <input
          type="text"
          className="dc-search"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="dc-list">
        {tab !== 'custom' && (
          <div className="dc-group dc-group-unracked">
            <button type="button" className="dc-group-header" onClick={() => setUnrackedOpen((v) => !v)}>
              {unrackedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <span>Unracked Devices</span>
              <span className="dc-group-count">{unrackedDevices.length}</span>
            </button>
            {unrackedOpen && (
              unrackedDevices.length === 0 ? (
                <p className="dc-empty">No unracked devices.</p>
              ) : (
                <div className="dc-group-body">
                  {unrackedDevices.map((device) => {
                    const { color, Icon } = getCategoryStyle({ device_type: device.type, item_type: 'device' });
                    const iconBoxStyle = { borderColor: `${color}55`, background: `${color}18` };
                    const catalogMatch = findCatalogEntryByModel(device.model);
                    const uSize = catalogMatch ? catalogMatch.uSize : 1;
                    return (
                      <div
                        key={device.id}
                        className="dc-card"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/device-id', String(device.id));
                          if (catalogMatch) {
                            e.dataTransfer.setData('text/device-catalog', JSON.stringify({
                              uSize: catalogMatch.uSize,
                              mountedFace: catalogMatch.mountedFace,
                              halfDepth: catalogMatch.halfDepth,
                              halfWidth: catalogMatch.halfWidth,
                            }));
                          }
                        }}
                        onClick={() => addUnrackedDevice(device)}
                        title={`${device.hostname || device.ip || `Device ${device.id}`}${catalogMatch ? ` · ${uSize}U${catalogMatch.mountedFace === 'rear' ? ' · Rear' : ''}` : ''}`}
                      >
                        <GripVertical size={12} className="dc-card-grip" />
                        <div className="dc-card-icon-box" style={iconBoxStyle}>
                          <Icon size={13} color={color} />
                        </div>
                        <span className="dc-card-name">{device.hostname || device.ip || `Device ${device.id}`}</span>
                        <div className="dc-card-badges">
                          <span className="dc-card-badge">{uSize}U</span>
                          {catalogMatch?.mountedFace === 'rear' && <span className="dc-card-badge dc-card-badge-rear">Rear</span>}
                          {catalogMatch?.halfDepth && <span className="dc-card-badge dc-card-badge-accent">½D</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </div>
        )}

        {tab === 'category' && renderCategoryTab()}
        {tab === 'az'       && <div className="dc-az-list">{renderAZTab()}</div>}
        {tab === 'custom'   && renderCustomTab()}
      </div>

      {customCtxMenu && (
        <div className="dc-ctx-menu-overlay" onMouseDown={() => setCustomCtxMenu(null)}>
          <div
            className="dc-ctx-menu"
            style={{ top: customCtxMenu.y, left: customCtxMenu.x }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => { setRenamingId(customCtxMenu.id); setCustomCtxMenu(null); }}
            >
              Rename
            </button>
            <button
              type="button"
              className="dc-ctx-menu-danger"
              onClick={() => { onCustomEntryDeleted(customCtxMenu.id); setCustomCtxMenu(null); }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
