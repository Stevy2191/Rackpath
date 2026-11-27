import { strict as assert } from 'node:assert';
import { join } from 'node:path';

export default function (test, { base, password, shots }) {
  const snap = async (page, name) => shots && (await page.screenshot({ path: join(shots, `${name}.png`) }));

  test('first sign-in asks for a new password', async (page) => {
    await page.goto(base + '/');
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill('wrong-password-x');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /Invalid username or password/);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Choose a new password' }).waitFor();
    await snap(page, 'forced-password');
    await page.getByLabel('Current password').fill(password);
    await page.getByLabel('New password', { exact: true }).fill('owner-password-1');
    await page.getByLabel('New password again').fill('owner-password-1');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await page.getByRole('heading', { name: 'Projects' }).waitFor();
  });

  test('create a project and land on it', async (page) => {
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Code').fill('acme');
    await page.getByLabel('Name').fill('Acme Corp');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByRole('heading', { name: 'Acme Corp' }).waitFor();
    assert.equal(await page.getByLabel('Project').inputValue(), page.url().split('/p/')[1]);
    await snap(page, 'project-home');
  });

  test('search finds the project’s things', async (page) => {
    // Seed a location through the API with the same session.
    const pid = Number(page.url().split('/p/')[1]);
    const r = await page.request.post(`${base}/api/projects/${pid}/locations`, { data: { code: 'HQ', name: 'Headquarters' } });
    assert.equal(r.status(), 201);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Headq');
    await page.locator('.search-hit .path').first().waitFor();
    assert.match(await page.locator('.search-results').innerText(), /ACME\/HQ/);
    await snap(page, 'search');
    await page.keyboard.press('Escape');
  });

  test('turn on two-factor sign-in, then sign in with it', async (page) => {
    await page.getByRole('link', { name: /admin|Administrator/ }).click();
    await page.getByRole('heading', { name: 'Your account' }).waitFor();
    await page.getByRole('button', { name: 'Turn on' }).click();
    await page.getByLabel('Your password').fill('owner-password-1');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByAltText('QR code for your authenticator app').waitFor();
    await snap(page, 'totp-qr');
    const secret = await page.locator('code').first().innerText();
    const code = await totp(secret);
    await page.getByLabel('Code', { exact: true }).fill(code);
    await page.getByRole('button', { name: 'Turn on two-factor sign-in' }).click();
    await page.getByText('Keep these recovery codes').waitFor();
    const recovery = (await page.locator('.codes span').first().innerText()).trim();
    await page.getByRole('button', { name: 'I’ve saved them' }).click();
    await page.getByText('recovery code(s) left').waitFor();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill('owner-password-1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Two-factor sign-in' }).waitFor();
    await page.getByRole('button', { name: 'Use a recovery code' }).click();
    await page.getByLabel('Recovery code').fill(recovery);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('heading', { name: 'Projects' }).waitFor();
  });

  test('dark theme and deep links survive a reload', async (page) => {
    await page.getByRole('button', { name: 'Dark theme' }).click();
    await page.goto(base + '/account');
    await page.getByRole('heading', { name: 'Your account' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await snap(page, 'account-dark');
    await page.getByRole('button', { name: 'Light theme' }).click();
  });
}

// RFC 6238 TOTP, for the test only.
async function totp(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = new Uint8Array(Math.floor(bits.length / 8)).map((_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2));
  const counter = Math.floor(Date.now() / 1000 / 30);
  const msg = new ArrayBuffer(8);
  new DataView(msg).setUint32(4, counter);
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', k, msg));
  const o = h[19] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
