import { createContext, useContext } from 'react';

// Shared context that X6 node-cell React components read from.
// The provider lives in X6Canvas and is populated by Topology.js.
export const TopologyGraphContext = createContext({
  onZoneUpdate: () => {},
  onZoneDelete: () => {},
  onShapeUpdate: () => {},
  onShapeDelete: () => {},
  onLabelChange: () => {},
  onLabelDelete: () => {},
  onNodeDblClick: () => {},
  vlans: [],
  mode: 'select',
});

export function useTopologyGraph() {
  return useContext(TopologyGraphContext);
}
