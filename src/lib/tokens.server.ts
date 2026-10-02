export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const ALLOWED_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
  "application/zip",
  "application/dicom",
  "model/stl",
  "application/octet-stream",
  "text/plain",
];

export const MAX_BYTES = 50 * 1024 * 1024;

/** DUMMY: placeholder for Web Push (VAPID) + e-mail fallback. Only records to outbox. */
export async function sendDummyNotification(
  admin: { from: (t: string) => any },
  userId: string,
  orgName: string,
) {
  const body = `Nowy plik w: ${orgName}`; // no file names / patient data (G3)
  await admin.from("notifications_outbox").insert([
    { user_id: userId, channel: "web_push", body },
    { user_id: userId, channel: "email", body },
  ]);
  console.log("[dummy-notify]", userId, body);
}
