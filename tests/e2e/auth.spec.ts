import { _electron as electron, expect, test } from '@playwright/test';
import path from 'path';

const APP_ROOT = path.join(__dirname, '..', '..');

test('first-run shows LoginGate, sign in, restart, auto-restore', async () => {
  // Launch app
  const app = await electron.launch({ args: [path.join(APP_ROOT, 'dist-electron', 'main.js')] });
  const page = await app.firstWindow();

  // First run: should see LoginGate
  await expect(page.getByTestId('first-run-screen')).toBeVisible({ timeout: 15000 });

  // Sign in (use mock RunNode or skip if no test server)
  await page.getByTestId('tab-password').click();
  await page.getByTestId('mobile-input').fill('13800138000');
  await page.getByTestId('password-input').fill('testpassword');
  await page.getByTestId('password-submit').click();

  // After login: should enter main app
  await expect(page.getByTestId('first-run-screen')).not.toBeVisible({ timeout: 15000 });

  await app.close();

  // Re-launch
  const app2 = await electron.launch({ args: [path.join(APP_ROOT, 'dist-electron', 'main.js')] });
  const page2 = await app2.firstWindow();

  // Should NOT see LoginGate this time
  await expect(page2.getByTestId('first-run-screen')).not.toBeVisible({ timeout: 15000 });

  await app2.close();
});
