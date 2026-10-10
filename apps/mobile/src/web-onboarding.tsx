import {useEffect,useRef,useState} from 'react';
import {Pressable,Text,View} from 'react-native';
import {paperbound} from '@folio/ui-tokens';
import {
  fetchWebOnboarding,updateWebOnboarding,WebSessionHttpError,
} from '@folio/contracts';
import type {OnboardingSnapshot} from '@folio/contracts';
import type {FolioLocale} from './shell-data';

type Palette=typeof paperbound.mobile.light|typeof paperbound.mobile.dark;
type State='loading'|'ready'|'saving'|'error';
type Step=OnboardingSnapshot['stage'];
interface Props{
  origin:string;
  locale:FolioLocale;
  colors:Palette;
  onSessionExpired:()=>void;
  onLocaleSaved:(value:FolioLocale)=>void;
}
const interests=[
  {id:'fiction',tr:'Kurgu',en:'Fiction'},
  {id:'history',tr:'Tarih',en:'History'},
  {id:'science',tr:'Bilim',en:'Science'},
  {id:'biography',tr:'Biyografi',en:'Biography'},
] as const;

function onboardingError(error:unknown,locale:FolioLocale):string{
  if(error instanceof WebSessionHttpError){
    if(error.status===409)return locale==='tr'
      ?'Tercihler başka bir cihazda değişti. Sunucudan yenile.'
      :'Preferences changed on another device. Refresh from the server.';
    if(error.status===403)return locale==='tr'
      ?'Güvenlik kontrolü işlemi reddetti.':'Security checks denied this action.';
  }
  return locale==='tr'
    ?'Tercihler doğrulanamadı. Bağlantını kontrol edip yeniden yükle.'
    :'Preferences could not be verified. Check your network and reload.';
}

/**
 * All progress originates from the account's verified server session and
 * stays in memory until the backend confirms a versioned update. This V1
 * partial intentionally CANNOT mark onboarding complete: privacy consent
 * still requires a dedicated backend audit/acceptance gate.
 */
