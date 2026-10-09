// LinkedIn sign-in and publishing, through the official API.
// Docs: https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api

const SCOPES = "openid profile w_member_social";

/**
 * LinkedIn's post format treats some characters as markup, and silently cuts
 * a post off at an unescaped one such as "(". Everything reserved is escaped
 * except "#", so hashtags still work.
 */
export function escapeForLinkedIn(text) {
  return text.replace(/[\\|{}@[\]()<>*_~]/g, "\\$&");
}

export function createLinkedIn({ clientId, clientSecret, redirectUri, apiVersion, apiBase, authBase }) {
  return {
    isConfigured: () => Boolean(clientId && clientSecret),

    authorizeUrl(state) {
      const params = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        scope: SCOPES,
      });
      return `${authBase}/oauth/v2/authorization?${params}`;
    },

    /** Swaps the sign-in code for an access token and looks up who signed in. */
    async exchangeCode(code) {
      const tokenRes = await fetch(`${authBase}/oauth/v2/accessToken`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenRes.ok) throw new Error(`LinkedIn sign-in failed (${tokenRes.status}): ${await tokenRes.text()}`);
      const token = await tokenRes.json();

      const userRes = await fetch(`${apiBase}/v2/userinfo`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (!userRes.ok) throw new Error(`Couldn't read your LinkedIn profile (${userRes.status}).`);
      const user = await userRes.json();

      return {
        accessToken: token.access_token,
        expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
        personUrn: `urn:li:person:${user.sub}`,
        name: user.name,
      };
    },

    /** Publishes a text post and returns its LinkedIn ID. */
    async createPost({ accessToken, personUrn, text }) {
      const res = await fetch(`${apiBase}/rest/posts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Linkedin-Version": apiVersion,
          "X-Restli-Protocol-Version": "2.0.0",
        },
        body: JSON.stringify({
          author: personUrn,
          commentary: escapeForLinkedIn(text),
          visibility: "PUBLIC",
          distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
        }),
      });

      if (res.status === 401) throw new Error("Your LinkedIn connection has expired. Reconnect and try again.");
      if (!res.ok) throw new Error(`LinkedIn rejected the post (${res.status}): ${await res.text()}`);
      return res.headers.get("x-restli-id");
    },
  };
}
