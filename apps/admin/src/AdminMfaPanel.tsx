import {useEffect,useState} from 'react';
import type {FormEvent} from 'react';
import {
  AdminMfaClientError,beginAdminWebTotp,bootstrapAdminWebCsrf,
  confirmAdminWebTotp,isSafeAdminMfaOrigin,isValidTotpCode,
  loginAdminWeb,logoutAdminWeb,verifyAdminWebTotp,
} from './admin-mfa-client.js';
import type {TotpEnrollment,TotpProof} from './admin-mfa-client.js';

type Language='tr'|'en';
type Mode='checking'|'insecure'|'unavailable'|'signed-out'|'authenticated';
type Busy='login'|'refresh'|'enroll'|'confirm'|'verify'|'logout'|null;
const words={
  tr:{
    title:'Yönetici oturumu ve MFA',
    introductory:'Yalnız doğrulanmış HTTPS, HttpOnly oturum çerezi ve sunucu CSRF korumasıyla çalışır. Bu ekran yönetici erişimini kendiliğinden vermez.',
    insecure:'Güvenli HTTPS bağlantısı gerekli. Bu yerel HTTP önizlemesi parola veya doğrulama kodu göndermez.',
    unavailable:'Yönetici oturum hizmeti bu sunucuda etkin değil. Gerçek yönetici hesabı ve sunucu onayı olmadan kullanılamaz.',
    checking:'Güvenli oturum kontrol ediliyor…',
    offline:'Çevrimdışı. Gizli oturum işlemleri kuyruğa alınmaz.',
    email:'E-posta',password:'Parola',login:'Oturum aç',
    checkSession:'Oturumu yeniden kontrol et',
    registered:'Tarayıcı oturumu doğrulandı. Yönetici yetkisi ve MFA, sunucu tarafından ayrıca kontrol edilir.',
    logout:'Güvenli çıkış',enroll:'Yeni TOTP kaydı başlat',
    initial:'Zaten bir doğrulayıcı kayıtlıysa yeni kayıt açmayın. Etkin faktör kurtarma/sıfırlama burada bulunmaz.',
    seedTitle:'Doğrulayıcı kurulum anahtarı (yalnız bu adımda gösterilir)',
    seedHelp:'Anahtarı güvenilir doğrulayıcı uygulamasına elle girin. Ekran görüntüsünü veya kodu paylaşmayın. Kayıt henüz yetki vermez.',
    expiry:'Kayıt sonu',closeSeed:'Kurulum anahtarını ekrandan kaldır',
    code:'Altı haneli güncel TOTP kodu',confirm:'Faktör kaydını onayla',
    verify:'Bu cihazın oturumunu MFA ile doğrula',
    confirmed:'Faktör kaydı onaylandı. Bu oturumu yetkilendirmek için sonraki farklı TOTP kodunu kullanın.',
    verified:'Bu cihaz için MFA kanıtı doğrulandı.',proofExpiry:'Kanıt süresi sonu',
    noCrud:'Katalog erişimi ayrıca sunucu TLS açma bayrakları ve gerçek katalog rolü gerektirir. Diğer yönetici modülleri hâlâ kapalıdır.',
    busy:'Güvenli işlem sürüyor…',
    invalidCode:'Altı haneli geçerli bir kod girin.',
    errors:{
      'secure-https':'Yalnız HTTPS bağlantısında kullanılabilir.',
      unauthorized:'Oturum, yönetici yetkisi veya TOTP kodu reddedildi.',
      forbidden:'İstek origin veya CSRF doğrulamasından geçmedi.',
      disabled:'Sunucu özelliği kapalı; deneme ortamında etkinmiş gibi gösterilmez.',
      unavailable:'Güvenli sunucu yapılandırması veya hizmet kullanılamıyor.',
      invalid:'Gönderilen alan veya kod geçersiz.',
      network:'Ağ isteği tamamlanamadı. Gizli işlem tekrar gönderilmedi.',
      unexpected:'Sunucudan beklenmeyen yanıt alındı.',
    },
  },
  en:{
    title:'Administrator session and MFA',
    introductory:'Uses verified HTTPS, an HttpOnly session cookie and server-side CSRF protection. This screen never grants administrator access on its own.',
    insecure:'Verified HTTPS required. This local HTTP preview never submits a password or authentication code.',
    unavailable:'Administrator login is not enabled on this server. An approved administrator account and server configuration are required.',
    checking:'Checking secure session…',
    offline:'Offline. Sensitive authentication operations are never queued.',
    email:'Email',password:'Password',login:'Sign in',
    checkSession:'Check session again',
    registered:'Browser session verified. The server separately checks administrator roles and MFA.',
    logout:'Secure logout',enroll:'Start a new TOTP enrollment',
    initial:'Do not enroll again if an authenticator is already active. Lost-factor recovery or reset is not offered here.',
    seedTitle:'Authenticator setup secret (shown only at this step)',
    seedHelp:'Enter this secret manually in a trusted authenticator. Never share screenshots or codes. Enrollment alone does not grant access.',
    expiry:'Enrollment expires',closeSeed:'Remove setup secret from screen',
    code:'Current six-digit TOTP code',confirm:'Confirm factor enrollment',
    verify:'Verify MFA for this device session',
    confirmed:'Factor enrollment confirmed. Use a DIFFERENT, fresh TOTP code to authorize this device.',
    verified:'MFA evidence verified for this device.',proofExpiry:'Evidence expires',
    noCrud:'Catalog access additionally requires server-side TLS flags and a real catalog role. Other administrator modules remain unavailable.',
    busy:'Secure request in progress…',
    invalidCode:'Enter a valid six-digit TOTP code.',
    errors:{
      'secure-https':'Available over HTTPS only.',
      unauthorized:'The session, administrator permission or TOTP code was rejected.',
      forbidden:'The origin or CSRF verification was rejected.',
      disabled:'This feature is disabled on the server and is not simulated.',
      unavailable:'Secure server configuration or service is unavailable.',
      invalid:'Invalid field or verification code.',
      network:'Network request failed. Sensitive operations were not retried.',
      unexpected:'Unexpected server response.',
    },
  },
} as const;

