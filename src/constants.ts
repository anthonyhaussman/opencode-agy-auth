// Provider identifier shared between the plugin loader and credential storage.
export const AGY_PROVIDER_ID = 'google-agy';

// Antigravity CLI (Daily) constant definitions.
export const AGY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
export const AGY_CLIENT_SECRET = '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';
export const AGY_SCOPES: readonly string[] = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
];
export const AGY_REDIRECT_URI = 'https://antigravity.google/oauth-callback';
export const AGY_CODE_ASSIST_ENDPOINT = process.env.OPENCODE_AGY_ENDPOINT || 'https://daily-cloudcode-pa.googleapis.com';
export const AGY_GENERATIVE_LANGUAGE_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
