import { Text, View, useColorScheme } from 'react-native';
import { paperbound, typography } from '@folio/ui-tokens';

export default function Home() {
  const colorScheme = useColorScheme();
  const colors = colorScheme === 'dark' ? paperbound.mobile.dark : paperbound.mobile.light;
  return (
    <View style={{flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg}}>
      <Text style={{fontSize: typography.sizes.xxl, color: colors.ink, fontFamily: typography.heading}}>Folio</Text>
      <Text style={{color: colors.ink}}>Okuyucu henüz geliştirme aşamasında.</Text>
    </View>
  );
}
