import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {AdminMfaPanel} from './AdminMfaPanel.js';

describe('Admin MFA safe browser panel',()=>{
  it('never renders secret fields on an untrusted/server-rendered HTTP surface',()=>{
    const html=renderToStaticMarkup(<AdminMfaPanel language="tr"/>);
    expect(html).toContain('Yönetici oturumu ve MFA');
    expect(html).toContain('Güvenli HTTPS bağlantısı gerekli');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('name="otp"');
    expect(html).not.toContain('ABCDEFGHIJKLMNOPQRST');
    expect(html).not.toContain('1000 eser');
  });
  it('provides concise English secure mode without fake elevated privileges',()=>{
    const html=renderToStaticMarkup(<AdminMfaPanel language="en"/>);
    expect(html).toContain('Administrator session and MFA');
    expect(html).toContain('Verified HTTPS required');
    expect(html).not.toContain('already authorized');
    expect(html).not.toContain('type="email"');
  });
});
