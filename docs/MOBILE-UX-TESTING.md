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
