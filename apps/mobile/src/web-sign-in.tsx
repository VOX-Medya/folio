import {useEffect,useState} from 'react';
import {Platform,Pressable,Text,TextInput,View} from 'react-native';
import {paperbound} from '@folio/ui-tokens';
import {
  fetchWebSessionCsrf,loginWebSession,logoutWebSession,WebSessionHttpError,
} from '@folio/contracts';
import type {FolioLocale} from './shell-data';

type Palette=typeof paperbound.mobile.light|typeof paperbound.mobile.dark;
type Phase='checking'|'signedOut'|'signedIn'|'busy'|'unavailable';

function errorCopy(error:unknown,locale:FolioLocale):string{
  if(error instanceof WebSessionHttpError){
    if(error.status===401)return locale==='tr'
      ?'E-posta veya parola doğrulanamadı.':'Email or password could not be verified.';
    if(error.status===429)return locale==='tr'
      ?'Çok sayıda deneme yapıldı. Daha sonra tekrar dene.':'Too many attempts. Try again later.';
    if(error.status===403)return locale==='tr'
      ?'Güvenlik kontrolü isteği reddetti.':'Security checks rejected the request.';
    if(error.status===404||error.status===503)return locale==='tr'
      ?'Giriş hizmeti henüz etkin değil.':'Sign-in service is not enabled yet.';
  }
  return locale==='tr'
    ?'Bağlantı kurulamadı. Ağını kontrol edip yeniden dene.'
    :'Connection failed. Check your network and retry.';
}
function enabledOrigin():string|null{
  if(Platform.OS!=='web'||typeof window==='undefined'||
     window.location.protocol!=='https:')return null;
  return window.location.origin;
}
export function WebSignInPanel({locale,colors}:{locale:FolioLocale;colors:Palette}){
  const [phase,setPhase]=useState<Phase>('checking');
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [error,setError]=useState('');
  const origin=enabledOrigin();

  useEffect(()=>{
    if(!origin){setPhase('unavailable');return;}
    const controller=new AbortController();
    let active=true;
    setPhase('checking');
    // The only source of authenticated state is a fresh server-side
    // DB verification of the HttpOnly cookie, never browser persistence.
    void fetchWebSessionCsrf({baseUrl:origin,signal:controller.signal})
      .then(()=>{if(active)setPhase('signedIn');})
      .catch((cause:unknown)=>{
        if(!active)return;
        if(cause instanceof WebSessionHttpError&&cause.status===401){
          setPhase('signedOut');
        }else{
          setPhase('unavailable');
        }
      });
    return ()=>{active=false;controller.abort();};
  },[origin]);

  async function login():Promise<void>{
    if(!origin||phase!=='signedOut')return;
    setError('');
    setPhase('busy');
    try{
      await loginWebSession({baseUrl:origin},{email,password});
      // A returned 204 alone is not proof that a browser cookie was saved.
      await fetchWebSessionCsrf({baseUrl:origin});
      setPhase('signedIn');
      setEmail('');
    }catch(cause){
      setError(errorCopy(cause,locale));
      setPhase(cause instanceof WebSessionHttpError&&
        [404,503].includes(cause.status)?'unavailable':'signedOut');
    }finally{
      // Never persist a password, even after a failed request.
      setPassword('');
    }
  }
  async function logout():Promise<void>{
    if(!origin||phase!=='signedIn')return;
    setError('');
    setPhase('busy');
    try{
      await logoutWebSession({baseUrl:origin});
      setPhase('signedOut');
    }catch(cause){
      setError(errorCopy(cause,locale));
      setPhase(cause instanceof WebSessionHttpError&&cause.status===401
        ?'signedOut':'unavailable');
    }
  }

  const loading=phase==='checking'||phase==='busy';
  return <View style={{borderWidth:1,borderColor:colors.line,borderRadius:18,
    backgroundColor:colors.surface,padding:20,gap:12}}>
    <Text accessibilityRole="header" style={{fontSize:17,fontWeight:'700',color:colors.ink}}>
      {locale==='tr'?'Güvenli web oturumu':'Secure web session'}
    </Text>
    {phase==='unavailable'&&<View testID="folio-web-auth-unavailable">
      <Text style={{fontSize:14,lineHeight:22,color:colors.accessibleMuted}}>
        {locale==='tr'
          ?'Web girişi yalnız yapılandırılmış HTTPS ortamında kullanılabilir. Android/iOS için güvenli oturum saklama henüz hazırlanıyor.'
          :'Web sign-in is available only on configured HTTPS. Secure Android/iOS session storage is still in development.'}
      </Text>
    </View>}
    {loading&&<Text testID="folio-web-auth-loading"
      accessibilityRole="text" style={{fontSize:14,color:colors.accessibleMuted}}>
      {locale==='tr'?'Oturum doğrulanıyor…':'Verifying session…'}
    </Text>}
    {phase==='signedOut'&&<>
      <Text style={{fontSize:14,color:colors.accessibleMuted}}>
        {locale==='tr'
          ?'Oturum bilgilerin bu cihazda JavaScript depolamasına yazılmaz.'
          :'Your session credentials are never placed in JavaScript storage.'}
      </Text>
      <TextInput
        testID="folio-login-email"
        accessibilityLabel={locale==='tr'?'E-posta':'Email'}
        autoCapitalize="none" autoCorrect={false}
        autoComplete="email" keyboardType="email-address"
        value={email} onChangeText={setEmail}
        placeholder={locale==='tr'?'E-posta adresi':'Email address'}
        placeholderTextColor={colors.accessibleMuted}
        style={{minHeight:48,borderWidth:1,borderColor:colors.line,
          borderRadius:10,paddingHorizontal:14,fontSize:16,
          color:colors.ink,backgroundColor:colors.bg}}
      />
      <TextInput
        testID="folio-login-password"
        accessibilityLabel={locale==='tr'?'Parola':'Password'}
        autoCapitalize="none" autoCorrect={false}
        autoComplete="current-password" secureTextEntry
        value={password} onChangeText={setPassword}
        placeholder={locale==='tr'?'Parola':'Password'}
        placeholderTextColor={colors.accessibleMuted}
        onSubmitEditing={()=>{void login();}}
        style={{minHeight:48,borderWidth:1,borderColor:colors.line,
          borderRadius:10,paddingHorizontal:14,fontSize:16,
          color:colors.ink,backgroundColor:colors.bg}}
      />
      <Pressable testID="folio-login-submit" accessibilityRole="button"
        accessibilityLabel={locale==='tr'?'Giriş yap':'Sign in'}
        disabled={!email.trim()||password.length<12}
        onPress={()=>{void login();}}
        style={{minHeight:48,borderRadius:10,alignItems:'center',
          justifyContent:'center',backgroundColor:colors.accent,paddingHorizontal:18}}>
        <Text style={{fontWeight:'700',fontSize:16,color:colors.accentOn}}>
          {locale==='tr'?'Giriş yap':'Sign in'}
        </Text>
      </Pressable>
    </>}
    {phase==='signedIn'&&<>
      <Text testID="folio-web-session-verified"
        style={{fontSize:14,lineHeight:22,color:colors.ink}}>
        {locale==='tr'
          ?'Web oturumu sunucuda doğrulandı. Kişisel içerik, yalnız kendi API izinleriyle yüklenecek.'
          :'Your web session was verified by the server. Private content will load only through its own authorized API.'}
      </Text>
      <Pressable testID="folio-logout-submit" accessibilityRole="button"
        accessibilityLabel={locale==='tr'?'Çıkış yap':'Sign out'}
        onPress={()=>{void logout();}}
        style={{minHeight:48,backgroundColor:colors.surface2,borderWidth:1,
          borderColor:colors.line,borderRadius:10,justifyContent:'center',
          alignItems:'center',paddingHorizontal:18}}>
        <Text style={{fontSize:15,fontWeight:'700',color:colors.ink}}>
          {locale==='tr'?'Çıkış yap':'Sign out'}
        </Text>
      </Pressable>
    </>}
    {!!error&&<Text testID="folio-web-auth-error" accessibilityRole="alert"
      style={{fontSize:14,lineHeight:21,color:colors.ink}}>{error}</Text>}
  </View>;
}
