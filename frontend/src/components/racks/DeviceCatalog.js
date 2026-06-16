import React, { useState } from 'react';
import { X, Plus, Trash2, ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import {
  RACK_CATALOG, CATALOG_CATEGORIES, CATALOG_VENDORS,
  VENDOR_COLORS, groupByVendor, groupByCategory,
} from './rackCatalog';
import { getCategoryStyle } from './deviceRenderConfig';
import CustomDeviceModal from './CustomDeviceModal';
import './DeviceCatalog.css';

function findNextFreeU(rack, allSlots, uSize, mountedFace) {
  const occupied = new Set();
  for (const s of allSlots) {
    if (s.rack_id !== rack.id) continue;
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

function CatalogCard({ entry, onClick }) {
  const { color, Icon } = getCategoryStyle({ custom_type: entry.renderType });
  const iconBoxStyle = { borderColor: `${color}55`, background: `${color}18` };

  return (
    <div
      className="dc-card"
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/catalog-item', JSON.stringify(entry))}
      onClick={onClick}
      title={`${entry.name} · ${entry.uSize}U${entry.mountedFace === 'rear' ? ' · Rear' : ''}`}
    >
      <GripVertical size={12} className="dc-card-grip" />
      <div className="dc-card-icon-box" style={iconBoxStyle}>
        <Icon size={13} color={color} />
      </div>
      <span className="dc-card-name">{entry.name}</span>
      <div className="dc-card-badges">
        <span className="dc-card-badge">{entry.uSize}U</span>
        {entry.halfWidth && <span className="dc-card-badge dc-card-badge-accent">½W</span>}
        {entry.halfDepth && <span className="dc-card-badge dc-card-badge-accent">½D</span>}
        {entry.mountedFace === 'rear' && <span className="dc-card-badge dc-card-badge-rear">Rear</span>}
      </div>
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
  { id: 'brand',     label: 'Brand' },
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
  rackCustomDevices,
  focusedRackId,
  actions,
  onCustomDeviceCreated,
  onCustomDeviceDeleted,
}) {
  const [tab, setTab] = useState('brand');
  const [search, setSearch] = useState('');
  const [customDeviceModalOpen, setCustomDeviceModalOpen] = useState(false);
  const [unrackedOpen, setUnrackedOpen] = useState(false);

  if (!open) return null;

  const focusedRack = racks.find((r) => r.id === focusedRackId) || null;
  const rackedDeviceIds = new Set(allSlots.map((s) => s.device_id).filter(Boolean));
  const unrackedDevices = devices.filter((d) => !rackedDeviceIds.has(d.id));

  const searchTerm = search.trim().toLowerCase();
  const filteredCatalog = searchTerm
    ? RACK_CATALOG.filter((e) => e.name.toLowerCase().includes(searchTerm) || e.vendor.toLowerCase().includes(searchTerm))
    : RACK_CATALOG;

  const addCatalogEntry = (entry) => {
    if (!focusedRack) return;
    const u_position = findNextFreeU(focusedRack, allSlots, entry.uSize, entry.mountedFace || 'front');
    if (u_position == null) return;
    const itemType = ['patch-panel', 'blank', 'cable-manager'].includes(entry.renderType) ? entry.renderType : 'custom-device';
    actions.onSlotCreate({
      rack_id: focusedRack.id,
      item_type: itemType,
      item_label: entry.name,
      vendor: entry.vendor,
      catalog_id: entry.id,
      custom_type: entry.renderType,
      u_position,
      u_size: entry.uSize,
      mounted_face: entry.mountedFace || 'front',
      half_depth: entry.halfDepth ? 1 : 0,
      half_width: entry.halfWidth ? 1 : 0,
    });
  };

  const addCustomDevice = (custom) => {
    if (!focusedRack) return;
    const u_position = findNextFreeU(focusedRack, allSlots, custom.u_size, 'front');
    if (u_position == null) return;
    actions.onSlotCreate({
      rack_id: focusedRack.id,
      item_type: 'custom-device',
      item_label: custom.name,
      vendor: custom.vendor,
      custom_type: custom.type,
      custom_image_url: custom.image_url,
      u_position,
      u_size: custom.u_size,
      mounted_face: 'front',
    });
  };

  const addUnrackedDevice = (device) => {
    if (!focusedRack) return;
    const u_position = findNextFreeU(focusedRack, allSlots, 1, 'front');
    if (u_position == null) return;
    actions.onSlotCreate({
      rack_id: focusedRack.id,
      device_id: device.id,
      item_type: 'device',
      u_position,
      u_size: 1,
      mounted_face: 'front',
    });
  };

  const renderBrandTab = () => {
    const byVendor = groupByVendor(filteredCatalog);
    return CATALOG_VENDORS.filter((v) => byVendor.has(v)).map((vendor) => {
      const entries = byVendor.get(vendor);
      const color = VENDOR_COLORS[vendor] || '#555';
      return (
        <CollapsibleGroup
          key={vendor}
          title={vendor}
          count={entries.length}
          defaultOpen={vendor === 'Generic'}
        >
          <div className="dc-group-brand-header" style={{ borderLeftColor: color }}>
            <span className="dc-group-brand-dot" style={{ background: color }} />
            <span className="dc-group-brand-name">{vendor}</span>
          </div>
          {entries.map((entry) => (
            <CatalogCard key={entry.id} entry={entry} onClick={() => addCatalogEntry(entry)} />
          ))}
        </CollapsibleGroup>
      );
    });
  };

  const renderCategoryTab = () => {
    const byCategory = groupByCategory(filteredCatalog);
    return CATALOG_CATEGORIES.filter((c) => byCategory.has(c.id)).map((cat) => {
      const entries = byCategory.get(cat.id);
      return (
        <CollapsibleGroup key={cat.id} title={cat.label} count={entries.length}>
          {entries.map((entry) => (
            <CatalogCard key={entry.id} entry={entry} onClick={() => addCatalogEntry(entry)} />
          ))}
        </CollapsibleGroup>
      );
    });
  };

  const renderAZTab = () => {
    const sorted = [...filteredCatalog].sort((a, b) => a.name.localeCompare(b.name));
    return sorted.map((entry) => (
      <CatalogCard key={entry.id} entry={entry} onClick={() => addCatalogEntry(entry)} />
    ));
  };

  const renderCustomTab = () => (
    <div className="dc-custom-section">
      {rackCustomDevices.map((custom) => {
        const { color, Icon } = getCategoryStyle({ custom_type: custom.type });
        const iconBoxStyle = { borderColor: `${color}55`, background: `${color}18` };
        return (
          <div
            key={custom.id}
            className="dc-card"
            draggable
            onDragStart={(e) => e.dataTransfer.setData('text/custom-device-id', String(custom.id))}
            onClick={() => addCustomDevice(custom)}
          >
            <GripVertical size={12} className="dc-card-grip" />
            {custom.image_url ? (
              <img src={custom.image_url} alt={custom.name} className="dc-card-icon-box dc-card-icon-img" />
            ) : (
              <div className="dc-card-icon-box" style={iconBoxStyle}>
                <Icon size={13} color={color} />
              </div>
            )}
            <span className="dc-card-name">{custom.name}</span>
            <div className="dc-card-badges">
              <span className="dc-card-badge">{custom.u_size}U</span>
            </div>
            <button
              type="button"
              className="dc-card-delete"
              title="Delete"
              onClick={(e) => { e.stopPropagation(); onCustomDeviceDeleted(custom.id); }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        );
      })}
      {rackCustomDevices.length === 0 && <p className="dc-empty">No custom devices yet.</p>}
      <button type="button" className="dc-add-custom-btn" onClick={() => setCustomDeviceModalOpen(true)}>
        <Plus size={13} /> Add Custom Device
      </button>
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

      {tab !== 'custom' && (
        <div className="dc-search-row">
          <input
            type="text"
            className="dc-search"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

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
                    return (
                      <div
                        key={device.id}
                        className="dc-card"
                        draggable
                        onDragStart={(e) => e.dataTransfer.setData('text/device-id', String(device.id))}
                        onClick={() => addUnrackedDevice(device)}
                      >
                        <GripVertical size={12} className="dc-card-grip" />
                        <div className="dc-card-icon-box" style={iconBoxStyle}>
                          <Icon size={13} color={color} />
                        </div>
                        <span className="dc-card-name">{device.hostname || device.ip || `Device ${device.id}`}</span>
                        <div className="dc-card-badges">
                          <span className="dc-card-badge">1U</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            )}
          </div>
        )}

        {tab === 'brand'    && renderBrandTab()}
        {tab === 'category' && renderCategoryTab()}
        {tab === 'az'       && <div className="dc-az-list">{renderAZTab()}</div>}
        {tab === 'custom'   && renderCustomTab()}
      </div>

      {customDeviceModalOpen && (
        <CustomDeviceModal
          onClose={() => setCustomDeviceModalOpen(false)}
          onCreated={(custom) => {
            onCustomDeviceCreated(custom);
            setCustomDeviceModalOpen(false);
          }}
        />
      )}
    </div>
  );
}
