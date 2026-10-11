import {useEffect,useRef,useState} from 'react';
import {Platform,Pressable,Text,TextInput,View} from 'react-native';
import {paperbound} from '@folio/ui-tokens';
import {
  fetchWebSessionCsrf,loginWebSession,logoutWebSession,
  fetchWebDeviceSessions,revokeWebDeviceSession,WebSessionHttpError,
} from '@folio/contracts';
import type {DeviceSessionInventory} from '@folio/contracts';
import type {FolioLocale} from './shell-data';
import {WebOnboardingPanel} from './web-onboarding';
import {OwnProfilePanel} from './own-profile';
import {WebFriendshipPanel} from './web-friendship';

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
function deviceErrorCopy(error:unknown,locale:FolioLocale):string{
  if(error instanceof WebSessionHttpError){
    if(error.status===401)return locale==='tr'
      ?'Oturum süresi doldu. Tekrar giriş yap.'
      :'Your session expired. Sign in again.';
    if(error.status===403)return locale==='tr'
      ?'Cihaz işlemi güvenlik denetimi tarafından reddedildi.'
      :'The device action was blocked by a security check.';
    if(error.status===404)return locale==='tr'
      ?'Cihaz oturumu artık bulunamadı.'
      :'The device session is no longer available.';
  }
  return locale==='tr'
    ?'Cihaz oturumları yüklenemedi. Bağlantını kontrol edip tekrar dene.'
    :'Device sessions could not be loaded. Check your connection and retry.';
}
function enabledOrigin():string|null{
  if(Platform.OS!=='web'||typeof window==='undefined'||
     window.location.protocol!=='https:')return null;
  return window.location.origin;
}
export function WebSignInPanel({locale,colors,onLocaleSaved}:{locale:FolioLocale;colors:Palette;onLocaleSaved:(next:FolioLocale)=>void}){
  const [phase,setPhase]=useState<Phase>('checking');
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [error,setError]=useState('');
  const [devices,setDevices]=useState<DeviceSessionInventory|null>(null);
  const [devicePhase,setDevicePhase]=useState<'idle'|'loading'|'ready'|'error'>('idle');
  const [deviceError,setDeviceError]=useState('');
  const [revokingId,setRevokingId]=useState<string|null>(null);
  // Ignore any late inventory reply after sign-out, origin changes or revoke.
  const deviceEpoch=useRef(0);
  const origin=enabledOrigin();

  function clearDevices():void{
    deviceEpoch.current+=1;
    setDevices(null);
    setDevicePhase('idle');
    setDeviceError('');
    setRevokingId(null);
  }

  useEffect(()=>{
    if(!origin){setPhase('unavailable');return;}
    const controller=new AbortController();
    let active=true;
    setPhase('checking');
    clearDevices();
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
  async function loadDevices():Promise<void>{
    if(!origin||phase!=='signedIn'||revokingId!==null)return;
    setDeviceError('');
    setDevicePhase('loading');
    const epoch=++deviceEpoch.current;
    try{
      const inventory=await fetchWebDeviceSessions({baseUrl:origin});
      if(epoch!==deviceEpoch.current)return;
      setDevices(inventory);
      setDevicePhase('ready');
    }catch(cause){
      if(epoch!==deviceEpoch.current)return;
      clearDevices();
      if(cause instanceof WebSessionHttpError&&cause.status===401){
        setPhase('signedOut');
        setError(deviceErrorCopy(cause,locale));
      }else{
        setDevicePhase('error');
        setDeviceError(deviceErrorCopy(cause,locale));
      }
    }
  }

  async function revokeDevice(id:string,isCurrent:boolean):Promise<void>{
    // The current browser device is signed out through the logout endpoint,
    // which clears the HttpOnly cookie; DELETE alone cannot clear that cookie.
    if(!origin||phase!=='signedIn'||revokingId!==null||isCurrent)return;
    setDeviceError('');
    setRevokingId(id);
    const epoch=++deviceEpoch.current;
    try{
      await revokeWebDeviceSession({baseUrl:origin},id);
      if(epoch!==deviceEpoch.current)return;
      // Server ownership is always rechecked; never mark a local row revoked
      // without re-reading the backend state.
      const inventory=await fetchWebDeviceSessions({baseUrl:origin});
      if(epoch!==deviceEpoch.current)return;
      setDevices(inventory);
      setDevicePhase('ready');
    }catch(cause){
      if(epoch!==deviceEpoch.current)return;
      clearDevices();
      if(cause instanceof WebSessionHttpError&&cause.status===401){
        setPhase('signedOut');
        setError(deviceErrorCopy(cause,locale));
      }else{
        setDevicePhase('error');
        setDeviceError(deviceErrorCopy(cause,locale));
      }
    }finally{
      if(epoch===deviceEpoch.current)setRevokingId(null);
    }
  }

  async function logout():Promise<void>{
    if(!origin||phase!=='signedIn')return;
    setError('');
    setPhase('busy');
    clearDevices();
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
      {origin&&<WebOnboardingPanel
        origin={origin} locale={locale} colors={colors}
        onLocaleSaved={onLocaleSaved}
        onSessionExpired={()=>{
          clearDevices();
          setPhase('signedOut');
          setError(locale==='tr'
            ?'Oturum sona erdi. Tekrar giriş yap.'
            :'Your session expired. Sign in again.');
        }}/>} 
      {origin&&<OwnProfilePanel origin={origin} locale={locale} colors={colors}
        onLocaleSaved={onLocaleSaved}
        onSessionExpired={()=>{clearDevices();setPhase('signedOut');}}/>}
      {origin&&<WebFriendshipPanel origin={origin} locale={locale} colors={colors}
        onSessionExpired={()=>{clearDevices();setPhase('signedOut');}}/>}
      <View style={{gap:10}}>
        <Pressable testID="folio-device-sessions-load" accessibilityRole="button"
          accessibilityLabel={locale==='tr'?'Cihaz oturumlarını yükle':'Load device sessions'}
          disabled={devicePhase==='loading'||revokingId!==null}
          onPress={()=>{void loadDevices();}}
          style={{minHeight:48,backgroundColor:colors.surface2,borderWidth:1,
            borderColor:colors.line,borderRadius:10,justifyContent:'center',
            alignItems:'center',paddingHorizontal:18}}>
          <Text style={{fontWeight:'700',fontSize:15,color:colors.ink}}>
            {devicePhase==='ready'
              ?locale==='tr'?'Cihaz listesini yenile':'Refresh devices'
              :locale==='tr'?'Cihaz oturumlarım':'My device sessions'}
          </Text>
        </Pressable>
        {devicePhase==='loading'&&<Text testID="folio-devices-loading"
          style={{fontSize:14,color:colors.accessibleMuted}}>
          {locale==='tr'?'Cihazlar yükleniyor…':'Loading devices…'}
        </Text>}
        {devicePhase==='ready'&&devices&&
          (devices.items.length===0
            ?<Text testID="folio-devices-empty"
              style={{fontSize:14,color:colors.accessibleMuted}}>
              {locale==='tr'?'Etkin cihaz oturumu yok.':'No active device sessions.'}
            </Text>
            :<View testID="folio-devices-list" style={{gap:8}}>
              {devices.items.map(session=><View key={session.id}
                style={{flexDirection:'row',alignItems:'center',
                  justifyContent:'space-between',flexWrap:'wrap',gap:10,
                  padding:12,borderRadius:10,borderWidth:1,borderColor:colors.line}}>
                <View style={{gap:4,flex:1,minWidth:125}}>
                  <Text style={{fontSize:14,fontWeight:'700',color:colors.ink}}>
                    {session.deviceLabel}
                    {session.isCurrent
                      ?locale==='tr'?' · Bu cihaz':' · This device'
                      :''}
                  </Text>
                  <Text style={{fontSize:12,color:colors.accessibleMuted}}>
                    {session.createdAt.slice(0,10)}
                  </Text>
                </View>
                {session.isCurrent
                  ?<Text style={{fontSize:12,color:colors.accessibleMuted}}>
                    {locale==='tr'?'Çıkış Yap ile kapatılır':'Use Sign out'}
                  </Text>
                  :<Pressable testID={'folio-device-revoke-'+session.id}
                    accessibilityRole="button"
                    accessibilityLabel={locale==='tr'
                      ?session.deviceLabel+' oturumunu iptal et'
                      :'Revoke '+session.deviceLabel+' session'}
                    disabled={revokingId!==null}
                    onPress={()=>{void revokeDevice(session.id,session.isCurrent);}}
                    style={{minHeight:48,minWidth:80,borderRadius:8,
                      borderWidth:1,borderColor:colors.line,alignItems:'center',
                      justifyContent:'center',paddingHorizontal:10}}>
                    <Text style={{color:colors.ink,fontWeight:'600'}}>
                      {revokingId===session.id
                        ?locale==='tr'?'İptal…':'Revoking…'
                        :locale==='tr'?'İptal et':'Revoke'}
                    </Text>
                  </Pressable>}
              </View>)}
            </View>)}
        {devicePhase==='error'&&<Text testID="folio-devices-error"
          accessibilityRole="alert" style={{fontSize:14,color:colors.ink}}>
          {deviceError}
        </Text>}
      </View>
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
