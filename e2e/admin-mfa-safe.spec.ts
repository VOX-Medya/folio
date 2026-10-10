import {expect,test} from '@playwright/test';

const ADMIN='http://127.0.0.1:4173/admin/settings';

test('admin MFA remains inaccessible over HTTP and never attempts sensitive fetches',async({page})=>{
  const sensitive:string[]=[];
  await page.route('**/v1/**',route=>{
    sensitive.push(route.request().url());
    void route.abort();
  });
  await page.goto(ADMIN);
  await expect(page.getByRole('heading',{name:'Ayarlar'})).toBeVisible();
  await expect(page.getByTestId('admin-mfa-insecure')).toBeVisible();
  await expect(page.getByTestId('admin-mfa-panel')).toContainText(
    'Bu yerel HTTP önizlemesi parola veya doğrulama kodu göndermez');
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.locator('input[name="otp"]')).toHaveCount(0);
  await expect(page.getByTestId('admin-mfa-secret')).toHaveCount(0);
  expect(sensitive).toEqual([]);
});

test('Paperbound administrator MFA instructions are bilingual, keyboard accessible and responsive',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto(ADMIN);
  const panel=page.getByTestId('admin-mfa-panel');
  await expect(panel).toBeVisible();
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole('button',{name:'EN',exact:true}).click();
  await expect(panel.getByRole('heading',{name:'Administrator session and MFA'})).toBeVisible();
  await expect(page.getByTestId('admin-mfa-insecure')).toContainText('Verified HTTPS required');
  await expect(page.getByRole('button',{name:'EN',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await page.getByRole('button',{name:'TR',exact:true}).click();
  await expect(panel.getByRole('heading',{name:'Yönetici oturumu ve MFA'})).toBeVisible();
  await expect(page.getByTestId('admin-mfa-secret')).toHaveCount(0);
});
