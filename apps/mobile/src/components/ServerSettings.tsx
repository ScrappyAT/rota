import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Switch, Text, View } from 'react-native';
import { SettingsPatchSchema } from '@rota/shared';
import { useSettings } from '../context/SettingsContext';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { typography, spacing } from './ui/theme';
export function ServerSettings() {
  const { state, controller } = useSettings();
  const settings = state.settings;
  const [timeZone, setTimeZone] = useState('UTC'), [start, setStart] = useState('22:00'), [end, setEnd] = useState('06:00'), [language, setLanguage] = useState('en');
  useEffect(() => {
    if (settings) {
      setTimeZone(settings.timeZone);
      setStart(settings.quietHours.start);
      setEnd(settings.quietHours.end);
      setLanguage(settings.language);
    }
  }, [settings]);
  const save = async (patch: unknown) => {
    const parsed = SettingsPatchSchema.safeParse(patch);
    if (!parsed.success) {
      Alert.alert('Check settings', parsed.error.issues[0].message);
      return;
    }
    try {
      await controller?.update(parsed.data);
    }
    catch {
      Alert.alert('Could not save', 'The change was rolled back. Check your connection and retry.');
    }
  };
  if (!settings)
    return <View>{state.loading ? <ActivityIndicator /> : <Button title="Load settings" onPress={() => { void controller?.refresh(); }} />}{state.error ? <Text>{state.error}</Text> : null}</View>;
  return <View style={{ gap: spacing.sm }}>
    <Text style={typography.label}>SERVER SETTINGS</Text>
    <Text>Changes sync when your other devices open or return to the foreground.</Text>
    {state.error ? <Text accessibilityRole="alert">{state.error}</Text> : null}
    <Text>Quiet hours</Text><Switch value={settings.quietHours.enabled} disabled={state.saving} onValueChange={enabled => { void save({ quietHours: { ...settings.quietHours, enabled } }); }} />
    <Input label="Quiet hours start (HH:mm)" value={start} onChangeText={setStart} editable={!state.saving} />
    <Input label="Quiet hours end (HH:mm)" value={end} onChangeText={setEnd} editable={!state.saving} />
    <Input label="Time zone (for example Africa/Lagos)" value={timeZone} onChangeText={setTimeZone} autoCapitalize="none" editable={!state.saving} />
    <Input label="Language tag (for example en or fr)" value={language} onChangeText={setLanguage} autoCapitalize="none" editable={!state.saving} />
    <Button title={state.saving ? 'Saving...' : 'Save time and language'} disabled={state.saving} onPress={() => { void save({ quietHours: { enabled: settings.quietHours.enabled, start, end }, timeZone, language }); }} />
    {(['shifts', 'swaps', 'billing'] as const).map(key => <View key={key} style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text>{key.charAt(0).toUpperCase() + key.slice(1)} notifications</Text><Switch value={settings.notificationCategories[key]} disabled={state.saving} onValueChange={enabled => { void save({ notificationCategories: { [key]: enabled } }); }} /></View>)}
    {(['shiftAssigned', 'swapRequested', 'swapApproved', 'swapRejected'] as const).map(key => <View key={key} style={{ flexDirection: 'row', justifyContent: 'space-between' }}><Text>{({ shiftAssigned: 'Shift assignments', swapRequested: 'Swap requests', swapApproved: 'Swap approvals', swapRejected: 'Swap rejections' })[key]}</Text><Switch value={settings.notificationTypes[key]} disabled={state.saving} onValueChange={enabled => { void save({ notificationTypes: { [key]: enabled } }); }} /></View>)}
    <Text>Theme: {settings.theme}</Text>
    {(['system', 'light', 'dark'] as const).map(theme => <Button key={theme} title={theme} variant="secondary" disabled={state.saving} onPress={() => { void save({ theme }); }} />)}
    <Text style={typography.bodySmall}>Last saved: {settings.updatedAt}</Text>
  </View>;
}