export function WebOnboardingPanel({
  origin,locale,colors,onSessionExpired,onLocaleSaved,
}:Props){
  const [snapshot,setSnapshot]=useState<OnboardingSnapshot|null>(null);
  const [state,setState]=useState<State>('loading');
  const [chosenLocale,setChosenLocale]=useState<FolioLocale>('tr');
  const [chosenInterests,setChosenInterests]=useState<string[]>([]);
  const [error,setError]=useState('');
  const epoch=useRef(0);
  const callbacks=useRef({onSessionExpired,onLocaleSaved});
  callbacks.current={onSessionExpired,onLocaleSaved};

  function applySnapshot(next:OnboardingSnapshot){
    setSnapshot(next);
    setChosenLocale(next.locale);
    setChosenInterests([...next.interests]);
    callbacks.current.onLocaleSaved(next.locale);
  }

  useEffect(()=>{
    const controller=new AbortController();
    const token=++epoch.current;
    setState('loading');
    void fetchWebOnboarding({baseUrl:origin,signal:controller.signal})
      .then(server=>{
        if(token!==epoch.current)return;
        applySnapshot(server);
        setError('');
        setState('ready');
      }).catch((cause:unknown)=>{
        if(token!==epoch.current)return;
        if(cause instanceof WebSessionHttpError&&cause.status===401){
          callbacks.current.onSessionExpired();
          return;
        }
        setError(onboardingError(cause,locale));
        setState('error');
      });
    return ()=>{epoch.current++;controller.abort();};
  },[origin]);

  async function reload():Promise<void>{
    if(state==='loading'||state==='saving')return;
    const token=++epoch.current;
    setState('loading');
    setError('');
    try{
      const server=await fetchWebOnboarding({baseUrl:origin});
      if(token!==epoch.current)return;
      applySnapshot(server);
      setState('ready');
    }catch(cause){
      if(token!==epoch.current)return;
      if(cause instanceof WebSessionHttpError&&cause.status===401){
        callbacks.current.onSessionExpired();
        return;
      }
      setError(onboardingError(cause,locale));
      setState('error');
    }
  }

  async function persist(target:'language'|'interests'):Promise<void>{
    if(!snapshot||state!=='ready')return;
    const token=++epoch.current;
    setState('saving');
    setError('');
    try{
      const saved=await updateWebOnboarding({baseUrl:origin},{
        expectedVersion:snapshot.version,
        stage:target,
        locale:chosenLocale,
        interests:chosenInterests,
      });
      if(token!==epoch.current)return;
      applySnapshot(saved);
      setState('ready');
    }catch(cause){
      if(token!==epoch.current)return;
      if(cause instanceof WebSessionHttpError&&cause.status===401){
        callbacks.current.onSessionExpired();
        return;
      }
      // On a 409 or a network outage we do not guess whether PATCH applied:
      // server reload is mandatory before any further write.
      setError(onboardingError(cause,locale));
      setState('error');
    }
  }

  const stage:Step|undefined=snapshot?.stage;
  const disabled=state!=='ready';
  const intro=locale==='tr'?'Okuma tercihlerin':'Reading preferences';
  return <View testID="folio-web-onboarding-panel"
    style={{borderWidth:1,borderColor:colors.line,borderRadius:12,
      backgroundColor:colors.surface2,padding:16,gap:12}}>
    <Text accessibilityRole="header"
      style={{fontSize:16,fontWeight:'700',color:colors.ink}}>{intro}</Text>
    <Text style={{fontSize:13,lineHeight:20,color:colors.accessibleMuted}}>
      {locale==='tr'
        ?'Her adım doğrulanmış hesabında saklanır. Daha sonra başka cihazdan devam edebilirsin.'
        :'Every saved step belongs to your verified account. Continue later on another device.'}
    </Text>
    {state==='loading'&&<Text testID="folio-onboarding-loading"
      style={{color:colors.accessibleMuted,fontSize:14}}>
      {locale==='tr'?'Tercihler yükleniyor…':'Loading preferences…'}
    </Text>}
    {state==='saving'&&<Text testID="folio-onboarding-saving"
      style={{color:colors.accessibleMuted,fontSize:14}}>
      {locale==='tr'?'Sunucuda kaydediliyor…':'Saving to server…'}
    </Text>}
    {state==='error'&&<View style={{gap:8}}>
      <Text testID="folio-onboarding-error" accessibilityRole="alert"
        style={{fontSize:14,color:colors.ink}}>{error}</Text>
      <Pressable accessibilityRole="button" testID="folio-onboarding-reload"
        accessibilityLabel={locale==='tr'?'Sunucudan yeniden yükle':'Reload from server'}
        onPress={()=>{void reload();}}
        style={{minHeight:48,borderWidth:1,borderColor:colors.line,borderRadius:8,
          paddingHorizontal:12,alignItems:'center',justifyContent:'center'}}>
        <Text style={{fontWeight:'600',color:colors.ink}}>
          {locale==='tr'?'Yeniden yükle':'Reload'}</Text>
      </Pressable>
    </View>}
    {state==='ready'&&stage==='welcome'&&<View style={{gap:10}}>
      <Text testID="folio-onboarding-stage-welcome"
        style={{fontSize:14,lineHeight:21,color:colors.ink}}>
        {locale==='tr'
          ?'Önce okuma dilini, sonra ilgilendiğin konuları seçeceksin.'
          :'First choose your reading language, then your topics.'}
      </Text>
      <Pressable testID="folio-onboarding-start" accessibilityRole="button"
        onPress={()=>{void persist('language');}} disabled={disabled}
        style={{minHeight:48,borderRadius:9,backgroundColor:colors.accent,
          justifyContent:'center',alignItems:'center'}}>
        <Text style={{color:colors.accentOn,fontWeight:'700'}}>
          {locale==='tr'?'Başla':'Start'}</Text>
      </Pressable>
    </View>}
    {state==='ready'&&stage==='language'&&<View style={{gap:10}}>
      <Text testID="folio-onboarding-stage-language"
        style={{fontSize:14,color:colors.ink}}>
        {locale==='tr'?'Okuma dili':'Reading language'}
      </Text>
      <View style={{flexDirection:'row',gap:8,flexWrap:'wrap'}}>
        {(['tr','en'] as const).map(code=><Pressable key={code}
          testID={'folio-onboarding-locale-'+code} accessibilityRole="button"
          accessibilityLabel={code.toUpperCase()}
          accessibilityState={{selected:chosenLocale===code}}
          onPress={()=>setChosenLocale(code)}
          style={{minHeight:48,minWidth:82,borderWidth:1,borderRadius:9,
            borderColor:colors.line,alignItems:'center',justifyContent:'center',
            backgroundColor:chosenLocale===code?colors.accent:colors.surface}}>
          <Text style={{fontWeight:'700',
            color:chosenLocale===code?colors.accentOn:colors.ink}}>
            {code.toUpperCase()}</Text>
        </Pressable>)}
      </View>
      <Pressable testID="folio-onboarding-next" accessibilityRole="button"
        onPress={()=>{void persist('interests');}}
        style={{minHeight:48,borderRadius:9,backgroundColor:colors.accent,
          justifyContent:'center',alignItems:'center'}}>
        <Text style={{color:colors.accentOn,fontWeight:'700'}}>
          {locale==='tr'?'Dili kaydet ve devam et':'Save language and continue'}</Text>
      </Pressable>
    </View>}
    {state==='ready'&&stage==='interests'&&<View style={{gap:10}}>
      <Text testID="folio-onboarding-stage-interests"
        style={{fontSize:14,color:colors.ink}}>
        {locale==='tr'?'İlgilendiğin konular':'Topics you enjoy'}
      </Text>
      <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
        {interests.map(item=>{
          const active=chosenInterests.includes(item.id);
          return <Pressable key={item.id}
            testID={'folio-onboarding-interest-'+item.id}
            accessibilityRole="button" accessibilityLabel={item[locale]}
            accessibilityState={{selected:active}}
            onPress={()=>setChosenInterests(old=>active
              ?old.filter(x=>x!==item.id):[...old,item.id])}
            style={{minHeight:48,paddingHorizontal:12,
              borderWidth:1,borderColor:colors.line,borderRadius:9,
              justifyContent:'center',backgroundColor:active?colors.accent:colors.surface}}>
            <Text style={{color:active?colors.accentOn:colors.ink}}>
              {item[locale]}</Text>
          </Pressable>;
        })}
      </View>
      <Pressable testID="folio-onboarding-save-interests"
        accessibilityRole="button" onPress={()=>{void persist('interests');}}
        style={{minHeight:48,borderRadius:9,backgroundColor:colors.accent,
          justifyContent:'center',alignItems:'center'}}>
        <Text style={{color:colors.accentOn,fontWeight:'700'}}>
          {locale==='tr'?'Konularımı kaydet':'Save my topics'}</Text>
      </Pressable>
      <Text testID="folio-onboarding-consent-pending"
        style={{fontSize:12,lineHeight:19,color:colors.accessibleMuted}}>
        {locale==='tr'
          ?'Gizlilik onayı ve son tamamlama adımı henüz etkin değil. Kaydedip daha sonra devam edebilirsin.'
          :'Privacy consent and final completion are not enabled yet. Save and continue later.'}
      </Text>
    </View>}
    {state==='ready'&&stage==='complete'&&<Text
      testID="folio-onboarding-stage-complete"
      style={{fontSize:14,lineHeight:21,color:colors.ink}}>
      {locale==='tr'
        ?'Sunucuda önceki onboarding tamamlandı durumu bulundu. Gizlilik onayı bu ekran tarafından doğrulanmaz.'
        :'The server has a previously completed onboarding state. Privacy consent is not verified by this screen.'}
    </Text>}
  </View>;
}
