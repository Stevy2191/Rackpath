import React from 'react';
import SubnetCalculatorTool from '../components/networkTools/SubnetCalculatorTool';
import MacLookupTool from '../components/networkTools/MacLookupTool';
import PingTool from '../components/networkTools/PingTool';
import TracerouteTool from '../components/networkTools/TracerouteTool';
import DnsResolverTool from '../components/networkTools/DnsResolverTool';
import './NetworkTools.css';

export default function NetworkToolsPage() {
  return (
    <div className="network-tools-page">
      <div className="network-tools-header">
        <h2>Network Tools</h2>
      </div>
      <div className="network-tools-grid">
        <SubnetCalculatorTool />
        <MacLookupTool />
        <PingTool />
        <TracerouteTool />
        <DnsResolverTool />
      </div>
    </div>
  );
}
