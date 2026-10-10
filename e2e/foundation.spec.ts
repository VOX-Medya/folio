import { expect, test } from '@playwright/test';

const screens = [
  { width: 320, height: 720 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];
for (const viewport of screens) {
  test(`admin shell renders at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('http://127.0.0.1:4173/');
    await expect(page.getByRole('heading', { name: 'Folio Admin' })).toBeVisible();
    await expect(page.getByText('henüz etkin değil', { exact: false })).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(viewport.width);
  });
  test(`Expo Web shell renders at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('http://127.0.0.1:4174/');
    await expect(page.getByText('Folio', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Okuyucu henüz geliştirme aşamasında.')).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(viewport.width);
  });
}
