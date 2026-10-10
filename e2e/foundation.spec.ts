import { expect, test } from '@playwright/test';

const screens = [
  { width: 320, height: 720 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
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

for (const scheme of ['light', 'dark'] as const) {
  test(`Paperbound ${scheme} theme is visible in admin and mobile shells`, async ({ page }) => {
    await page.emulateMedia({colorScheme: scheme});
    await page.setViewportSize({width: 390, height: 844});
    await page.goto('http://127.0.0.1:4173/');
    const adminRoot = page.locator('main');
    await expect(adminRoot).toHaveAttribute('data-paperbound-theme', scheme);
    await expect(adminRoot).toHaveCSS('background-color', scheme === 'dark' ? 'rgb(21, 29, 25)' : 'rgb(246, 244, 237)');
    await page.goto('http://127.0.0.1:4174/');
    const readerShell = page.getByText('Okuyucu henüz geliştirme aşamasında.').locator('..');
    await expect(readerShell).toHaveCSS('background-color', scheme === 'dark' ? 'rgb(23, 29, 27)' : 'rgb(245, 240, 231)');
  });
}
