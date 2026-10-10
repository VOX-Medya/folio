import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from './App.js';
import {AdminCatalogPanel} from './AdminCatalogPanel.js';

describe('Admin shell', () => {
  it('renders a truthful foundation for unfinished sections, no fake analytics', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('Folio Admin');
    expect(html).toContain('henüz etkin değil');
    expect(html).not.toContain('1000 eser');
    expect(html).not.toContain('1000 books');
  });
  it('keeps canonical authors/works completely private over non-HTTPS previews',()=>{
    for(const kind of ['works','authors'] as const){
      const html=renderToStaticMarkup(<AdminCatalogPanel kind={kind} language="tr" theme="light"/>);
      expect(html).toContain('HTTPS gerekli');
      expect(html).toContain('admin-catalog-insecure');
      expect(html).not.toContain('<form');
      expect(html).not.toContain('type="search"');
      expect(html).not.toContain('name="password"');
      expect(html).not.toContain('İstanbul’da Sessiz');
      expect(html).not.toContain('admin-folio-cover-preview');
      expect(html).not.toContain('1000 eser');
    }
  });
  it('renders the bounded English HTTPS notice without fake signed-in records',()=>{
    const html=renderToStaticMarkup(<AdminCatalogPanel kind="works" language="en" theme="dark"/>);
    expect(html).toContain('HTTPS required');
    expect(html).toContain('Session and MFA settings');
    expect(html).not.toContain('Published books');
  });
});
