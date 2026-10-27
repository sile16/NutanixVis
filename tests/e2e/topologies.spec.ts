import { expect, test } from '@playwright/test';
import { topologies, topologyIds } from '../../src/topologies';

/** Every real topology renders from the live engine (loader) with all devices and cables. */
for (const id of topologyIds) {
  test(`real topology ${id} renders every device and cable`, async ({ page }) => {
    const t = topologies[id];
    await page.goto(`./#topology=${id}`);
    await expect(page.getByTestId('node-sw-a')).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(t.devices.length);
    await expect(page.locator('.react-flow__edge')).toHaveCount(t.links.length);
  });
}

test('real T1: Step advances the live engine clock', async ({ page }) => {
  await page.goto('./#topology=t1-ahv-flasharray');
  await expect(page.getByTestId('sim-clock')).toHaveText('T+00:00');
  await page.getByRole('button', { name: /^step/i }).click();
  await expect(page.getByTestId('sim-clock')).toHaveText('T+00:01');
});
