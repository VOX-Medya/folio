import React from 'react';
import { createRoot } from 'react-dom/client';
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(<main style={{fontFamily:'system-ui',background:'#F6F4ED',color:'#26372C',minHeight:'100vh',padding:32}}><h1>Folio Admin</h1><p>Temel uygulama kabuğu. Yönetim işlevleri henüz etkin değil.</p></main>);
