import {describe,expect,it} from 'vitest';
import {paperbound} from './index.js';
import {layoutFolioCover,renderFolioCoverSvg} from './cover.js';

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
    expect(first).not.toMatch(/(?:href|src)=/);
    expect(first).not.toContain('<foreignObject');
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
  it('shares stable native geometry and browser SVG elements without runtime measurements',()=>{
    const model=layoutFolioCover(cover);
    const svg=renderFolioCoverSvg(cover);
    expect(model.width).toBe(320);
    expect(model.height).toBe(480);
    expect(model.background).toMatch(/^#[A-Fa-f0-9]{6}$/);
    expect(model.titleLines.length).toBeGreaterThan(0);
    expect(model.titleLines.length).toBeLessThanOrEqual(3);
    expect(model.titleStartY+(model.titleLines.length-1)*model.titleLineHeight)
      .toBeLessThan(model.authorStartY);
    expect(model.authorStartY+model.authorLines.length*23).toBeLessThan(427);
    for(const line of model.titleLines)expect(svg).toContain(line);
    for(const line of model.authorLines)expect(svg).toContain(line);
    expect(svg).toContain('fill="'+model.background+'"');
    expect(svg).toContain('fill="'+model.ink+'"');
    expect(svg).toContain('fill="'+model.accent+'"');
    expect(model.accessibleLabel).toContain('Şule İpek');
    expect(model.footer).toBe('TR · roman');
  });

  it('renders Unicode canonically and refuses illegal XML controls or bidi impersonation',()=>{
    const precomposed={...cover,title:'İlk öykü',authors:['Şule İpek'],genre:'şiir'};
    const decomposed={...precomposed,title:'I\u0307lk o\u0308yku\u0308',
      authors:['S\u0327ule I\u0307pek'],genre:'s\u0327iir'};
    expect(renderFolioCoverSvg(decomposed)).toBe(renderFolioCoverSvg(precomposed));
    const canonical=renderFolioCoverSvg({...cover,title:'A & B < C'});
    expect(canonical).toContain('A &amp; B &lt; C');
    for(const unsafe of ['A\u0001B','A\u202eB','A\ud800B','A\ufffeB']){
      expect(()=>renderFolioCoverSvg({...cover,title:unsafe})).toThrow();
    }
  });

  it('remains accessible when 16 authors or an unusually long genre exceed the cover footprint',()=>{
    const authors=Array.from({length:16},(_,index)=>'Yazar Adı '+index+' Ş');
    const input={...cover,title:'Ö'.repeat(250),authors,
      genre:'Kurgusal uzun bir edebi türün tanımı ve uyumlu alt türleri için başlık'};
    const model=layoutFolioCover(input);
    const svg=renderFolioCoverSvg(input);
    expect(model.titleLines.length).toBeLessThanOrEqual(3);
    expect(model.authorLines.length).toBe(3);
    expect(model.authorLines[2]).toMatch(/…$/u);
    expect(model.accessibleLabel).toContain('Yazar Adı 15 Ş');
    expect(svg).toContain('lengthAdjust="spacingAndGlyphs"');
    expect(svg).toContain('title id="folio-cover-');
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('<foreignObject');
    expect(svg).not.toMatch(/\s(?:href|src|onload|onclick)=/iu);
  });

  it('meets 4.5:1 WCAG text contrast for all Paperbound background selections and themes',()=>{
    const linear=(hex:string)=>{
      const value=hex.slice(1).match(/.{2}/g)!.map(part=>parseInt(part,16)/255);
      const luminance=value.map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
      return .2126*luminance[0]!+.7152*luminance[1]!+.0722*luminance[2]!;
    };
    const ratio=(a:string,b:string)=>{
      const x=linear(a),y=linear(b);
      return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
    };
    for(const theme of ['light','dark'] as const){
      const colors=paperbound.mobile[theme];
      for(const background of [colors.bg,colors.surface,colors.surface2]){
        expect(ratio(colors.ink,background)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(colors.accent,background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
