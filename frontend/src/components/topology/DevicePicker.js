import React, { useState } from 'react';
import { DEVICE_TYPES, classifyDevice } from './deviceTypes';
import './DevicePicker.css';

export const MANUAL_DRAG_TYPE = 'application/rackpath-manual-device';
export const DISCOVERED_DRAG_TYPE = 'application/rackpath-discovered-device';

export default function DevicePicker({ unplacedDevices }) {
  const [tab, setTab] = useState('manual');

  const handleManualDragStart = (e, deviceType) => {
    e.dataTransfer.setData(MANUAL_DRAG_TYPE, deviceType);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDiscoveredDragStart = (e, deviceId) => {
    e.dataTransfer.setData(DISCOVERED_DRAG_TYPE, String(deviceId));
    e.dataTransfer.effectAllowed = 'move';
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
        {tab === 'manual' &&
          Object.entries(DEVICE_TYPES).map(([key, info]) => (
            <div
              key={key}
              className="device-picker-card"
              draggable
              onDragStart={(e) => handleManualDragStart(e, key)}
            >
              <span className="device-picker-icon" style={{ color: info.color }}>
                {info.icon}
              </span>
              <span className="device-picker-label">{info.label}</span>
            </div>
          ))}

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
