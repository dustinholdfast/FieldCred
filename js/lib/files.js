// Public and granted URLs for files stored in Neon (public.files).
// file.php streams the bytes. The browser never holds a database password.

export function publicFileUrl(tenant, bucket, path) {
  const q = new URLSearchParams({ tenant, bucket, path });
  return `file.php?${q.toString()}`;
}

export function grantedFileUrl(tenant, token) {
  const q = new URLSearchParams({ tenant, token });
  return `file.php?${q.toString()}`;
}

export async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
