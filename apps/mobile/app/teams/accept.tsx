import { useEffect, useRef, useState } from 'react';
import { Text, Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { apiClient } from '../../src/api/client';
import { dataOrThrow, ApiError } from '../../src/api/ensure';
import { authStorage } from '../../src/storage/authStorage';
import { invitationFromParams, readInvitation, saveInvitation, clearInvitation, redeemAndSelect } from '../../src/services/invitationLinks';
import { useAuth } from '../../src/context/AuthContext';
import { useTeam } from '../../src/context/TeamContext';
import { Screen } from '../../src/components/ui/Screen';
import { Input } from '../../src/components/ui/Input';
import { Button } from '../../src/components/ui/Button';
export default function AcceptInvitationScreen() {
  const params = useLocalSearchParams<{ code?: string; email?: string; expiresAt?: string }>();
  const { user, readOnlySession } = useAuth(), { refreshTeams, selectTeam } = useTeam();
  const [ready, setReady] = useState(false);
  const [code, setCode] = useState(''), [email, setEmail] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const claimed = useRef(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      const linked = params.code !== undefined ? invitationFromParams(params) : null;
      if (params.code !== undefined && !linked) { if (active) { setMessage('Invalid invitation link. Ask the owner for a new link.'); setReady(true); } return; }
      const saved = await readInvitation(authStorage);
      const pending = linked && saved?.code === linked.code && saved.expiresAt === linked.expiresAt ? saved : linked ?? saved;
      if (pending) await saveInvitation(authStorage, pending);
      if (active) setReady(true);
      if (active && pending) { setCode(pending.code); setEmail(pending.email ?? ''); if (pending.expiresAt <= Date.now() && !pending.acceptedTeamId) setMessage('This invitation may have expired. Ask the owner for a new link.'); }
    })();
    return () => { active = false; };
  }, [params.code, params.email, params.expiresAt]);
  const continueAuth = async (path: '/(auth)/login' | '/(auth)/register') => {
    const saved = await readInvitation(authStorage);
    const pending = saved?.code === code ? saved : invitationFromParams({ code, email: email || undefined });
    if (!pending) { setMessage('Enter exactly six digits before signing in.'); return; }
    await saveInvitation(authStorage, pending); router.push(path);
  };
  const accept = async () => {
    if (claimed.current) return;
    if (!/^\d{6}$/.test(code)) { setMessage('Enter exactly six digits.'); return; }
    claimed.current = true; setBusy(true); setMessage('');
    try {
      const saved = await readInvitation(authStorage);
      const pending = saved?.code === code ? saved : invitationFromParams({ code })!;
      await saveInvitation(authStorage, pending);
      await redeemAndSelect(authStorage, pending, {
        redeem: async value => dataOrThrow(await apiClient.request<{ teamId: string }>('/invitations/accept', { method: 'POST', body: JSON.stringify({ code: value }) })),
        refresh: refreshTeams, select: selectTeam,
      });
      router.replace('/'); Alert.alert('Joined team', 'Your new team is now selected.');
    } catch (error) {
      if (error instanceof ApiError && ['INVALID_CODE', 'INVALID_TOKEN'].includes(error.code)) { await clearInvitation(authStorage); await refreshTeams().catch(() => {}); setMessage('This invitation is invalid, expired or already used. Check My teams if you already joined; otherwise ask the owner for a new link.'); }
      else if (error instanceof ApiError && error.code === 'FORBIDDEN') setMessage('Sign in with the invited email address, then open this link again.');
      else setMessage(error instanceof Error ? error.message : 'Could not join. Check your connection and retry.');
    } finally { claimed.current = false; setBusy(false); }
  };
  return <Screen>
    <Text>Join a Rota team</Text>
    <Text>{email ? `Invitation for ${email}` : 'Enter the code supplied by your team owner or manager.'}</Text>
    {message ? <Text accessibilityRole="alert">{message}</Text> : null}
    <Input label="Invitation code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} editable={!busy} />
    {!user ? <><Text>Sign in or create an account with the invited email. Your invitation will be kept.</Text><Button title="Sign in" disabled={!ready} onPress={() => { void continueAuth('/(auth)/login'); }} /><Button title="Create account" disabled={!ready} onPress={() => { void continueAuth('/(auth)/register'); }} /></> : <Button title={busy ? 'Joining...' : 'Join team / retry team refresh'} disabled={busy || readOnlySession} onPress={() => { void accept(); }} />}
    {user ? <Button title="My teams" onPress={() => router.push('/teams')} /> : null}
    {readOnlySession && user ? <Text>Reconnect to accept this invitation.</Text> : null}
  </Screen>;
}
