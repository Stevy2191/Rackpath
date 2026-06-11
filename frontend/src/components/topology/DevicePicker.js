import React, { useEffect, useRef, useState } from 'react';
import client from '../../api/client';
import { DEVICE_TYPES, DEVICE_CATEGORIES, classifyDevice, customType, customIconUrl } from './deviceTypes';
import './DevicePicker.css';

export const MANUAL_DRAG_TYPE = 'application/rackpath-manual-device';
export const DISCOVERED_DRAG_TYPE = 'application/rackpath-discovered-device';

export default function DevicePicker({ unplacedDevices }) {
  const [tab, setTab] = useState('manual');
  const [collapsed, setCollapsed] = useState({});
  const [customIcons, setCustomIcons] = useState([]);
  const [uploadError, setUploadError] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    loadCustomIcons();
  }, []);

  const loadCustomIcons = () => {
    client
      .get('/topology/icons')
      .then((res) => setCustomIcons(res.data || []))
      .catch((err) => setUploadError(err.message));
  };

  const toggleCategory = (name) => {
    setCollapsed((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  const handleManualDragStart = (e, info) => {
    e.dataTransfer.setData(MANUAL_DRAG_TYPE, JSON.stringify(info));
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDiscoveredDragStart = (e, deviceId) => {
    e.dataTransfer.setData(DISCOVERED_DRAG_TYPE, String(deviceId));
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const defaultName = file.name.replace(/\.[^.]+$/, '');
    const name = window.prompt('Name for this icon:', defaultName);
    if (name === null) return;

    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('icon', file);
      formData.append('name', name.trim() || defaultName);
      const res = await client.post('/topology/icons', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setCustomIcons((prev) => [...prev, res.data].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) {
      setUploadError(err.response?.data?.error || err.message);
    }
  };

  const handleDeleteCustomIcon = async (e, id) => {
    e.stopPropagation();
    try {
      await client.delete(`/topology/icons/${id}`);
      setCustomIcons((prev) => prev.filter((icon) => icon.id !== id));
    } catch (err) {
      setUploadError(err.message);
    }
  };

  return (
    <aside className="device-picker">
      <div className="device-picker-tabs">
        <button
          type="button"
          className={tab === 'manual' ? 'active' : ''}
          onClick={() => setTab('manual')}
        >
          Manual
        </button>
        <button
          type="button"
          className={tab === 'discovered' ? 'active' : ''}
          onClick={() => setTab('discovered')}
        >
          Discovered
        </button>
      </div>

      <div className="device-picker-list">
        {tab === 'manual' && (
          <>
            {DEVICE_CATEGORIES.map((category) => (
              <div className="device-picker-category" key={category.name}>
                <button
                  type="button"
                  className="device-picker-category-header"
                  onClick={() => toggleCategory(category.name)}
                >
                  <span className={`device-picker-chevron ${collapsed[category.name] ? 'collapsed' : ''}`}>▾</span>
                  {category.name}
                </button>
                {!collapsed[category.name] && (
                  <div className="device-picker-category-items">
                    {category.types.map((key) => {
                      const info = DEVICE_TYPES[key];
                      return (
                        <div
                          key={key}
                          className="device-picker-card"
                          draggable
                          onDragStart={(e) =>
                            handleManualDragStart(e, {
                              type: key,
                              label: info.label,
                              icon: info.icon,
                              color: info.color,
                              isCustom: false,
                            })
                          }
                        >
                          <span className="device-picker-icon" style={{ color: info.color }}>
                            {info.icon}
                          </span>
                          <span className="device-picker-label">{info.label}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}

            <div className="device-picker-category">
              <button
                type="button"
                className="device-picker-category-header"
                onClick={() => toggleCategory('Custom Items')}
              >
                <span className={`device-picker-chevron ${collapsed['Custom Items'] ? 'collapsed' : ''}`}>▾</span>
                Custom Items
              </button>
              {!collapsed['Custom Items'] && (
                <div className="device-picker-category-items">
                  {customIcons.map((icon) => {
                    const url = customIconUrl(icon.filename);
                    return (
                      <div
                        key={icon.id}
                        className="device-picker-card"
                        draggable
                        onDragStart={(e) =>
                          handleManualDragStart(e, {
                            type: customType(icon.filename),
                            label: icon.name,
                            icon: url,
                            color: DEVICE_TYPES.custom.color,
                            isCustom: true,
                          })
                        }
                      >
                        <img className="device-picker-custom-icon" src={url} alt="" />
                        <span className="device-picker-label">{icon.name}</span>
                        <button
                          type="button"
                          className="device-picker-delete-icon"
                          title="Delete custom icon"
                          onClick={(e) => handleDeleteCustomIcon(e, icon.id)}
                        >
                          &times;
                        </button>
                      </div>
                    );
                  })}

                  <button type="button" className="device-picker-upload-btn" onClick={handleUploadClick}>
                    Upload Custom Icon
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/svg+xml,.png,.svg"
                    className="device-picker-file-input"
                    onChange={handleFileChange}
                  />
                  {uploadError && <div className="device-picker-error">{uploadError}</div>}
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'discovered' &&
          (unplacedDevices.length === 0 ? (
            <div className="device-picker-empty">No discovered devices to place.</div>
          ) : (
            unplacedDevices.map((device) => {
              const info = DEVICE_TYPES[classifyDevice(device.type)];
              return (
                <div
                  key={device.id}
                  className="device-picker-card"
                  draggable
                  onDragStart={(e) => handleDiscoveredDragStart(e, device.id)}
                >
                  <span className="device-picker-icon" style={{ color: info.color }}>
                    {info.icon}
                  </span>
                  <span className="device-picker-label">
                    {device.hostname || device.ip || `Device ${device.id}`}
                  </span>
                </div>
              );
            })
          ))}
      </div>
    </aside>
  );
}
