import {expect,test} from '@playwright/test';

test('Expo V1 tabs navigate and preserve TR/EN locale across browser back',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('http://127.0.0.1:4174/');
  await expect(page.getByText('Okuyucu henüz geliştirme aşamasında.')).toBeVisible();
  await expect(page.getByTestId('folio-bottom-navigation')).toBeVisible();
  await page.getByTestId('folio-tab-catalog').click();
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(page.getByText('Kitap ve yazar araması henüz etkin değil.')).toBeVisible();
  await expect(page.getByText('Kullanıcı araması bulunmaz.',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'EN'}).click();
  await expect(page.getByText('Book and author search is not enabled yet.')).toBeVisible();
  await page.goBack();
  await expect(page.getByText('The reader is still in development.')).toBeVisible();
  await expect(page.getByTestId('folio-tab-home')).toBeVisible();
  await expect(page.getByTestId('folio-tab-library')).toBeVisible();
  await expect(page.getByTestId('folio-tab-profile')).toBeVisible();
});

for(const width of [320,390,768,1024,1440,1920]){
  test(`Expo V1 responsive navigation fits ${width}px, no fake active account`,async({page})=>{
    await page.setViewportSize({width,height:900});
    await page.goto('http://127.0.0.1:4174/');
    if(width<600)await expect(page.getByTestId('folio-bottom-navigation')).toBeVisible();
    else await expect(page.getByTestId('folio-responsive-navigation')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.getByTestId('folio-tab-library').click();
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.getByText('Kütüphanene erişmek için giriş yapman gerekecek.')).toBeVisible();
    await expect(page.getByText('Kişisel raf, özel kitap veya ilerleme verisi', {exact:false})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.getByTestId('folio-tab-profile')).toBeVisible();
  });
}
