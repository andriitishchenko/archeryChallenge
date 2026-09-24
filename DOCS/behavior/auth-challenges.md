# Authentication, profile, and challenge behavior

## FEAT-AUTH-001 — Guest and registered account sessions

- Status: Implemented
- Scope: `backend/routers/auth.py`, `backend/core/security.py`, `backend/routers/profile.py`, and frontend auth/session restoration.
- Goal / acceptance: Guests can start gameplay; registered users can create an account, sign in, refresh a session, and restore their profile.
- Expected behavior and invariants: Guest data is retained when upgraded using `existing_user_id`; tokens are validated server-side; protected profile/match behavior requires authentication and profile setup where applicable.
- Enforcement and current behavior: `POST /api/guest` → creates a guest and returns access/refresh JWTs → gameplay can begin without registration. Register with `existing_user_id` → upgrades the guest row → existing guest data remains attached. Login/refresh → issues a token pair → invalid credentials or refresh tokens are rejected. Browser restore → validates `/api/auth/me`, reloads profile/matches, and opens the user socket → invalid sessions are cleared and return to entry.
- Regression coverage: No automated test suite is committed; verify API behavior and browser session restoration when changing this flow.
- Remaining limits: Automated regression coverage is absent.

## FEAT-AUTH-002 — Password recovery and authentication throttling

- Status: Implemented
- Scope: Auth routes, password reset persistence/email service, and auth forms.
- Goal / acceptance: Users can reset a password with a one-time expiring link without disclosing whether an email is registered.
- Expected behavior and invariants: Store only a hashed reset token; reject invalid, expired, or reused tokens; never send passwords by email; rate-limit repeated auth attempts.
- Enforcement and current behavior: Reset request → creates a hashed one-time token and sends an expiring SMTP link → unknown addresses receive a generic response. Valid reset submission → consumes the token and changes the password → invalid, expired, and reused links are rejected. Repeated register/login attempts → sliding-window IP limit applies → excess requests receive HTTP 429.
- Regression coverage: No automated test suite is committed; verify reset token lifecycle and HTTP 429 behavior with targeted API checks.
- Remaining limits: SMTP delivery requires deployment configuration; no automated coverage is committed.

## FEAT-PROFILE-001 — Profile setup and unfinished-match leave guard

- Status: Implemented
- Scope: `backend/routers/profile.py`, frontend settings/session/navigation.
- Goal / acceptance: An authenticated user can create/update a profile; navigation away from an unfinished match requests confirmation.
- Expected behavior and invariants: Challenge creation/join remains blocked until a profile exists. Cancelling the native leave confirmation retains the active match and SPA history guard.
- Enforcement and current behavior: `PUT /api/profile` → creates or updates the authenticated profile → challenge creation/join remain blocked until a profile exists. Reload/close or browser/device Back during an unfinished match → requests leave confirmation → cancelling keeps the match available; no active match means no guard.
- Regression coverage: No automated test suite is committed; profile validation and browser navigation require targeted API/UI verification.
- Remaining limits: Browser leave prompts vary by browser and have not been verified end-to-end here.

## FEAT-CHALLENGE-001 — Challenge discovery, creation, joining, and expiry

- Status: Implemented
- Scope: Challenge routes/services, expiry worker, and challenge screens.
- Goal / acceptance: Players can find and create public/private challenges and eligible opponents can join them.
- Expected behavior and invariants: Public feeds exclude a user's own challenges and honor profile, bow, distance, and country filters. Private challenges stay out of the public feed and resolve from their invite link. A challenge cannot be joined by its creator or after expiry. Joining creates an active match and deactivates live/scheduled challenges.
- Enforcement and current behavior: Public list → returns eligible active public challenges with filters → own challenges are excluded. New-challenge form → selects defaults from bow profile → Compound uses total/15 arrows and Recurve uses Set System/3 arrows per set. Public creation → persists challenge and broadcasts `new_challenge`; private creation → persists without public broadcast and offers an invite link. Invite-link lookup → returns the identified challenge without authentication → joining still requires an authenticated profile. Join → creates match and sends `opponent_joined`; live/scheduled challenges are deactivated and removed from the public feed → own/expired joins are rejected. Deadline passes without a match → expiry worker deactivates challenge and sends `challenge_expired` → private/public notification behavior remains distinct.
- Regression coverage: No automated test suite is committed; verify filtered API responses, join authorization/state changes, and expiry notifications.
- Remaining limits: Scheduled-match deadline validation exists, but joining starts a match immediately.

## FEAT-CHALLENGE-002 — Open-match limit and challenge deletion

- Status: Implemented
- Scope: Challenge and rematch routes/services.
- Goal / acceptance: Prevent a user from accumulating too many open parent matches and prevent deleting a challenge after play begins.
- Expected behavior and invariants: At most 10 unfinished parent matches per participant; tiebreak child matches do not use another slot. Only a challenge creator can delete it, and an active match with both participants prevents deletion.
- Enforcement and current behavior: Join or propose/accept rematch → server counts unfinished parent matches → returns HTTP 409 at 10 per user; tiebreak child does not consume another slot. Creator deletes challenge → detaches existing matches and removes the challenge → an in-progress match with both participants prevents deletion; public removal is broadcast as `challenge_removed`.
- Regression coverage: No automated test suite is committed; verify 409 boundary and deletion constraints through API checks.
- Remaining limits: Automated regression coverage is absent.
