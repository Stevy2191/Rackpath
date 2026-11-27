// Locations, floors (plan image, drawn rooms, placed racks), rack elevations
// and devices. Runs after auth.mjs: signed in, project ACME with location HQ.
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

export default function (test, { base, shots }) {
  const snap = async (page, name) => shots && (await page.screenshot({ path: join(shots, `${name}.png`) }));
  let pid;
  const api = async (page, path) => {
    const r = await page.request.get(base + path);
    assert.equal(r.status(), 200, path);
    return r.json();
  };

  test('locations list and adding a floor', async (page) => {
    pid = (await api(page, '/api/projects')).find((p) => p.code === 'ACME').id;
    await page.goto(`${base}/p/${pid}`);
    await page.getByRole('link', { name: 'Locations' }).click();
    await page.getByRole('heading', { name: 'Locations' }).waitFor();
    await page.getByRole('link', { name: 'HQ' }).click();
    await page.getByRole('heading', { name: /HQ/ }).waitFor();
    await page.getByRole('button', { name: 'Add floor' }).click();
    await page.getByLabel('Code').fill('f1');
    await page.getByLabel('Name').fill('First floor');
    await page.getByLabel('Level').fill('1');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('heading', { name: /F1/ }).waitFor();
    assert.match(await page.locator('.crumbs').innerText(), /HQ/);
  });

  test('upload a floor plan image', async (page) => {
    await page.locator('input[type=file]').setInputFiles({ name: 'plan.png', mimeType: 'image/png', buffer: png(1000, 600) });
    await page.locator('svg.plan image').waitFor();
    const floorId = Number(page.url().split('/floors/')[1]);
    const f = await api(page, `/api/floors/${floorId}`);
    assert.equal(f.plan_width, 1000);
    assert.equal(f.plan_height, 600);
  });

  test('draw a room on the plan', async (page) => {
    const rooms = page.locator('.plan-side .card').filter({ hasText: 'Rooms' });
    await rooms.getByRole('button', { name: 'Draw' }).click();
    const plan = page.locator('svg.plan');
    const box = await plan.boundingBox();
    for (const [x, y] of [[0.1, 0.1], [0.6, 0.1], [0.6, 0.8], [0.1, 0.8]]) {
      await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
    }
    await page.getByRole('button', { name: 'Finish' }).click();
    await page.getByRole('dialog').getByLabel('Code').fill('sr1');
    await page.getByRole('dialog').getByLabel('Name').fill('Server room');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.locator('.plan-room polygon').waitFor();
    assert.match(await page.locator('.plan-room text').textContent(), /SR1/);
  });

  test('add a rack, place it on the plan and drag it', async (page) => {
    const floorId = Number(page.url().split('/floors/')[1]);
    await page.locator('.plan-side .card').filter({ hasText: 'Racks' }).getByRole('button', { name: 'Add' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Room').selectOption({ label: 'SR1 (Server room)' });
    await assert.doesNotReject(async () => {
      await page.waitForFunction(() => document.querySelector('[role=dialog] input[name=code]')?.value === 'RK01');
    });
    await dlg.getByLabel('Height (U)').fill('24');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Place', exact: true }).click();
    const box = await page.locator('svg.plan').boundingBox();
    const reloaded = page.waitForResponse((res) => res.url().endsWith(`/api/floors/${floorId}`) && res.request().method() === 'GET');
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
    await reloaded;
    const rack = page.locator('g[data-rack=RK01]');
    await rack.waitFor();
    let f = await api(page, `/api/floors/${floorId}`);
    const before = f.racks[0].plan_x;
    assert.ok(Math.abs(before - 300) <= 3, `placed at ${before}`);
    const r = await rack.locator('rect').boundingBox();
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width / 2 + 60, r.y + r.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForResponse((res) => res.url().includes('/api/racks/') && res.request().method() === 'PATCH');
    f = await api(page, `/api/floors/${floorId}`);
    assert.ok(f.racks[0].plan_x > before + 40, `dragged to ${f.racks[0].plan_x}`);
    await snap(page, 'floor-plan');
  });

  test('rack elevation: add devices by type and from a template', async (page) => {
    await page.locator('.plan-side').getByRole('link', { name: 'RK01' }).click();
    await page.getByRole('heading', { level: 1, name: /RK01/ }).waitFor();
    assert.equal(await page.locator('.rack-slot').count(), 24);
    await page.getByRole('button', { name: 'Add a device at U10' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Type').selectOption({ label: 'Switch' });
    await assert.equal(await dlg.getByLabel('Lowest U').inputValue(), '10');
    await dlg.getByLabel('Name').fill('Core switch');
    await page.waitForFunction(() => /^SW\d+/.test(document.querySelector('[role=dialog] input[maxlength="16"]')?.value ?? ''));
    await page.getByRole('button', { name: 'Save' }).click();
    await page.locator('.rack-device[data-device=SW01]').waitFor();

    await page.getByRole('button', { name: 'Add device' }).click();
    await page.getByRole('tab', { name: /From a template/ }).click();
    await dlg.getByLabel('Lowest U').fill('20');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    const rackId = Number(page.url().split('/racks/')[1]);
    const rack = await api(page, `/api/racks/${rackId}`);
    assert.equal(rack.devices.length, 2);
    const fromTemplate = rack.devices.find((d) => d.template_id && d.placement.u === 20);
    assert.ok(fromTemplate);
    await page.locator(`.rack-device[data-device=${fromTemplate.code}]`).click();
    const top = 20 + Math.ceil(fromTemplate.u_height) - 1;
    assert.match(await page.locator('aside .kv').innerText(), new RegExp(top > 20 ? `U20–U${top}, front` : 'U20, front'));
    await snap(page, 'rack-elevation');
  });

  test('drag a device to another U; rear view shows it as the other face', async (page) => {
    const rackId = Number(page.url().split('/racks/')[1]);
    await page.locator('.rack-device[data-device=SW01]').dragTo(page.getByRole('button', { name: 'Add a device at U5' }));
    await page.waitForResponse((res) => res.url().includes('/api/racks/') && res.request().method() === 'GET');
    const rack = await api(page, `/api/racks/${rackId}`);
    assert.equal(rack.devices.find((d) => d.code === 'SW01').placement.u, 5);
    await page.getByRole('button', { name: 'Rear', exact: true }).click();
    await page.locator('.rack-device.other-face[data-device=SW01]').waitFor();
    await page.getByRole('button', { name: 'Front', exact: true }).click();
  });

  test('devices list, device page and moving to Unplaced', async (page) => {
    await page.getByRole('link', { name: 'Devices' }).click();
    await page.getByRole('heading', { name: 'Devices' }).waitFor();
    await page.locator('.filters').getByLabel('Search').fill('core');
    await page.waitForURL(/q=core/);
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
    assert.match(await page.locator('tbody tr').innerText(), /SW01/);
    await page.getByRole('link', { name: 'SW01' }).click();
    await page.getByRole('heading', { level: 1, name: /SW01/ }).waitFor();
    assert.match(await page.locator('.kv').first().innerText(), /U5/);
    await page.getByRole('button', { name: 'Move' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Move to').selectOption('unplaced');
    await dlg.getByText('→').waitFor();
    await dlg.getByRole('button', { name: 'Move', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.locator('.kv').getByText('Unplaced').waitFor();
    await snap(page, 'device');
  });

  test('deleting a rack needs its code', async (page) => {
    const pidNow = pid;
    const racks = await api(page, `/api/projects/${pidNow}/places`);
    const rack = racks.find((p) => p.kind === 'rack');
    await page.goto(`${base}/p/${pidNow}/racks/${rack.id}`);
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('alert').waitFor();
    await page.getByLabel('Type RK01 to confirm').fill('rk01');
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('heading', { level: 1, name: /SR1/ }).waitFor();
    const unplaced = await api(page, `/api/projects/${pidNow}/devices?unplaced=true`);
    assert.equal(unplaced.devices.length, 2, 'the template device moved to Unplaced too');
  });
}

/** A real (if dull) PNG of the given size. */
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + w * 3, 0xee);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);

  test('buildings grouped by site on the locations list', async (page) => {
    // In a project of its own, so ACME's list stays ungrouped for later tests.
    const r = await page.request.post(`${base}/api/projects`, { data: { code: 'campus', name: 'Campus' } });
    assert.equal(r.status(), 201, await r.text());
    const cid = (await r.json()).id;
    const add = async (code, site) => {
      await page.goto(`${base}/p/${cid}/locations`);
      await page.getByRole('button', { name: 'Add location' }).click();
      await page.getByLabel('Code', { exact: true }).fill(code);
      if (site) await page.getByLabel('Site').fill(site);
      await page.getByRole('button', { name: 'Save' }).click();
      await page.getByRole('heading', { name: new RegExp(code.toUpperCase()) }).waitFor();
    };
    await add('cthse', 'Main campus');
    await add('annex', 'Main campus');
    await add('barn');
    // The site shows on the location's page.
    await page.goto(`${base}/p/${cid}/locations`);
    await page.locator('.site-group').first().waitFor();
    assert.deepEqual(await page.locator('.site-heading').allTextContents(), ['Main campus', 'No site']);
    const main = page.getByRole('region', { name: 'Main campus' });
    assert.deepEqual(await main.locator('tbody tr td:first-child').allTextContents(), ['ANNEX', 'CTHSE']);
    await main.getByRole('link', { name: 'CTHSE' }).click();
    await page.getByText('Main campus').waitFor();
    await snap(page, 'location-site');
    // A US phone number is formatted when the field is left, and saved so.
    await page.getByRole('button', { name: 'Edit' }).click();
    const phone = page.getByLabel('Phone');
    await phone.fill('979.203.4748');
    await phone.press('Tab');
    assert.equal(await phone.inputValue(), '(979) 203-4748');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('(979) 203-4748').waitFor();
  });
}
