import {expect,test} from '@playwright/test';

function required(name:string):string{
  const value=process.env[name];
  if(!value)throw Error('Missing Folio-only synthetic live browser fixture: '+name);
  return value;
}

test('actual Expo Chrome search -> owner shelf -> reader route; other user sees empty shelf',
  async({browser})=>{
  test.setTimeout(110_000);
  const origin=required('FOLIO_LIVE_SHELF_ORIGIN');
  const workId=required('FOLIO_LIVE_SHELF_WORK_ID');
  const title=required('FOLIO_LIVE_SHELF_TITLE');
  const owner=required('FOLIO_LIVE_SHELF_OWNER_TOKEN');
  const other=required('FOLIO_LIVE_SHELF_OTHER_TOKEN');
  const cookie=(token:string)=>[{
    name:'__Host-folio_session',value:token,url:origin,
    httpOnly:true,secure:true,sameSite:'Strict' as const,
  }];
  const first=await browser.newContext({
    ignoreHTTPSErrors:true,viewport:{width:390,height:844},
  });
  const second=await browser.newContext({
    ignoreHTTPSErrors:true,viewport:{width:390,height:844},
  });
  try{
    await first.addCookies(cookie(owner));
    await second.addCookies(cookie(other));
    const page=await first.newPage();
    await page.goto(origin+'/catalog');
    await expect(page.getByTestId('folio-public-search')).toBeVisible();
    await page.getByTestId('folio-public-search-input').fill(title);
    await page.getByTestId('folio-public-search-submit').click();
    await expect(page.getByTestId('folio-public-book-'+workId)).toBeVisible();
    await page.getByTestId('folio-shelf-add-'+workId).click();
    await expect(page.getByTestId('folio-public-search-status')).toHaveText('Raf kaydedildi.');
    await page.getByTestId('folio-tab-library').click();
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.getByTestId('folio-owned-shelf')).toBeVisible();
    await expect(page.getByTestId('folio-shelf-continue-'+workId)).toBeVisible();
    const otherPage=await second.newPage();
    await otherPage.goto(origin+'/library');
    await expect(otherPage.getByText('Rafında yayımlanmış kitap yok.')).toBeVisible();
    await page.getByTestId('folio-shelf-continue-'+workId).click();
    await expect(page).toHaveURL(/\/reader\/[0-9a-f-]+$/);
    await expect(page.getByTestId('folio-reader-route')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }finally{
    await first.close();
    await second.close();
  }
});
