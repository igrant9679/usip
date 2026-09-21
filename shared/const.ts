export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';
/**
 * Workspace-wide `enforce2fa` refused this request. 10003 and not 10002: the
 * client keys the full-screen enrolment interstitial off this exact string,
 * and reusing the NOT_ADMIN code would have shown it to anyone lacking a role.
 */
export const MFA_REQUIRED_ERR_MSG = 'Two-factor authentication is required (10003)';
