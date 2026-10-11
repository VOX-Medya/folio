import {expect,test} from '@playwright/test';

const base='http://127.0.0.1:4174';
const valid='11111111-1111-4111-8111-111111111111';

for(const width of [390,1024]){
  test(`Expo book detail route works at ${width}px in TR/EN with keyboard navigation`,async({page})=>{
    await page.setViewportSize({width,height:900});
    await page.goto(base+'/books/'+valid);
    await expect(page.getByTestId('folio-book-route')).toBeVisible();
    await expect(page.getByText('Eser bilgileri henüz sunucuya bağlanmadı.')).toBeVisible();
    await expect(page.getByTestId(width===390?'folio-bottom-navigation':'folio-responsive-navigation')).toBeVisible();
    await expect(page.getByTestId('folio-web-session-verified')).toHaveCount(0);
    await expect(page.getByTestId('folio-login-submit')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.getByRole('button',{name:'EN'}).click();
    await expect(page.getByText('Book details are not connected to the server yet.')).toBeVisible();
    const back=page.getByTestId('folio-route-return');
    await back.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/catalog$/);
    await expect(page.getByText('Book and author search is not enabled yet.')).toBeVisible();
  });
}

test('Expo reader route blocks unauthorized content and rejects malformed deep links',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto(base+'/reader/'+valid);
  await expect(page.getByTestId('folio-reader-route')).toBeVisible();
  await expect(page.getByText('Okuyucu henüz güvenli içerik API’sine bağlanmadı.')).toBeVisible();
  await expect(page.getByTestId('folio-web-session-verified')).toHaveCount(0);
  await page.goto(base+'/reader/not-a-uuid');
  await expect(page.getByTestId('folio-invalid-reading-route')).toBeVisible();
  await expect(page.getByText('Geçersiz okuyucu bağlantısı.')).toBeVisible();
  await page.goto(base+'/books/not-a-uuid');
  await expect(page.getByTestId('folio-invalid-reading-route')).toBeVisible();
  await expect(page.getByText('Geçersiz eser bağlantısı.')).toBeVisible();
});
