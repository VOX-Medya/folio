import { useEffect, useState } from 'react';
import { paperbound, spacing, typography } from '@folio/ui-tokens';

function systemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function App() {
  const [dark, setDark] = useState(systemDark);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => setDark(event.matches);
    setDark(preference.matches);
    preference.addEventListener('change', handleChange);
    return () => preference.removeEventListener('change', handleChange);
  }, []);
  const color = dark ? paperbound.admin.dark : paperbound.admin.light;
  return (
    <main data-paperbound-theme={dark ? 'dark' : 'light'} style={{fontFamily: typography.ui, background: color.bg, color: color.ink, minHeight: '100vh', padding: spacing.xl}}>
      <h1 style={{fontFamily: typography.heading}}>Folio Admin</h1>
      <p>Temel uygulama kabuğu. Yönetim işlevleri henüz etkin değil.</p>
    </main>
  );
}
