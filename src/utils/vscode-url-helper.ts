/**
 * Helper function to transform VS Code URLs
 *
 * This function checks if a VS Code URL points to localhost and replaces it with
 * the current window's hostname if they don't match.
 *
 * @param vsCodeUrl The original VS Code URL from the backend
 * @returns The transformed URL with the correct hostname
 */
export function transformVSCodeUrl(vsCodeUrl: string | null): string | null {
  if (!vsCodeUrl) return null;

  try {
    const url = new URL(vsCodeUrl);

    // Backend-provided editor URLs are opened in a new browser tab. Only web
    // URLs are valid here; rejecting every other scheme also keeps malformed
    // values from reaching window.open at call sites that reuse this helper.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    // Check if the URL points to localhost
    if (
      url.hostname === "localhost" &&
      window.location.hostname !== "localhost"
    ) {
      // Replace localhost with the current hostname
      url.hostname = window.location.hostname;
      return url.toString();
    }

    return vsCodeUrl;
  } catch {
    return null;
  }
}
