import {useState} from 'react';
import {Pressable,Text,TextInput,View} from 'react-native';
import {registerWebAccount,verifyWebAccountEmail,WebSessionHttpError} from '@folio/contracts';
import type {FolioLocale} from './shell-data';
import {paperbound} from '@folio/ui-tokens';

type Palette=typeof paperbound.mobile.light|typeof paperbound.mobile.dark;
/** No token in browser storage, links, redirects or analytics. */
export function WebRegistrationPanel({origin,locale,colors}:{
  origin:string;locale:FolioLocale;colors:Palette;
}){
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [code,setCode]=useState('');
  const [phase,setPhase]=useState<'idle'|'busy'|'sent'|'verified'>('idle');
  const [error,setError]=useState('');
  const tr=locale==='tr';
  const copy=(a:string,b:string)=>tr?a:b;
  async function register(){
    if(phase==='busy')return;
    setPhase('busy');setError('');
    try{
      await registerWebAccount({baseUrl:origin},{email,password});
      setPhase('sent');
    }catch(e){
      setPhase('idle');
      setError(e instanceof WebSessionHttpError&&e.status===429
        ?copy('Çok fazla deneme. Daha sonra tekrar dene.','Too many attempts. Try again later.')
        :copy('Kayıt şu anda kullanılamıyor.','Registration is unavailable.'));
    }finally{setPassword('');}
  }
  async function verify(){
    if(phase==='busy')return;
    setPhase('busy');setError('');
    try{
      await verifyWebAccountEmail({baseUrl:origin},{token:code.trim()});
      setPhase('verified');
    }catch(e){
      setPhase('sent');
      setError(e instanceof WebSessionHttpError&&e.status===401
        ?copy('Kod geçersiz veya süresi dolmuş.','Code is invalid or expired.')
        :copy('Doğrulama yapılamadı.','Could not verify your email.'));
    }finally{setCode('');}
  }
  const button=(id:string,title:string,fn:()=>void,disabled:boolean)=>
    <Pressable testID={id} accessibilityRole="button" accessibilityLabel={title}
      disabled={disabled} onPress={fn} style={{minHeight:48,borderRadius:10,
        backgroundColor:colors.accent,justifyContent:'center',alignItems:'center',
        paddingHorizontal:18}}>
      <Text style={{fontWeight:'700',fontSize:15,color:colors.accentOn}}>{title}</Text>
    </Pressable>;
  const inputStyle={minHeight:48,borderWidth:1,borderColor:colors.line,
    borderRadius:10,paddingHorizontal:14,fontSize:16,
    color:colors.ink,backgroundColor:colors.bg} as const;
  return <View testID="folio-register-panel"
    style={{borderWidth:1,borderColor:colors.line,borderRadius:12,padding:14,gap:9}}>
    <Text accessibilityRole="header" style={{color:colors.ink,fontWeight:'700',fontSize:16}}>
      {copy('Hesap oluştur','Create an account')}
    </Text>
    {phase!=='verified'&&<>
      <TextInput testID="folio-register-email"
        accessibilityLabel={copy('Kayıt e-postası','Registration email')}
        autoCapitalize="none" autoCorrect={false} autoComplete="email" keyboardType="email-address"
        value={email} onChangeText={setEmail}
        placeholder={copy('E-posta','Email')} placeholderTextColor={colors.accessibleMuted}
        style={inputStyle}/>
      <TextInput testID="folio-register-password"
        accessibilityLabel={copy('Kayıt parolası','Registration password')}
        autoCapitalize="none" autoCorrect={false} autoComplete="new-password"
        secureTextEntry value={password} onChangeText={setPassword}
        placeholder={copy('En az 12 karakterli parola','Password, at least 12 characters')}
        placeholderTextColor={colors.accessibleMuted} style={inputStyle}/>
      {button('folio-register-submit',copy('Doğrulama kodu gönder','Send verification code'),
        ()=>{void register();},phase==='busy'||!email.trim()||password.length<12)}
    </>}
    {phase==='sent'&&<Text testID="folio-register-sent" style={{color:colors.ink}}>
      {copy('Adres kayıt için uygunsa e-postana 15 dakikalık kod gönderildi. Gelen kutunu kontrol et.',
        'If eligible, a 15-minute code was sent to your email. Check your inbox.')}
    </Text>}
    {phase!=='verified'&&<TextInput testID="folio-verify-email-code"
      accessibilityLabel={copy('E-posta doğrulama kodu','Email verification code')}
      autoCapitalize="none" autoCorrect={false} value={code} onChangeText={setCode}
      placeholder={copy('E-postadaki doğrulama kodu','Verification code from email')}
      placeholderTextColor={colors.accessibleMuted} maxLength={43} style={inputStyle}/>}
    {phase!=='verified'&&button('folio-verify-email-submit',copy('E-postayı doğrula','Verify email'),
      ()=>{void verify();},phase==='busy'||code.trim().length!==43)}
    {phase==='verified'&&<Text testID="folio-register-verified" style={{color:colors.ink}}>
      {copy('E-posta doğrulandı. Şimdi yukarıdan giriş yap.',
        'Email verified. You can now sign in above.')}
    </Text>}
    {!!error&&<Text testID="folio-register-error" accessibilityRole="alert"
      style={{color:colors.ink}}>{error}</Text>}
  </View>;
}
