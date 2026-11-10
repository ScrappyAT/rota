import { useState } from 'react';
import { Alert, Platform, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useMutation } from '@tanstack/react-query';
import { UpdateShiftSchema } from '@rota/shared';
import { Shift, updateShift } from '../api/shifts';
import { useNetwork } from '../context/NetworkContext';
import { Input } from './ui/Input';
import { Button } from './ui/Button';

export function ShiftEditor({ shift, onSaved }: { shift: Shift; onSaved: () => void }) {
  const { isOffline } = useNetwork();
  const [title, setTitle] = useState(shift.title), [description, setDescription] = useState(shift.description ?? '');
  const [start, setStart] = useState(new Date(shift.startsAt)), [end, setEnd] = useState(new Date(shift.endsAt));
  const [picker, setPicker] = useState<'start' | 'end' | null>(null), [mode, setMode] = useState<'date' | 'time'>('date');
  const mutation = useMutation({
    mutationFn: () => {
      if (isOffline) throw new Error('Reconnect before editing shifts');
      const value = UpdateShiftSchema.parse({ title: title.trim(), description: description.trim() || null, startsAt: start.toISOString(), endsAt: end.toISOString() });
      return updateShift(shift.teamId, shift.id, value);
    },
    onSuccess: onSaved,
    onError: error => Alert.alert('Could not save shift', error.message),
  });
  const open = (field: 'start' | 'end', nextMode: 'date' | 'time') => { setMode(nextMode); setPicker(field); };
  return <View style={{ gap: 8 }}>
    <Input label="Shift title" value={title} onChangeText={setTitle} editable={!mutation.isPending && !isOffline} />
    <Input label="Description" value={description} onChangeText={setDescription} multiline editable={!mutation.isPending && !isOffline} />
    <Text>Start: {start.toLocaleString()}</Text>
    <Button title="Change start date" onPress={() => open('start', 'date')} disabled={mutation.isPending || isOffline} />
    <Button title="Change start time" onPress={() => open('start', 'time')} disabled={mutation.isPending || isOffline} />
    <Text>End: {end.toLocaleString()}</Text>
    <Button title="Change end date" onPress={() => open('end', 'date')} disabled={mutation.isPending || isOffline} />
    <Button title="Change end time" onPress={() => open('end', 'time')} disabled={mutation.isPending || isOffline} />
    {picker ? <DateTimePicker value={picker === 'start' ? start : end} mode={mode} onChange={(event, date) => {
      if (date && event.type !== 'dismissed') { if (picker === 'start') setStart(date); else setEnd(date); }
      if (Platform.OS !== 'ios') setPicker(null);
    }} /> : null}
    <Button title={mutation.isPending ? 'Saving shift...' : 'Save shift details'} disabled={isOffline || mutation.isPending || !title.trim() || end <= start} onPress={() => mutation.mutate()} />
  </View>;
}
