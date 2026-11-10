# Rota - Mobile UX Testing (Android)

This document outlines the manual testing checklist for the UI and UX refinements on Android physical devices (e.g., Samsung).

## 1. Authentication & Account Management
- [ ] **Registration**: Verify that creating an account works and correctly navigates to the Shifts dashboard. Keyboard should not hide the inputs.
- [ ] **Login**: Verify that logging in works. Keyboard avoids inputs.
- [ ] **Logout**: Go to Settings, tap "Sign Out". Verify a confirmation prompt appears. Confirm, and verify the app correctly returns to the login screen without preserving session data.
- [ ] **Session Persistence**: Force-close the app and reopen. Ensure you are still logged in and the active team is preserved.

## 2. Team Management
- [ ] **Create Team**: Create a new team. Verify keyboard behavior. Upon creation, the app should automatically select the new team and navigate to the dashboard.
- [ ] **Switch Teams**: Navigate to Settings -> Switch Teams, and verify tapping a team correctly switches your context in the `TeamContext`.
- [ ] **Team Members**: Ensure the member list accurately displays names and roles.
- [ ] **Invite Member**: Enter an email and assign a role. Verify the invitation token appears in a highlighted card below.
- [ ] **Accept Invitation**: Paste an invitation token. Verify you successfully join the team and are navigated to the dashboard.

## 3. Shift Dashboard
- [ ] **Shift List**: Verify that active shifts have a green badge, and past/other shifts have a grey badge.
- [ ] **Header**: Verify the header uses human-readable titles (e.g., "Shifts", "Settings") instead of raw file names.

## 4. Shift Creation
- [ ] **Form usability**: Open the "Create Shift" form. Ensure the keyboard does not hide the fields.
- [ ] **Date & Time Picker**: Tap the Date/Time fields. Verify that Android native pickers appear (first Date, then Time).
- [ ] **Assign Staff**: Tap a member to assign them to the shift. Ensure their name highlights indicating selection.
- [ ] **Submission**: Create the shift and verify it appears in the list.

## 5. Shift Details
- [ ] **Information**: Open a shift. Verify the start and end times display clearly.
- [ ] **Swap Request**: As a staff member, tap "Request Swap", select an offered member, enter a reason, and submit.
- [ ] **Assignments**: As a manager, tap "Assign Staff", pick from the list, and confirm assignment updates.

## 6. General UX
- [ ] **Safe Area**: Ensure headers and footers are not obscured by device notches or navigation bars.
- [ ] **Buttons & Inputs**: Verify the new rounded design system applies globally to inputs, buttons, and cards.


## Graduation Phase 2 verification — not yet executed on a device

Use an isolated test backend with mocked financial/mail/push providers. The
following are manual acceptance checks, not passing claims from compilation or
Jest. Existing demo recording/post completion is unchanged.

- [ ] Owner shares/copies an invitation link. On a fresh installed app, open it,
      register using its prefilled email, redeem and land in the invited team.
- [ ] Repeat through login/magic link; restart between link intake and login.
- [ ] Wrong email, malformed link, expired and already-used codes show actionable
      feedback. A post-redemption connection failure retries team selection
      without another redemption.
- [ ] Staff requests a swap under slow networking: pending appears immediately,
      duplicate taps issue one request, rejection restores the prior UI/error.
      After rejection/cancellation, notification/refetch allows a new request.
- [ ] Load upcoming assigned shifts for two users/teams; force-close, go offline,
      reopen within the read lease, and verify correct rows/team, read-only
      banner and last-updated time. No other user's/team's rows appear.
- [ ] Confirm a successful empty response removes old upcoming rows. Log out or
      revoke membership online, then relaunch offline and verify purged data.
- [ ] Activity shows initial loading, empty, error/retry, next-page spinner/retry,
      and end message; fast scrolling does not duplicate requests. Pull refresh
      preserves rows until the new response arrives.
- [ ] On two devices, change settings and foreground the other: returned server
      timestamps and values sync. A rejected save rolls back the original value.
- [ ] Owner and Manager create, edit title/notes/start/end, assign/unassign,
      cancel/reopen and delete shifts. Date navigation works across month ends.
      Staff and outsiders remain denied by the server.
