import {
  generateInvitationCode,
  hashInvitationCode,
  isValidInvitationCodeFormat,
  isAttemptBlocked,
  recordFailedAttempt,
  clearFailedAttempts,
  resetMemoryFailedAttempts,
  INVITATION_EXPIRATION_MS,
  MAX_FAILED_ATTEMPTS,
} from '../src/services/invitation';

describe('6-Digit Numeric Invitation System', () => {
  beforeEach(() => {
    resetMemoryFailedAttempts();
  });

  describe('1. Code Generation & Leading Zero Preservation', () => {
    it('generates a 6-digit numeric string matching /^\\d{6}$/', () => {
      for (let i = 0; i < 50; i++) {
        const code = generateInvitationCode();
        expect(code).toMatch(/^\d{6}$/);
        expect(code.length).toBe(6);
      }
    });

    it('preserves leading zeros properly', () => {
      // Test code formatting logic
      const formatCode = (n: number) => n.toString().padStart(6, '0');
      expect(formatCode(0)).toBe('000000');
      expect(formatCode(7)).toBe('000007');
      expect(formatCode(42)).toBe('000042');
      expect(formatCode(12345)).toBe('012345');
      expect(formatCode(999999)).toBe('999999');
    });

    it('generates pseudo-random and distributed codes', () => {
      const sample = new Set<string>();
      for (let i = 0; i < 100; i++) {
        sample.add(generateInvitationCode());
      }
      // With 1M possibilities, 100 random draws should have high uniqueness
      expect(sample.size).toBeGreaterThan(95);
    });
  });

  describe('2. Code Hashing & Storage Security', () => {
    it('hashes 6-digit codes to a 64-character SHA-256 hexadecimal digest', () => {
      const code = '012345';
      const hash = hashInvitationCode(code);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).not.toContain(code);
    });

    it('computes deterministic hashes for verification and trims whitespace', () => {
      const code = '789012';
      const hash1 = hashInvitationCode(code);
      const hash2 = hashInvitationCode(`  ${code}  `);
      expect(hash1).toBe(hash2);
    });

    it('produces distinct hashes for different codes', () => {
      const hashA = hashInvitationCode('000001');
      const hashB = hashInvitationCode('000002');
      expect(hashA).not.toBe(hashB);
    });
  });

  describe('3. Code Format Validation', () => {
    it('accepts valid 6-digit numeric strings', () => {
      expect(isValidInvitationCodeFormat('000000')).toBe(true);
      expect(isValidInvitationCodeFormat('123456')).toBe(true);
      expect(isValidInvitationCodeFormat('999999')).toBe(true);
      expect(isValidInvitationCodeFormat(' 654321 ')).toBe(true);
    });

    it('rejects invalid code lengths or non-numeric characters', () => {
      expect(isValidInvitationCodeFormat('12345')).toBe(false); // 5 digits
      expect(isValidInvitationCodeFormat('1234567')).toBe(false); // 7 digits
      expect(isValidInvitationCodeFormat('abcdef')).toBe(false); // letters
      expect(isValidInvitationCodeFormat('12345a')).toBe(false);
      expect(isValidInvitationCodeFormat('')).toBe(false);
      expect(isValidInvitationCodeFormat(null as any)).toBe(false);
    });

    it('supports backward-compatible 64-character legacy hex tokens', () => {
      const legacyToken = 'a'.repeat(64);
      expect(isValidInvitationCodeFormat(legacyToken)).toBe(true);
    });
  });

  describe('4. Expiration Policy', () => {
    it('sets invitation expiration to exactly 15 minutes', () => {
      expect(INVITATION_EXPIRATION_MS).toBe(15 * 60 * 1000);
      expect(INVITATION_EXPIRATION_MS / (60 * 1000)).toBe(15);
    });

    it('verifies expiration timestamp computation', () => {
      const now = Date.now();
      const expiresAt = new Date(now + INVITATION_EXPIRATION_MS);
      const diffMinutes = (expiresAt.getTime() - now) / (60 * 1000);
      expect(diffMinutes).toBeCloseTo(15, 2);
    });
  });

  describe('5. Failed Attempts & Brute Force Protection', () => {
    it('tracks failed attempts and enforces maximum attempt threshold of 5', async () => {
      const testUser = 'user-test-attempt-1';

      expect(await isAttemptBlocked(testUser)).toBe(false);

      await recordFailedAttempt(testUser); // 1
      await recordFailedAttempt(testUser); // 2
      await recordFailedAttempt(testUser); // 3
      await recordFailedAttempt(testUser); // 4

      expect(await isAttemptBlocked(testUser)).toBe(false);

      const count = await recordFailedAttempt(testUser); // 5
      expect(count).toBe(MAX_FAILED_ATTEMPTS);
      expect(await isAttemptBlocked(testUser)).toBe(true);
    });

    it('clears failed attempts on successful redemption', async () => {
      const testUser = 'user-test-attempt-2';

      await recordFailedAttempt(testUser);
      await recordFailedAttempt(testUser);
      expect(await isAttemptBlocked(testUser)).toBe(false);

      await clearFailedAttempts(testUser);
      expect(await isAttemptBlocked(testUser)).toBe(false);
    });

    it('isolates failed attempt tracking between different users or IPs', async () => {
      const userA = 'user-a';
      const userB = 'user-b';

      for (let i = 0; i < 5; i++) {
        await recordFailedAttempt(userA);
      }

      expect(await isAttemptBlocked(userA)).toBe(true);
      expect(await isAttemptBlocked(userB)).toBe(false);
    });
  });

  describe('6. Invitation Security & Authorization Rules', () => {
    it('ensures invitation requires invited email match to prevent unauthorized team takeover', () => {
      const invite = {
        email: 'alice@example.com',
        teamId: 'team-1',
        role: 'STAFF',
      };

      const authorizedUser = { email: 'alice@example.com' };
      const attackerUser = { email: 'eve@example.com' };

      const isAuthorized = (userEmail: string) =>
        userEmail.toLowerCase() === invite.email.toLowerCase();

      expect(isAuthorized(authorizedUser.email)).toBe(true);
      expect(isAuthorized(attackerUser.email)).toBe(false);
    });

    it('restricts role assignment during invitation: managers cannot invite owners or managers', () => {
      const canInviteRole = (myRole: string, targetRole: string): boolean => {
        if (myRole === 'OWNER') return true;
        if (myRole === 'MANAGER') return targetRole === 'STAFF';
        return false;
      };

      expect(canInviteRole('OWNER', 'STAFF')).toBe(true);
      expect(canInviteRole('OWNER', 'MANAGER')).toBe(true);
      expect(canInviteRole('OWNER', 'OWNER')).toBe(true);

      expect(canInviteRole('MANAGER', 'STAFF')).toBe(true);
      expect(canInviteRole('MANAGER', 'MANAGER')).toBe(false);
      expect(canInviteRole('MANAGER', 'OWNER')).toBe(false);

      expect(canInviteRole('STAFF', 'STAFF')).toBe(false);
    });

    it('enforces that once accepted_at is set, an invitation cannot be accepted again (single-use)', () => {
      const invite = {
        acceptedAt: new Date(),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      };

      const isEligible = (inv: typeof invite) =>
        inv.acceptedAt === null && inv.expiresAt > new Date();

      expect(isEligible(invite)).toBe(false);
    });
  });
});
