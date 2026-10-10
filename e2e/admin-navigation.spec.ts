import {expect,test} from '@playwright/test';

test('Paperbound admin routes, language and browser history are real navigation',async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  await page.goto('http://127.0.0.1:4173/admin/works');
  await expect(page.getByRole('heading',{name:'Folio Admin'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Eserler'})).toBeVisible();
  await page.getByRole('link',{name:'Yayın Hakları'}).click();
  await expect(page).toHaveURL(/\/admin\/rights$/);
  await expect(page.getByRole('heading',{name:'Yayın Hakları'})).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading',{name:'Eserler'})).toBeVisible();

  await page.getByRole('button',{name:'EN'}).click();
  await expect(page.getByRole('heading',{name:'Works'})).toBeVisible();
  await expect(page.getByText('No content, members or files are shown', {exact:false})).toBeVisible();
  await expect(page.getByRole('link',{name:'Automatic source sync'})).toHaveCount(0);
  await expect(page.getByRole('link',{name:'AI translation / TTS generation'})).toHaveCount(0);
  await expect(page.getByText('AI translation / TTS generation')).toHaveAttribute('aria-disabled','true');
});

for(const width of [320,390,768,1024,1440,1920]){
  test(`Paperbound admin navigation fits ${width}px and remains keyboard accessible`,async({page})=>{
    await page.setViewportSize({width,height:900});
    await page.goto('http://127.0.0.1:4173/admin/dashboard');
    await expect(page.getByRole('navigation',{name:'V1 modülleri'})).toBeVisible();
    await expect(page.getByRole('link',{name:'Eserler'})).toBeVisible();
    await expect(page.getByText('Gerçek bir yönetici oturumu', {exact:false})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.getByRole('link',{name:'Eserler'}).focus();
    await expect(page.getByRole('link',{name:'Eserler'})).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/admin\/works$/);
    await expect(page.getByRole('heading',{name:'Eserler'})).toBeVisible();
  });
}
