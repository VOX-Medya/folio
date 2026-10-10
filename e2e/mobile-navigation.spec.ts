import {expect,test} from '@playwright/test';

test('Expo V1 tabs navigate and preserve TR/EN locale across browser back',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('http://127.0.0.1:4174/');
  await expect(page.getByText('Okuyucu henüz geliştirme aşamasında.')).toBeVisible();
  await expect(page.getByTestId('folio-bottom-navigation')).toBeVisible();
  await page.getByTestId('folio-tab-catalog').click();
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(page.getByText('Kitap ve yazar araması henüz etkin değil.').filter({visible:true}).first()).toBeVisible();
  await expect(page.getByText('Kullanıcı araması bulunmaz.',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'EN'}).click();
  await expect(page.getByText('Book and author search is not enabled yet.').filter({visible:true}).first()).toBeVisible();
  await page.goBack();
  await expect(page.getByText('The reader is still in development.').filter({visible:true}).first()).toBeVisible();
  await expect(page.getByTestId('folio-tab-home').filter({visible:true}).first()).toBeVisible();
  await expect(page.getByTestId('folio-tab-library').filter({visible:true}).first()).toBeVisible();
  await expect(page.getByTestId('folio-tab-profile').filter({visible:true}).first()).toBeVisible();
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
    await expect(page.getByText('Kütüphanene erişmek için giriş yapman gerekecek.').filter({visible:true}).first()).toBeVisible();
    await expect(page.getByText('Kişisel raf, özel kitap veya ilerleme verisi', {exact:false}).filter({visible:true}).first()).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.getByTestId('folio-tab-profile').filter({visible:true}).first()).toBeVisible();
  });
}


test('Expo Web profile does not activate HTTP or native-unverified login',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('http://127.0.0.1:4174/profile');
  await expect(page.getByTestId('folio-web-auth-unavailable')).toBeVisible();
  await expect(page.getByText('Web girişi yalnız yapılandırılmış HTTPS ortamında',{
    exact:false,
  })).toBeVisible();
  await expect(page.getByTestId('folio-login-submit')).toHaveCount(0);
  await expect(page.getByTestId('folio-device-sessions-load')).toHaveCount(0);
  await expect(page.getByTestId('folio-devices-list')).toHaveCount(0);
  const keys=await page.evaluate(()=>Object.keys(window.sessionStorage));
  expect(keys.filter(key=>/token|bearer|session|password|csrf/i.test(key))).toEqual([]);
});
