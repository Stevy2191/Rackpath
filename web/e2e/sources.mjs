// CSV import, integrations (Windows DHCP XML upload, a failing UniFi
// test) and diagrams. Runs after cabling.mjs (SW20, PP01, WO01 exist).
import { strict as assert } from 'node:assert';
import { join } from 'node:path';

const XML = `<?xml version="1.0" encoding="utf-8"?><DHCPServer><IPv4><Scopes><Scope><ScopeId>10.40.1.0</ScopeId><Name>Branch</Name>
<SubnetMask>255.255.255.0</SubnetMask><StartRange>10.40.1.50</StartRange><EndRange>10.40.1.200</EndRange>
<OptionValues><OptionValue><OptionId>3</OptionId><Value>10.40.1.1</Value></OptionValue></OptionValues>
<ExclusionRanges><IPRange><StartRange>10.40.1.50</StartRange><EndRange>10.40.1.59</EndRange></IPRange></ExclusionRanges>
<Reservations><Reservation><Name>printer9.branch.lan</Name><IPAddress>10.40.1.60</IPAddress><ClientId>aa-bb-cc-00-99-22</ClientId></Reservation></Reservations>
</Scope></Scopes></IPv4></DHCPServer>`;

export default function (test, { base, shots, allow }) {
  const snap = async (page, name) => shots && (await page.screenshot({ path: join(shots, `${name}.png`) }));
  const s = {};
  const call = async (page, method, path, data) => {
    const r = await page.request[method](base + path, data ? { data } : undefined);
    assert.ok(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`);
    return r.status() === 204 ? null : r.json();
  };

  test('CSV import: a bad row stops everything; fixed, it imports', async (page) => {
    s.pid = (await call(page, 'get', '/api/projects')).find((p) => p.code === 'ACME').id;
    await page.goto(`${base}/p/${s.pid}`);
    await page.getByRole('link', { name: 'Integrations' }).click();
    await page.getByRole('button', { name: 'Import a CSV file' }).click();
    await page.getByLabel('What it holds').selectOption('ports');
    await page.locator('.col-name').getByText('interface_name').waitFor();
    const box = page.getByLabel('Or paste it');
    await box.fill('device,code,connector\nHQ/F1/SR1/RK02/SW20,X1,RJ45\nHQ/F1/SR1/RK02/NOPE,X2,RJ45\n');
    await page.getByRole('button', { name: 'Check it' }).click();
    await page.getByText('Not imported').waitFor();
    assert.match(await page.locator('.csv-errors').innerText(), /^Row\s+Problem\s+3\s+/);
    assert.ok(await page.getByRole('button', { name: 'Import', exact: true }).isDisabled());
    await box.fill('device,code,connector\nHQ/F1/SR1/RK02/SW20,X1,RJ45\nHQ/F1/SR1/RK02/SW20,X2,RJ45\n');
    await page.getByRole('button', { name: 'Check it' }).click();
    await page.getByText('Ready to import').waitFor();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByText('Imported 2 row(s)').waitFor();
    const sw = (await call(page, 'get', `/api/projects/${s.pid}/devices?q=SW20`)).devices[0];
    const codes = (await call(page, 'get', `/api/devices/${sw.id}/ports`)).ports.map((p) => p.code);
    assert.ok(codes.includes('X1') && codes.includes('X2'));
  });

  test('Windows DHCP: token shown once, then an XML export imported', async (page) => {
    await page.goto(`${base}/p/${s.pid}/integrations`);
    await page.getByRole('button', { name: 'Add integration' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Source').selectOption('windows_dhcp');
    await dlg.getByLabel('Name').fill('DHCP01');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('heading', { name: 'Import token' }).waitFor();
    assert.ok((await page.locator('.secret code').innerText()).trim().length >= 32);
    await page.getByRole('button', { name: 'I’ve saved it' }).or(page.getByRole('button', { name: "I've saved it" })).click();
    await page.getByRole('heading', { level: 1, name: 'DHCP01' }).waitFor();
    await page.locator('input[type=file]').setInputFiles({ name: 'dhcp.xml', mimeType: 'application/xml', buffer: Buffer.from(XML) });
    const result = page.getByRole('dialog');
    await result.getByRole('heading', { name: 'Imported dhcp.xml' }).waitFor();
    assert.match(await result.innerText(), /prefix\s+1\s+0\s+0\s+0/);
    await page.getByRole('button', { name: 'Close' }).last().click();
    await page.locator('.runs li[data-status=success]').waitFor();
    const prefixes = (await call(page, 'get', `/api/projects/${s.pid}/prefixes`)).prefixes;
    const p = prefixes.find((x) => x.cidr === '10.40.1.0/24');
    assert.equal(p.source, 'integration');
    await snap(page, 'integration');
  });

  test('UniFi: a connection test that can’t reach the console says so', async (page) => {
    await page.goto(`${base}/p/${s.pid}/integrations`);
    await page.getByRole('button', { name: 'Add integration' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Name').fill('Lab UniFi');
    await dlg.getByLabel('Address', { exact: true }).fill('https://127.0.0.1:9');
    await dlg.getByLabel('API key').fill('not-a-real-key');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('heading', { level: 1, name: 'Lab UniFi' }).waitFor();
    assert.match(await page.locator('.kv').first().innerText(), /api key/);
    await page.getByRole('button', { name: 'Test connection' }).click();
    await page.locator('.toast-error').waitFor();
    const i = (await call(page, 'get', `/api/projects/${s.pid}/integrations`)).integrations.find((x) => x.name === 'Lab UniFi');
    assert.equal(i.has_secret, true);
    assert.equal(JSON.stringify(i).includes('not-a-real-key'), false, 'secrets never come back');
  });

  test('a diagram built from documented cables', async (page) => {
    await page.goto(`${base}/p/${s.pid}`);
    await page.getByRole('link', { name: 'Diagrams' }).click();
    await page.getByRole('button', { name: 'New diagram' }).click();
    await page.getByLabel('Name').fill('Floor 1 cabling');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByRole('heading', { level: 1, name: /Floor 1 cabling/ }).waitFor();
    await page.getByRole('button', { name: 'Add device' }).click();
    await page.getByRole('dialog').getByLabel('Find a device').fill('PP01');
    await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] select option')].some((o) => o.textContent.endsWith('PP01')));
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.locator('g[data-node=PP01]').waitFor();
    await page.getByRole('button', { name: 'Add what it’s cabled to' }).or(page.getByRole('button', { name: "Add what it's cabled to" })).click();
    await page.locator('g[data-node=WO01]').waitFor();
    assert.equal(await page.locator('.d-edge').count(), 1);
    // Drag the outlet somewhere else, then save.
    const n = await page.locator('g[data-node=WO01] rect').boundingBox();
    await page.mouse.move(n.x + 20, n.y + 20);
    await page.mouse.down();
    await page.mouse.move(n.x + 220, n.y + 60, { steps: 5 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Saved', { exact: true }).waitFor();
    await page.reload();
    await page.locator('.d-edge.s-incomplete').waitFor();
    const id = Number(page.url().split('/diagrams/')[1]);
    const d = await call(page, 'get', `/api/topologies/${id}`);
    assert.equal(d.nodes.length, 2);
    assert.ok(d.edges[0].connection_id && d.edges[0].cable.chain_state === 'incomplete');
    assert.ok(d.nodes.find((x) => x.device.code === 'WO01').x >= 200, 'moved by the drag');
    await snap(page, 'diagram');
  });
}
