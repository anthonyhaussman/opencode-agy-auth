import type { AuthDetails, OAuthAuthDetails, RefreshParts } from './types';

const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;

export function isOAuthAuth(auth: AuthDetails): auth is OAuthAuthDetails {
  return auth.type === 'oauth';
}

/**
 * Splits the packed refresh string into the corresponding refresh token and project ID.
 */
export function parseRefreshParts(refresh: string): RefreshParts {
  const [refreshToken = '', projectId = '', managedProjectId = ''] = (refresh ?? '').split('|');
  return {
    refreshToken,
    projectId: projectId || undefined,
    managedProjectId: managedProjectId || undefined
  };
}

/**
 * Serializes the parts of a refresh token into the stored string format.
 */
export function formatRefreshParts(parts: RefreshParts): string {
  if (!parts.refreshToken) {
    return '';
  }

  if (!parts.projectId && !parts.managedProjectId) {
    return parts.refreshToken;
  }

  const projectSegment = parts.projectId ?? '';
  const managedSegment = parts.managedProjectId ?? '';
  return `${parts.refreshToken}|${projectSegment}|${managedSegment}`;
}

/**
 * Determines whether the access token has expired or is missing, with a buffer for clock skew.
 */
export function accessTokenExpired(auth: OAuthAuthDetails): boolean {
  if (!auth.access || typeof auth.expires !== 'number') {
    return true;
  }
  return auth.expires <= Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
}
