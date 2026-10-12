import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Alert,
  Keyboard,
  Platform,
  ScrollView,
  TextInput,
  Dimensions,
  LayoutChangeEvent,
  NativeSyntheticEvent,
  NativeScrollEvent,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { apiClient } from '../../src/api/client';
import { useAuth } from '../../src/context/AuthContext';
import { AuthResponse } from '@rota/shared';
import { Input } from '../../src/components/ui/Input';
import { Button } from '../../src/components/ui/Button';
import { typography, spacing, colors } from '../../src/components/ui/theme';

export default function RegisterScreen() {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();

  // Native input & scroll references
  const scrollViewRef = useRef<ScrollView>(null);
  const firstNameRef = useRef<TextInput>(null);
  const lastNameRef = useRef<TextInput>(null);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  // Layout & coordinate trackers
  const scrollOffsetRef = useRef<number>(0);
  const keyboardHeightRef = useRef<number>(0);
  const keyboardTopRef = useRef<number>(0);
  const initialViewportHeight = useRef<number>(0);
  const contentHeightRef = useRef<number>(0);
  const focusedInputRef = useRef<'firstName' | 'lastName' | 'email' | 'password' | null>(null);

  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // Check if native Android window resizing occurred
  // If native window resized, initialViewportHeight - currentViewportHeight ≈ keyboardHeight
  const didNativeResize =
    initialViewportHeight.current > 0 &&
    keyboardHeight > 0 &&
    initialViewportHeight.current - viewportHeight > keyboardHeight * 0.5;

  // If native resize occurred, we don't apply keyboard height padding again (avoids double spacing)
  // If native resize did NOT occur, we supply keyboard height as bottom padding for full scroll reach
  const avoidanceBottomPadding =
    keyboardHeight > 0 && !didNativeResize
      ? keyboardHeight + spacing.lg
      : spacing.xl;

  const scrollToInput = useCallback((
    inputRef: React.RefObject<TextInput | null>,
    extraOffset = 60
  ) => {
    if (!scrollViewRef.current || !inputRef.current) return;

    inputRef.current.measureInWindow((x, y, width, height) => {
      if (typeof y === 'number' && typeof height === 'number' && height > 0) {
        const windowHeight = Dimensions.get('window').height;
        const kbHeight = keyboardHeightRef.current;
        const kbTop =
          keyboardTopRef.current > 0
            ? keyboardTopRef.current
            : windowHeight - kbHeight;

        const inputBottom = y + height + extraOffset;
        if (kbTop > 0 && inputBottom > kbTop) {
          const overlap = inputBottom - kbTop;
          const targetY = scrollOffsetRef.current + overlap;
          scrollViewRef.current?.scrollTo({ y: Math.max(0, targetY), animated: true });
        }
      }
    });
  }, []);

  const handleFocus = (field: 'firstName' | 'lastName' | 'email' | 'password') => {
    focusedInputRef.current = field;
    if (keyboardHeightRef.current > 0) {
      if (field === 'password') {
        scrollToInput(passwordRef, 60);
      } else if (field === 'email') {
        scrollToInput(emailRef, 40);
      }
    }
  };

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, (e) => {
      const kbH = e.endCoordinates.height;
      const kbY = e.endCoordinates.screenY;
      setKeyboardHeight(kbH);
      keyboardHeightRef.current = kbH;
      keyboardTopRef.current = kbY;

      // When keyboard shows, if password or email is active, bring it above the keyboard
      const currentField = focusedInputRef.current;
      if (currentField === 'password') {
        setTimeout(() => {
          scrollToInput(passwordRef, 60);
        }, 50);
      } else if (currentField === 'email') {
        setTimeout(() => {
          scrollToInput(emailRef, 40);
        }, 50);
      }
    });

    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
      keyboardHeightRef.current = 0;
      keyboardTopRef.current = 0;
      focusedInputRef.current = null;
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [scrollToInput]);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
  };

  const handleScrollViewLayout = (e: LayoutChangeEvent) => {
    const { height } = e.nativeEvent.layout;
    if (initialViewportHeight.current === 0) {
      initialViewportHeight.current = height;
    }
    setViewportHeight(height);
  };

  const handleContentSizeChange = (_w: number, h: number) => {
    contentHeightRef.current = h;
  };

  const handleRegister = async () => {
    if (!firstName || !lastName || !email || !password) {
      return Alert.alert('Error', 'Please fill out all fields');
    }
    setLoading(true);
    const res = await apiClient.request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ firstName, lastName, email, password }),
    });
    setLoading(false);

    if (res.success && res.data) {
      await login(res.data);
      router.replace('/');
    } else {
      Alert.alert('Registration failed', res.error?.message || 'Unknown error');
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.keyboardContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          ref={scrollViewRef}
          style={styles.scrollView}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: avoidanceBottomPadding },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="none"
          showsVerticalScrollIndicator={false}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          onLayout={handleScrollViewLayout}
          onContentSizeChange={handleContentSizeChange}
        >
          <View style={styles.header}>
            <Text style={typography.h1}>Create Account</Text>
            <Text style={[typography.body, { marginTop: spacing.sm }]}>Join Rota today</Text>
          </View>

          <View style={styles.form}>
            <Input
              ref={firstNameRef}
              label="First Name"
              placeholder="First Name"
              value={firstName}
              onChangeText={setFirstName}
              editable={!loading}
              returnKeyType="next"
              onSubmitEditing={() => lastNameRef.current?.focus()}
              onFocus={() => handleFocus('firstName')}
            />
            <Input
              ref={lastNameRef}
              label="Last Name"
              placeholder="Last Name"
              value={lastName}
              onChangeText={setLastName}
              editable={!loading}
              returnKeyType="next"
              onSubmitEditing={() => emailRef.current?.focus()}
              onFocus={() => handleFocus('lastName')}
            />
            <Input
              ref={emailRef}
              label="Email Address"
              placeholder="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              editable={!loading}
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              onFocus={() => handleFocus('email')}
            />
            <Input
              ref={passwordRef}
              label="Password"
              placeholder="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              editable={!loading}
              returnKeyType="done"
              onSubmitEditing={handleRegister}
              onFocus={() => handleFocus('password')}
            />
            <Button
              title={loading ? 'Registering...' : 'Register'}
              onPress={handleRegister}
              loading={loading}
              style={styles.button}
            />
          </View>

          <View style={styles.footer}>
            <Text style={typography.bodySmall}>Already have an account?</Text>
            <Button
              title="Log In"
              variant="ghost"
              onPress={() => router.back()}
              disabled={loading}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  keyboardContainer: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    padding: spacing.xl,
    paddingTop: spacing.xxl,
  },
  header: {
    marginBottom: spacing.xl,
  },
  form: {
    width: '100%',
  },
  button: {
    marginTop: spacing.md,
  },
  footer: {
    marginTop: spacing.xl,
    alignItems: 'center',
    paddingBottom: spacing.xl,
  },
});
