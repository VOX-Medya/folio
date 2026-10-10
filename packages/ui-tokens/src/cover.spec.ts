import {describe,expect,it} from 'vitest';
import {paperbound} from './index.js';
import {renderFolioCoverSvg} from './cover.js';

const cover={
  workId:'7c2b438c-6ee9-45ad-b817-8ef58ab54c5e',
  language:'tr' as const,
  title:'İstanbul’da Sessiz Günler ve Geceler',
  authors:['Çağrı Yılmaz','Şule İpek'],
  genre:'roman',
  templateVersion:'paperbound-v1' as const,
  theme:'light' as const,
};

describe('Folio deterministic typographic cover',()=>{
  it('renders the same immutable source metadata to the same original SVG',()=>{
    const first=renderFolioCoverSvg(cover);
    expect(renderFolioCoverSvg({...cover})).toBe(first);
    expect(first).toContain('viewBox="0 0 320 480"');
    expect(first).toContain('FOLIO');
    expect(first).toContain('İstanbul');
    expect(first).toContain('Çağrı Yılmaz');
    expect(first).not.toContain('<image');
    expect(first).not.toContain('http://');
    expect(first).not.toContain('https://');
  });

  it('retains canonical metadata in accessible SVG title even for long text',()=>{
    const long={...cover,title:'İstanbul ve Çanakkale arasında unutulmayan hikâyelerin sesli ve sessiz hatıraları üzerine uzun bir roman'};
    const rendered=renderFolioCoverSvg(long);
    expect(rendered).toContain('İstanbul ve Çanakkale');
    expect(rendered).toContain('uzun bir roman');
    expect((rendered.match(/class="title"/g)||[]).length).toBeLessThanOrEqual(3);
    expect(rendered).toContain('aria-labelledby="folio-cover-');
  });

  it('escapes untrusted titles and genres without remote artwork or script',()=>{
    const rendered=renderFolioCoverSvg({...cover,title:'<script>alert(1)</script> & "Kitap"',genre:'<svg onload=alert(1)>'});
    expect(rendered).not.toContain('<script>');
    expect(rendered).not.toContain('<svg onload');
    expect(rendered).toContain('&lt;script&gt;');
    expect(rendered).toContain('&amp;');
  });

  it('reflects language and Paperbound light/dark palettes consistently',()=>{
    const light=renderFolioCoverSvg(cover);
    const dark=renderFolioCoverSvg({...cover,theme:'dark'});
    const english=renderFolioCoverSvg({...cover,language:'en'});
    expect(light).not.toBe(dark);
    expect(light).not.toBe(english);
    expect(light).toContain(paperbound.mobile.light.ink);
    expect(dark).toContain(paperbound.mobile.dark.ink);
    expect(english).toContain('EN · roman');
  });

  it('requires a canonical UUID, template version and editorial title/author',()=>{
    expect(()=>renderFolioCoverSvg({...cover,workId:'../other'})).toThrow();
    expect(()=>renderFolioCoverSvg({...cover,authors:[]})).toThrow();
    expect(()=>renderFolioCoverSvg({...cover,title:''})).toThrow();
    expect(()=>renderFolioCoverSvg({...cover,templateVersion:'v2' as 'paperbound-v1'})).toThrow();
  });
});
