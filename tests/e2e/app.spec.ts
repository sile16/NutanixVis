import { existsSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

/** The T1 fixture: 61 devices and 21 cables (see src/fixtures/snapshots/t1-frames.ts). */
const T1_DEVICES = 61;
const T1_LINKS = 21;

/** UI-behavior tests run on the scripted fixture demo (deterministic traffic and failures). */
async function open(page: Page) {
  await page.goto('./#topology=demo-t1-ahv-flasharray');
  await expect(page.getByTestId('node-sw-a')).toBeVisible();
}

test('diagram renders device nodes, port handles and cables', async ({ page }) => {
  await open(page);
  await expect(page.locator('.react-flow__node')).toHaveCount(T1_DEVICES);
  await expect(page.locator('.react-flow__edge')).toHaveCount(T1_LINKS);
  // Every cable end is its own port handle.
  await expect(page.locator('.react-flow__handle.nv-port')).toHaveCount(T1_LINKS * 2);
  await expect(page.getByTestId('node-fa.ct0')).toContainText('CT0');
  await expect(page.getByTestId('node-fa.ct0')).toContainText('Primary');
  await expect(page.getByTestId('node-node-1')).toContainText('Acropolis leader');
  await expect(page.getByTestId('traffic-legend')).toContainText('IO read');
});

test('selecting a node shows the inspector with its actions', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('inspector-empty')).toBeVisible();
  await page.getByTestId('node-sw-b').click();
  await expect(page.getByTestId('inspector-title')).toHaveText('Switch B');
  await expect(page.getByTestId('inspector-fields')).toContainText('10,20,100,200');
  await expect(page.getByTestId('action-fail')).toBeVisible();

  // A VM gets the path-usage view: owning CVM plus per-uplink shares.
  await page.getByTestId('node-node-2.vm-1').click();
  await expect(page.getByTestId('path-usage')).toContainText('CVM 2');
  await expect(page.getByTestId('path-usage')).toContainText('Node 2 eth3');

  // Clicking empty canvas clears the selection.
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
  await expect(page.getByTestId('inspector-empty')).toBeVisible();

  // Keyboard: focus a node and press Enter to select it.
  await page.locator('.react-flow__node[data-id="fa.ct1"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('inspector-title')).toHaveText('CT1');

  // Selecting a cable shows its endpoints and utilization.
  await page.locator('.react-flow__edge[data-id="l-isl"]').click({ force: true });
  await expect(page.getByTestId('inspector-link')).toContainText('Switch A');
});

test('Step and Next event advance time; the next scheduled event fires', async ({ page }) => {
  await open(page);
  const clock = page.getByTestId('sim-clock');
  await expect(clock).toHaveAttribute('data-step', '0');
  await page.getByTestId('step').click();
  await page.getByTestId('fast-forward').click();
  await expect(page.getByTestId('node-sw-a')).toHaveAttribute('data-status', 'failed');
});

test('the step counter has a "What is a step?" help on hover', async ({ page }) => {
  await open(page);
  const tip = page.locator('#steps-help');
  await expect(tip).toBeHidden();
  await page.getByTestId('help-steps-help').hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('relative timing');
  if (process.env.SHOT) {
    await page.waitForTimeout(400);
    await page.screenshot({
      path: process.env.SHOT,
      clip: { x: 0, y: 60, width: 520, height: 380 },
    });
  }
});

test('version selector shows the Nutanix release and Purity 6.11.8+', async ({ page }) => {
  // Multi-release filtering is unit-tested against the fixture matrix (src/ui/app/app-logic.test.ts);
  // here we check the live matrix (src/domain/versions/matrix.ts) end to end.
  await open(page);
  const nutanix = page.getByTestId('nutanix-version');
  const fa = page.getByTestId('flasharray-version');
  await expect(nutanix).toHaveValue('aos-7.6');
  await expect(fa).toHaveValue('purity-6.12');
  await expect(fa.locator('option')).toHaveText(['6.11.8+']);

  // Topologies without an array hide the FlashArray select.
  await page.evaluate(() => {
    window.location.hash = 'topology=t2-hci-ahv';
  });
  await expect(page.getByTestId('node-node-1.disk-1')).toBeVisible();
  await expect(fa).toHaveCount(0);
});

test('right-click quick menu fails a device; manual mode queues actions', async ({ page }) => {
  await open(page);
  await page.getByTestId('node-sw-b').click({ button: 'right' });
  const menu = page.getByTestId('context-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Fail' }).click();
  // Auto mode: the action applies on an immediate tick.
  await expect(page.getByTestId('node-sw-b')).toHaveAttribute('data-status', 'failed');

  await page.getByTestId('manual').click();
  await page.getByTestId('node-sw-b').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Recover' }).click();
  await expect(page.getByTestId('queued')).toHaveText('1 queued');
  await expect(page.getByTestId('node-sw-b')).toHaveAttribute('data-status', 'failed');
  await page.getByTestId('step').click();
  await expect(page.getByTestId('node-sw-b')).toHaveAttribute('data-status', 'healthy');
});

test('events tab shows the causal chain; there is no Explain tab', async ({ page }) => {
  await open(page);
  await page.getByTestId('fast-forward').click(); // → Switch A fails
  await page.getByTestId('step').click(); // → bonds fail over, paths lost (a quiet Step runs a few ticks)
  await page.getByRole('tab', { name: 'Events' }).click();
  const row = page.locator('[data-testid="event-row"][data-code="nvme.io.redistributed"]').first();
  await expect(row).toContainText('caused by nvme.path.lost');
  await expect(page.getByRole('tab', { name: 'Explain' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: /Explain/ })).toHaveCount(0);
});

test('visual baseline: T1 steady state (animation off)', async ({ page }, testInfo) => {
  const name = 't1-steady.png';
  test.skip(
    !!process.env.CI && !existsSync(testInfo.snapshotPath(name, { kind: 'screenshot' })),
    'No baseline for this platform yet; generate with --update-snapshots on the CI image.',
  );
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  // The banner shows the build id and date, which change on every commit.
  await page.getByTestId('build-version').evaluate((el) => {
    el.textContent = '0000000 · 0000-00-00 00:00 UTC';
  });
  await expect(page).toHaveScreenshot(name, { animations: 'disabled', maxDiffPixelRatio: 0.01 });
});

test('the traffic legend collapses to its title and remembers it across a reload', async ({
  page,
}) => {
  await open(page);
  await expect(page.getByTestId('traffic-preset-all')).toBeVisible();
  await page.getByTestId('legend-toggle').click();
  await expect(page.getByTestId('legend-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('traffic-preset-all')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('legend-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('legend-toggle').click();
  await expect(page.getByTestId('traffic-preset-all')).toBeVisible();
});
