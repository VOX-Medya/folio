import {createContext,useContext,useEffect,useState} from 'react';
import type {ReactNode} from 'react';
import {Link} from 'expo-router';
import {
  Platform,Pressable,ScrollView,Text,View,useColorScheme,useWindowDimensions,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {paperbound,responsiveMode,spacing,typography} from '@folio/ui-tokens';
import type {ResponsiveMode} from '@folio/ui-tokens';
import {mobileSections,readingRouteCopy,screenCopy,validReadingRouteId} from './shell-data';
import type {FolioLocale,MobileSection,ReadingRouteKind} from './shell-data';
import {WebSignInPanel} from './web-sign-in';
import {PublishedBookPanel} from './published-book';
import {PublicCatalogSearchPanel} from './public-search';
import {OwnedShelfPanel} from './owned-shelf';

interface Settings {locale:FolioLocale;setLocale:(next:FolioLocale)=>void;}
const SettingsContext=createContext<Settings|undefined>(undefined);
export function MobileShellProvider({children}:{children:ReactNode}){
  const [locale,setLocaleState]=useState<FolioLocale>('tr');
  // Route history may remount Expo Web screens. Persist ONLY this UI preference,
  // never a bearer token, account, book body or reading cursor.
  useEffect(()=>{
    if(Platform.OS!=='web')return;
    try{
      const previous=window.sessionStorage.getItem('folio.ui.locale');
      if(previous==='tr'||previous==='en')setLocaleState(previous);
    }catch{return;} // Private browsing may disable session storage
  },[]);
  const setLocale=(next:FolioLocale)=>{
    setLocaleState(next);
    if(Platform.OS==='web'){
      try{window.sessionStorage.setItem('folio.ui.locale',next);}
      catch{return;}
    }
  };
  return <SettingsContext.Provider value={{locale,setLocale}}>{children}</SettingsContext.Provider>;
}
function useSettings():Settings{
  const settings=useContext(SettingsContext);
  if(!settings)throw new Error('Folio shell language provider is missing');
  return settings;
}

type Palette=typeof paperbound.mobile.light|typeof paperbound.mobile.dark;
function Nav({active,locale,mode,colors}:{active:MobileSection;locale:FolioLocale;
  mode:ResponsiveMode;colors:Palette}){
  const vertical=mode==='desktop';
  return <View testID={mode==='phone'?'folio-bottom-navigation':'folio-responsive-navigation'}
    accessibilityLabel={locale==='tr'?'Folio V1 gezintisi':'Folio V1 navigation'}
    style={{flexDirection:vertical?'column':'row',gap:vertical?5:0,
      backgroundColor:colors.surface,borderColor:colors.line,
      borderTopWidth:mode==='phone'?1:0,borderBottomWidth:mode==='tablet'?1:0,
      paddingVertical:mode==='phone'?6:8,paddingHorizontal:vertical?12:4,
      justifyContent:vertical?'flex-start':'space-around'}}>
    {mobileSections.map(page=>{
      const selected=active===page.id;
      return <Link key={page.id} href={page.href} asChild>
        <Pressable testID={'folio-tab-'+page.id}
          accessibilityRole="link"
          accessibilityLabel={page[locale]}
          accessibilityState={{selected}}
          style={({pressed})=>({
            minHeight:48,minWidth:mode==='phone'?56:vertical?160:86,
            flex:vertical?undefined:1,
            backgroundColor:selected?colors.tint:pressed?colors.surface2:colors.surface,
            borderRadius:12,paddingHorizontal:vertical?12:2,paddingVertical:7,
            alignItems:vertical?'flex-start':'center',justifyContent:'center',
          })}>
          {vertical
            ? <Text style={{fontSize:15,fontWeight:selected?'700':'500',color:colors.ink}}>
                {page.icon+'  '+page[locale]}
              </Text>
            : <View style={{alignItems:'center',gap:3}}>
                <Text style={{fontSize:19,color:colors.ink}}>{page.icon}</Text>
                <Text numberOfLines={1} style={{fontSize:mode==='phone'?10:12,
                  fontWeight:selected?'700':'500',color:colors.ink}}>{page[locale]}</Text>
              </View>}
        </Pressable>
      </Link>;
    })}
  </View>;
}
function Brand({locale,colors}:{locale:FolioLocale;colors:Palette}){
  return <View style={{gap:3}}>
    <Text accessibilityRole="header"
      style={{fontFamily:typography.heading,fontSize:28,fontWeight:'700',
        color:colors.ink}}>Folio</Text>
    <Text style={{fontSize:11,color:colors.accessibleMuted}}>
      {locale==='tr'?'KİTAP · OKUMA · SES':'BOOKS · READING · AUDIO'}
    </Text>
  </View>;
}
function LanguageSwitch({colors}:{colors:Palette}){
  const {locale,setLocale}=useSettings();
  return <View style={{flexDirection:'row',gap:6,alignItems:'center'}}
    accessibilityLabel={locale==='tr'?'Dil seçimi':'Language selection'}>
    {(['tr','en'] as const).map(code=>{
      const active=locale===code;
      return <Pressable key={code} onPress={()=>setLocale(code)}
        accessibilityRole="button"
        accessibilityLabel={code.toUpperCase()}
        accessibilityState={{selected:active}}
        style={{minWidth:44,minHeight:44,alignItems:'center',justifyContent:'center',
          borderRadius:10,borderWidth:1,borderColor:colors.line,
          backgroundColor:active?colors.accent:colors.surface}}>
        <Text style={{fontWeight:'700',color:active?colors.accentOn:colors.ink}}>
          {code.toUpperCase()}</Text>
      </Pressable>;
    })}
  </View>;
}
export function MobileShell({section,route}:{section:MobileSection;route?:{kind:ReadingRouteKind;id:unknown}}){
  const {locale,setLocale}=useSettings();
  const {width}=useWindowDimensions();
  const mode=responsiveMode(Math.max(0,width));
  const scheme=useColorScheme();
  const colors=scheme==='dark'?paperbound.mobile.dark:paperbound.mobile.light;
  const routeScreen=route?readingRouteCopy[route.kind][locale]:null;
  const screen=routeScreen??screenCopy[section][locale];
  const validId=route?validReadingRouteId(route.id):false;
  return <SafeAreaView style={{flex:1,backgroundColor:colors.bg}}>
    <View testID={'folio-layout-'+mode}
      style={{flex:1,flexDirection:mode==='desktop'?'row':'column',
        backgroundColor:colors.bg}}>
      {mode==='desktop'&&<View style={{width:250,backgroundColor:colors.surface,
        borderRightWidth:1,borderColor:colors.line,paddingTop:20}}>
        <View style={{paddingHorizontal:24,paddingBottom:24}}>
          <Brand colors={colors} locale={locale}/>
        </View>
        <Nav active={section} locale={locale} colors={colors} mode={mode}/>
      </View>}
      <View style={{flex:1,minWidth:0}}>
        <View style={{paddingHorizontal:spacing.base,paddingTop:12,paddingBottom:8,
          backgroundColor:colors.surface,
          flexDirection:'row',alignItems:'center',justifyContent:'space-between',
          gap:8,borderBottomWidth:mode==='desktop'?1:0,borderColor:colors.line}}>
          {mode==='desktop'
            ? <Text style={{color:colors.accessibleMuted,fontSize:14}}>
              {locale==='tr'?'Okuma alanı':'Reading workspace'}
            </Text>
            : <Brand colors={colors} locale={locale}/>}
          <LanguageSwitch colors={colors}/>
        </View>
        {mode==='tablet'&&<Nav active={section} locale={locale} colors={colors} mode={mode}/>}
        <ScrollView style={{flex:1,backgroundColor:colors.bg}}
          contentContainerStyle={{flexGrow:1,padding:mode==='phone'?20:32}}>
          <View style={{flex:1,flexDirection:mode==='phone'?'column':'row',
            alignItems:'stretch',gap:mode==='phone'?16:24,maxWidth:1260,width:'100%',
            alignSelf:'center'}}>
            <View style={{flex:1,minWidth:0,backgroundColor:colors.bg,
              justifyContent:'center',gap:16,paddingVertical:24}}>
              <Text accessibilityRole="header"
                style={{fontFamily:typography.heading,fontSize:mode==='phone'?30:38,
                  fontWeight:'700',lineHeight:mode==='phone'?40:48,color:colors.ink}}>
                {screen.heading}
              </Text>
              <View style={{backgroundColor:colors.bg,alignSelf:'stretch',gap:12}}>
                <Text style={{fontSize:16,lineHeight:25,color:colors.ink}}>
                  {route&&!validId?routeScreen?.invalid:screen.message}
                </Text>
                <Text style={{fontSize:14,lineHeight:23,color:colors.accessibleMuted}}>
                  {screen.detail}
                </Text>
              </View>
              {route
                ? <View testID={validId?'folio-'+route.kind+'-route':'folio-invalid-reading-route'}
                    style={{backgroundColor:colors.surface,borderColor:colors.line,
                      borderWidth:1,borderRadius:18,padding:20,gap:14}}>
                  {validId&&route.kind==='book'
                    ? <PublishedBookPanel workId={route.id as string} locale={locale} colors={colors}/>
                    : <Text testID="folio-reading-route-notice"
                        style={{fontSize:15,lineHeight:23,color:colors.accessibleMuted}}>
                      {validId
                        ?locale==='tr'
                          ?'Okuyucu henüz içerik sunucusuna bağlanmadı.'
                          :'The reader is not connected to the content server yet.'
                        :locale==='tr'?'Bağlantı kimliği doğrulanamadı.':'The link identifier is invalid.'}
                    </Text>}
                  <Link href="/catalog" asChild>
                    <Pressable testID="folio-route-return" accessibilityRole="link"
                      accessibilityLabel={routeScreen?.back}
                      style={{minHeight:48,minWidth:150,alignSelf:'flex-start',
                        backgroundColor:colors.accent,borderRadius:10,
                        paddingHorizontal:20,justifyContent:'center',alignItems:'center'}}>
                      <Text style={{fontWeight:'700',fontSize:15,color:colors.accentOn}}>
                        {routeScreen?.back}
                      </Text>
                    </Pressable>
                  </Link>
                </View>
                : section==='profile'
                ? <WebSignInPanel locale={locale} colors={colors} onLocaleSaved={setLocale}/>
                : section==='catalog'
                ? <PublicCatalogSearchPanel locale={locale} colors={colors}/>
                : section==='library'
                ? <OwnedShelfPanel locale={locale} colors={colors}/>
                : <View style={{backgroundColor:colors.surface,borderColor:colors.line,
                    borderWidth:1,borderRadius:18,padding:20,gap:10}}>
                  <Text style={{fontSize:16,fontWeight:'700',color:colors.ink}}>
                    {locale==='tr'?'Oturum doğrulaması bekleniyor':'Authentication pending'}
                  </Text>
                  <Text style={{fontSize:14,lineHeight:21,color:colors.accessibleMuted}}>
                    {locale==='tr'
                      ?'Kişisel raf, özel kitap veya ilerleme verisi giriş doğrulanmadan yüklenmez.'
                      :'Personal shelves, private books and reading progress stay hidden before sign-in.'}
                  </Text>
                </View>}
            </View>
            {mode!=='phone'&&<View style={{width:mode==='desktop'?300:240,
              justifyContent:'center',paddingVertical:16}}>
              <View style={{backgroundColor:colors.surface,borderWidth:1,
                borderColor:colors.line,borderRadius:18,padding:20,gap:12}}>
                <Text style={{fontSize:17,fontWeight:'700',color:colors.ink}}>
                  {locale==='tr'?'Çoklu okuma modu':'Multiple reading modes'}
                </Text>
                <Text style={{fontSize:13,lineHeight:23,color:colors.accessibleMuted}}>
                  {locale==='tr'
                    ?'Normal okuyucu, RSVP ve hazır ses oynatıcı kendi kabul testlerinden sonra açılacak.'
                    :'Reader, RSVP and prepared audio will open after their own acceptance tests.'}
                </Text>
              </View>
            </View>}
          </View>
        </ScrollView>
        {mode==='phone'&&<Nav active={section} locale={locale} colors={colors} mode={mode}/>}
      </View>
    </View>
  </SafeAreaView>;
}
