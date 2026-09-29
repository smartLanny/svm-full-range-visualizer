import type { ManifestEntry } from './bundled';

// Only imported by the standalone build: embeds public/datasets/*.json into the bundle.
const modules = import.meta.glob('../../public/datasets/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

export function embeddedBundled(): { manifest: ManifestEntry[]; files: Record<string, unknown> } {
  const files: Record<string, unknown> = {};
  for (const [path, json] of Object.entries(modules)) files[path.split('/').pop()!] = json;
  return { manifest: (files['manifest.json'] ?? []) as ManifestEntry[], files };
}
