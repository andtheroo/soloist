import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';

import type { Chart, Course, Lesson, SkillNodeDef, SongManifest } from '../types/chart';

/**
 * Where is the lesson server?
 *  1. An address the player typed in Settings (needed for standalone/preview APKs).
 *  2. Dev builds: the computer running Metro (`expo start`) — same machine as the mock
 *     server, so we reuse its LAN IP. Zero configuration on a shared Wi-Fi.
 *  3. app.json → expo.extra.apiUrl (defaults to the Android emulator's host alias).
 */
let overrideUrl: string | null = null;

export function setServerUrlOverride(url: string | null) {
  overrideUrl = url;
}

export function detectedServerUrl(): string {
  const hostUri = Constants.expoConfig?.hostUri; // e.g. "192.168.1.23:8081" in dev builds
  const host = hostUri?.split(':')[0];
  if (host) return `http://${host}:4000`;
  return (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? 'http://10.0.2.2:4000';
}

export function serverUrl(): string {
  return overrideUrl ?? detectedServerUrl();
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message;
    throw new Error(`Can't reach the lesson server at ${serverUrl()} (${msg}).`);
  } finally {
    clearTimeout(timer);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetchWithTimeout(`${serverUrl()}${path}`);
  if (!res.ok) throw new Error(`Server error ${res.status} for ${path}`);
  return (await res.json()) as T;
}

const speedQuery = (speed: number) => (speed === 100 ? '' : `?speed=${speed}`);

export const api = {
  course: () => get<Course>('/v1/course'),
  lesson: (id: string) => get<Lesson>(`/v1/lessons/${id}`),
  chart: (id: string, speed = 100) => get<Chart>(`/v1/charts/${id}${speedQuery(speed)}`),
  songManifest: (songId: string, speed = 100) => get<SongManifest>(`/v1/songs/${songId}/manifest${speedQuery(speed)}`),
  reportSession: async (payload: unknown) => {
    const res = await fetchWithTimeout(`${serverUrl()}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`POST /v1/sessions -> ${res.status}`);
  },
};

/** Used by Settings and onboarding: is there a Soloist server at this address? */
export async function checkServer(url = serverUrl()): Promise<{ ok: true; ms: number } | { ok: false; error: string }> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/v1/health`, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, error: `Server answered ${res.status}` };
    const body = (await res.json()) as { ok?: boolean };
    return body.ok ? { ok: true, ms: Date.now() - t0 } : { ok: false, error: 'Not a Soloist server' };
  } catch (e) {
    return { ok: false, error: (e as Error).name === 'AbortError' ? 'No answer (timed out)' : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads stems once into the cache dir. Files are content-addressed by sha256 prefix,
 * so a re-mastered stem is a new file and stale caches are never played.
 * Returns { stemId: file:// uri }.
 */
export async function ensureStemsCached(manifest: SongManifest): Promise<Record<string, string>> {
  const dir = new Directory(Paths.cache, 'stems', manifest.songId);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const out: Record<string, string> = {};
  await Promise.all(
    manifest.stems.map(async (s) => {
      const file = new File(dir, `${s.id}-${s.sha256.slice(0, 12)}.wav`);
      if (!file.exists || file.size !== s.bytes) {
        const url = s.url.startsWith('http') ? s.url : `${serverUrl()}${s.url}`;
        await File.downloadFileAsync(url, file, { idempotent: true });
      }
      out[s.id] = file.uri;
    }),
  );
  return out;
}

/** Deletes all cached stems (Settings → Storage). */
export function clearStemCache() {
  const dir = new Directory(Paths.cache, 'stems');
  if (dir.exists) dir.delete();
}

// ---- course cache (changes rarely; refetched on app start or pull-to-refresh) ----
let coursePromise: Promise<Course> | null = null;
export function loadCourse(force = false): Promise<Course> {
  if (!coursePromise || force) {
    coursePromise = api.course();
    coursePromise.catch(() => (coursePromise = null));
  }
  return coursePromise;
}

export const loadSkillTree = (force = false): Promise<SkillNodeDef[]> => loadCourse(force).then((c) => c.skills);
