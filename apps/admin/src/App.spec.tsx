import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from './App.js';

describe('Admin shell', () => {
  it('renders a truthful non-functional foundation state', () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('Folio Admin');
    expect(html).toContain('henüz etkin değil');
    expect(html).not.toContain('1000 eser');
  });
});