function firstMode():Mode{
  if(typeof window==='undefined')return 'insecure';
  return isSafeAdminMfaOrigin(window.location.protocol)?'checking':'insecure';
}
function connectivity():boolean{
  return typeof navigator==='undefined'||navigator.onLine!==false;
}
export function AdminMfaPanel({language}:{language:Language}){
  const w=words[language];
  const [mode,setMode]=useState<Mode>(firstMode);
  const [online,setOnline]=useState(connectivity);
  const [csrf,setCsrf]=useState<string|null>(null);
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [code,setCode]=useState('');
  const [seed,setSeed]=useState<TotpEnrollment|null>(null);
  const [proof,setProof]=useState<TotpProof|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [failure,setFailure]=useState<string|null>(null);
  const [busy,setBusy]=useState<Busy>(null);
  const locked=busy!==null||!online;

  function explain(error:unknown):string{
    if(error instanceof AdminMfaClientError)return w.errors[error.kind];
    return w.errors.unexpected;
  }
  useEffect(()=>{
    if(typeof window==='undefined')return;
    const changed=()=>setOnline(connectivity());
    window.addEventListener('online',changed);
    window.addEventListener('offline',changed);
    return ()=>{
      window.removeEventListener('online',changed);
      window.removeEventListener('offline',changed);
    };
  },[]);
  useEffect(()=>{
    if(mode!=='checking'||!online)return;
    let active=true;
    void bootstrapAdminWebCsrf().then(token=>{
      if(active){setCsrf(token);setMode('authenticated');}
    }).catch((error:unknown)=>{
      if(!active)return;
      setCsrf(null);
      if(error instanceof AdminMfaClientError&&error.kind==='unauthorized'){
        setMode('signed-out');
      }else{
        setMode('unavailable');
      }
    });
    return ()=>{active=false;};
  },[mode,online]);

  async function run(
    operation:Exclude<Busy,null>,action:()=>Promise<void>,
  ):Promise<void>{
    if(locked)return;
    setBusy(operation);
    setFailure(null);
    setNotice(null);
    try{await action();}
    catch(error){setFailure(explain(error));}
    finally{setBusy(null);}
  }
  function refresh(){
    if(locked||mode==='insecure')return;
    setMode('checking');
    setCsrf(null);
    setSeed(null);
    setProof(null);
    setCode('');
    setFailure(null);
  }
  function submitLogin(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(locked||mode!=='signed-out')return;
    const submittedEmail=email.trim();
    const submittedPassword=password;
    setPassword(''); // Do not retain plaintext password during the request.
    void run('login',async()=>{
      await loginAdminWeb(submittedEmail,submittedPassword);
      setEmail('');
      const next=await bootstrapAdminWebCsrf();
      setCsrf(next);
      setMode('authenticated');
    });
  }
  function enroll(){
    if(!csrf)return;
    void run('enroll',async()=>{
      setSeed(await beginAdminWebTotp(csrf));
      setProof(null);
      setCode('');
    });
  }
  function submitCode(event:FormEvent<HTMLFormElement>,kind:'confirm'|'verify'){
    event.preventDefault();
    if(!csrf||locked||!isValidTotpCode(code)){
      if(!isValidTotpCode(code))setFailure(w.invalidCode);
      return;
    }
    const submitted=code;
    setCode(''); // Never persist OTP in component state after submission.
    if(kind==='confirm'){
      void run('confirm',async()=>{
        await confirmAdminWebTotp(csrf,submitted);
        setSeed(null);
        setNotice(w.confirmed);
      });
    }else{
      void run('verify',async()=>{
        setProof(await verifyAdminWebTotp(csrf,submitted));
      });
    }
  }
  function logout(){
    if(!csrf)return;
    void run('logout',async()=>{
      await logoutAdminWeb(csrf);
      setCsrf(null);setSeed(null);setProof(null);
      setEmail('');setPassword('');setCode('');
      setMode('signed-out');
    });
  }
  return(
    <section className="folio-mfa" aria-labelledby="folio-admin-mfa-heading"
      data-testid="admin-mfa-panel">
      <h3 id="folio-admin-mfa-heading">{w.title}</h3>
      <p>{w.introductory}</p>
      {!online&&<p className="folio-mfa-warning" role="status">{w.offline}</p>}
      {mode==='insecure'&&<p className="folio-mfa-warning" role="status"
        data-testid="admin-mfa-insecure">{w.insecure}</p>}
      {mode==='unavailable'&&<p role="status">{w.unavailable}</p>}
      {mode==='checking'&&<p role="status">{w.checking}</p>}
      {mode==='signed-out'&&
        <form className="folio-mfa-fields" onSubmit={submitLogin}
          autoComplete="on" aria-label={w.login}>
          <label htmlFor="folio-admin-email">{w.email}</label>
          <input id="folio-admin-email" type="email" name="email"
            value={email} autoComplete="username" inputMode="email" required
            maxLength={254} onChange={event=>setEmail(event.target.value)}/>
          <label htmlFor="folio-admin-password">{w.password}</label>
          <input id="folio-admin-password" type="password" name="password"
            value={password} autoComplete="current-password" minLength={12}
            maxLength={128} required onChange={event=>setPassword(event.target.value)}/>
          <button type="submit" disabled={locked}>{w.login}</button>
        </form>}
      {(mode==='authenticated'&&csrf)&&<>
        <p role="status">{w.registered}</p>
        <p>{w.initial}</p>
        <div className="folio-mfa-actions">
          <button type="button" onClick={enroll} disabled={locked||seed!==null}>
            {w.enroll}
          </button>
          <button type="button" onClick={logout} disabled={locked}>{w.logout}</button>
        </div>
        {seed&&<div className="folio-mfa-secret" data-testid="admin-mfa-secret">
          <strong>{w.seedTitle}</strong>
          <p>{w.seedHelp}</p>
          <code translate="no">{seed.secretBase32}</code>
          <p>{w.expiry}: <time dateTime={seed.expiresAt}>
            {new Date(seed.expiresAt).toLocaleString(language)}</time></p>
          <button type="button" onClick={()=>setSeed(null)} disabled={locked}>
            {w.closeSeed}
          </button>
        </div>}
        <form className="folio-mfa-fields" onSubmit={event=>submitCode(event,seed?'confirm':'verify')}>
          <label htmlFor="folio-admin-otp">{w.code}</label>
          <input id="folio-admin-otp" type="text" name="otp"
            inputMode="numeric" pattern="[0-9]{6}" maxLength={6} minLength={6}
            autoComplete="one-time-code" value={code} required
            onChange={event=>setCode(event.target.value)}/>
          <button type="submit" disabled={locked||!isValidTotpCode(code)}>
            {seed?w.confirm:w.verify}
          </button>
        </form>
        {proof&&<div role="status" className="folio-mfa-evidence">
          <strong>{w.verified}</strong>
          <p>{w.proofExpiry}: <time dateTime={proof.expiresAt}>
            {new Date(proof.expiresAt).toLocaleString(language)}</time></p>
          <p>{w.noCrud}</p>
        </div>}
      </>}
      {mode!=='insecure'&&<button type="button" className="folio-mfa-refresh"
        onClick={refresh} disabled={locked||mode==='checking'}>{w.checkSession}</button>}
      {busy!==null&&<p role="status">{w.busy}</p>}
      {notice&&<p className="folio-mfa-notice" role="status">{notice}</p>}
      {failure&&<p className="folio-mfa-warning" role="alert">{failure}</p>}
    </section>
  );
}
