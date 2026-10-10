import { paperbound, spacing, typography } from '@folio/ui-tokens';

export function App() {
  const color = paperbound.admin.light;
  return (
    <main style={{fontFamily: typography.ui, background: color.bg, color: color.ink, minHeight: '100vh', padding: spacing.xl}}>
      <h1>Folio Admin</h1>
      <p>Temel uygulama kabuğu. Yönetim işlevleri henüz etkin değil.</p>
    </main>
  );
}
