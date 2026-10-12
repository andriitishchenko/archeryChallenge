# Authentication, profile, and challenge behavior

## FEAT-AUTH-001 — Guest and registered account sessions

- Status: Implemented
- Scope: `backend/routers/auth.py`, `backend/core/security.py`, `backend/routers/profile.py`, and frontend auth/session restoration.
- Goal / acceptance: Guests can start gameplay; registered users can create an account, sign in, refresh a session, and restore their profile.
- Expected behavior and invariants: Guest data is retained only when the caller presents that guest's access token and matching `existing_user_id`; a registered account cannot be replaced through the guest-upgrade path. Protected HTTP and WebSocket behavior accepts access tokens, while refresh tokens are accepted only by the refresh endpoint. Protected profile/match behavior requires authentication and profile setup where applicable.
- Enforcement and current behavior: `POST /api/guest` → creates a guest and returns access/refresh JWTs → gameplay can begin without registration. Register with a matching guest access token and `existing_user_id` → upgrades that guest row → existing guest data remains attached; missing/mismatched identity and registered accounts are rejected. Protected HTTP/WebSocket requests accept access-token claims only; refresh → issues a new token pair from a refresh token. Browser restore → validates `/api/auth/me`, reloads profile/matches, and opens the user socket → invalid sessions are cleared and return to entry.
- Regression coverage: `backend/tests/test_auth_security.py` verifies access-versus-refresh token use, guest upgrade identity, and account ownership. `frontend/tests/auth-registration.test.js` verifies that the client sends the guest identity with its access token and omits local-only IDs.
- Remaining limits: HTTP middleware wiring, WebSocket rejection, and browser session restoration are not covered by automated tests.

## FEAT-AUTH-002 — Password recovery and authentication throttling

- Status: Implemented
- Scope: Auth routes, password reset persistence/email service, and auth forms.
- Goal / acceptance: Users can reset a password with a one-time expiring link without disclosing whether an email is registered.
- Expected behavior and invariants: Store only a hashed reset token; reject invalid, expired, or reused tokens; never send passwords by email; rate-limit repeated auth attempts. Reset tokens travel in the URL fragment and are removed from the browser address after the reset form opens so web servers and referrer headers do not receive them.
- Enforcement and current behavior: Reset request → creates a hashed one-time token and sends an expiring SMTP link with the token in the URL fragment → unknown addresses receive a generic response. The reset form reads the fragment then removes it from browser history. Valid reset submission → consumes the token and changes the password → invalid, expired, and reused links are rejected. Register/login/reset/guest creation → uses a bounded, locked sliding-window client-IP bucket that ignores caller-supplied forwarding headers → excess requests receive HTTP 429.
- Regression coverage: `backend/tests/test_auth_recovery.py` verifies hashed one-time tokens, fragment-only links, expiration, prior-token invalidation, password replacement, and generic unknown-address responses. `frontend/tests/password-reset-link.test.js` verifies fragment parsing and immediate address cleanup. `backend/tests/test_production_guards.py` verifies forwarded-header spoofing does not bypass the IP bucket, guest attempts use a separate bucket, and storage remains bounded. API integration behavior still needs deployment-level verification.
- Remaining limits: SMTP delivery requires deployment configuration; browser form and HTTP rate-limit behavior are not covered by automated tests.

## FEAT-PROFILE-001 — Profile setup and unfinished-match leave guard

- Status: Implemented
- Scope: `backend/routers/profile.py`, frontend settings/session/navigation.
- Goal / acceptance: An authenticated user can create/update a profile; navigation away from an unfinished match requests confirmation.
- Expected behavior and invariants: Challenge creation/join remains blocked until a profile exists. Cancelling the native leave confirmation retains the active match and SPA history guard.
- Enforcement and current behavior: `PUT /api/profile` → creates or updates the authenticated profile → challenge creation/join remain blocked until a profile exists. Reload/close or browser/device Back during an unfinished match → requests leave confirmation → cancelling keeps the match available; no active match means no guard.
- Regression coverage: No automated tests cover profile API validation or browser navigation; verify those through targeted API/UI checks.
- Remaining limits: Browser leave prompts vary by browser and have not been verified end-to-end here.

## FEAT-CHALLENGE-001 — Challenge discovery, creation, joining, and expiry

- Status: Implemented
- Scope: Challenge routes/services, expiry worker, and challenge screens.
- Goal / acceptance: Players can find and create public/private challenges and eligible opponents can join them.
- Expected behavior and invariants: Public feeds exclude a user's own challenges and honor profile, bow, distance, and country filters. Private challenges stay out of the public feed and resolve from their invite link. A challenge cannot be joined by its creator or after expiry. Joining creates an active match and deactivates live/scheduled challenges.
- Enforcement and current behavior: Public list → returns eligible active public challenges with filters → own challenges are excluded. New-challenge form → selects defaults from bow profile → Compound uses total/15 arrows and Recurve uses Set System/3 arrows per set. Public creation → persists challenge and broadcasts `new_challenge`; private creation → persists without public broadcast and offers an invite link. Invite-link lookup → returns the identified challenge without authentication → joining still requires an authenticated profile. Join → creates match and sends `opponent_joined`; live/scheduled challenges are deactivated and removed from the public feed → own/expired joins are rejected. Deadline passes without a match → expiry worker deactivates challenge and sends `challenge_expired` → private/public notification behavior remains distinct.
- Regression coverage: Match-capacity boundary behavior is covered by `backend/tests/test_match_scoring.py`; filtered API responses, join authorization/state changes, and expiry notifications still require targeted API checks.
- Remaining limits: Scheduled-match deadline validation exists, but joining starts a match immediately.

## FEAT-CHALLENGE-002 — Open-match limit and challenge deletion

- Status: Implemented
- Scope: Challenge and rematch routes/services.
- Goal / acceptance: Prevent a user from accumulating too many open parent matches and prevent deleting a challenge after play begins.
- Expected behavior and invariants: At most 10 unfinished parent matches per participant; tiebreak child matches do not use another slot. Only a challenge creator can delete it, and an active match with both participants prevents deletion.
- Enforcement and current behavior: Join or propose/accept rematch → server counts unfinished parent matches → returns HTTP 409 at 10 per user; tiebreak child does not consume another slot. Creator deletes challenge → detaches existing matches and removes the challenge → an in-progress match with both participants prevents deletion; public removal is broadcast as `challenge_removed`.
- Regression coverage: The 10-open-parent-match boundary and tiebreak-child exclusion are covered by `backend/tests/test_match_scoring.py`; deletion authorization and active-match constraints still require API checks.
- Remaining limits: Challenge list, join, expiry, and deletion routes do not have automated API coverage.
