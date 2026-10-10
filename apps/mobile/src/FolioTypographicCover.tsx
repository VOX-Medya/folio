import {Text,View} from 'react-native';
import {layoutFolioCover} from '@folio/ui-tokens';
import type {FolioCoverInput} from '@folio/ui-tokens';

/** Platform-native typography only: no WebView, remote images or extra package.
 * A caller MUST first verify catalog/owner/territory rights. This component
 * never loads, stores or publishes a book, and cannot grant access. */
export function FolioTypographicCover({
  cover,width=160,
}:{
  cover:FolioCoverInput;
  width?:number;
}){
  if(!Number.isFinite(width)||width<72||width>640){
    throw new RangeError('Folio cover width must be between 72 and 640 points');
  }
  const plan=layoutFolioCover(cover);
  const scale=width/plan.width;
  const s=(px:number)=>px*scale;
  const typeBase={
    fontFamily:'Georgia',color:plan.ink,
    includeFontPadding:false as const,
  };
  return <View testID="folio-native-cover" accessible
    accessibilityRole="image" accessibilityLabel={plan.accessibleLabel}
    style={{width,height:s(plan.height),overflow:'hidden',
      backgroundColor:plan.background,position:'relative'}}>
    <View style={{position:'absolute',left:s(15),top:s(22),
      width:s(3),height:s(436),backgroundColor:plan.accent}}/>
    <Text accessible={false} numberOfLines={1} allowFontScaling={false}
      style={{position:'absolute',left:s(30),top:s(40),
        fontFamily:'Georgia',fontSize:s(13),fontWeight:'700',
        letterSpacing:s(4),color:plan.accent,
        includeFontPadding:false}}>FOLIO</Text>
    <View style={{position:'absolute',left:s(30),top:s(83),
      width:s(260),height:s(1),backgroundColor:plan.accent}}/>
    {plan.titleLines.map((line,index)=><Text key={'title-'+index}
      testID={'folio-native-cover-title-'+index}
      accessible={false} numberOfLines={1} allowFontScaling={false}
      adjustsFontSizeToFit minimumFontScale={0.5}
      style={{...typeBase,position:'absolute',left:s(30),width:s(260),
        top:s(plan.titleStartY+index*plan.titleLineHeight-plan.titleFontSize),
        fontSize:s(plan.titleFontSize),lineHeight:s(plan.titleLineHeight)}}>
      {line}</Text>)}
    {plan.authorLines.map((line,index)=><Text key={'author-'+index}
      accessible={false} numberOfLines={1} allowFontScaling={false}
      adjustsFontSizeToFit minimumFontScale={0.5}
      style={{...typeBase,position:'absolute',left:s(30),width:s(260),
        top:s(plan.authorStartY+index*23-16),
        fontSize:s(16),lineHeight:s(23)}}>
      {line}</Text>)}
    <View style={{position:'absolute',left:s(30),top:s(427),
      width:s(260),height:s(1),backgroundColor:plan.accent}}/>
    <Text accessible={false} numberOfLines={1} allowFontScaling={false}
      adjustsFontSizeToFit minimumFontScale={0.5}
      style={{position:'absolute',left:s(30),top:s(437),
        width:s(260),fontFamily:'Georgia',fontSize:s(12),lineHeight:s(18),
        includeFontPadding:false,color:plan.accent}}>
      {plan.footer}</Text>
  </View>;
}
